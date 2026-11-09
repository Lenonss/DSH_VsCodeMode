/**
 * 待审差异采集：环绕一次文件写入读取真实前后内容，只有内容确实变化才落库。
 * @author ddj 2026年10月29号
 */
import { cwdOfSession } from '../store.js'
import type { Ctx } from '../store.js'
import { log } from '../log.js'
import { toolTargets, patchDiagnostics, OPS_PREFIX } from '../toolTargets.js'
import { replaceCandidates, BULK_LIMIT } from './bulkTargets.js'
import type { BulkSearcher } from './bulkTargets.js'
import { rawText, rawReviewFile } from '../reviewEvidence.js'

/** 可被采信为待审来源的写文件工具（含 dsh-ops 的单目标写工具）。 */
const WRITE_TOOLS = [
  'edit', 'write', 'str_replace_editor', 'apply_patch',
  OPS_PREFIX + 'edit_file', OPS_PREFIX + 'write_file', OPS_PREFIX + 'remove', OPS_PREFIX + 'copy', OPS_PREFIX + 'move',
]
/** 批量替换：目标执行前未知，走候选预读 + 回执对齐。 */
const BULK_TOOL = OPS_PREFIX + 'replace'
/** 单文件文本上限：超过即标注 oversized，不静默截断。 */
const MAX_TEXT = 1024 * 1024
const captureGaps = new Map<string, { cwd: string; sessionId: string; message: string }>()

/** @public @author ddj 2026年11月04号 @param cwd Workspace identity. @returns Bounded runtime-only capture diagnostics. */
export function pendingGaps(cwd: string): string[] {
  return [...captureGaps.values()].filter((gap) => gap.cwd === cwd).map((gap) => gap.message)
}

/** @private @author ddj 2026年11月04号 @param ctx Host scope. @param exec Original call. @param path Failed target. @param error Evidence failure. Records no writable state. */
function recordGap(scope: { cwd: string; sessionId: string }, exec: WriteExec, path: string, error: unknown): void {
  const { cwd, sessionId } = scope
  const key = JSON.stringify([cwd, sessionId, exec.id, path])
  captureGaps.set(key, { cwd, sessionId, message: path + ': ' + String(error) })
  const local = [...captureGaps].filter(([, gap]) => gap.cwd === cwd)
  while (local.length > 50) captureGaps.delete(local.shift()![0])
  while (captureGaps.size > 500) captureGaps.delete(captureGaps.keys().next().value!)
}

/** 一次已确认的写入。 */
export interface PendingWrite {
  cwd: string
  sessionId: string
  path: string
  identity: string
  before: string | null
  after: string | null
  now: number
}

/** 采集器。 */
export interface PendingCapture {
  /** 释放监听并丢弃暂存。 */
  dispose(): void
}

/** 采集器的进程内状态：同一目标并发写入时只采信最外层那一次。 */
interface CaptureState {
  busy: Set<string>
  stopped: boolean
  disposed: Set<string>
  /** 批量替换候选搜索注入点；缺省使用打包 ripgrep。 */
  search?: BulkSearcher
}

/** 工具的写工具参数形状；只取本采集关心的字段。 */
interface WriteExec {
  id?: string
  name?: string
  arguments?: { file_path?: unknown; path?: unknown; to?: unknown; input?: unknown; dryRun?: unknown; pattern?: unknown; glob?: unknown }
  agent?: { session?: { id?: string; cwd?: string } }
}

/**
 * @author ddj 2026年10月30号
 * @description: 安装写文件采集；读写失败只影响待审来源，绝不影响用户工具本身。
 * @param ctx Host 生命周期
 * @param sink 已确认写入的接收方
 * @returns 可释放的采集器
 */
export function installPending(
  ctx: Ctx, sink: (write: PendingWrite) => void, options?: { search?: BulkSearcher },
): PendingCapture {
  const state: CaptureState = { busy: new Set<string>(), stopped: false, disposed: new Set<string>(), search: options?.search }
  ctx.on('tools/execute', (exec: WriteExec, next: () => Promise<unknown>) => aroundTool(ctx, state, sink, exec, next))
  ctx.on('session/disposed', (session: { id: string }) => {
    state.disposed.add(session.id)
    for (const [key, gap] of captureGaps) {
      if (gap.sessionId === session.id) captureGaps.delete(key)
    }
  })
  return {
    dispose(): void {
      state.stopped = true
      state.busy.clear()
      captureGaps.clear()
    },
  }
}

/**
 * @author ddj 2026年10月30号
 * @description: 判定本次调用是否值得采集；不值得时返回 null，调用方直接透传原始分发。
 * @param ctx Host 生命周期
 * @param state 采集状态
 * @param exec 工具分发上下文
 * @returns 采集计划或 null
 */
