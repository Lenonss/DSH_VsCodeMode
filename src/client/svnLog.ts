/**
 * dsh-vscode-mode client — SVN 日志状态层（P3）。
 *
 * 数据源经 svnStore 工厂创建（scope 缓存 + 在途去重 + 事件广播），键为 `scope::target`
 * 复合键——同一工作区下「根的日志」与「某文件的日志」是两份数据，不能共用一个 key。
 * 另提供 update 结果 / cleanup / 版本差异的动作封装，供动作执行器与面板复用。
 * 作者 ddj 2026年09月16号
 */
import type { SvnActionResult, SvnDiffRevResult, SvnLogEntry } from '../shared/svn.js'
import { SVN_LOG_SHOW_ALL_CAP } from '../svnLog.js'
import { createSvnStore, svnStoreKey } from './svnStore.js'
import { rpc } from './rpc.js'

/** 日志数据源（key = `scope\0target[\0variant]`；variant 编码 Stop on copy / merged / Show Range，P1-4/P1-5/P1-6）。 */
const logStore = createSvnStore<'svn.log', SvnLogEntry[]>({
  method: 'svn.log',
  event: 'edrv:svn-log',
  args: (key) => {
    const [target, variant] = splitLogKey(key)
    return { path: target, ...logVariantArgsOf(variant) }
  },
  select: (res) => ({
    value: Array.isArray(res.entries) ? (res.entries as SvnLogEntry[]) : [],
    meta: {
      truncated: res.truncated === true,
      loadedLimit: Number(res.limit) || (Array.isArray(res.entries) ? (res.entries as SvnLogEntry[]).length : 0),
    },
  }),
})

/** 日志取数选项（P1-4 Stop on copy / P1-6 Show Range / P1-5 Include merged revs）。 */
export interface SvnLogOpts {
  /** 勾选 Stop on copy（遇到 copy/rename 即停止回溯）。 */
  stopOnCopy?: boolean
  /** Show Range 区间 [较早, 较晚]（不传 = 默认 HEAD:1 窗口）。 */
  range?: [number, number] | null
  /** 勾选 Include merged revisions（argv `-g`；P1-5）。 */
  showMerged?: boolean
}

/**
 * 拆日志键：`scope\0target[\0variant]` → [target, variant]（scope 由 svnStoreKey 前缀保证）。
 * @author ddj 2026年09月17号
 * @param key 缓存键
 * @returns [目标相对路径, variant 串]
 */
function splitLogKey(key: string): [string, string] {
  const at = key.indexOf('\u0000')
  if (at < 0) return ['', '']
  const rest = key.slice(at + 1)
  const sep = rest.indexOf('\u0000')
  if (sep < 0) return [rest, '']
  return [rest.slice(0, sep), rest.slice(sep + 1)]
}

/** 日志取数选项的类型化参数（variant → RPC 参数，三处入口共用防漂移）。 */
type LogVariantArgs = { stopOnCopy?: boolean; startRev?: number; endRev?: number; showMerged?: boolean }

/**
 * variant → RPC 参数（`soc` = stopOnCopy；`mrg` = showMerged；`rSTART-END` = 区间；`|` 连接）。
 * @author ddj 2026年09月17号 / 2026年09月18号
 * @param variant 键尾变体串
 * @returns svn.log 附加参数
 */
function logVariantArgsOf(variant: string): LogVariantArgs {
  const out: LogVariantArgs = {}
  for (const part of variant.split('|')) {
    if (part === 'soc') { out.stopOnCopy = true; continue }
    if (part === 'mrg') { out.showMerged = true; continue }
    if (!part.startsWith('r')) continue
    const dash = part.indexOf('-')
    if (dash < 2) continue
    const startRev = Number(part.slice(1, dash))
    const endRev = Number(part.slice(dash + 1))
    if (Number.isFinite(startRev) && startRev > 0) out.startRev = startRev
    if (Number.isFinite(endRev) && endRev > 0) out.endRev = endRev
  }
  return out
}

