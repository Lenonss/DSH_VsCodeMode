/**
 * dsh-vscode-mode host — RPC 分发：类型化方法表替代巨型 switch。
 * 迁移自原 src/index.ts 的 handleRpc，方法名/载荷/错误文案一字不改。
 * 新功能 = shared/rpc.ts 加方法 + 这里加一个 handler，不改其他模块。
 * 作者 ddj 2026-08-20
 */
import type { DecideItem, DecideResult, RpcHandlerMap, RpcMethod, RpcRequestMap, RpcResult, RpcScope } from './shared/rpc.js'
import { binaryMimeOf } from './shared/rpc.js'
import type { DiffRecord, RecordView } from './shared/types.js'
import type { Ctx, Session } from './store.js'
import {
  BINARY_READ_CAP,
  READ_CAP,
  appendArchiveEntries,
  archiveRecords,
  autoArchiveStale,
  parseArchive,
  policyOf,
  readArchiveText,
  resolveTarget,
  saveBucket,
} from './store.js'
import { cp, mkdir, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { archiveEntryFor, markDecision, recordResolved, reconstructOriginal } from './model.js'
import type { Registry } from './registry.js'
import { bucketOf, cwdOf, sessionOf } from './registry.js'
import type { SearchOrchestrator } from './search/orchestrator.js'
import { newSearcher } from './search/orchestrator.js'
import type { ContentSearcher } from './search/content.js'
import { newContentSearcher } from './search/content.js'
import { restoreFile, revertCall, revertHunk } from './revert.js'
import { rulesList, rulesRead, rulesRemove, rulesSave, rulesToggle } from './rules.js'
import { isSnippetFilePath, snippetsEntries, snippetsList, snippetsRead, snippetsRemove, snippetsSave } from './snippets.js'
import { listMcp, refreshMcp, removeMcp, saveMcp, toggleMcp } from './mcp.js'
import { listProjects, projectRefresh, projectRemove, projectSave, projectToggle } from './mcpProject.js'
import { normalizeFileOpenTool, FILE_OPEN_DEFAULT, FILE_OPEN_SETTINGS_NS, sectionOf, updateSection } from './fileOpenSettings.js'
import { INTEGRATION_BASE_DEFAULT } from './shared/integration.js'
import { shellMenuRegister, shellMenuRemove, shellMenuStatus } from './integrate.js'
import { unityAdd, unityInstall, unityList, unityRemove } from './unityBridge.js'
import { handoffOpen, pendingState, pollPending } from './externalHandoff.js'
import { buildReport } from './compat.js'
import { findProfileDir, readDevForm, setDevForm } from './devForm.js'
import { normalizeRel } from './tree.js'
import { baseNameOf, checkNewName, checkRenameName, isSubPath, joinRelPath, parentRelOf } from './shared/fsNames.js'
import { invalidateIndex, listDirCached } from './treeIndex.js'
import { revealInExplorer } from './reveal.js'
import { dshHome, debugLogFile, pluginLogRoot } from './paths.js'
import { clearDebugLog, debugRecord, isDebugLogName, listDebugLogs, readDebugLog } from './debugLog.js'
import { markActiveSessions, markOfficialFlags, moveOutSessions, planMoveOut, purgeArchive, restoreSession, scanSessionInventory, sessionsArchiveRoot, sessionSizeOf, sidecarSummaryOf, unarchiveOfficial } from './perf.js'
import { patchHasPerfConfig, patchInsertPerfConfig, patchRemovePerfConfig, perfConfigBlock } from './perfPatch.js'
import type { FileVersions } from './fileVersions.js'

/** cwd → 上次 stale 自动清理时间：全量轮询（EditorView/DiffBadge/Dock 各自 5s）节流，避免每轮都读文件算指纹。 */
const staleCheckedAt = new Map<string, number>()
/** stale 自动清理最小间隔。 */
const STALE_CHECK_MIN_MS = 10_000

/** 记录 → 客户端视图（不含 before 全文，仅长度）。 */
function recView(record: DiffRecord): RecordView {
  return {
    callId: record.callId,
    toolName: record.toolName,
    path: record.path,
    beforeLen: typeof record.before === 'string' ? record.before.length : 0,
    create: record.create === true,
    callHunk: record.callHunk,
    hunks: record.hunks,
    decisions: record.decisions,
    note: record.note ?? null,
    superseded: record.superseded === true,
    after: record.after ?? null,
    baseFingerprint: record.baseFingerprint ?? null,
    afterFingerprint: record.afterFingerprint ?? null,
    conflict: record.conflict === true,
    legacy: record.legacy === true,
    at: record.at,
  }
}

/** 会话/工作区公共前置：返回 {session,cwd} 或错误文案。 */
async function requireSession(ctx: Ctx, sessionId: string | undefined): Promise<
  { session: Session; cwd: string } | { err: string }
> {
  const session = sessionOf(ctx, sessionId)
  if (!session) return { err: '会话不存在' }
  const cwd = cwdOf(session)
  if (!cwd) return { err: '会话无工作区' }
  return { session, cwd }
}

/** 片段文件保存时的沙箱策略：用户显式 GUI 写操作，放开到 danger-full-access（镜像 rules.fullPolicy）。 */
function snippetPolicy(ctx: Ctx): unknown {
  const svc = ctx.get('sandboxPolicy')
  if (!svc || typeof svc.resolve !== 'function') return undefined
  return svc.resolve({ mode: 'danger-full-access' })
}

/**
 * 片段文件路径解析：命中全局片段目录（~/.dsh/snippets）返回归一化绝对路径，否则 null。
 * 全局片段位于工作区之外，edrv.read / edrv.save 需绕开 resolveTarget 的 cwd 语义直读直写。
 * @author ddj 2026年09月10号
 * @param path 客户端请求路径（绝对路径）
 * @returns 归一化后的绝对路径或 null
 */
function snippetTargetOf(path: string): string | null {
  return isSnippetFilePath(path) ? path.replace(/\\/g, '/') : null
}

/** readTargetOf 成功形态：解析后的目标路径、stat 信息与 fs 服务句柄。 */
interface ReadTargetOk {
  target: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fs: any
  info: { version?: unknown; size?: number }
}

/**
 * 二进制/文本读取共用前置（edrv.read 与 edrv.readBinary）：解析路径 + debugRecord +
 * stat + 文件类型校验 + 32MB 二进制上限，保证两条读通道的错误口径完全一致。
 * @author ddj 2026年09月22号
 * @param ctx DSH 上下文
 * @param sc requireSession 成功结果（session + cwd）
 * @param path 客户端请求路径
 * @returns 成功返回解析目标与 stat；失败返回错误文案（文件不存在时附 resolvedPath）
 */
async function readTargetOf(
  ctx: Ctx,
  sc: { session: Session; cwd: string },
  path: string,
): Promise<ReadTargetOk | { err: string; resolvedPath?: string }> {
  const fs = ctx.get('fs')
  if (!fs) return { err: '缺少 fs' }
  try {
    const target = await resolveTarget(ctx, sc.session, path)
    debugRecord(ctx, sc.cwd, '[DEBUG path.resolve] input=' + String(path ?? '') + ' resolved=' + fs.processPath(target), 'debug')
    const info = await fs.stat(target)
    if (!info || info.type !== 'file') {
      // 带上解析后的真实路径：跳转失败时可直接看出是路径解析错还是目标本身不存在
      return { err: '文件不存在', resolvedPath: fs.processPath(target) }
    }
    if ((info.size ?? 0) > BINARY_READ_CAP) return { err: '文件过大（>32MB），不支持整文件预览' }
    return { target, fs, info }
  } catch (error) {
    return { err: '读取失败：' + String(error) }
  }
}

/**
 * readTargetOf 失败结果 → RPC 错误载荷（文件不存在时保留 resolvedPath 供诊断）。
 * @author ddj 2026年09月22号
 * @param prep readTargetOf 的失败分支
 * @returns { ok:false } 形态载荷
 */
function targetErrOf(prep: { err: string; resolvedPath?: string }): { ok: false; error: string; resolvedPath?: string } {
  return prep.resolvedPath !== undefined
    ? { ok: false, error: prep.err, resolvedPath: prep.resolvedPath }
    : { ok: false, error: prep.err }
}

/**
 * 本地文件系统版本令牌（mtime+size）：与 ctx.fs 的不透明版本串用途相同，
 * 仅供全局片段文件（走 node:fs 直读、不经 ctx.fs）在 edrv.read 时回带。
 * @author ddj 2026年09月15号
 * @param info node fs.Stats（stat 失败传 null）
 * @returns 版本令牌；取不到 → 空串（不启用护栏）
 */
function fileVersionOf(info: { mtimeMs?: number; size?: number } | null): string {
  if (!info || typeof info.mtimeMs !== 'number' || typeof info.size !== 'number') return ''
  return info.mtimeMs + ':' + info.size
}

/**
 * 判定错误是否为「读取后文件已被外部修改」（版本守卫拒绝写入）。
 * 不依赖 host fs 的 FsError 类（外置模块，instanceof 不可靠），按错误码与文案双重判定。
 * @author ddj 2026年09月15号
 * @param error 捕获到的异常
 * @returns 是否为版本冲突
 */
function isStaleVersion(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown } | null
  if (err && err.code === 'FS_STALE_VERSION') return true
  const message = err && typeof err.message === 'string' ? err.message : String(error)
  return message.includes('changed since it was read')
}

