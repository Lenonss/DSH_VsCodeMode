/**
 * dsh-vscode-mode client — 深链打开规则引擎（资源管理器右键 / Unity 外部编辑器落地）。
 * 规则：文件夹 ⊂ 某已注册工作区 → 页面内弹窗二选一（使用最近的工作区 / 新建工作区）；
 * 文件夹不在任何工作区 → 直达最近对话所在工作区新增；文件 → 最近对话 + 编辑器展开
 * （无任何会话 → 以文件父目录注册工作区引导创建）。首路径驱动规则，其余路径：文件进
 * 编辑器、文件夹补引用。纯函数可单测；编排依赖经 OpenDeps 注入（mock 可测）。
 * 作者 ddj 2026-09-07
 */
import { rpc } from './rpc.js'
import { chooseWorkspace } from './chooseDialog.js'
import { emitOpenAt, openEditorView } from './events.js'
import { toastDom } from './externalOpen.js'
import { createAddToConversation } from './addToConversation.js'
import type { AddOutcome, CtxLike } from './addToConversation.js'
import type { OpenParams } from '../shared/externalOpen.js'

/** 路径类型（host edrv.externalStat 判定）。 */
export type PathKind = 'file' | 'directory' | 'missing'

/** 打开规则分派结果。 */
export type OpenRule = 'choose' | 'folderNew' | 'fileRecent' | 'bootstrap' | 'abort'

/** 工作区视图最小形状（ctx.workspaces.list 快照行）。 */
export interface WsView {
  workspaceId: string
  path: string
  title: string
  sessionIds?: readonly string[]
  updatedAt?: string
}

/** 会话行最小形状（ctx.sessions.list 快照行）。 */
export interface SessionRow {
  id: string
  cwd?: string
  updatedAt?: number
  origin?: 'subagent'
}

/** 打开编排依赖（全部可注入，便于 mock 测试）。 */
export interface OpenDeps {
  stat(path: string): Promise<PathKind>
  workspaces(): { items: WsView[]; ready: boolean }
  sessions(): { ids: string[]; byId: Record<string, SessionRow>; ready: boolean }
  createSession(opts: { workspaceId?: string; cwd?: string }): Promise<string>
  createWorkspace(path: string): Promise<{ workspaceId: string; title: string }>
  openSession(id: string): void
  reference(sessionId: string, path: string, appearance: 'file' | 'folder'): Promise<boolean>
  choose(title: string, folder: string): Promise<'recent' | 'create' | null>
  openEditor(path: string | null, line?: number, column?: number): void
  schedule(fn: () => void, ms: number): void
  notify(text: string): void
}

/** 等列表/输入就绪的节奏。 */
const READY_TIMEOUT_MS = 15000
const READY_TICK_MS = 300
const REF_RETRY_MAX = 20
const REF_RETRY_MS = 300
const REST_STEP_MS = 150
const LINE_AT_DELAY_MS = 200

/**
 * 路径规范化：`\→/`、小写、去尾分隔符（Windows 大小写不敏感前缀匹配用）。
 * @author ddj 2026年09月07号
 */