async function planOf(scope: { cwd: string; sessionId: string; fs: any }, state: CaptureState, requested: string): Promise<CapturePlan | null> {
  const { cwd, sessionId, fs } = scope
  if (state.stopped || state.disposed.has(sessionId)) return null
  const target = await fs.resolve(requested, { cwd })
  const identity = fs.processPath(target)
  if (state.stopped || state.disposed.has(sessionId) || typeof identity !== 'string' || !identity || state.busy.has(identity)) return null
  state.busy.add(identity)
  try {
    const before = await readText(fs, target)
    if (state.stopped || state.disposed.has(sessionId) || (before !== null && before.length > MAX_TEXT)) {
      state.busy.delete(identity)
      return null
    }
    return { cwd: String(cwd), sessionId, path: requested, identity, before, target, fs }
  } catch (error) {
    state.busy.delete(identity)
    throw error
  }
}

/** 一次采集所需的固定信息。 */
interface CapturePlan {
  cwd: string
  sessionId: string
  path: string
  identity: string
  before: string | null
  target: unknown
  fs: any
}

/** 替换回执里的一条文件结果；只关心目标与完成状态。 */
interface BulkItem { path: string; status?: string }

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: dryRun 只预览不落盘，既不预读基线也不产生待审条目。
 * @param exec 工具分发上下文
 * @returns 是否预览调用
 */
function isDryRun(exec: WriteExec): boolean {
  return exec.arguments?.dryRun === true
}

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: 解析批量替换回执里的文件条目；形状不符返回空，交给官方快照兜底。
 * @param result 工具返回值
 * @returns 带路径的回执条目
 */
function bulkItems(result: unknown): BulkItem[] {
  const envelope = result as { value?: unknown } | null
  const payload = (envelope?.value ?? result) as { items?: unknown } | null
  if (!Array.isArray(payload?.items)) return []

  const items: BulkItem[] = []
  for (const raw of payload.items as unknown[]) {
    const item = raw as { path?: unknown; status?: unknown } | null
    if (!item || typeof item.path !== 'string' || !item.path) continue
    items.push({ path: item.path, status: typeof item.status === 'string' ? item.status : undefined })
  }
  return items
}

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: 求本次调用的采集目标；批量替换先按字面量预读候选，其余按工具参数取路径。
 * @param ctx Host 生命周期
 * @param cwd 工作区
 * @param exec 工具分发上下文
 * @param bulk 是否批量替换
 * @returns 目标路径与批量替换的候选总数
 * @throws 候选求值失败或工具参数不可用
 */
async function captureTargets(
  ctx: Ctx, cwd: string, exec: WriteExec, bulk: boolean, search?: BulkSearcher,
): Promise<{ paths: string[]; total: number }> {
  if (!bulk) return { paths: await toolTargets(exec), total: 0 }
  const session = exec.agent?.session ?? { id: '' }
  return replaceCandidates({ ctx, session: session as never, cwd, args: exec.arguments ?? {} }, search)
}

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: 用替换回执对齐预读候选；回执完成但没预读到的文件只记 gap，不伪造基线。
 * @param scope 工作区作用域
 * @param exec 工具分发上下文
 * @param result 工具返回值
 * @param plans 已完成写前冻结的采集计划
 * @returns 无；路径解析失败只记 gap
 */
async function reconcileBulk(
  scope: { cwd: string; sessionId: string; fs: any }, exec: WriteExec, result: unknown, plans: CapturePlan[],
): Promise<void> {
  const known = new Set(plans.map((plan) => plan.identity))
  for (const item of bulkItems(result)) {
    if (item.status !== 'completed') continue
    try {
      const target = await scope.fs.resolve(item.path, { cwd: scope.cwd })
      if (known.has(scope.fs.processPath(target))) continue
      recordGap(scope, exec, item.path, '未预读基线，未采集该文件前后差异')
    } catch (error) {
      recordGap(scope, exec, item.path, error)
    }
  }
}

/**
 * @private
 * @author ddj 2026年11月09号
 * @description: 逐目标冻结写前基线；预算超限、路径不可用或读取失败只影响对应目标。
 * @param scope 工作区作用域
 * @param state 采集生命周期状态
 * @param exec 工具分发上下文
 * @param paths 本次调用的目标路径
 * @returns 已冻结的采集计划
 */