/**
 * 手动保存收尾（edrv.save / edrv.saveBinary 共用）：目录树失效 + 该路径 pending
 * 文本差异记录标记 superseded 并归档（旧文本 diff 不得再应用到新内容上）。
 * @author ddj 2026年09月22号
 * @param ctx DSH 上下文
 * @param registry 差异记录桶注册表
 * @param sc requireSession 成功结果（session + cwd）
 * @param path 保存的文件路径
 */
async function afterManualSave(
  ctx: Ctx,
  registry: Registry,
  sc: { session: Session; cwd: string },
  path: string,
): Promise<void> {
  // 手动保存后目录树可能变化（新建/删除文件）：父目录+祖先进失效，后台自愈。
  invalidateIndex(ctx, sc.cwd, path)
  const bucket = await bucketOf(registry, ctx, sc.cwd)
  let changed = false
  for (const rec of bucket.values()) {
    if (rec.path === path && rec.superseded !== true) { rec.superseded = true; rec.at = new Date().toISOString(); changed = true }
  }
  if (changed) {
    const done: DiffRecord[] = []
    for (const rec of bucket.values()) if (rec.path === path && rec.superseded) done.push(rec)
    if (done.length) await archiveRecords(ctx, sc.session, sc.cwd, bucket, done, '被手动编辑覆盖')
    else await saveBucket(ctx, sc.cwd, bucket, sc.session)
  }
}

/**
 * 批量决策核心：一次会话/桶解析 + 逐项处理 + 统一落盘（accept/reject 单条与 decideBatch 共用）。
 * rejected 项先做回滚，失败记入该项 error 且不改决策；hunk 的新文本已不在文件中
 * （被后续修改覆盖/撤销）时不算失败：不写文件，按已回滚记录决策并归档（结果项带 stale）。
 * 本批次新增"已解决"记录一次性归档，有任何成功项则整桶只写盘一次，避免逐条读写整个 sidecar。
 * @author ddj 2026年08月25号
 * @param items 决策项（按数组顺序处理，rejected 的先后即回滚顺序）
 * @returns 逐项结果（ok 项含更新后的记录视图）
 */
async function applyDecisions(
  ctx: Ctx,
  session: Session,
  cwd: string,
  bucket: Map<string, DiffRecord>,
  items: DecideItem[],
): Promise<DecideResult[]> {
  const results: DecideResult[] = []
  const resolved: DiffRecord[] = []
  let changed = false
  for (const item of items) {
    const record = bucket.get(item.callId)
    if (!record) {
      results.push({ callId: item.callId, ok: false, error: '记录不存在' })
      continue
    }
    let revertedStale = false
    if (item.decision === 'rejected') {
      const scope: RpcScope = item.scope ?? 'call'
      const outcome = scope === 'hunk' ? await revertHunk(ctx, session, record, item.hunkIndex ?? -1) : await revertCall(ctx, session, record)
      if (!outcome.ok) {
        if (scope !== 'hunk' || outcome.stale !== true) {
          results.push({ callId: item.callId, ok: false, error: outcome.error })
          continue
        }
        revertedStale = true
      }
    }
    const wasResolved = recordResolved(record)
    markDecision(record, item.scope ?? 'call', item.hunkIndex, item.decision)
    changed = true
    if (!wasResolved && recordResolved(record)) resolved.push(record)
    const result: DecideResult = { callId: item.callId, ok: true, record: recView(record) }
    if (revertedStale) result.stale = true
    results.push(result)
  }
  if (resolved.length) {
    const reason = items.some((item) => item.decision === 'rejected') ? '已处理（回滚）' : '已处理'
    await archiveRecords(ctx, session, cwd, bucket, resolved, reason, { deferSave: true })
  }
  if (changed) await saveBucket(ctx, cwd, bucket, session)
  return results
}

/** 当前活跃会话 id 集合（live sessions，用于移出/恢复护栏）。 */
function activeSessionIds(ctx: Ctx): Set<string> {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.list !== 'function') return new Set()
  return new Set((sessions.list() as Session[]).map((s) => s.id).filter(Boolean))
}

/** profile patch 文件定位（依赖本插件的 profile，同 devForm）。 */
async function patchFileInfo(): Promise<{ profileDir?: string; patchPath?: string }> {
  const profileDir = findProfileDir()
  if (!profileDir) return {}
  return { profileDir, patchPath: join(profileDir, 'cordis.patch.yml') }
}