/**
 * 选项 → 键 variant 串（空选项 = 空串，键退回 `scope\0target`）。
 * @author ddj 2026年09月17号 / 2026年09月18号
 * @param opts 日志取数选项
 * @returns variant 串
 */
function logVariantOf(opts: SvnLogOpts): string {
  const parts: string[] = []
  if (opts.stopOnCopy) parts.push('soc')
  if (opts.showMerged) parts.push('mrg')
  if (opts.range && opts.range[0] > 0 && opts.range[1] > 0) parts.push('r' + opts.range[0] + '-' + opts.range[1])
  return parts.join('|')
}

/**
 * 选项 → RPC 附加参数（ensure/refresh 两个入口共用，防两处漂移）。
 * @author ddj 2026年09月18号
 * @param opts 日志取数选项
 * @returns RPC 附加参数（limit 由调用方另加）
 */
function logOptsArgsOf(opts: SvnLogOpts): LogVariantArgs {
  const extra: LogVariantArgs = {}
  if (opts.stopOnCopy) extra.stopOnCopy = true
  if (opts.showMerged) extra.showMerged = true
  if (opts.range && opts.range[0] > 0 && opts.range[1] > 0) { extra.startRev = opts.range[0]; extra.endRev = opts.range[1] }
  return extra
}

/**
 * 从复合键解析目标与条数（`scope\0target` 的 `\0` 之后部分）。
 * P1-8 起 limit 不再参与键，第二个返回值恒为 0，仅为兼容旧复合格式保留解析。
 * @author ddj 2026年09月16号
 * @param key 复合键
 * @returns [目标相对路径, 条数（恒 0）]
 */
export function svnStoreTargetOf(key: string): [string, number] {
  const at = key.indexOf('\u0000')
  if (at < 0) return ['', 0]
  const rest = key.slice(at + 1)
  const sep = rest.indexOf('\u0000')
  if (sep < 0) return [rest, 0]
  return [rest.slice(0, sep), Number(rest.slice(sep + 1)) || 0]
}

/**
 * 构造日志缓存键（P1-8：scope + target；P1-4/P1-6：非空选项追加 `\0variant` 维度）。
 * @author ddj 2026年09月17号
 * @param scope 状态作用域
 * @param target 目标相对路径
 * @param variant 键尾变体串（'' = 默认窗口）
 * @returns 复合键
 */
export function logKeyOf(scope: string, target: string, variant = ''): string {
  return variant ? svnStoreKey(scope, target + '\u0000' + variant) : svnStoreKey(scope, target)
}

/**
 * 选项 → 缓存键（EditorView 事件订阅键与状态层共用，防止两处拼法漂移）。
 * @author ddj 2026年09月17号
 * @param scope 状态作用域
 * @param target 目标相对路径
 * @param opts 日志取数选项
 * @returns 复合键
 */
export function svnLogKeyOf(scope: string, target: string, opts: SvnLogOpts = {}): string {
  return logKeyOf(scope, target, logVariantOf(opts))
}

/**
 * Show All 的拉取上限（P0-6 / P1-7）：复用 host 侧 `SVN_LOG_SHOW_ALL_CAP`（`src/svnLog.ts`
 * 为纯模块、无 node 导入链，client 可安全引用），单一事实源。
 * 真全量（省略 `-l`）在超大仓库会拉上百 MB，故 host 侧仍以该值为硬上限。
 * @author ddj 2026年09月17号 / 2026年09月18号
 */
export const SVN_LOG_SHOW_ALL_LIMIT = SVN_LOG_SHOW_ALL_CAP

/**
 * 拉取（或命中缓存的）日志。
 * @author ddj 2026年09月16号 / 2026年09月17号
 * @param sessionId 会话 id
 * @param scope 状态作用域
 * @param target 目标相对路径（'' = 工作区根）
 * @param limit 本次请求条数（0 = 默认）
 * @param force 强制重取（P1-8「加载更多/Show All」用：绕过缓存命中，成功后原地替换同键数据）
 * @param opts 取数选项（P1-4 stopOnCopy / P1-6 range，参与键维度）
 */
