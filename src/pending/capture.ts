/**
 * 待审差异采集：环绕一次文件写入读取真实前后内容，只有内容确实变化才落库。
 * @author ddj 2026年10月29号
 */
import { cwdOfSession } from '../store.js'
import type { Ctx } from '../store.js'
import { log } from '../log.js'
import { toolTargets, patchDiagnostics } from '../toolTargets.js'
import { rawText, rawReviewFile } from '../reviewEvidence.js'

/** 可被采信为待审来源的写文件工具。 */
const WRITE_TOOLS = ['edit', 'write', 'str_replace_editor', 'apply_patch']
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
}

/** 工具的写工具参数形状；只取本采集关心的字段。 */
interface WriteExec {
  id?: string
  name?: string
  arguments?: { file_path?: unknown; path?: unknown; input?: unknown }
  agent?: { session?: { id?: string; cwd?: string } }
}

/**
 * @author ddj 2026年10月30号
 * @description: 安装写文件采集；读写失败只影响待审来源，绝不影响用户工具本身。
 * @param ctx Host 生命周期
 * @param sink 已确认写入的接收方
 * @returns 可释放的采集器
 */
export function installPending(ctx: Ctx, sink: (write: PendingWrite) => void): PendingCapture {
  const state: CaptureState = { busy: new Set<string>(), stopped: false, disposed: new Set<string>() }
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
  if (state.stopped || !WRITE_TOOLS.includes(String(exec.name))) return next()
  const session = exec.agent?.session
  const cwd = session ? cwdOfSession(ctx, session as never) : null
  if (!session?.id || !cwd) return next()
  const scope = { cwd, sessionId: session.id, fs: ctx.get('fs') }
  const plans: CapturePlan[] = []
  try {
    const paths = await toolTargets(exec)
    for (const path of paths) {
      try {
        if (plans.length >= 16) throw new Error('capture target budget exceeded')
        const plan = await planOf(scope, state, path)
        if (plan) plans.push(plan)
      } catch (error) { if (!state.stopped && !state.disposed.has(scope.sessionId)) recordGap(scope, exec, path, error); log.debug('待审采集跳过：' + path + ': ' + String(error)) }
    }
  } catch (error) { if (!state.stopped && !state.disposed.has(scope.sessionId)) recordGap(scope, exec, String(exec.name), error); log.debug('待审目标不可用：' + String(error)) }

  try {
    const result = await next()
    if (exec.name === 'apply_patch' && !state.stopped && !state.disposed.has(scope.sessionId)) {
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