/** 最新一次压缩配置备份文件名（cordis.patch.yml.bak-<ts>，按名倒序取新）。 */
async function latestPatchBackup(patchPath: string): Promise<string | undefined> {
  const dir = join(patchPath, '..')
  const base = basename(patchPath)
  const names = await readdir(dir).catch(() => [])
  return names.filter((n) => n.startsWith(base + '.bak-')).sort().reverse()[0]
}

/** 读取设置中的深链基址（缺省/非法回退默认 3080）。 */
async function integrationBaseUrlOf(ctx: Ctx): Promise<string> {
  const settings = ctx.get('settings')
  const value = sectionOf(settings, FILE_OPEN_SETTINGS_NS)?.value as { integrationBaseUrl?: unknown } | undefined
  const raw = typeof value?.integrationBaseUrl === 'string' ? value.integrationBaseUrl.trim() : ''
  return raw || INTEGRATION_BASE_DEFAULT
}

// --region 文件操作（edrv.fs.*：资源管理器右键的新建/重命名/删除/复制/移动）

/**
 * 文件操作目标解析：工作区相对路径 → 绝对路径，并做工作区边界检查。
 * edrv.fs.* 各方法共用（对齐 edrv.saveBinary 的 contains 护栏口径）。
 * @author ddj 2026年09月22号
 * @param ctx DSH 上下文
 * @param session 当前会话
 * @param rel 工作区相对路径
 * @returns 绝对路径；缺 fs/越界/解析失败返回错误文案
 */
async function fsOpsTarget(ctx: Ctx, session: Session, rel: string): Promise<{ abs: string } | { err: string }> {
  const fs = ctx.get('fs')
  if (!fs) return { err: '缺少 fs' }
  try {
    const target = await resolveTarget(ctx, session, rel)
    const rootTarget = await fs.resolve(policyOf(ctx, session)?.workspaceRoot ?? '.', {})
    if (!fs.contains(rootTarget, target)) return { err: '拒绝操作：目标不在会话工作区内' }
    return { abs: fs.processPath(target) }
  } catch (error) {
    return { err: '路径解析失败：' + String(error) }
  }
}

/**
 * 取异常的系统错误码（EEXIST/EXDEV 等分支判定用）。
 * @author ddj 2026年09月22号
 * @param error 捕获到的异常
 * @returns 错误码；取不到返回空串
 */
function fsErrCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

/**
 * 复制/移动共用核心（edrv.fsCopy / edrv.fsMove）：目标目录存在 + 同名拒绝覆盖 +
 * 「不能以自身或其子目录为目标」护栏；move 跨设备（EXDEV）回退「递归复制 + 删除源」。
 * @author ddj 2026年09月22号
 * @param ctx DSH 上下文
 * @param sc requireSession 成功结果（session + cwd）
 * @param args 请求载荷（from / toDir 均为工作区相对路径）
 * @param mode copy = 复制；move = 移动
 * @returns 成功返回 from/to 相对路径；失败返回错误文案
 */
async function fsTransfer(
  ctx: Ctx,
  sc: { session: Session; cwd: string },
  args: { from: string; toDir: string },
  mode: 'copy' | 'move',
): Promise<{ from: string; to: string } | { err: string }> {
  const fromRel = normalizeRel(args.from)
  const toDirRel = normalizeRel(args.toDir)
  if (fromRel === null || fromRel === '' || toDirRel === null) return { err: '路径不合法' }
  if (isSubPath(fromRel, toDirRel)) return { err: '不能以自身或其子目录为目标' }
  const src = await fsOpsTarget(ctx, sc.session, fromRel)
  if ('err' in src) return src
  const dir = await fsOpsTarget(ctx, sc.session, toDirRel)
  if ('err' in dir) return dir
  const dirInfo = await stat(dir.abs).catch(() => null)
  if (!dirInfo || !dirInfo.isDirectory()) return { err: '目标目录不存在' }
  const toRel = joinRelPath(toDirRel, baseNameOf(fromRel))
  const dst = await fsOpsTarget(ctx, sc.session, toRel)
  if ('err' in dst) return dst
  const srcInfo = await stat(src.abs).catch(() => null)
  if (!srcInfo) return { err: '源不存在' }
  if (await stat(dst.abs).catch(() => null)) return { err: '目标目录已存在同名文件或目录' }
  try {
    await transferEntry(src.abs, dst.abs, mode)
  } catch (error) {
    return { err: (mode === 'copy' ? '复制失败：' : '移动失败：') + String(error) }
  }
  invalidateIndex(ctx, sc.cwd, fromRel)
  invalidateIndex(ctx, sc.cwd, toRel)
  return { from: fromRel, to: toRel }
}

/**
 * 单条目复制/移动落盘（文件/目录通用；move 跨设备回退复制+删除源）。
 * @author ddj 2026年09月22号
 * @param absFrom 源绝对路径
 * @param absTo 目标绝对路径
 * @param mode copy = 复制；move = 移动
 */
async function transferEntry(absFrom: string, absTo: string, mode: 'copy' | 'move'): Promise<void> {
  if (mode === 'copy') {
    await cp(absFrom, absTo, { recursive: true, force: false, errorOnExist: true })
    return
  }
  try {
    await rename(absFrom, absTo)
  } catch (error) {
    if (fsErrCode(error) !== 'EXDEV') throw error
    await cp(absFrom, absTo, { recursive: true, force: false, errorOnExist: true })
    await rm(absFrom, { recursive: true })
  }
}

// --endregion