export function ensureSvnLog(
  sessionId: string | undefined,
  scope: string | null | undefined,
  target = '',
  limit = 0,
  force = false,
  opts: SvnLogOpts = {},
): void {
  if (!scope) return
  const extra: Record<string, unknown> = { ...logOptsArgsOf(opts) }
  if (limit) extra.limit = limit
  logStore.ensure(sessionId, logKeyOf(scope, target, logVariantOf(opts)), force, extra)
}

/**
 * 读缓存的日志（未加载返回 null）。
 * @author ddj 2026年09月16号 / 2026年09月17号
 * @param scope 状态作用域
 * @param target 目标相对路径
 * @param _limit 仅保留兼容旧签名，P1-8 起不参与键
 * @param opts 取数选项（参与键维度）
 * @returns 日志条目或 null
 */
export function getSvnLog(scope: string | null | undefined, target = '', _limit = 0, opts: SvnLogOpts = {}): SvnLogEntry[] | null {
  if (!scope) return null
  return logStore.get(logKeyOf(scope, target, logVariantOf(opts)))
}

/** 日志是否可能还有更多（host 侧已达本次请求上限；按 opts 对应键的 meta 读取）。 */
export function svnLogTruncated(scope: string | null | undefined, target = '', _limit = 0, opts: SvnLogOpts = {}): boolean {
  if (!scope) return false
  return logStore.meta(logKeyOf(scope, target, logVariantOf(opts))).truncated === true
}

/**
 * 已加载的请求上限（P1-8：「加载更多」按它递增，避免用旧的 limit 维度算出倒退值）。
 * @author ddj 2026年09月17号
 * @param scope 状态作用域
 * @param target 目标相对路径
 * @param opts 取数选项（参与键维度）
 * @returns 已请求条数（未加载 = 0）
 */
export function svnLogLoadedLimit(scope: string | null | undefined, target = '', opts: SvnLogOpts = {}): number {
  if (!scope) return 0
  return Number(logStore.meta(logKeyOf(scope, target, logVariantOf(opts))).loadedLimit) || 0
}

/**
 * 强制重查日志（面板 ⟳；按已加载上限与传入上限的较大者重取，避免刷新缩水）。
 * @author ddj 2026年09月16号 / 2026年09月17号
 * @param sessionId 会话 id
 * @param scope 状态作用域
 * @param target 目标相对路径
 * @param limit 期望条数（0 = 默认页大小）
 * @param opts 取数选项（参与键维度）
 */
export function refreshSvnLog(
  sessionId: string | undefined,
  scope: string | null | undefined,
  target = '',
  limit = 0,
  opts: SvnLogOpts = {},
): void {
  if (!scope) return
  const wanted = Math.max(limit || 0, svnLogLoadedLimit(scope, target, opts))
  const extra: Record<string, unknown> = { ...logOptsArgsOf(opts) }
  if (wanted) extra.limit = wanted
  logStore.refresh(sessionId, logKeyOf(scope, target, logVariantOf(opts)), extra)
}

/** 丢弃日志缓存。 */
export function clearSvnLog(scope?: string | null): void {
  logStore.clear(scope ?? null)
}

/** 动作结果（message 可直接落状态栏/notify）。 */
export interface SvnLogOutcome {
  ok: boolean
  message: string
}

/**
 * 读取某版本的左右两侧内容（版本差异视图）。
 * 左侧为 null 属正常业务分支（该版本尚无此文件 = 新增），调用方应渲染为空而非报错。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id
 * @param path 工作区相对路径
 * @param revision 目标版本
 * @returns 双侧内容或错误
 */
export async function svnDiffRev(sessionId: string | undefined, path: string, revision: number): Promise<SvnDiffRevResult & { ok: boolean }> {
  try {
    const res = await rpc('svn.diffRev', { sessionId, path, revision })
    if (!res.ok) return { ok: false, left: null, right: null, error: res.error }
    return { ok: true, left: res.left ?? null, right: res.right ?? null, reason: res.reason, error: res.error, binary: res.binary === true, encodingHint: res.encodingHint === true }
  } catch (error) {
    return { ok: false, left: null, right: null, error: String(error) }
  }
}

