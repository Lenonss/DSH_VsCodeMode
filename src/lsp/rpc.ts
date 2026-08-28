/**
 * dsh-vscode-mode host — edrv.lsp.* RPC handlers。
 * 文档跟踪（openDocs 集合 + root|lang 引用计数）→ 懒启动服务器、用完释放。
 * 作者 ddj 2026-08-27
 */
import type { Ctx } from '../store.js'
import { searchRoot } from '../search/ripgrep.js'
import { sessionOf, cwdOf } from '../registry.js'
import { resolveProviderSpec, langOfPath, configFromPlugin, configFromSettings, LSP_SETTINGS_NS, type LspConfig } from './config.js'
import type { LspManager } from './manager.js'
import type { RpcHandlerMap } from '../shared/rpc.js'
import { installFromMarket, installVsixFile, listInstalled, marketGet, marketSearch, uninstall, updateExtension, type ExtInfo } from './extmgr.js'

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
  const openDocs = new Map<string, string>()
  const rootLangRefs = new Map<string, number>()
  const sessionAcquired = new Map<string, Set<string>>()
  const rootLangOf = (docKey: string): string => docKey.slice(0, docKey.lastIndexOf('|'))
  return {
    /** 记录文档打开；返回 true 表示"首个该 root|lang 的文档"（应 acquire）。 */
    open(root: string, lang: string, path: string, sessionId: string): boolean {
      const docKey = root + '|' + lang + '|' + path
      if (openDocs.has(docKey)) return false
      openDocs.set(docKey, sessionId)
      const rl = root + '|' + lang
      rootLangRefs.set(rl, (rootLangRefs.get(rl) ?? 0) + 1)
      if (!sessionAcquired.has(sessionId)) sessionAcquired.set(sessionId, new Set())
      sessionAcquired.get(sessionId)!.add(rl)
      return true
    },
    /** 记录文档关闭；返回 true 表示"该 root|lang 已无文档"（应 release）。 */
    close(root: string, lang: string, path: string, sessionId: string): boolean {
      const docKey = root + '|' + lang + '|' + path
      if (!openDocs.has(docKey)) return false
      openDocs.delete(docKey)
      const rl = rootLangOf(docKey)
      const next = (rootLangRefs.get(rl) ?? 1) - 1
      if (next <= 0) {
        rootLangRefs.delete(rl)
        return true
      }
      rootLangRefs.set(rl, next)
      sessionAcquired.get(sessionId)?.delete(rl)
      return false
    },
    /** 关闭某会话全部文档；返回需要 release 的 root|lang 键列表。 */
    closeSession(sessionId: string): string[] {
      const acquired = sessionAcquired.get(sessionId)
      if (!acquired) return []
      sessionAcquired.delete(sessionId)
      const toRelease: string[] = []
      for (const rl of acquired) {
        // 从 openDocs 移除属于该会话的文档
        for (const [docKey, sid] of [...openDocs]) {
          if (sid !== sessionId) continue
          if (rootLangOf(docKey) !== rl) continue
          openDocs.delete(docKey)
          const next = (rootLangRefs.get(rl) ?? 1) - 1
          if (next <= 0) rootLangRefs.delete(rl)
          else rootLangRefs.set(rl, next)
        }
        if (!(rootLangRefs.get(rl) ?? 0)) toRelease.push(rl)
      }
      return toRelease
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

  const serverOf = (root: string, lang: string) =>
    manager.acquire(root, lang, (languageId: string) => resolveProviderSpec(ctx, pluginConfig, languageId))

  const disposeSession = (sessionId: string): void => {
    for (const rl of tracker.closeSession(sessionId)) {
      const sep = rl.lastIndexOf('|')
      manager.release(rl.slice(0, sep), rl.slice(sep + 1))
    }
  }

  const handlers: Partial<RpcHandlerMap> = {
    'edrv.lsp.status': async () => ({ ok: true, servers: manager.statusAll() }),

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
        const descriptor = settings.describe?.({ redactSecrets: true })?.find((item: { ns?: string }) => item.ns === LSP_SETTINGS_NS)
        const stored = descriptor?.value as Record<string, unknown> | undefined
        const merged: LspConfig = { ...configFromPlugin(pluginConfig), ...(stored as LspConfig) }
        return { ok: true, config: merged as unknown as Record<string, unknown> }
      } catch (error) {
        return { ok: false, error: '配置保存失败：' + String(error) }
      }
    },

    'edrv.lsp.sync': async (args) => {
      const lang = langOfPath(args.path)
      if (!lang) return { ok: true }
      const sc = await rootOf(args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      if (tracker.open(sc.root, lang, args.path, sc.sessionId)) {
        serverOf(sc.root, lang)
      }
      const server = serverOf(sc.root, lang)
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
        const locations = await serverOf(sc.root, lang).definition(args.path, args.position.line, args.position.character)
        const truncated = locations.length > 500
        return { ok: true, locations: truncated ? locations.slice(0, 500) : locations, truncated: truncated || undefined }
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
        const locations = await serverOf(sc.root, lang).references(args.path, args.position.line, args.position.character, args.includeDeclaration !== false)
        const truncated = locations.length > 500
        return { ok: true, locations: truncated ? locations.slice(0, 500) : locations, truncated: truncated || undefined }
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
        const symbols = await serverOf(sc.root, lang).documentSymbol(args.path)
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
        try {
          const server = serverOf(sc.root, lang)
          const symbols = await server.workspaceSymbol(args.query)
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
        const hover = await serverOf(sc.root, lang).hover(args.path, args.position.line, args.position.character)
        return { ok: true, hover: hover ?? undefined }
      } catch (error) {
        return { ok: false, error: 'LSP hover 查询失败：' + String(error) }
      }
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
        return { ok: true, extension: info }
      } catch (error) {
        return { ok: false, error: '安装失败：' + String(error) }
      }
    },

    'edrv.lsp.ext.uninstall': async (args) => {
      return uninstall(args.id) ? { ok: true } : { ok: false, error: '扩展未安装：' + args.id }
    },

    'edrv.lsp.ext.update': async (args) => {
      try {
        const updated = await updateExtension(args.id)
        if (!updated) {
          const current = listInstalled().find((e) => e.id === args.id)
          return current ? { ok: true, extension: current, updated: false } : { ok: false, error: '扩展未安装：' + args.id }
        }
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
