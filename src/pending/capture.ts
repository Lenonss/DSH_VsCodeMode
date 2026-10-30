/**
 * 待审差异采集：环绕一次文件写入读取真实前后内容，只有内容确实变化才落库。
 * @author ddj 2026年10月29号
 */
import { cwdOf } from '../registry.js'
import { resolveTarget } from '../store.js'
import type { Ctx } from '../store.js'
import { log } from '../log.js'

/** 可被采信为待审来源的写文件工具。 */
const WRITE_TOOLS = ['edit', 'write', 'str_replace_editor']
/** 单文件文本上限：超过即标注 oversized，不静默截断。 */
const MAX_TEXT = 1024 * 1024

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
}

/** 工具的写工具参数形状；只取本采集关心的字段。 */
interface WriteExec {
  name?: string
  arguments?: { file_path?: unknown; path?: unknown }
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
  const state: CaptureState = { busy: new Set<string>(), stopped: false }
  ctx.on('tools/execute', (exec: WriteExec, next: () => Promise<unknown>) => aroundTool(ctx, state, sink, exec, next))
  return {
    dispose(): void {
      state.stopped = true
      state.busy.clear()
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
async function planOf(ctx: Ctx, state: CaptureState, exec: WriteExec): Promise<CapturePlan | null> {
  const session = exec.agent?.session
  const requested = exec.arguments?.file_path ?? exec.arguments?.path
  if (state.stopped || !session?.id || typeof requested !== 'string') return null
  if (!WRITE_TOOLS.includes(String(exec.name))) return null
  const cwd = cwdOf(session as never)
  if (!cwd) return null
  const fs = ctx.get('fs')
  const target = await resolveTarget(ctx, session as never, requested)
  const identity = fs.processPath(target)
  if (typeof identity !== 'string' || !identity || state.busy.has(identity)) return null
  const before = await readText(fs, target)
  if (before !== null && before.length > MAX_TEXT) return null
  return { cwd: String(cwd), sessionId: String(session.id), path: requested, identity, before, session: session as never }
}

/** 一次采集所需的固定信息。 */
interface CapturePlan {
  cwd: string
  sessionId: string
  path: string
  identity: string
  before: string | null
  session: never
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
  let plan: CapturePlan | null = null
  try {
    plan = await planOf(ctx, state, exec)
  } catch (error) {
    log.debug('待审采集跳过：' + String(error))
  }
  if (!plan) return next()

  state.busy.add(plan.identity)
  try {
    return await next()
  } finally {
    state.busy.delete(plan.identity)
    try {
      reportWrite(ctx, sink, plan)
    } catch (error) {
      log.debug('待审上报失败：' + String(error))
    }
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 写后读回并比较，内容一致视为无净变化不产生条目。
 * @param ctx Host 生命周期
 * @param sink 已确认写入的接收方
 * @param plan 采集计划
 * @returns 无；读回失败只记日志
 */
function reportWrite(ctx: Ctx, sink: (write: PendingWrite) => void, plan: CapturePlan): void {
  const fs = ctx.get('fs')
  void resolveTarget(ctx, plan.session, plan.path).then(async (target: unknown) => {
    const after = await readText(fs, target)
    if (after !== null && after.length > MAX_TEXT) return
    if (plan.before === after) return
    sink({ cwd: plan.cwd, sessionId: plan.sessionId, path: plan.path, identity: plan.identity, before: plan.before, after, now: Date.now() })
  }).catch((error: unknown) => log.debug('待审读回失败：' + String(error)))
}

/**
 * @author ddj 2026年10月29号
 * @description: 读取全文；缺失或不可读按"无内容"处理，交由上层决定语义。
 * @param fs 文件系统
 * @param target 目标
 * @returns 文本或 null
 */
export async function readText(fs: any, target: any): Promise<string | null> {
  try {
    return String(await fs.readText(target))
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'FS_NOT_FOUND' || code === 'FS_TOO_LARGE') return null
    throw error
  }
}