async function buildPlans(
  scope: { cwd: string; sessionId: string; fs: any }, state: CaptureState, exec: WriteExec, paths: string[],
): Promise<CapturePlan[]> {
  const plans: CapturePlan[] = []
  for (const path of paths) {
    try {
      if (plans.length >= BULK_LIMIT) throw new Error('capture target budget exceeded')
      const plan = await planOf(scope, state, path)
      if (plan) plans.push(plan)
    } catch (error) {
      if (!state.stopped && !state.disposed.has(scope.sessionId)) recordGap(scope, exec, path, error)
      log.debug('待审采集跳过：' + path + ': ' + String(error))
    }
  }
  return plans
}

/**
 * @author ddj 2026年10月30号
 * @description: 写工具执行前后各读一次，内容变化才上报；任何采集异常都不改变工具结果。
 * @param ctx Host 生命周期
 * @param state 采集状态
 * @param sink 已确认写入的接收方
 * @param exec 工具分发上下文
 * @param next 原始分发
 * @returns 原始工具结果
 */
async function aroundTool(
  ctx: Ctx, state: CaptureState, sink: (write: PendingWrite) => void,
  exec: WriteExec, next: () => Promise<unknown>,
): Promise<unknown> {
  const name = String(exec.name)
  const bulk = name === BULK_TOOL
  if (state.stopped || (!bulk && !WRITE_TOOLS.includes(name)) || isDryRun(exec)) return next()

  const session = exec.agent?.session
  const cwd = session ? cwdOfSession(ctx, session as never) : null
  if (!session?.id || !cwd) return next()

  const scope = { cwd, sessionId: session.id, fs: ctx.get('fs') }
  let targets: { paths: string[]; total: number }
  try {
    targets = await captureTargets(ctx, scope.cwd, exec, bulk, state.search)
  } catch (error) {
    recordGap(scope, exec, bulk ? BULK_TOOL : name, error)
    log.debug('待审目标不可用：' + String(error))
    return next()
  }

  // 候选超出预算时只保证前 BULK_LIMIT 个文件有真实基线，其余在回执对齐阶段补 gap。
  if (bulk && targets.total > targets.paths.length) {
    recordGap(scope, exec, BULK_TOOL, '批量替换候选 ' + targets.total + ' 个文件，仅采集前 ' + targets.paths.length + ' 个')
  }
  const plans = await buildPlans(scope, state, exec, targets.paths)

  try {
    const result = await next()
    if (bulk && !state.stopped && !state.disposed.has(scope.sessionId)) await reconcileBulk(scope, exec, result, plans)
    if (name === 'apply_patch' && !state.stopped && !state.disposed.has(scope.sessionId)) {
      for (const diagnostic of patchDiagnostics(result)) recordGap(scope, exec, 'apply_patch', diagnostic)
    }
    return result
  } finally {
    for (const plan of plans) {
      try { await reportWrite(state, sink, plan) }
      catch (error) { if (!state.stopped && !state.disposed.has(scope.sessionId)) recordGap(scope, exec, plan.path, error); log.debug('待审上报失败：' + String(error)) }
      finally { state.busy.delete(plan.identity) }
    }
  }
}

/**
 * @author ddj 2026年11月04号
 * @description: 固定目标写后读回；内容一致不产生条目，卸载后不再上报。
 * @param state 采集生命周期状态
 * @param sink 已确认写入的接收方
 * @param plan 采集计划
 * @returns 无；读回失败只记日志
 */
async function reportWrite(state: CaptureState, sink: (write: PendingWrite) => void, plan: CapturePlan): Promise<void> {
  if (state.stopped || state.disposed.has(plan.sessionId)) return
  // 目录、provider 和目标均在写前冻结，切目录或卸载不能将内容串到其他工作区。
  const after = await readText(plan.fs, plan.target)
  if (state.stopped || state.disposed.has(plan.sessionId)) return
  if (after !== null && after.length > MAX_TEXT) throw new Error('capture text budget exceeded')
  for (const [key, gap] of captureGaps) {
    const identity = JSON.parse(key) as unknown[]
    if (gap.cwd === plan.cwd && gap.sessionId === plan.sessionId && identity[3] === plan.path) captureGaps.delete(key)
  }
  if (plan.before === after) return
  sink({ cwd: plan.cwd, sessionId: plan.sessionId, path: plan.path, identity: plan.identity, before: plan.before, after, now: Date.now() })
}

/**
 * @author ddj 2026年10月29号
 * @description: 读取全文；只有明确缺失返回 null，不可读或超限错误保留失败语义。
 * @param fs 文件系统
 * @param target 目标
 * @returns 文本或 null
 */
export async function readText(fs: any, target: any, signal?: AbortSignal): Promise<string | null> {
  try {
    if (typeof fs.readBytes === 'function') {
      return rawText(rawReviewFile(await fs.readBytes(target, signal, MAX_TEXT)))
    }
    throw new Error('Raw byte capture unavailable')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'FS_NOT_FOUND') return null
    throw error
  }
}
