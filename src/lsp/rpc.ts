/**
 * dsh-vscode-mode host — edrv.lsp.* RPC handlers。
 * 文档跟踪（openDocs 集合 + root|lang 引用计数）→ 懒启动服务器、用完释放。
 * 作者 ddj 2026-08-27
 */
import type { Ctx } from '../store.js'
import { searchRoot } from '../search/ripgrep.js'
import { sessionOf, cwdOf } from '../registry.js'
import { resolveProviderSpec, langOfPath, configFromPlugin, configFromSettings, LSP_LANGUAGES, LSP_SETTINGS_NS, type LspConfig } from './config.js'
import { clearProviderCache } from './providers.js'
import { onRuntimeProvisioned, envInstallStates } from './dotnetProvision.js'
import { envRequirementsFor, installRequirement } from './envRequirements.js'
import type { LspManager } from './manager.js'
import type { RpcHandlerMap } from '../shared/rpc.js'
import type { LspLocation, LspServerStatus } from '../shared/lsp.js'
import { installFromMarket, installVsixFile, listInstalled, marketGet, marketSearch, uninstall, updateExtension, type ExtInfo } from './extmgr.js'
import { dshHome } from '../paths.js'

export interface LspRpcDeps {
  ctx: Ctx
  pluginConfig: unknown
  manager: LspManager
}

/**
 * 打开文档跟踪：openDocs(docKey→sessionId) + rootLangRefs 计数 + sessionAcquired 归属。
 * 保证 manager 的 acquire/release 一一配对（多会话共享同一 root|lang 也平衡）。
 */
function createDocTracker() {
  const openDocs = new Map<string, Set<string>>()
  const rootLangRefs = new Map<string, number>()
  const sessionDocs = new Map<string, Set<string>>()
  const keyOf = (root: string, lang: string, path: string): string => root + '|' + lang + '|' + path
  const rootLangOf = (docKey: string): string => docKey.slice(0, docKey.lastIndexOf('|'))
  const rememberDoc = (sessionId: string, docKey: string): void => {
    const docs = sessionDocs.get(sessionId) ?? new Set<string>()
    docs.add(docKey)
    sessionDocs.set(sessionId, docs)
  }
  const forgetDoc = (sessionId: string, docKey: string): void => {
    const docs = sessionDocs.get(sessionId)
    docs?.delete(docKey)
    if (docs?.size === 0) sessionDocs.delete(sessionId)
  }
  const releaseRef = (rl: string): boolean => {
    const next = (rootLangRefs.get(rl) ?? 1) - 1
    if (next <= 0) {
      rootLangRefs.delete(rl)
      return true
    }
    rootLangRefs.set(rl, next)
    return false
  }
  return {
    /** 记录文档打开；同一文档可由多个会话打开，但每个会话只计一次。 */
    open(root: string, lang: string, path: string, sessionId: string): boolean {
      const docKey = keyOf(root, lang, path)
      const owners = openDocs.get(docKey) ?? new Set<string>()
      if (owners.has(sessionId)) return false
      owners.add(sessionId)
      openDocs.set(docKey, owners)
      rememberDoc(sessionId, docKey)
      const rl = root + '|' + lang
      const count = rootLangRefs.get(rl) ?? 0
      rootLangRefs.set(rl, count + 1)
      return count === 0
    },
    /** 记录文档关闭；返回 true 表示 root|lang 已无文档（应 release）。 */
    close(root: string, lang: string, path: string, sessionId: string): boolean {
      const docKey = keyOf(root, lang, path)
      const owners = openDocs.get(docKey)
      if (!owners?.has(sessionId)) return false
      owners.delete(sessionId)
      if (owners.size === 0) openDocs.delete(docKey)
      forgetDoc(sessionId, docKey)
      return releaseRef(root + '|' + lang)
    },
    /** 关闭某会话全部文档；返回全局引用归零、需要 release 的 root|lang。 */
    closeSession(sessionId: string): string[] {
      const docs = sessionDocs.get(sessionId)
      if (!docs) return []
      const toRelease = new Set<string>()
      for (const docKey of docs) {
        const owners = openDocs.get(docKey)
        owners?.delete(sessionId)
        if (owners?.size === 0) openDocs.delete(docKey)
        if (releaseRef(rootLangOf(docKey))) toRelease.add(rootLangOf(docKey))
      }
      sessionDocs.delete(sessionId)
      return [...toRelease]
    },
    /** 清除指定语言的文档归属，让当前客户端重新同步时重新 acquire。 */
    resetLanguage(languageId: string): void {
      for (const [docKey, owners] of openDocs) {
        if (!docKey.includes('|' + languageId + '|')) continue
        for (const sessionId of owners) forgetDoc(sessionId, docKey)
        openDocs.delete(docKey)
      }
      for (const key of [...rootLangRefs.keys()]) if (key.endsWith('|' + languageId)) rootLangRefs.delete(key)
    },
    /** 返回指定会话已打开的文档路径，用于重检测后恢复同步。 */
    pathsFor(sessionId: string, languageId: string): string[] {
      const docs = sessionDocs.get(sessionId)
      if (!docs) return []
      return [...docs].filter((key) => key.includes('|' + languageId + '|')).map((key) => key.slice(key.lastIndexOf('|') + 1))
    },
  }
}

