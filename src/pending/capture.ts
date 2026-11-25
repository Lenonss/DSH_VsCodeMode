/**
 * 待审差异采集：环绕一次文件写入读取真实前后内容，只有内容确实变化才落库。
 * @author ddj 2026年10月29号
 */
import { createHash } from 'node:crypto'
import { cwdOfSession } from '../store.js'
import type { Ctx } from '../store.js'
import { log } from '../log.js'
import { toolTargets, patchDiagnostics, OPS_PREFIX } from '../toolTargets.js'
import { replaceCandidates, BULK_LIMIT } from './bulkTargets.js'
import type { BulkSearcher } from './bulkTargets.js'
import { rawText, rawReviewFile } from '../reviewEvidence.js'
import type { PendingBaseKind, PendingEvidence, PendingOrigin, PendingVerdict } from '../shared/pendingReview.js'
import { receiptsOf } from './receipt.js'
import type { ToolReceipt } from './receipt.js'
import { verdictOf } from './verdict.js'

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

/**
 * @public
 * @author ddj 2026-11-24
 * @description: 外部采集（watch / 补扫）的缺口上报：非文本、超大、读取失败都记进同一份列表，
 * 让面板能把「没记下来」说清楚，而不是静默丢条目。
 * @param cwd 工作区
 * @param sessionId 会话
 * @param path 出问题的路径
 * @param error 原因
 * @returns 无
 */