/** 各方法 handler 表（类型由 shared/rpc 的 RpcHandlerMap 约束）。 */
export function buildHandlers(
  ctx: Ctx,
  registry: Registry,
  searcher = newSearcher(ctx),
  contentSearcher = newContentSearcher(ctx),
  lspHandlers?: Partial<RpcHandlerMap>,
  aiHandlers?: Partial<RpcHandlerMap>,
  fileVersions?: FileVersions,
  svnHandlers?: Partial<RpcHandlerMap>,
  dapHandlers?: Partial<RpcHandlerMap>,
): RpcHandlerMap {
  return {
    // edrv.lsp.* 由 createLspRpc 一次性提供（tracker 跨请求保留），这里并入。
    ...((lspHandlers ?? {}) as RpcHandlerMap),
    // edrv.ai.* 由 createAiRpc 提供（AI 内联补全/模型目录/配置读写），这里并入。
    ...((aiHandlers ?? {}) as RpcHandlerMap),
    // svn.* 由 createSvnRpc 提供（SVN 检测/更新/Tortoise 发射），这里并入。
    ...((svnHandlers ?? {}) as RpcHandlerMap),
    // edrv.dap.* 由 createDapRpc 提供（调试会话单例），这里并入。
    ...((dapHandlers ?? {}) as RpcHandlerMap),
    'edrv.list': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const want = Array.isArray(args.callIds) ? new Set(args.callIds) : null
      // 全量轮询时自动清理 stale 幽灵差异（批量决策后的即时刷新可 skipStale 跳过）；
      // 三个组件各自 5s 全量 list，stale 检查节流到 STALE_CHECK_MIN_MS 一次，
      // 避免每轮都对全部记录读文件 + 算指纹（keepall 期间多组件同时刷新的主要 host 开销）。
      if (!want && args.skipStale !== true) {
        const now = Date.now()
        if (now - (staleCheckedAt.get(sc.cwd) ?? 0) > STALE_CHECK_MIN_MS) {
          staleCheckedAt.set(sc.cwd, now)
          await autoArchiveStale(ctx, sc.session, sc.cwd, bucket)
        }
      }
      const out: RecordView[] = []
      for (const rec of bucket.values()) {
        // 面板全量查询过滤已归档；聊天条按 callId 查询保留（状态徽章仍需正确显示）
        if (!want && rec.archived) continue
        if (want && !want.has(rec.callId)) continue
        out.push(recView(rec))
      }
      out.sort((a, b) => (a.at < b.at ? -1 : 1))
      return { ok: true, records: out }
    },
    'edrv.accept': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const results = await applyDecisions(ctx, sc.session, sc.cwd, bucket, [{ callId: args.callId, scope: args.scope, hunkIndex: args.hunkIndex, decision: 'accepted' }])
      const item = results[0]
      if (!item?.ok) return { ok: false, error: item?.error ?? '操作失败' }
      return { ok: true, record: item.record! }
    },
    'edrv.reject': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const results = await applyDecisions(ctx, sc.session, sc.cwd, bucket, [{ callId: args.callId, scope: args.scope, hunkIndex: args.hunkIndex, decision: 'rejected' }])
      const item = results[0]
      if (!item?.ok) return { ok: false, error: item?.error ?? '操作失败' }
      return { ok: true, record: item.record! }
    },
    'edrv.decideBatch': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const results = await applyDecisions(ctx, sc.session, sc.cwd, bucket, Array.isArray(args.items) ? args.items : [])
      return { ok: true, results }
    },
    'edrv.read': async (args) => {
      // 全局片段文件（~/.dsh/snippets/*.code-snippets）在工作区之外：直读，不走会话 cwd 解析
      const snippetTarget = snippetTargetOf(args.path)
      if (snippetTarget && args.encoding !== 'base64') {
        try {
          const content = await readFile(snippetTarget, 'utf8')
          // 版本令牌随读带回：客户端据此判断「读后是否被外部改过」（片段文件同理）
          const info = await stat(snippetTarget).catch(() => null)
          return { ok: true, content, size: content.length, version: fileVersionOf(info) }
        } catch (error) {
          return { ok: false, error: '读取片段文件失败：' + String(error), resolvedPath: snippetTarget }
        }
      }
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const prep = await readTargetOf(ctx, sc, args.path)
      if ('err' in prep) return targetErrOf(prep)
      try {
        if (args.encoding === 'base64') {
          // 图片/PDF 等二进制预览：readBytes 无解码、无二进制拒绝；超上限已由 readTargetOf 拦截
          const bytes = await prep.fs.readBytes(prep.target, undefined, BINARY_READ_CAP)
          const content = Buffer.from(bytes).toString('base64')
          return { ok: true, content, size: bytes.byteLength, encoding: 'base64', mime: binaryMimeOf(args.path), version: String(prep.info.version ?? '') }
        }
        if ((prep.info.size ?? 0) > READ_CAP) return { ok: false, error: '文件过大（>8MB），不支持整文件预览' }
        const content = await prep.fs.readText(prep.target)
        return { ok: true, content, size: content.length, version: String(prep.info.version ?? '') }
      } catch (error) {
        return { ok: false, error: '读取失败：' + String(error) }
      }
    },
    'edrv.readBinary': async (args) => {
      // 二进制直读通道（图片/PDF 预览）：与 edrv.read base64 分支共用 readTargetOf 前置，
      // 返回 Uint8Array 信封；routes 接线后以 octet-stream + x-edrv-* 头直出，
      // 未接线时信封被 JSON 化，由 client 探测到后自动回退 base64 路径（见 shared/rpc readBinaryPreview）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const prep = await readTargetOf(ctx, sc, args.path)
      if ('err' in prep) return targetErrOf(prep)
      try {
        const bytes = await prep.fs.readBytes(prep.target, undefined, BINARY_READ_CAP)
        return {
          ok: true,
          binary: { bytes, mime: binaryMimeOf(args.path), size: bytes.byteLength, version: String(prep.info.version ?? '') },
        }
      } catch (error) {
        return { ok: false, error: '读取失败：' + String(error) }
      }
    },
    'edrv.versions': async (args) => {
      // 外部改动检测：批量返回已打开文件的磁盘版本（观察器同时失效变化的目录树）
      if (!fileVersions) return { ok: false, error: '文件版本观察器未装配' }
      return fileVersions.versions(args)
    },
    'edrv.original': async (args) => {
      // 重建"本批次修改前"内容：DiffEditor 原始侧。仅反解 pending 块；
      // 全部反解失败时回退到最早记录的整体 before（若存在）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const target = await resolveTarget(ctx, sc.session, args.path)
         debugRecord(ctx, sc.cwd, '[DEBUG path.resolve] input=' + String(args.path ?? '') + ' resolved=' + fs.processPath(target), 'debug')
        const info = await fs.stat(target)
        if (!info || info.type !== 'file') return { ok: false, error: '文件不存在' }
        if ((info.size ?? 0) > READ_CAP) return { ok: false, error: '文件过大（>8MB），不支持差异重建' }
        const content = await fs.readText(target)
        const bucket = await bucketOf(registry, ctx, sc.cwd)
        const records = [...bucket.values()].filter((r) => r.path === args.path && !r.archived).sort((a, b) => (a.at < b.at ? -1 : 1))
        if (!records.length) return { ok: true, content, size: content.length, stale: [], fallback: false }
        const rebuilt = reconstructOriginal(records, content)
        if (rebuilt.stale.length && records[0].before !== null) {
          return { ok: true, content: records[0].before, size: records[0].before.length, stale: rebuilt.stale, fallback: true }
        }
        return { ok: true, content: rebuilt.content, size: rebuilt.content.length, stale: rebuilt.stale, fallback: false }
      } catch (error) {
        return { ok: false, error: '重建失败：' + String(error) }
      }
    },
    'edrv.save': async (args) => {
      // 全局片段文件：直写（工作区外），且不进差异审查（片段变更不是 agent 编辑产物）
      const snippetTarget = snippetTargetOf(args.path)
      if (snippetTarget) {
        try {
          await writeFile(snippetTarget, args.content, 'utf8')
          return { ok: true }
        } catch (error) {
          return { ok: false, error: '保存片段文件失败：' + String(error) }
        }
      }
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const target = await resolveTarget(ctx, sc.session, args.path)
         debugRecord(ctx, sc.cwd, '[DEBUG path.resolve] input=' + String(args.path ?? '') + ' resolved=' + fs.processPath(target), 'debug')
        // 版本守卫（客户端带回上次读取的版本）：文件在读取后被外部改过则拒绝写入，
        // 避免用陈旧缓冲静默覆盖外部改动；客户端未带 rev（旧版/无版本后端）时行为不变。
        const rev = typeof args.rev === 'string' && args.rev ? args.rev : null
        const intent = rev ? { kind: 'replaceIfVersion', version: rev } : undefined
        const outcome = await fs.writeText(target, args.content, intent, void 0, policyOf(ctx, sc.session))
        await afterManualSave(ctx, registry, sc, args.path)
        return { ok: true, rev: outcome?.version ? String(outcome.version) : rev ?? undefined }
      } catch (error) {
        if (isStaleVersion(error)) {
          return { ok: false, conflict: true, error: '文件已被外部修改，请先重新加载（或用编辑器内容覆盖）' }
        }
        return { ok: false, error: '保存失败：' + String(error) }
      }
    },
    'edrv.saveBinary': async (args) => {
      if (args.encoding !== 'base64') return { ok: false, error: '仅支持 base64 编码' }
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const target = await resolveTarget(ctx, sc.session, args.path)
         debugRecord(ctx, sc.cwd, '[DEBUG path.resolve] input=' + String(args.path ?? '') + ' resolved=' + fs.processPath(target), 'debug')
        const info = await fs.stat(target)
        if (!info || info.type !== 'file') return { ok: false, error: '文件不存在' }
        // fs 服务仅提供文本写（writeText/editText），二进制回写经 node:fs 直写解析后的
        // 真实路径；以工作区边界 + 大小上限 + 用户显式保存动作三重约束兜底（对齐
        // revert.ts deleteCreated 的 contains 用法）。
        const rootTarget = await fs.resolve(policyOf(ctx, sc.session)?.workspaceRoot ?? '.', {})
        if (!fs.contains(rootTarget, target)) return { ok: false, error: '拒绝保存：目标不在会话工作区内' }
        const bytes = Buffer.from(args.content, 'base64')
        if (bytes.byteLength === 0) return { ok: false, error: '内容为空，拒绝写回' }
        if (bytes.byteLength > BINARY_READ_CAP) return { ok: false, error: '内容过大（>32MB），拒绝写回' }
        await writeFile(fs.processPath(target), bytes)
        await afterManualSave(ctx, registry, sc, args.path)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: '二进制保存失败：' + String(error) }
      }
    },
    'edrv.archiveList': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const batches = parseArchive(await readArchiveText(ctx, sc.cwd)).filter((b) => b.cwd === sc.cwd)
      const entries = batches.map((b) => {
        const recs = Array.isArray(b.records) ? b.records : []
        const sum = recs.reduce((s, r) => {
          const sm = r.summary || { accepted: 0, rejected: 0, pending: 0, superseded: false }
          s.accepted += sm.accepted || 0
          s.rejected += sm.rejected || 0
          s.pending += sm.pending || 0
          if (sm.superseded) s.superseded++
          return s
        }, { accepted: 0, rejected: 0, pending: 0, superseded: 0 })
        return { at: b.at, lastAt: b.lastAt || b.at, path: b.path, batch: b.batch ?? null, reason: b.reason ?? null, nRecords: recs.length, summary: sum }
      })
      entries.sort((a, b) => (Number(b.batch ?? -1) - Number(a.batch ?? -1)) || (a.at < b.at ? 1 : -1))
      return { ok: true, entries }
    },
    'edrv.archiveRead': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const batchPath = args.path
      const batches = parseArchive(await readArchiveText(ctx, sc.cwd)).filter((b) => b.cwd === sc.cwd && (!batchPath || b.path === batchPath))
      return { ok: true, batches }
    },
    'edrv.rollback': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      const batch = args.batch
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      let affected: DiffRecord[] = []
      let beforeRec: DiffRecord | null = null
      if (batch !== undefined) {
        const all = parseArchive(await readArchiveText(ctx, sc.cwd)).filter((b) => b.cwd === sc.cwd && b.path === args.path)
        const recs: DiffRecord[] = []
        for (const b of all) if (b.batch === batch) for (const r of (b.records || [])) recs.push(r as unknown as DiffRecord)
        if (!recs.length) return { ok: false, error: '归档中找不到该批次' }
        recs.sort((a, b2) => (a.at < b2.at ? -1 : 1))
        beforeRec = recs[0]
        affected = recs
      } else {
        for (const r of bucket.values()) if (r.path === args.path && !r.archived) affected.push(r)
        if (!affected.length) return { ok: false, error: '该文件没有可回滚的差异' }
        affected.sort((a, b2) => (a.at < b2.at ? -1 : 1))
        beforeRec = affected[0]
      }
      const rerr = await restoreFile(ctx, sc.session, beforeRec)
      if (rerr) return { ok: false, error: rerr }
      if (batch === undefined) {
        await archiveRecords(ctx, sc.session, sc.cwd, bucket, affected, '已回滚')
      } else {
        const all = parseArchive(await readArchiveText(ctx, sc.cwd)).filter((b) => b.cwd === sc.cwd && b.path === args.path && b.batch === batch)
        const sumRecs = all.reduce((s, b) => s + ((b.records || []).length), 0)
        const logRec = Object.assign({}, affected[0], { note: (affected[0].note ? affected[0].note + '；' : '') + '回滚至本批次前（批次 ' + batch + '）' })
        await appendArchiveEntries(ctx, sc.cwd, [archiveEntryFor([logRec], sc.cwd, '已回滚（批次 ' + batch + '，' + sumRecs + ' 条）')], sc.session)
        // 批次回滚恢复的是旧内容，文件当前活跃差异已失效，一并归档
        const activeRecs: DiffRecord[] = []
        for (const r of bucket.values()) if (r.path === args.path && !r.archived) activeRecs.push(r)
        if (activeRecs.length) await archiveRecords(ctx, sc.session, sc.cwd, bucket, activeRecs, '已回滚（批次回滚覆盖）')
      }
      return { ok: true, path: args.path, batch: batch ?? null }
    },
    'edrv.debug': async (args) => {
      // 诊断日志：client 上报 → debugLog 模块缓冲批量落盘 ~/.dsh/dsh-vscode-mode/logs/
      // （console 不一定落盘，文件可靠）。只出现在调试开关开启时（client dbg 默认关）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      debugRecord(ctx, sc.cwd, String(args.text ?? ''), args.level)
      return { ok: true }
    },
    'edrv.dlog.list': async (args) => {
      // 诊断日志清单：日志根下全部 debug.*.log + 当前会话对应文件名（可能尚不存在）
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const files = await listDebugLogs()
      const current = basename(debugLogFile(sc.cwd))
      return { ok: true, root: pluginLogRoot(), files, current }
    },
    'edrv.dlog.read': async (args) => {
      // 尾部读取：file 缺省读当前会话那份；maxBytes 夹取 [1KB, 512KB]
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const name = isDebugLogName(args.file) ? args.file : basename(debugLogFile(sc.cwd))
      const maxBytes = Math.min(Math.max(args.maxBytes ?? 256 * 1024, 1024), 512 * 1024)
      const read = await readDebugLog(name, maxBytes)
      if (!read) return { ok: false, error: '日志不存在：' + name + '（开启诊断日志并触发一次操作后生成）' }
      return { ok: true, ...read }
    },
    'edrv.dlog.clear': async (args) => {
      // 清空：file 缺省清当前会话那份；白名单外直接拒绝
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const name = isDebugLogName(args.file) ? args.file : basename(debugLogFile(sc.cwd))
      const cleared = await clearDebugLog(name)
      if (!cleared) return { ok: false, error: '清空失败：日志不存在或名字非法' }
      return { ok: true, name }
    },
    'edrv.dlog.reveal': async () => {
      // 打开日志根目录（OS 文件管理器；目录形态 → 直接打开）
      const revealed = await revealInExplorer(pluginLogRoot(), true)
      if (!revealed.ok) return { ok: false, error: revealed.error }
      return { ok: true, opened: true }
    },
    'edrv.searchFiles': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bucket = await bucketOf(registry, ctx, sc.cwd)
      const activePaths: string[] = []
      for (const record of bucket.values()) if (record.path) activePaths.push(record.path)
      const result = await searcher.search({ session: sc.session, cwd: sc.cwd, query: args.query, activePaths })
      return { ok: true, ...result }
    },
    'edrv.searchContent': async (args) => {
      // 工作区内容搜索：rg --json 主路径；provider 失败转错误响应（无 fallback）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const result = await contentSearcher.search({
          session: sc.session,
          cwd: sc.cwd,
          query: args.query,
          matchCase: args.matchCase,
          wholeWord: args.wholeWord,
          regex: args.regex,
          maxResults: args.maxResults,
          include: args.include,
          exclude: args.exclude,
        })
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: '搜索失败：' + String(error) }
      }
    },
    'edrv.listDir': async (args) => {
      // 目录树（侧边栏文件管理用）：树索引命中直出（内存，0 IO）；失效/force 时
      // 走快路径（resolve + listDirCheap + putIndex）；同路径在途请求去重复用。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const rel = normalizeRel(args.path)
      if (rel === null) return { ok: false, error: '路径不合法' }
      const res = await listDirCached(ctx, sc.cwd, rel, args.force === true)
      if ('error' in res) return { ok: false, error: res.error }
      return { ok: true, root: res.root, path: rel, entries: res.entries }
    },
    'edrv.revealInExplorer': async (args) => {
      // 在 OS 文件浏览器中打开/定位路径（树行/编辑器右键菜单用），相对工作区解析。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const rel = normalizeRel(args.path)
        if (rel === null) return { ok: false, error: '路径不合法' }
        const target = await fs.resolve(rel || '.', { cwd: sc.cwd })
        const info = await fs.stat(target)
        if (!info) return { ok: false, error: '路径不存在' }
        const abs = fs.processPath(target)
        const outcome = await revealInExplorer(abs, info.type === 'directory')
        if (!outcome.ok) return { ok: false, error: outcome.error }
        return { ok: true, revealed: abs }
      } catch (error) {
        return { ok: false, error: '打开失败：' + String(error) }
      }
    },
    'edrv.fsCreateFile': async (args) => {
      // 新建文件（资源管理器右键「新建文件…」）：空内容独占创建（同名拒绝），
      // 名称可含 a/b.c 嵌套段（父目录按需创建）；名称校验与客户端弹窗共用 shared/fsNames。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bad = checkNewName(args.path)
      if (bad) return { ok: false, error: bad }
      const r = await fsOpsTarget(ctx, sc.session, args.path)
      if ('err' in r) return { ok: false, error: r.err }
      try {
        await mkdir(dirname(r.abs), { recursive: true })
        await writeFile(r.abs, '', { flag: 'wx' })
      } catch (error) {
        const code = fsErrCode(error)
        return { ok: false, error: code === 'EEXIST' ? '已存在同名文件或目录' : '新建文件失败：' + String(error) }
      }
      invalidateIndex(ctx, sc.cwd, args.path)
      return { ok: true, path: args.path }
    },
    'edrv.fsCreateDir': async (args) => {
      // 新建文件夹（资源管理器右键「新建文件夹」）：名称可含嵌套段（父目录按需创建），已存在拒绝。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bad = checkNewName(args.path)
      if (bad) return { ok: false, error: bad }
      const r = await fsOpsTarget(ctx, sc.session, args.path)
      if ('err' in r) return { ok: false, error: r.err }
      try {
        await mkdir(dirname(r.abs), { recursive: true })
        await mkdir(r.abs)
      } catch (error) {
        const code = fsErrCode(error)
        return { ok: false, error: code === 'EEXIST' ? '已存在同名文件或目录' : '新建文件夹失败：' + String(error) }
      }
      invalidateIndex(ctx, sc.cwd, args.path)
      return { ok: true, path: args.path }
    },
    'edrv.fsRename': async (args) => {
      // 重命名（仅名称段、同父目录内）：目标已存在拒绝；名称未变化按幂等成功返回。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const bad = checkRenameName(args.newName)
      if (bad) return { ok: false, error: bad }
      const fromRel = normalizeRel(args.path)
      if (fromRel === null || fromRel === '') return { ok: false, error: '路径不合法' }
      const toRel = joinRelPath(parentRelOf(fromRel), args.newName)
      if (toRel === fromRel) return { ok: true, from: fromRel, to: fromRel }
      const src = await fsOpsTarget(ctx, sc.session, fromRel)
      if ('err' in src) return { ok: false, error: src.err }
      const dst = await fsOpsTarget(ctx, sc.session, toRel)
      if ('err' in dst) return { ok: false, error: dst.err }
      if (!(await stat(src.abs).catch(() => null))) return { ok: false, error: '源不存在' }
      try {
        await rename(src.abs, dst.abs)
      } catch (error) {
        const code = fsErrCode(error)
        const exists = code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM'
        return { ok: false, error: exists ? '已存在同名文件或目录' : '重命名失败：' + String(error) }
      }
      invalidateIndex(ctx, sc.cwd, fromRel)
      invalidateIndex(ctx, sc.cwd, toRel)
      return { ok: true, from: fromRel, to: toRel }
    },
    'edrv.fsDelete': async (args) => {
      // 删除（文件/文件夹递归；「删除/永久删除」共用）：根拒绝；破坏性由客户端确认框把关。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const rel = normalizeRel(args.path)
      if (rel === null || rel === '') return { ok: false, error: '路径不合法' }
      const r = await fsOpsTarget(ctx, sc.session, rel)
      if ('err' in r) return { ok: false, error: r.err }
      try {
        await rm(r.abs, { recursive: true })
      } catch (error) {
        return { ok: false, error: '删除失败：' + String(error) }
      }
      invalidateIndex(ctx, sc.cwd, rel)
      return { ok: true, path: rel }
    },
    'edrv.fsCopy': async (args) => {
      // 复制到目标目录（文件/文件夹递归）：同名拒绝覆盖（细节见 fsTransfer）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const r = await fsTransfer(ctx, sc, args, 'copy')
      if ('err' in r) return { ok: false, error: r.err }
      return { ok: true, from: r.from, to: r.to }
    },
    'edrv.fsMove': async (args) => {
      // 移动到目标目录（文件/文件夹）：同名拒绝覆盖（细节见 fsTransfer）。
      const sc = await requireSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const r = await fsTransfer(ctx, sc, args, 'move')
      if ('err' in r) return { ok: false, error: r.err }
      return { ok: true, from: r.from, to: r.to }
    },
    'mcp.list': async () => ({ ok: true, ...listMcp(ctx) }),
    'mcp.save': async (args) => {
      try { return { ok: true, server: await saveMcp(ctx, args.config) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.remove': async (args) => {
      try { await removeMcp(ctx, args.id); return { ok: true } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.toggle': async (args) => {
      try { return { ok: true, server: await toggleMcp(ctx, args.id, args.enabled) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.refresh': async (args) => {
      try { return { ok: true, server: await refreshMcp(ctx, args.id) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projects': async () => {
      try { return { ok: true, ...await listProjects(ctx) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectSave': async (args) => {
      try { return { ok: true, project: await projectSave(ctx, args.workspacePath, args.serverName, args.config) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectRemove': async (args) => {
      try { return { ok: true, project: await projectRemove(ctx, args.workspacePath, args.serverName) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectToggle': async (args) => {
      try { return { ok: true, project: await projectToggle(ctx, args.workspacePath, args.serverName, args.enabled) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'mcp.projectRefresh': async (args) => {
      try { return { ok: true, project: await projectRefresh(ctx, args.workspacePath, args.serverName) } }
      catch (error) { return { ok: false, error: String(error) } }
    },
    'vscode.fileOpenSettingsGet': async () => {
      const settings = ctx.get('settings')
      const section = sectionOf(settings, FILE_OPEN_SETTINGS_NS)
      const value = section?.value as { fileOpenTool?: unknown } | undefined
      return { ok: true, fileOpenTool: normalizeFileOpenTool(value?.fileOpenTool ?? FILE_OPEN_DEFAULT), integrationBaseUrl: await integrationBaseUrlOf(ctx), revision: section?.revision }
    },
    'vscode.fileOpenSettingsUpdate': async (args) => {
      const settings = ctx.get('settings')
      const patch: Record<string, unknown> = { fileOpenTool: normalizeFileOpenTool(args.fileOpenTool) }
      if (typeof args.integrationBaseUrl === 'string' && args.integrationBaseUrl.trim()) patch.integrationBaseUrl = args.integrationBaseUrl.trim()
      // 冲突自愈（0.1.7 SettingsConflictError 重读重试一次）与形状校验读取统一走 fileOpenSettings 工具
      const result = await updateSection(settings, FILE_OPEN_SETTINGS_NS, patch, args.expectedRevision)
      if (!result.ok) return { ok: false, error: result.error ?? '设置服务不可用' }
      const section = sectionOf(settings, FILE_OPEN_SETTINGS_NS)
      const value = section?.value as { fileOpenTool?: unknown } | undefined
      return { ok: true, fileOpenTool: normalizeFileOpenTool(value?.fileOpenTool), integrationBaseUrl: await integrationBaseUrlOf(ctx), revision: section?.revision }
    },
    'compat': async () => ({ ok: true, report: await buildReport(ctx) }),
    'vscode.devFormGet': async () => ({ ok: true, devForm: readDevForm() }),
    'vscode.devFormSet': async (args) => {
      try {
        const result = await setDevForm(ctx, args.enabled === true, args.path)
        if (!result.ok) return { ok: false, error: result.error ?? '切换开发形态失败' }
        return { ok: true, devForm: readDevForm(), restart: result.restart }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'edrv.integration.status': async () => {
      try {
        return { ok: true, ...(await shellMenuStatus(ctx, await integrationBaseUrlOf(ctx))) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'edrv.integration.register': async () => {
      try {
        return { ok: true, ...(await shellMenuRegister(ctx, await integrationBaseUrlOf(ctx))) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'edrv.integration.unregister': async () => {
      try {
        return { ok: true, ...(await shellMenuRemove(ctx, await integrationBaseUrlOf(ctx))) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'edrv.unity.list': async () => {
      try {
        return { ok: true, ...(await unityList()) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'edrv.unity.add': async (args) => {
      try {
        return { ok: true, project: await unityAdd(args.path) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'edrv.unity.remove': async (args) => {
      try {
        await unityRemove(args.path)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'edrv.unity.install': async (args) => {
      try {
        return { ok: true, project: await unityInstall(args.path) }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'edrv.externalStat': async (args) => {
      // 深链判型（无会话依赖）：绝对路径直过 resolve；缺失/其他类型归入 missing
      const fs = ctx.get('fs')
      if (!fs) return { ok: false, error: '缺少 fs' }
      try {
        const target = await fs.resolve(args.path)
        const info = await fs.stat(target)
        if (!info || info.type === 'other') return { ok: true, kind: 'missing' }
        return { ok: true, kind: info.type === 'directory' ? 'directory' : 'file' }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    },
    'edrv.external.handoff': async (args) => ({
      ok: true,
      ...handoffOpen({ paths: args.paths, line: args.line, column: args.column }),
    }),
    'edrv.external.pending': async () => ({ ok: true, open: pollPending() }),
    'edrv.external.pendingState': async (args) => ({
      ok: true,
      delivered: pendingState(args.token, args.take === true).delivered,
    }),
    'edrv.perf.inventory': async () => {
      try {
        const home = dshHome()
        const inventory = await scanSessionInventory(home, sessionsArchiveRoot(home))
        const active = activeSessionIds(ctx)
        markActiveSessions(inventory.sessions, active)
        markOfficialFlags(inventory.sessions, ctx)
        return { ok: true, ...inventory, activeIds: [...active] }
      } catch (error) {
        return { ok: false, error: '盘点失败：' + String(error) }
      }
    },
    'edrv.perf.sessionSize': async (args) => {
      try {
        const size = await sessionSizeOf(dshHome(), args.cwd, args.sessionId ?? '')
        return { ok: true, ...size }
      } catch (error) {
        return { ok: false, error: '读取会话体积失败：' + String(error) }
      }
    },
    'edrv.perf.movePlan': async (args) => {
      try {
        const home = dshHome()
        const inventory = await scanSessionInventory(home, sessionsArchiveRoot(home))
        markActiveSessions(inventory.sessions, activeSessionIds(ctx))
        const plan = planMoveOut(inventory, { workspaceKey: args.workspaceKey, sessionIds: args.sessionIds, minBytes: args.minBytes, olderThanDays: args.olderThanDays })
        return { ok: true, ...plan }
      } catch (error) {
        return { ok: false, error: '移出规划失败：' + String(error) }
      }
    },
    'edrv.perf.moveOut': async (args) => {
      try {
        const home = dshHome()
        const items = (args.sessionIds ?? []).map((sessionId) => ({ workspaceKey: args.workspaceKey, sessionId, bytes: 0 }))
        const result = await moveOutSessions(home, sessionsArchiveRoot(home), items, activeSessionIds(ctx), args.dryRun === true)
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: '移出失败：' + String(error) }
      }
    },
    'edrv.perf.restore': async (args) => {
      try {
        const result = await restoreSession(dshHome(), sessionsArchiveRoot(dshHome()), args.workspaceKey, args.sessionId)
        if (!result.ok) return { ok: false, error: result.error ?? '恢复失败' }
        // 目录搬回后对齐官方归档标志（best-effort：服务缺失/调用失败不影响恢复结果，见 perf.unarchiveOfficial）
        await unarchiveOfficial(ctx, args.sessionId)
        return { ok: true, restored: true }
      } catch (error) {
        return { ok: false, error: '恢复失败：' + String(error) }
      }
    },
    'edrv.perf.purgeArchive': async (args) => {
      try {
        const result = await purgeArchive(sessionsArchiveRoot(dshHome()), args.olderThanDays)
        return { ok: true, ...result }
      } catch (error) {
        return { ok: false, error: '清除失败：' + String(error) }
      }
    },
    'edrv.perf.sidecarSummary': async (args) => {
      const sc = await requireSession(ctx, args.sessionId)
      const cwd = 'err' in sc ? null : sc.cwd
      try {
        const summary = await sidecarSummaryOf(ctx, cwd)
        return { ok: true, ...summary }
      } catch (error) {
        return { ok: false, error: '读取侧车摘要失败：' + String(error) }
      }
    },
    'edrv.perf.configGet': async () => {
      try {
        const { profileDir, patchPath } = await patchFileInfo()
        const block = perfConfigBlock()
        if (!patchPath) return { ok: true, applied: false, block }
        const text = await readFile(patchPath, 'utf8').catch(() => '')
        const backup = await latestPatchBackup(patchPath)
        return { ok: true, profileDir, patchPath, applied: patchHasPerfConfig(text), block, backup }
      } catch (error) {
        return { ok: false, error: '读取压缩配置失败：' + String(error) }
      }
    },
    'edrv.perf.configApply': async () => {
      try {
        const { patchPath } = await patchFileInfo()
        if (!patchPath) return { ok: false, error: '未找到依赖本插件的 profile（检查 DSH_HOME/profiles）' }
        const text = await readFile(patchPath, 'utf8').catch(() => '')
        const backup = patchPath + '.bak-' + Date.now()
        if (text) await writeFile(backup, text, 'utf8')
        await mkdir(join(patchPath, '..'), { recursive: true })
        await writeFile(patchPath, patchInsertPerfConfig(text), 'utf8')
        return { ok: true, applied: true, backup, restart: true }
      } catch (error) {
        return { ok: false, error: '写入压缩配置失败：' + String(error) }
      }
    },
    'edrv.perf.configUndo': async () => {
      try {
        const { patchPath } = await patchFileInfo()
        if (!patchPath) return { ok: false, error: '未找到依赖本插件的 profile（检查 DSH_HOME/profiles）' }
        const backup = await latestPatchBackup(patchPath)
        if (backup) {
          const backupPath = join(join(patchPath, '..'), backup)
          const saved = await readFile(backupPath, 'utf8').catch(() => null)
          if (saved !== null) {
            await writeFile(patchPath, saved, 'utf8')
            await rm(backupPath, { force: true }).catch(() => {})
            return { ok: true, restored: true, backup }
          }
        }
        const text = await readFile(patchPath, 'utf8').catch(() => '')
        if (!patchHasPerfConfig(text)) return { ok: false, error: '没有可撤销的压缩配置' }
        await writeFile(patchPath, patchRemovePerfConfig(text), 'utf8')
        return { ok: true, restored: true }
      } catch (error) {
        return { ok: false, error: '撤销压缩配置失败：' + String(error) }
      }
    },
    'rules.list': async () => {
      try {
        return { ok: true, ...(await rulesList(ctx)) }
      } catch (error) {
        return { ok: false, error: '读取规则失败：' + String(error) }
      }
    },
    'rules.read': async (args) => {
      try {
        return { ok: true, content: await rulesRead(ctx, args) }
      } catch (error) {
        return { ok: false, error: '读取规则失败：' + String(error) }
      }
    },
    'rules.save': async (args) => {
      try {
        return { ok: true, rule: await rulesSave(ctx, args) }
      } catch (error) {
        return { ok: false, error: '保存规则失败：' + String(error) }
      }
    },
    'rules.remove': async (args) => {
      try {
        await rulesRemove(ctx, args)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: '删除规则失败：' + String(error) }
      }
    },
    'rules.toggle': async (args) => {
      try {
        return { ok: true, rule: await rulesToggle(ctx, args, args.enabled === true) }
      } catch (error) {
        return { ok: false, error: '切换规则失败：' + String(error) }
      }
    },
    'snippets.list': async () => {
      try {
        return { ok: true, ...(await snippetsList(ctx)) }
      } catch (error) {
        return { ok: false, error: '读取代码片段失败：' + String(error) }
      }
    },
    'snippets.read': async (args) => {
      try {
        return { ok: true, content: await snippetsRead(ctx, args) }
      } catch (error) {
        return { ok: false, error: '读取代码片段失败：' + String(error) }
      }
    },
    'snippets.save': async (args) => {
      try {
        return { ok: true, file: await snippetsSave(ctx, args) }
      } catch (error) {
        return { ok: false, error: '保存代码片段失败：' + String(error) }
      }
    },
    'snippets.remove': async (args) => {
      try {
        await snippetsRemove(ctx, args)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: '删除代码片段失败：' + String(error) }
      }
    },
    'snippets.entries': async (args) => {
      try {
        // 当前会话工作区用于叠加项目片段；会话缺失时仅返回全局片段（不报错，补全仍可用）
        const sc = await requireSession(ctx, args.sessionId)
        const cwd = 'err' in sc ? undefined : sc.cwd
        return { ok: true, ...(await snippetsEntries(ctx, cwd)) }
      } catch (error) {
        return { ok: false, error: '读取代码片段条目失败：' + String(error) }
      }
    },
  }
}

/**
 * 统一入口：按方法分发到 handler 表。
 * @author ddj 2026年08月20号 / 2026年08月26号
 */
export async function handleRpc<M extends RpcMethod>(
  ctx: Ctx,
  registry: Registry,
  method: M,
  args: RpcRequestMap[M],
  searcher = newSearcher(ctx),
  contentSearcher = newContentSearcher(ctx),
  lspHandlers?: Partial<RpcHandlerMap>,
  aiHandlers?: Partial<RpcHandlerMap>,
  fileVersions?: FileVersions,
  svnHandlers?: Partial<RpcHandlerMap>,
  dapHandlers?: Partial<RpcHandlerMap>,
): Promise<RpcResult<M>> {
  const handlers = buildHandlers(ctx, registry, searcher, contentSearcher, lspHandlers, aiHandlers, fileVersions, svnHandlers, dapHandlers)
  const handler = handlers[method]
  if (!handler) return { ok: false, error: '未知方法: ' + String(method) } as RpcResult<M>
  return handler(args)
}