/**
 * 构造 edrv.lsp.* handlers（一次性创建，tracker 状态跨请求保留）。
 * @author ddj 2026年08月27号
 * @param deps 依赖（ctx/pluginConfig/manager）
 * @returns { handlers, disposeSession } handlers 为局部 map，disposeSession 供 session/disposed 清理
 */
export function createLspRpc(deps: LspRpcDeps): { handlers: Partial<RpcHandlerMap>; disposeSession: (sessionId: string) => void } {
  const { ctx, pluginConfig, manager } = deps
  const tracker = createDocTracker()

  // 运行时自动配置成功：清 provider 缓存并重置 C# 服务器，下一次文档同步即用新运行时重启
  onRuntimeProvisioned(() => {
    clearProviderCache()
    manager.resetLanguage('csharp')
  })

  /** 解析会话与工作区根（失败 → null + error）。 */
  const rootOf = async (sessionId: string | undefined): Promise<{ root: string; sessionId: string } | { err: string }> => {
    const session = sessionOf(ctx, sessionId)
    if (!session) return { err: '会话不存在' }
    const cwd = cwdOf(session)
    if (!cwd) return { err: '会话无工作区' }
    try {
      const root = await searchRoot(ctx, session)
      const sid = typeof session.id === 'string' && session.id ? session.id : sessionId ?? ''
      return { root, sessionId: sid }
    } catch (error) {
      return { err: String(error) }
    }
  }

  const acquireServer = (root: string, lang: string) =>
    manager.acquire(root, lang, (languageId: string) => resolveProviderSpec(ctx, pluginConfig, languageId))

  const serverOf = (root: string, lang: string) =>
    manager.peek(root, lang)

  const rootLocations = (locations: LspLocation[], root: string): LspLocation[] =>
    locations.map((location) => ({ ...location, root }))

  /** 当前 provider 检测结论 → 设置页 idle 状态（不启动 server）；附带未满足的环境需求。 */
  const detectedStatus = (languageId: string, root?: string): LspServerStatus => {
    const spec = resolveProviderSpec(ctx, pluginConfig, languageId)
    const missingEnv = envRequirementsFor(languageId, dshHome())
    return {
      languageId,
      source: spec.kind,
      phase: 'idle',
      reason: spec.ready ? undefined : spec.reason,
      version: spec.version,
      providerName: spec.providerName,
      root,
      missingEnv: missingEnv.length ? missingEnv : undefined,
    }
  }

  /**
   * 清发现缓存并重置旧 server（保留 tracker 文档记录）；
   * 下一次模型同步会按最新配置重新 acquire，已打开文档无需重开。
   * 作者 ddj 2026年09月02号
   * @param languageId 语言 id
   * @param sessionId 会话语境（缺省重置全部工作区该语言）
   * @returns 检测后的 idle 状态列表
   */
  const redetectLanguage = async (languageId: string, sessionId?: string): Promise<LspServerStatus[]> => {
    clearProviderCache()
    if (sessionId) {
      const sc = await rootOf(sessionId)
      if ('err' in sc) return []
      manager.reset(sc.root, languageId)
      return [detectedStatus(languageId, sc.root)]
    }
    const roots = [...new Set(manager.statusAll().filter((s) => s.languageId === languageId).map((s) => s.root))]
    manager.resetLanguage(languageId)
    return roots.length ? roots.map((root) => detectedStatus(languageId, root)) : [detectedStatus(languageId)]
  }

  const disposeSession = (sessionId: string): void => {
    for (const rl of tracker.closeSession(sessionId)) {
      const sep = rl.lastIndexOf('|')
      manager.release(rl.slice(0, sep), rl.slice(sep + 1))
    }
  }

  const handlers: Partial<RpcHandlerMap> = {
    'edrv.lsp.status': async (args) => {
      if (!args.sessionId) return { ok: true, servers: manager.statusAll() }
      const sc = await rootOf(args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      return { ok: true, servers: manager.statusAll().filter((status) => status.root === sc.root) }
    },

    'edrv.lsp.configGet': async () => {
      const settings = configFromSettings(ctx)
      const plugin = configFromPlugin(pluginConfig)
      const merged: LspConfig = { ...plugin }
      for (const lang of Object.keys(settings)) merged[lang] = { ...plugin[lang], ...settings[lang] }
      return { ok: true, config: merged as unknown as Record<string, unknown> }
    },

    'edrv.lsp.configUpdate': async (args) => {
      const lang = args.languageId
      if (!lang || !resolveProviderSpec(ctx, pluginConfig, lang).languageId) {
        return { ok: false, error: '不支持的语言：' + lang }
      }
      const current = configFromSettings(ctx)
      const next: LspConfig = { ...current, [lang]: { ...(current[lang] ?? {}) } }
      const target = next[lang]!
      if (args.enabled !== undefined) target.enabled = args.enabled
      if (args.command !== undefined) target.command = args.command || undefined
      if (args.path !== undefined) target.path = args.path || undefined
      try {
        const settings = ctx.get('settings')
        if (!settings?.update) return { ok: false, error: '设置服务不可用' }
        await settings.update(LSP_SETTINGS_NS, { [lang]: target })
        // 保存/切换后立即重新检测：清缓存 + 重置旧 server，旧状态不残留
        const servers = await redetectLanguage(lang)
        const descriptor = settings.describe?.({ redactSecrets: true })?.find((item: { ns?: string }) => item.ns === LSP_SETTINGS_NS)
        const stored = descriptor?.value as Record<string, unknown> | undefined
        const merged: LspConfig = { ...configFromPlugin(pluginConfig), ...(stored as LspConfig) }
        return { ok: true, config: merged as unknown as Record<string, unknown>, servers }
      } catch (error) {
        return { ok: false, error: '配置保存失败：' + String(error) }
      }
    },

    'edrv.lsp.sync': async (args) => {
      const lang = langOfPath(args.path)
      if (!lang) return { ok: true }
      const sc = await rootOf(args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const first = tracker.open(sc.root, lang, args.path, sc.sessionId)
      const server = first ? acquireServer(sc.root, lang) : serverOf(sc.root, lang)
      if (!server) return { ok: false, error: '语言服务器未注册' }
      server.sync(args.path, args.text, args.version)
      return { ok: true }
    },

    'edrv.lsp.close': async (args) => {
      const lang = langOfPath(args.path)
      if (!lang) return { ok: true }
      const sc = await rootOf(args.sessionId)
      if ('err' in sc) return { ok: true }
      if (tracker.close(sc.root, lang, args.path, sc.sessionId)) {
        manager.release(sc.root, lang)
      }
      return { ok: true }
    },

    'edrv.lsp.definition': async (args) => {
      const lang = langOfPath(args.path)
      if (!lang) return { ok: true, locations: [] }
      const sc = await rootOf(args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const server = serverOf(sc.root, lang)
        if (!server) return { ok: true, locations: [] }
        const locations = await server.definition(args.path, args.position.line, args.position.character)
        const rooted = rootLocations(locations, sc.root)
        const truncated = rooted.length > 500
        return { ok: true, locations: truncated ? rooted.slice(0, 500) : rooted, truncated: truncated || undefined }
      } catch (error) {
        return { ok: false, error: 'LSP 定义查询失败：' + String(error) }
      }
    },

    'edrv.lsp.references': async (args) => {
      const lang = langOfPath(args.path)
      if (!lang) return { ok: true, locations: [] }
      const sc = await rootOf(args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const server = serverOf(sc.root, lang)
        if (!server) return { ok: true, locations: [] }
        const locations = await server.references(args.path, args.position.line, args.position.character, args.includeDeclaration !== false)
        const rooted = rootLocations(locations, sc.root)
        const truncated = rooted.length > 500
        return { ok: true, locations: truncated ? rooted.slice(0, 500) : rooted, truncated: truncated || undefined }
      } catch (error) {
        return { ok: false, error: 'LSP 引用查询失败：' + String(error) }
      }
    },

    'edrv.lsp.documentSymbol': async (args) => {
      const lang = langOfPath(args.path)
      if (!lang) return { ok: true, symbols: [] }
      const sc = await rootOf(args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const server = serverOf(sc.root, lang)
        if (!server) return { ok: true, symbols: [] }
        const symbols = await server.documentSymbol(args.path)
        return { ok: true, symbols }
      } catch (error) {
        return { ok: false, error: 'LSP 大纲查询失败：' + String(error) }
      }
    },

    'edrv.lsp.workspaceSymbol': async (args) => {
      const sc = await rootOf(args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const out: { symbols: never[]; truncated?: boolean } = { symbols: [] }
      for (const lang of ['lua', 'csharp']) {
        const existing = serverOf(sc.root, lang)
        if (!existing) continue
        try {
          const symbols = await existing.workspaceSymbol(args.query)
          if (symbols.length) out.symbols.push(...(symbols as never[]))
        } catch (error) {
          /* 单语言失败忽略 */
        }
      }
      const truncated = out.symbols.length > 500
      return { ok: true, symbols: out.symbols.slice(0, 500), truncated: truncated || undefined }
    },

    'edrv.lsp.hover': async (args) => {
      const lang = langOfPath(args.path)
      if (!lang) return { ok: true, hover: undefined }
      const sc = await rootOf(args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const server = serverOf(sc.root, lang)
        if (!server) return { ok: true, hover: undefined }
        const hover = await server.hover(args.path, args.position.line, args.position.character)
        return { ok: true, hover: hover ?? undefined }
      } catch (error) {
        return { ok: false, error: 'LSP hover 查询失败：' + String(error) }
      }
    },

    'edrv.lsp.semanticTokens': async (args) => {
      const lang = langOfPath(args.path)
      if (!lang) return { ok: true, tokens: undefined }
      const sc = await rootOf(args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const server = serverOf(sc.root, lang)
        if (!server) return { ok: true, tokens: undefined }
        return { ok: true, tokens: (await server.semanticTokens(args.path)) ?? undefined }
      } catch (error) {
        return { ok: false, error: 'LSP 语义分色查询失败：' + String(error) }
      }
    },

    'edrv.lsp.redetect': async (args) => {
      if (!(LSP_LANGUAGES as readonly string[]).includes(args.languageId)) {
        return { ok: false, error: '不支持的语言：' + args.languageId }
      }
      try {
        return { ok: true, servers: await redetectLanguage(args.languageId) }
      } catch (error) {
        return { ok: false, error: '重新检测失败：' + String(error) }
      }
    },

    // 环境需求：一键安装（内置安装器）与安装进度查询
    'edrv.lsp.envInstall': async (args) => {
      if (!installRequirement(args.id)) {
        return { ok: false, started: false, error: '该需求不支持一键安装：' + args.id }
      }
      return { ok: true, started: true }
    },

    'edrv.lsp.envState': async () => {
      return { ok: true, states: envInstallStates() }
    },

    // --region 扩展管理（edrv.lsp.ext.*：已装/市场/安装/卸载/更新）
    'edrv.lsp.ext.list': async () => ({ ok: true, extensions: listInstalled() }),

    'edrv.lsp.ext.market': async (args) => {
      try {
        const items = await marketSearch(args.query, args.size ?? 12)
        return { ok: true, extensions: items }
      } catch (error) {
        return { ok: false, error: '市场搜索失败：' + String(error) }
      }
    },

    'edrv.lsp.ext.install': async (args) => {
      try {
        let info: ExtInfo
        if (args.vsixPath) info = await installVsixFile(args.vsixPath)
        else if (args.namespace && args.name) info = await installFromMarket(args.namespace, args.name, args.version)
        else return { ok: false, error: '缺少安装源（vsixPath 或 namespace+name）' }
        clearProviderCache() // 新扩展可能成为 Lua provider，立即丢弃旧发现结果
        return { ok: true, extension: info }
      } catch (error) {
        return { ok: false, error: '安装失败：' + String(error) }
      }
    },

    'edrv.lsp.ext.uninstall': async (args) => {
      const ok = uninstall(args.id)
      if (ok) clearProviderCache()
      return ok ? { ok: true } : { ok: false, error: '扩展未安装：' + args.id }
    },

    'edrv.lsp.ext.update': async (args) => {
      try {
        const updated = await updateExtension(args.id)
        if (!updated) {
          const current = listInstalled().find((e) => e.id === args.id)
          return current ? { ok: true, extension: current, updated: false } : { ok: false, error: '扩展未安装：' + args.id }
        }
        clearProviderCache()
        return { ok: true, extension: updated, updated: true }
      } catch (error) {
        return { ok: false, error: '更新失败：' + String(error) }
      }
    },

    'edrv.lsp.ext.updates': async () => {
      try {
        const updates = []
        for (const ext of listInstalled()) {
          const meta = await marketGet(ext.namespace, ext.name)
          const latest = String(meta?.version ?? '')
          if (latest && latest !== ext.version) updates.push({ id: ext.id, current: ext.version, latest, displayName: ext.displayName })
        }
        return { ok: true, updates }
      } catch (error) {
        return { ok: false, error: '检查更新失败：' + String(error) }
      }
    },
    // --endregion
  }
  return { handlers, disposeSession }
}