/**
 * 读取某文件两个指定版本的左右两侧内容（P1-2 比较两个修订）。
 * 左右均为 null 属正常业务分支（该版本尚无此文件 = 新增/已删除），调用方应渲染为空而非报错。
 * @author ddj 2026年09月17号
 * @param sessionId 会话 id
 * @param path 工作区相对路径
 * @param revA 左侧版本（选中顺序在前）
 * @param revB 右侧版本（选中顺序在后）
 * @returns 双侧内容或错误
 */
export async function svnDiffPair(sessionId: string | undefined, path: string, revA: number, revB: number): Promise<SvnDiffRevResult & { ok: boolean }> {
  try {
    const res = await rpc('svn.diffPair', { sessionId, path, revA, revB })
    if (!res.ok) return { ok: false, left: null, right: null, error: res.error }
    return { ok: true, left: res.left ?? null, right: res.right ?? null, reason: res.reason, error: res.error, binary: res.binary === true, encodingHint: res.encodingHint === true }
  } catch (error) {
    return { ok: false, left: null, right: null, error: String(error) }
  }
}

/**
 * 读取某版本与工作副本的左右两侧内容（P1-1 Compare with working copy）。
 * 左侧为 null 属正常业务分支（该版本尚无此文件 = 新增），调用方应渲染为空而非报错。
 * @author ddj 2026年09月17号
 * @param sessionId 会话 id
 * @param path 工作区相对路径
 * @param revision 左侧版本
 * @returns 双侧内容或错误
 */
export async function svnDiffWorking(sessionId: string | undefined, path: string, revision: number): Promise<SvnDiffRevResult & { ok: boolean }> {
  try {
    const res = await rpc('svn.diffWorking', { sessionId, path, revision })
    if (!res.ok) return { ok: false, left: null, right: null, error: res.error }
    return { ok: true, left: res.left ?? null, right: res.right ?? null, reason: res.reason, error: res.error, binary: res.binary === true, encodingHint: res.encodingHint === true }
  } catch (error) {
    return { ok: false, left: null, right: null, error: String(error) }
  }
}

/**
 * 读取文件目标的工作副本版号（P1-9 版号行加粗；目录/根/失败 = null）。
 * @author ddj 2026年09月17号
 * @param sessionId 会话 id
 * @param path 工作区相对路径
 * @returns 工作副本版号或 null
 */
export async function svnWcRev(sessionId: string | undefined, path: string): Promise<number | null> {
  try {
    const res = await rpc('svn.wcRev', { sessionId, path })
    if (!res.ok) return null
    return typeof res.revision === 'number' ? res.revision : null
  } catch (error) {
    return null
  }
}

/**
 * 清理工作副本（默认只清锁；破坏性选项须调用方先 confirm）。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id
 * @param options 破坏性选项
 * @returns 执行结果与反馈文案
 */
export async function svnCleanup(
  sessionId: string | undefined,
  options: { removeUnversioned?: boolean; removeIgnored?: boolean } = {},
): Promise<SvnLogOutcome> {
  try {
    const res = await rpc('svn.cleanup', {
      sessionId,
      removeUnversioned: options.removeUnversioned || undefined,
      removeIgnored: options.removeIgnored || undefined,
    })
    if (!res.ok) return { ok: false, message: res.error }
    return { ok: true, message: 'SVN 清理：' + res.summary }
  } catch (error) {
    return { ok: false, message: 'SVN 清理失败：' + String(error) }
  }
}

/**
 * 动作结果统一适配（把 SvnActionResult 转成带文案的结果）。
 * @author ddj 2026年09月16号
 * @param verb 动作动词
 * @param res 后端结果
 * @returns 结果与文案
 */
export function actionOutcomeOf(verb: string, res: SvnActionResult): SvnLogOutcome {
  return { ok: true, message: verb + '：' + res.summary }
}