export function noteCaptureGap(cwd: string, sessionId: string, path: string, error: unknown): void {
  recordGap({ cwd, sessionId }, { id: 'external' }, path, error)
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
  /** 触发本次写入的工具名；缺省按未知写工具（`tool`）记录。 */
  tool?: string
  /** 显式归属（外部采集用）；缺省按时间窗判定。 */
  origin?: PendingOrigin
  /** 修改前内容的可信度（外部采集用）；缺省按 before 是否为空推断。 */
  baseKind?: PendingBaseKind
  /** 证据强度；缺省按快照处理。 */
  evidence?: PendingEvidence
  /** 这次调用的结局；缺省按 changed 处理。 */
  verdict?: PendingVerdict
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
 * @description: 判定本次调用是否值得采集并冻结写前基线；同目标并发调用改记「无基线」，
 * 交给工具回执补前像，不再整次丢弃。
 * @param scope 工作区作用域
 * @param state 采集状态
 * @param requested 目标路径
 * @param tool 工具名
 * @returns 采集计划或 null
 */
async function planOf(scope: { cwd: string; sessionId: string; fs: any }, state: CaptureState, requested: string, tool: string): Promise<CapturePlan | null> {
  const { cwd, sessionId, fs } = scope
  if (state.stopped || state.disposed.has(sessionId)) return null
  const target = await fs.resolve(requested, { cwd })
  const identity = fs.processPath(target)
  if (state.stopped || state.disposed.has(sessionId) || typeof identity !== 'string' || !identity) return null
  const base = { cwd: String(cwd), sessionId, path: requested, identity, target, fs, tool }
  if (state.busy.has(identity)) return { ...base, before: undefined, hashBefore: null, held: false }
  state.busy.add(identity)
  try {
    const snapshot = await readSnapshot(fs, target)
    if (state.stopped || state.disposed.has(sessionId) || (snapshot.text !== null && snapshot.text.length > MAX_TEXT)) {
      state.busy.delete(identity)
      return null
    }
    return { ...base, before: snapshot.text, hashBefore: snapshot.hash, held: true }
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
  /** 写前原始文本；undefined = 同目标并发占用，没取到基线。 */
  before: string | null | undefined
  /** 写前原始字节的 SHA-256；没有基线时为 null。 */
  hashBefore: string | null
  /** 本次计划是否占住 busy；只有占住的一方负责释放。 */
  held: boolean
  target: unknown
  fs: any
  /** 触发本次写入的工具名，用于记录采集通道。 */
  tool: string
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
  const tool = String(exec.name ?? '')
  for (const path of paths) {
    try {
      if (plans.length >= BULK_LIMIT) throw new Error('capture target budget exceeded')
      const plan = await planOf(scope, state, path, tool)
      if (plan) plans.push(plan)
    } catch (error) {
      if (!state.stopped && !state.disposed.has(scope.sessionId)) recordGap(scope, exec, path, error)
      log.debug('待审采集跳过：' + path + ': ' + String(error))
    }
  }
  return plans
}

/** 上报阶段共享的调用事实。 */
interface WriteContext {
  scope: { cwd: string; sessionId: string; fs: any }
  exec: WriteExec
  isError: boolean
  receipts: Map<string, ToolReceipt>
}

/**
 * @author ddj 2026年10月30号 / 2026年11月25号
 * @description: 写工具执行前后各读一次，并用工具自己的回执对账；只有确认变化的调用才上报。
 * 任何采集异常都不改变工具结果。
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

  let result: unknown
  let failed: unknown
  try {
    result = await next()
    if (bulk && !state.stopped && !state.disposed.has(scope.sessionId)) await reconcileBulk(scope, exec, result, plans)
    if (name === 'apply_patch' && !state.stopped && !state.disposed.has(scope.sessionId)) {
      for (const diagnostic of patchDiagnostics(result)) recordGap(scope, exec, 'apply_patch', diagnostic)
    }
    return result
  } catch (error) {
    failed = error
    throw error
  } finally {
    await settle(scope, state, sink, exec, plans, result, failed)
  }
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 解析回执并逐条收尾；单条失败只记缺口，绝不改变工具结果与 busy 释放。
 * @param scope 工作区作用域
 * @param state 采集状态
 * @param sink 已确认写入的接收方
 * @param exec 工具分发上下文
 * @param plans 写前冻结的采集计划
 * @param result 工具结果
 * @param failure 工具抛出的错误（没有则 undefined）
 * @returns 无
 */
async function settle(
  scope: { cwd: string; sessionId: string; fs: any }, state: CaptureState, sink: (write: PendingWrite) => void,
  exec: WriteExec, plans: CapturePlan[], result: unknown, failure: unknown,
): Promise<void> {
  const flagError = Boolean((result as { isError?: unknown } | undefined)?.isError)
  const context: WriteContext = {
    scope, exec, isError: failure !== undefined || flagError, receipts: await receiptsFor(scope, exec, result),
  }
  for (const plan of plans) {
    try {
      await reportWrite(state, sink, plan, context)
    } catch (error) {
      if (!state.stopped && !state.disposed.has(scope.sessionId)) recordGap(scope, exec, plan.path, error)
      log.debug('待审上报失败：' + String(error))
    } finally {
      if (plan.held) state.busy.delete(plan.identity)
    }
  }
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 把回执里的路径解析成条目身份；解析不了的回执丢弃，退回快照判定。
 * @param scope 工作区作用域
 * @param exec 工具分发上下文
 * @param result 工具结果
 * @returns 身份 → 回执
 */
async function receiptsFor(
  scope: { cwd: string; sessionId: string; fs: any }, exec: WriteExec, result: unknown,
): Promise<Map<string, ToolReceipt>> {
  const map = new Map<string, ToolReceipt>()
  if (result === undefined) return map
  let receipts: ToolReceipt[]
  try {
    receipts = receiptsOf(String(exec.name), result, Boolean((result as { isError?: unknown }).isError))
  } catch {
    return map
  }
  for (const receipt of receipts) {
    try {
      const target = await scope.fs.resolve(receipt.path, { cwd: scope.cwd })
      const identity = scope.fs.processPath(target)
      if (typeof identity === 'string' && identity) map.set(identity, receipt)
    } catch {
      log.debug('回执路径不可解析：' + receipt.path)
    }
  }
  return map
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 该路径的旧缺口在本次写入被正式采用后清掉，避免缺口里留着已解决的原因。
 * @param plan 采集计划
 * @returns 无
 */
function clearGapsOf(plan: CapturePlan): void {
  for (const [key, gap] of captureGaps) {
    const identity = JSON.parse(key) as unknown[]
    if (gap.cwd === plan.cwd && gap.sessionId === plan.sessionId && identity[3] === plan.path) captureGaps.delete(key)
  }
}

/**
 * @author ddj 2026年11月04号 / 2026年11月25号
 * @description: 固定目标写后读回并按回执判定；不一致只记缺口，未确认变化一律不建条目。
 * @param state 采集生命周期状态
 * @param sink 已确认写入的接收方
 * @param plan 采集计划
 * @param context 本次调用的事实
 * @returns 无；读回失败只记日志
 */
async function reportWrite(
  state: CaptureState, sink: (write: PendingWrite) => void, plan: CapturePlan, context: WriteContext,
): Promise<void> {
  if (state.stopped || state.disposed.has(plan.sessionId)) return
  const receipt = context.receipts.get(plan.identity)
  // 没有基线也没有回执：这次调用改了什么无从判断，跳过（与旧行为一致，不造条目）。
  if (plan.before === undefined && !receipt) {
    log.debug('同目标并发写入且没有回执，跳过该次采集：' + plan.path)
    return
  }
  // 目录、provider 和目标均在写前冻结，切目录或卸载不能将内容串到其他工作区。
  const after = await readSnapshot(plan.fs, plan.target)
  if (state.stopped || state.disposed.has(plan.sessionId)) return
  if (after.text !== null && after.text.length > MAX_TEXT) throw new Error('capture text budget exceeded')
  clearGapsOf(plan)

  const judged = verdictOf({
    receipt, isError: context.isError, hasBaseline: plan.before !== undefined,
    beforeRead: plan.before ?? null, afterRead: after.text,
    hashBefore: plan.hashBefore, hashAfter: after.hash,
  })
  if (judged.verdict === 'unverified') {
    recordGap(context.scope, context.exec, plan.path, '回执与磁盘不一致，未记录该次调用：' + judged.reason)
    return
  }
  if (judged.verdict !== 'changed') {
    // 没记成条目却看到磁盘变了：可能是部分写入，也可能是别人写的，都不能冒充本次差异。
    if (plan.before !== undefined && plan.before !== after.text) {
      const reason = judged.verdict === 'failed'
        ? '工具报错后文件内容发生变化，无法判断是否本次写入：'
        : '回执声明没有变化但磁盘内容变了，未记录该次调用：'
      recordGap(context.scope, context.exec, plan.path, reason + judged.reason)
    }
    return
  }

  // 没取到基线时用回执的前像补，条目会标成归一基线，撤销前必须确认。
  const before = plan.before === undefined ? (receipt?.before ?? null) : plan.before
  if (before === after.text) return
  const write: PendingWrite = {
    cwd: plan.cwd, sessionId: plan.sessionId, path: plan.path, identity: plan.identity,
    before, after: after.text, now: Date.now(), tool: plan.tool,
    evidence: judged.evidence, verdict: judged.verdict,
  }
  if (plan.before === undefined && judged.evidence === 'authoritative') write.baseKind = 'normalized'
  sink(write)
}

/**
 * @author ddj 2026年10月29号
 * @description: 读取全文；只有明确缺失返回 null，不可读或超限错误保留失败语义。
 * @param fs 文件系统
 * @param target 目标
 * @returns 文本或 null
 */
/** 一次读盘的原始快照：文本用于写回，哈希用于与工具回执对账。 */
export interface TextSnapshot {
  /** 原始文本；null = 文件不存在。 */
  text: string | null
  /** 原始字节的 SHA-256；文件不存在时为 null。 */
  hash: string | null
}

/**
 * @author ddj 2026年10月29号 / 2026年11月25号
 * @description: 读原始字节并同时给出文本与 sha256；只有明确缺失返回空，不可读或超限保留失败语义。
 * @param fs 文件系统
 * @param target 目标
 * @param signal 取消信号
 * @returns 文本与哈希
 */
export async function readSnapshot(fs: any, target: any, signal?: AbortSignal): Promise<TextSnapshot> {
  try {
    if (typeof fs.readBytes !== 'function') throw new Error('Raw byte capture unavailable')
    const bytes = await fs.readBytes(target, signal, MAX_TEXT)
    if (bytes === null || bytes === undefined) return { text: null, hash: null }
    const payload = Buffer.from(bytes)
    return { text: rawText(rawReviewFile(payload)), hash: createHash('sha256').update(payload).digest('hex') }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'FS_NOT_FOUND') return { text: null, hash: null }
    throw error
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 读取全文；只有明确缺失返回 null，不可读或超限错误保留失败语义。
 * @param fs 文件系统
 * @param target 目标
 * @param signal 取消信号
 * @returns 文本或 null
 */
export async function readText(fs: any, target: any, signal?: AbortSignal): Promise<string | null> {
  return (await readSnapshot(fs, target, signal)).text
}
