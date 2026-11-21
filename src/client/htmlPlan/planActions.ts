/**
 * dsh-vscode-mode client — HTML 计划页的官方动作桥（状态读取、审批、退出、回填）。
 *
 * 所有官方客户端服务都是可选探测：缺失或版本不符时返回可读错误，绝不抛、绝不伪造批准。
 * 审批仍走官方 ask_user_question 通道（remote.userQuestions.answer）；退出计划模式走
 * 官方命令（remote.commands.execute('/plan off')），与 composer 计划徽标同源。
 * @author ddj 2026年11月21号
 */
import { createAddToConversation } from '../addToConversation.js'
import { findPendingReview, reviewAnswerOf, reviewLabelsOf, type PendingReview } from './planPage.js'

/** 客户端上下文的最小结构面。 */
export interface PlanActionCtx {
  get: (name: string) => unknown
}

/** 动作结果（失败带可展示原因）。 */
export interface PlanActionResult {
  ok: boolean
  error?: string
}

/** 已安装的动作宿主（index.ts 装配一次；未安装时所有动作返回未就绪）。 */
let host: {
  ctx: PlanActionCtx
  appendText: (sessionId: string | undefined, text: string) => Promise<string>
  sendTask: (sessionId: string | undefined, text: string) => Promise<PlanActionResult>
} | null = null
/** 取异常的展示文案。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

/** 失败结果。 */
function fail(error: string): PlanActionResult {
  return { ok: false, error }
}

/** 成功结果。 */
function ok(): PlanActionResult {
  return { ok: true }
}