export function normPath(p: string): string {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 目录包含判定：child === root 或 child 位于 root 之下。
 * @author ddj 2026年09月07号
 */
export function containsPath(root: string, child: string): boolean {
  const r = normPath(root)
  const c = normPath(child)
  return c === r || c.startsWith(r + '/')
}

/**
 * 父目录（文件引导创建工作区用；根路径回退自身）。
 * @author ddj 2026年09月07号
 */
export function dirnameOf(p: string): string {
  const norm = String(p ?? '').replace(/[\\/]+$/, '')
  const cut = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return cut > 0 ? norm.slice(0, cut) : norm
}

/**
 * 最近一次对话：排除子代理行，updatedAt 最新优先。
 * @author ddj 2026年09月07号
 */
export function recentSession(byId: Record<string, SessionRow>, ids?: string[]): SessionRow | undefined {
  const rows = (ids ?? Object.keys(byId)).map((id) => byId[id]).filter((row) => row && row.origin !== 'subagent')
  return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
}

/**
 * 文件夹命中的已注册工作区（前缀包含），updatedAt 新者优先。
 * @author ddj 2026年09月07号
 */
export function matchWorkspaces(items: WsView[], folder: string): WsView[] {
  return items.filter((ws) => containsPath(ws.path, folder))
}

/**
 * 规则分派：目录+命中工作区 → choose；目录未命中 → folderNew（以该文件夹为根注册新工作区，
 * 用户确认：一律取右键的文件夹本身）；文件有会话 → fileRecent；文件无会话 → bootstrap；
 * 路径缺失 → abort。
 * @author ddj 2026年09月08号
 */
export function pickRule(kind: PathKind, matched: boolean, hasSession: boolean): OpenRule {
  if (kind === 'missing') return 'abort'
  if (kind === 'directory') return matched ? 'choose' : 'folderNew'
  return hasSession ? 'fileRecent' : 'bootstrap'
}

/**
 * 深链打开编排入口：等列表就绪 → 判型 → 规则分派 → 编排 create/open/引用/编辑器。
 * @author ddj 2026年09月07号
 * @param ctx 客户端根上下文（sessions/workspaces 服务）
 * @param params 深链参数（首路径驱动规则）
 * @param overrides 依赖覆盖（测试注入）
 */
export async function openDeepLink(ctx: unknown, params: OpenParams, overrides: Partial<OpenDeps> = {}): Promise<void> {
  const deps = realDeps(ctx, overrides)
  if (!(await waitListsReady(deps))) {
    deps.notify('DSH 会话列表未就绪，请稍后重试')
    return
  }
  const primary = params.paths[0]
  const kind = await deps.stat(primary).catch(() => 'missing' as PathKind)
  const sess = deps.sessions()
  const rule = pickRule(kind, matchWorkspaces(deps.workspaces().items, primary).length > 0, Boolean(recentSession(sess.byId, sess.ids)))
  try {
    if (rule === 'abort') {
      deps.notify('路径不存在：' + primary)
      return
    }
    if (rule === 'choose') return await runChoose(deps, primary, params)
    if (rule === 'folderNew') return await runFolderNew(deps, primary, params)
    if (rule === 'fileRecent') return await runFileRecent(deps, primary, params)
    return await runFileBootstrap(deps, primary, params)
  } catch (error) {
    deps.notify('打开失败：' + String((error as Error)?.message ?? error))
  }
}

/** 等待会话与工作区列表就绪（上限 15s；超时按当前态判定）。 */
async function waitListsReady(deps: OpenDeps): Promise<boolean> {
  for (let waited = 0; waited < READY_TIMEOUT_MS; waited += READY_TICK_MS) {
    if (deps.sessions().ready && deps.workspaces().ready) return true
    await sleep(deps, READY_TICK_MS)
  }
  return deps.sessions().ready && deps.workspaces().ready
}

/** 规则 1：命中工作区 → 弹窗分派（取消即中止）。 */
async function runChoose(deps: OpenDeps, folder: string, params: OpenParams): Promise<void> {
  const matches = matchWorkspaces(deps.workspaces().items, folder)
  const best = bestMatch(deps, matches)
  const choice = await deps.choose(best?.title ?? '工作区', folder)
  if (choice === null) return
  if (choice === 'create') return runFolderNew(deps, folder, params)
  const ws = best ?? deps.workspaces().items[0]
  const sessionId = await spawnInWorkspace(deps, ws.workspaceId, undefined)
  await settleRef(deps, sessionId, folder, 'folder')
  deps.openEditor(null)
  await openRest(deps, sessionId, params, 1)
}

/** 规则 3a：文件 → 所属工作区优先（有会话打开其最近会话；无会话新建 + 文件引用）；无匹配 → 最近对话。 */
async function runFileRecent(deps: OpenDeps, file: string, params: OpenParams): Promise<void> {
  const ws = pickFileWorkspace(deps, file)
  if (ws) {
    const anchor = recentSessionIn(deps, ws)
    if (anchor) {
      deps.openSession(anchor.id)
      deps.openEditor(file, params.line, params.column)
      await openRest(deps, anchor.id, params, 1)
      return
    }
    // 文件所属工作区存在但无会话 → 在该工作区新建对话 + 文件引用
    const sessionId = await spawnInWorkspace(deps, ws.workspaceId, undefined)
    await settleRef(deps, sessionId, file, 'file')
    deps.openEditor(file, params.line, params.column)
    await openRest(deps, sessionId, params, 1)
    return
  }
  const anchor = recentSession(deps.sessions().byId, deps.sessions().ids)
  if (!anchor) return runFileBootstrap(deps, file, params)
  deps.openSession(anchor.id)
  deps.openEditor(file, params.line, params.column)
  await openRest(deps, anchor.id, params, 1)
}

/**
 * 文件所属工作区：前缀命中的工作区里，优先取有会话且最近活跃的；都无会话取路径最具体的。
 * @author ddj 2026年09月08号
 */
function pickFileWorkspace(deps: OpenDeps, file: string): WsView | undefined {
  const matches = matchWorkspaces(deps.workspaces().items, file)
  if (!matches.length) return undefined
  const withSessions = matches.filter((ws) => (ws.sessionIds ?? []).some((id) => Boolean(deps.sessions().byId[id])))
  if (!withSessions.length) {
    return [...matches].sort((a, b) => normPath(b.path).length - normPath(a.path).length)[0]
  }
  return withSessions.sort((a, b) => latestSessionAt(deps, b) - latestSessionAt(deps, a))[0]
}

/** 工作区内会话的最近活跃时间（无成员 → 0）。 */
function latestSessionAt(deps: OpenDeps, ws: WsView): number {
  const byId = deps.sessions().byId
  return (ws.sessionIds ?? []).reduce((max, id) => Math.max(max, byId[id]?.updatedAt ?? 0), 0)
}

/** 工作区内最近一次会话（排除子代理与不在列表中的陈旧行）。 */
function recentSessionIn(deps: OpenDeps, ws: WsView): SessionRow | undefined {
  const byId = deps.sessions().byId
  const rows = (ws.sessionIds ?? []).map((id) => byId[id]).filter((row) => row && row.origin !== 'subagent')
  return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
}

/** 规则 3b：文件 + 无任何会话 → 父目录注册工作区 + 新对话 + 文件引用 + 编辑器打开。 */
async function runFileBootstrap(deps: OpenDeps, file: string, params: OpenParams): Promise<void> {
  const ws = await deps.createWorkspace(dirnameOf(file))
  const sessionId = await spawnInWorkspace(deps, ws.workspaceId, undefined)
  await settleRef(deps, sessionId, file, 'file')
  deps.openEditor(file, params.line, params.column)
  await openRest(deps, sessionId, params, 1)
}

/** 规则 1.2：以文件夹注册新工作区 + 新对话 + 文件夹引用 + 编辑页。 */
async function runFolderNew(deps: OpenDeps, folder: string, params: OpenParams): Promise<void> {
  const ws = await deps.createWorkspace(folder)
  const sessionId = await spawnInWorkspace(deps, ws.workspaceId, undefined)
  await settleRef(deps, sessionId, folder, 'folder')
  deps.openEditor(null)
  await openRest(deps, sessionId, params, 1)
}

/** 在指定工作区（或回退 cwd）新建对话并置为当前；返回新会话 id。 */
async function spawnInWorkspace(deps: OpenDeps, workspaceId: string | undefined, fallbackCwd: string | undefined): Promise<string> {
  const sessionId = await deps.createSession(workspaceId ? { workspaceId } : fallbackCwd ? { cwd: fallbackCwd } : {})
  deps.openSession(sessionId)
  return sessionId
}

/** 命中工作区集中「最近」的一个（其成员会话 updatedAt 最新者优先）。 */
function bestMatch(deps: OpenDeps, matches: WsView[]): WsView | undefined {
  const byId = deps.sessions().byId
  const score = (ws: WsView): number => {
    const sessionLatest = (ws.sessionIds ?? []).reduce((max, id) => Math.max(max, byId[id]?.updatedAt ?? 0), 0)
    return Math.max(sessionLatest, Date.parse(ws.updatedAt ?? '') || 0)
  }
  return [...matches].sort((a, b) => score(b) - score(a))[0]
}

/** 引用插入轮询：输入门面就绪前每 300ms 重试（appendReference 忙态已降级视为成功）。 */
async function settleRef(deps: OpenDeps, sessionId: string, path: string, appearance: 'file' | 'folder'): Promise<void> {
  for (let attempt = 0; attempt < REF_RETRY_MAX; attempt++) {
    if (await deps.reference(sessionId, path, appearance)) return
    await sleep(deps, REF_RETRY_MS)
  }
}

/** 其余路径：文件进编辑器（步进），文件夹补文件夹引用。 */
async function openRest(deps: OpenDeps, sessionId: string | null, params: OpenParams, from: number): Promise<void> {
  const rest = params.paths.slice(from)
  for (const [index, path] of rest.entries()) {
    const kind = await deps.stat(path).catch(() => 'missing' as PathKind)
    if (kind === 'file') {
      deps.schedule(() => deps.openEditor(path), REST_STEP_MS * (index + 1))
    } else if (kind === 'directory' && sessionId) {
      await settleRef(deps, sessionId, path, 'folder')
    }
  }
}

/** 可注入 sleep。 */
function sleep(deps: OpenDeps, ms: number): Promise<void> {
  return new Promise((resolve) => deps.schedule(resolve, ms))
}

/** 真实依赖装配（全部来自 ctx 注入服务 + 既有 RPC/弹窗/编辑器入口）。 */
function realDeps(ctx: unknown, overrides: Partial<OpenDeps> = {}): OpenDeps {
  const service = (name: string): any => {
    const get = (ctx as { get?: (name: string) => unknown } | undefined)?.get
    return typeof get === 'function' ? get.call(ctx, name) : undefined
  }
  const add = createAddToConversation(ctx as CtxLike)
  const base: OpenDeps = {
    stat: async (path) => {
      const result = await rpc('edrv.externalStat', { path })
      return result.ok ? result.kind : 'missing'
    },
    workspaces: () => {
      const snap = (service('workspaces')?.list?.getSnapshot?.() ?? {}) as { items?: WsView[]; phase?: string }
      return { items: snap.items ?? [], ready: snap.phase === 'ready' }
    },
    sessions: () => {
      const snap = (service('sessions')?.list?.getSnapshot?.() ?? {}) as { ids?: string[]; byId?: Record<string, SessionRow>; phase?: string }
      return { ids: snap.ids ?? [], byId: snap.byId ?? {}, ready: snap.phase !== 'pending' }
    },
    createSession: async (opts) => await service('sessions').create(opts),
    createWorkspace: async (path) => {
      const ws = await service('workspaces').create({ path })
      return { workspaceId: ws.workspaceId, title: ws.title }
    },
    openSession: (id) => service('sessions').open(id),
    reference: async (sessionId, path, appearance) => {
      const outcome: AddOutcome = await add.appendReference(sessionId, path, undefined, appearance)
      // ok/busy（纯文本降级）都算已落点；unavailable/failed 交给 settleRef 继续重试
      return outcome === 'ok' || outcome === 'busy'
    },
    choose: (title, folder) => chooseWorkspace(title, folder),
    openEditor: (path, line, column) => {
      if (path == null) {
        openEditorView(null)
        return
      }
      openEditorView(path)
      if (line != null) setTimeout(() => emitOpenAt(path, line, column), LINE_AT_DELAY_MS)
    },
    schedule: (fn, ms) => setTimeout(fn, ms),
    notify: (text) => toastDom(text),
  }
  return { ...base, ...overrides }
}