/** 结构化探测可选服务（缺失/抛错一律 undefined）。 */
function serviceOf(ctx: PlanActionCtx, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 取会话绑定（sessions.binding）；服务缺失返回 undefined。 */
function bindingOf(ctx: PlanActionCtx, sessionId: string): unknown {
  const sessions = serviceOf(ctx, 'sessions') as { binding?: (id: string) => unknown } | undefined
  if (!sessions || typeof sessions.binding !== 'function') return undefined
  try {
    return sessions.binding(sessionId)
  } catch {
    return undefined
  }
}

/** 取会话投影 face（缺失/抛错返回 undefined）。 */
function faceOf(ctx: PlanActionCtx, sessionId: string, key: string): unknown {
  const binding = bindingOf(ctx, sessionId) as { session?: { projections?: { faceOf?: (name: string) => unknown } } } | undefined
  const faceOfFn = binding?.session?.projections?.faceOf
  if (typeof faceOfFn !== 'function') return undefined
  try {
    return faceOfFn.call(binding!.session!.projections, key)
  } catch {
    return undefined
  }
}

/** 投影 face 快照（无 face 返回 undefined）。 */
function faceSnapshot(face: unknown): unknown {
  const getSnapshot = (face as { getSnapshot?: () => unknown } | undefined)?.getSnapshot
  return typeof getSnapshot === 'function' ? getSnapshot.call(face) : undefined
}

/** 读 plan 投影快照（{ active, pending } 或 undefined）。 */
export function readPlanProjection(sessionId: string): unknown {
  if (!host) return undefined
  return faceSnapshot(faceOf(host.ctx, sessionId, 'plan'))
}

/** 在线待审批的会话卡片（PendingQuestion 实例：带 answer 与 intent）。 */
interface LiveReview {
  pending: { answer: (answer: unknown) => Promise<unknown> }
  labels: { questionId: string; approveLabel: string; keepLabel: string | null }
  callId: string
}

/**
 * 从 uiSession 的 Session 状态里取当前 plan-review 卡片。
 * 计划审批是阻塞请求，不进 userQuestions 投影；只有 pendingInteraction 带着 intent 与实时候选。
 * @author ddj 2026年11月21号
 * @param sessionId 会话 id
 * @returns 在线卡片与解析出的标签，或 null
 */
function liveReviewOf(sessionId: string): LiveReview | null {
  if (!host) return null
  const ui = serviceOf(host.ctx, 'uiSession') as { sessionStatus?: { getSnapshot?: () => unknown } } | undefined
  const snapshot = ui?.sessionStatus?.getSnapshot?.()
  const get = (snapshot as { get?: (id: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return null
  let status: unknown
  try {
    status = get.call(snapshot, sessionId)
  } catch {
    return null
  }
  const pending = status !== null && typeof status === 'object'
    ? (status as { pendingInteraction?: unknown }).pendingInteraction
    : undefined
  if (pending === null || typeof pending !== 'object') return null
  const row = pending as { kind?: unknown; sessionId?: unknown; callId?: unknown; questions?: unknown; answer?: unknown }
  if (row.kind !== 'plan-review' || typeof row.answer !== 'function') return null
  if (row.sessionId !== undefined && String(row.sessionId) !== sessionId) return null
  const labels = reviewLabelsOf(Array.isArray(row.questions) ? row.questions[0] : undefined)
  if (!labels) return null
  const callId = typeof row.callId === 'string' ? row.callId : ''
  return { pending: pending as LiveReview['pending'], labels, callId }
}

/** 读当前待审批的 plan-review（先看在线卡片，再退回投影）。 */
export function readPendingReview(sessionId: string): PendingReview | null {
  if (!host) return null
  const live = liveReviewOf(sessionId)
  if (live) {
    return { callId: live.callId, questionId: live.labels.questionId, approveLabel: live.labels.approveLabel, keepLabel: live.labels.keepLabel }
  }
  return findPendingReview(faceSnapshot(faceOf(host.ctx, sessionId, 'userQuestions')))
}

/** 订阅 plan 与 userQuestions 投影变化；返回合并的退订器。 */
export function subscribePlanFaces(sessionId: string, listener: () => void): () => void {
  if (!host) return () => {}
  const offs: Array<() => void> = []
  for (const key of ['plan', 'userQuestions']) {
    const face = faceOf(host.ctx, sessionId, key) as { subscribe?: (fn: () => void) => unknown } | undefined
    if (!face || typeof face.subscribe !== 'function') continue
    try {
      const off = face.subscribe(() => listener())
      if (typeof off === 'function') offs.push(off as () => void)
    } catch {
      /* 订阅失败不影响其他 face */
    }
  }
  return () => {
    for (const off of offs) {
      try {
        off()
      } catch {
        /* 退订异常忽略 */
      }
    }
  }
}

/** 官方 Typert 结果解包：{ ok, value } / { ok:false, error } / 裸值。 */
function unwrap(result: unknown): PlanActionResult {
  if (result === null || typeof result !== 'object') return result === false ? fail('官方服务拒绝了本次操作') : ok()
  const row = result as { ok?: unknown; error?: unknown }
  if (row.ok === false) {
    const detail = row.error as { message?: unknown } | string | undefined
    const message = typeof detail === 'string' ? detail : (typeof detail?.message === 'string' ? detail.message : '官方服务拒绝了本次操作')
    return fail(message)
  }
  return ok()
}

/**
 * 安装动作宿主（index.ts 装配一次）。
 * @author ddj 2026年11月21号
 * @param ctx 客户端上下文
 * @returns 幂等卸载器
 */
/** 安装选项（appendText / sendTask 可注入，便于单测；生产缺省用会话输入门面）。 */
export interface HtmlPlanActionOptions {
  appendText?: (sessionId: string | undefined, text: string) => Promise<string>
  sendTask?: (sessionId: string | undefined, text: string) => Promise<unknown>
}

/**
 * 把会话投递结果归一成动作结果：只有 accepted/submitted 视为成功。
 * @author ddj 2026年11月21号
 * @param raw TaskSendResult 或布尔裸值
 * @returns 动作结果
 */
function sendResultOf(raw: unknown): PlanActionResult {
  if (raw === true) return ok()
  if (raw === false) return fail('会话拒绝接收答复')
  if (raw === null || typeof raw !== 'object') return fail('发送结果未知')
  const row = raw as { status?: unknown; message?: unknown; ok?: unknown }
  if (row.ok === true) return ok()
  if (row.ok === false) return fail(typeof row.message === 'string' ? row.message : '发送失败')
  const status = typeof row.status === 'string' ? row.status : ''
  if (status === 'accepted' || status === 'submitted') return ok()
  const detail = typeof row.message === 'string' && row.message ? '：' + row.message : ''
  if (status === 'rejected') return fail('会话拒绝接收答复' + detail)
  if (status === 'unavailable') return fail('对话输入不可用' + detail)
  if (status === 'cancelled') return fail('发送已取消' + detail)
  return fail('发送结果未知' + detail)
}

export function installHtmlPlanActions(ctx: PlanActionCtx, options: HtmlPlanActionOptions = {}): () => void {
  const injectedAppend = options.appendText
  const injectedSend = options.sendTask
  const addToConversation = injectedAppend && injectedSend ? null : createAddToConversation(ctx as never)
  const sendInjected = injectedSend
  const conversations = addToConversation
  host = {
    ctx,
    appendText: injectedAppend ?? ((sessionId, text) => conversations!.appendText(sessionId, text)),
    sendTask: typeof sendInjected === 'function'
      ? async (sessionId, text) => sendResultOf(await sendInjected(sessionId, text))
      : async (sessionId, text) => {
          const send = conversations?.sendTaskResult
          if (typeof send !== 'function') return fail('当前 DSH 不支持直接发送，请用「填入对话输入框」')
          return sendResultOf(await send.call(conversations, sessionId, text))
        },
  }
  return () => {
    host = null
  }
}

/**
 * 回答官方 plan-review：批准 = 选批准标签；不批准 = 选继续规划标签（若官方提供）。
 * @author ddj 2026年11月21号
 * @param sessionId 会话 id
 * @param approve 是否批准
 * @returns 动作结果
 */
export async function answerPlanReview(sessionId: string, approve: boolean): Promise<PlanActionResult> {
  if (!host) return fail('计划动作桥未就绪，请在对话审批卡片中操作')
  if (!sessionId) return fail('当前没有活动会话')
  const live = liveReviewOf(sessionId)
  if (live) {
    const label = approve ? live.labels.approveLabel : live.labels.keepLabel
    if (!label) return fail(approve ? '该审批没有可用的批准选项' : '官方审批没有「继续规划」选项，请在对话中要求修改')
    try {
      await live.pending.answer({ answers: [{ id: live.labels.questionId, selected: [label] }] })
      return ok()
    } catch (error) {
      return fail('提交审批失败：' + messageOf(error))
    }
  }
  const review = readPendingReview(sessionId)
  if (!review) return fail('没有待审批的计划（可能已在别处审批）')
  const answer = reviewAnswerOf(review, approve)
  if (!answer) return fail(approve ? '该审批没有可用的批准选项' : '官方审批没有「继续规划」选项，请在对话中要求修改')
  const questions = serviceOf(host.ctx, 'remote.userQuestions') as { answer?: (id: string, callId: string, value: unknown) => Promise<unknown> } | undefined
  if (!questions || typeof questions.answer !== 'function') {
    return fail('当前 DSH 不支持在插件内作答，请在对话审批卡片中操作')
  }
  try {
    return unwrap(await questions.answer(sessionId, review.callId, answer))
  } catch (error) {
    return fail('提交审批失败：' + messageOf(error))
  }
}

/**
 * 退出计划模式（等价 composer 计划徽标的 /plan off）。
 * @author ddj 2026年11月21号
 * @param sessionId 会话 id
 * @returns 动作结果
 */
export async function exitPlanMode(sessionId: string): Promise<PlanActionResult> {
  if (!host) return fail('计划动作桥未就绪，请点 composer 计划徽标退出')
  if (!sessionId) return fail('当前没有活动会话')
  const commands = serviceOf(host.ctx, 'remote.commands') as { execute?: (id: string, line: string, attachments: unknown[]) => Promise<unknown> } | undefined
  if (!commands || typeof commands.execute !== 'function') {
    return fail('当前 DSH 不支持在插件内执行命令，请点 composer 计划徽标退出')
  }
  try {
    return unwrap(await commands.execute(sessionId, '/plan off', []))
  } catch (error) {
    return fail('退出计划模式失败：' + messageOf(error))
  }
}

/**
 * 发送计划页答复给 agent：有待审批时先提交「继续规划」，再发送反馈正文。
 * @author ddj 2026年11月21号
 * @param sessionId 会话 id
 * @param text 答复 markdown
 * @returns 动作结果（失败带原因，答复文本不丢）
 */
export async function submitPlanResponse(sessionId: string, text: string): Promise<PlanActionResult> {
  if (!host) return fail('计划动作桥未就绪')
  if (!sessionId) return fail('当前没有活动会话')
  const body = String(text ?? '').trim()
  if (!body) return fail('答复为空：先在页面里作答再点「回复」')
  // 有待审批卡片：先结算为「同意执行」，再把答复作为用户消息送出；失败则不发，避免半截状态。
  if (readPendingReview(sessionId)) {
    const approved = await answerPlanReview(sessionId, true)
    if (!approved.ok) return fail('先同意执行失败，答复未发送：' + String(approved.error ?? ''))
  }
  try {
    return await host.sendTask(sessionId, body)
  } catch (error) {
    return fail('发送失败：' + messageOf(error))
  }
}

/**
 * 打开官方审批卡片（兜底入口；能力缺失返回 false）。
 * @author ddj 2026年11月21号
 * @param sessionId 会话 id
 * @returns 是否已请求官方卡片
 */
export function revealPlanReview(sessionId: string): boolean {
  if (!host) return false
  const review = readPendingReview(sessionId)
  if (!review) return false
  const panels = serviceOf(host.ctx, 'userQuestionPanels') as { reveal?: (id: string, callId: string) => unknown } | undefined
  if (!panels || typeof panels.reveal !== 'function') return false
  try {
    return panels.reveal(sessionId, review.callId) !== false
  } catch {
    return false
  }
}

/**
 * 把页面答复填入对话输入框（复用既有引用/纯文本注入通道，不自动发送）。
 * @author ddj 2026年11月21号
 * @param sessionId 会话 id
 * @param text 答复 markdown（纯文本写入）
 * @returns 动作结果
 */
export async function fillComposer(sessionId: string, text: string): Promise<PlanActionResult> {
  if (!host) return fail('计划动作桥未就绪')
  if (!sessionId) return fail('当前没有活动会话')
  if (!String(text ?? '').trim()) return fail('没有可填入的答复：先在页面里点 Copy response')
  try {
    const outcome = await host.appendText(sessionId, String(text))
    return outcome === 'ok' || outcome === 'busy' ? ok() : fail('写入输入框失败（' + outcome + '）')
  } catch (error) {
    return fail('写入输入框失败：' + messageOf(error))
  }
}
