/**
 * client HTML 计划动作桥测试：可选服务探测、官方答案构造、命令与兜底路径。
 * @author ddj 2026年11月21号
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  answerPlanReview,
  exitPlanMode,
  fillComposer,
  installHtmlPlanActions,
  readPendingReview,
  readPlanProjection,
  revealPlanReview,
  submitPlanResponse,
  subscribePlanFaces,
} from '../src/client/htmlPlan/planActions.js'

/** 投影 face 假实现（可手动触发订阅回调）。 */
function fakeFace(snapshot: unknown) {
  const listeners: Array<() => void> = []
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.push(fn)
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) }
    },
    emit: () => { for (const fn of [...listeners]) fn() },
    count: () => listeners.length,
  }
}

/** 构造带 sessions/remote/userQuestionPanels 的假 ctx。 */
function fakeCtx(overrides: Record<string, unknown> = {}) {
  const plan = fakeFace(overrides.plan ?? { active: true, pending: false })
  const questions = fakeFace(overrides.questions ?? [])
  const calls: { answer: unknown[][]; execute: unknown[][]; reveal: unknown[][] } = { answer: [], execute: [], reveal: [] }
  const ctx = {
    get: (name: string) => {
      if (name === 'sessions') {
        return { binding: () => ({ session: { projections: { faceOf: (key: string) => (key === 'plan' ? plan : key === 'userQuestions' ? questions : undefined) } } }) }
      }
      if (name === 'remote.userQuestions' && overrides.questionsService !== null) {
        return { answer: async (...args: unknown[]) => { calls.answer.push(args); return overrides.answerResult ?? { ok: true, value: true } } }
      }
      if (name === 'remote.commands' && overrides.commandsService !== null) {
        return { execute: async (...args: unknown[]) => { calls.execute.push(args); return overrides.execResult ?? { ok: true } } }
      }
      if (name === 'userQuestionPanels' && overrides.panelsService !== null) {
        return { reveal: (...args: unknown[]) => { calls.reveal.push(args); return true } }
      }
      if (name === 'uiSession' && overrides.uiSession !== undefined) return overrides.uiSession
      return undefined
    },
  }
  return { ctx, calls, plan, questions }
}

const REVIEW = [{ callId: 'c1', questions: [{ id: 'plan-review', intent: 'plan-review', options: ['Approve', 'Keep planning'] }] }]

/** 在线 PendingQuestion 假实现（带 intent 与 answer 通道）。 */
function livePending(answers: unknown[]) {
  return {
    kind: 'plan-review',
    sessionId: 's1',
    callId: 'c1',
    questions: [{
      id: 'plan-review',
      intent: { kind: 'plan-review', approve: 'Approve', callId: 'c1' },
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    }],
    answer: async (answer: unknown) => { answers.push(answer) },
  }
}
afterEach(() => { installHtmlPlanActions({ get: () => undefined })( ) })

describe('状态读取与订阅', () => {
  it('读 plan 投影与待审批；订阅变化会回调', () => {
    const { ctx, plan, questions } = fakeCtx({ questions: REVIEW })
    const dispose = installHtmlPlanActions(ctx, { appendText: async () => 'ok' })
    expect(readPlanProjection('s1')).toEqual({ active: true, pending: false })
    expect(readPendingReview('s1')?.callId).toBe('c1')
    let fired = 0
    const off = subscribePlanFaces('s1', () => { fired += 1 })
    plan.emit()
    questions.emit()
    expect(fired).toBe(2)
    off()
    plan.emit()
    expect(fired).toBe(2)
    dispose()
  })

  it('未安装动作桥时一律不可用，不抛错', () => {
    expect(readPlanProjection('s1')).toBeUndefined()
    expect(readPendingReview('s1')).toBeNull()
    expect(revealPlanReview('s1')).toBe(false)
    expect(subscribePlanFaces('s1', () => {})()).toBeUndefined()
  })
})

describe('answerPlanReview', () => {
  it('批准：用批准标签作答官方 callId', async () => {
    const { ctx, calls } = fakeCtx({ questions: REVIEW })
    const dispose = installHtmlPlanActions(ctx, { appendText: async () => 'ok' })
    expect(await answerPlanReview('s1', true)).toEqual({ ok: true })
    expect(calls.answer).toEqual([['s1', 'c1', { answers: [{ id: 'plan-review', selected: ['Approve'], custom: '' }] }]])
    dispose()
  })

  it('继续规划：用 Keep planning 标签作答', async () => {
    const { ctx, calls } = fakeCtx({ questions: REVIEW })
    const dispose = installHtmlPlanActions(ctx, { appendText: async () => 'ok' })
    expect((await answerPlanReview('s1', false)).ok).toBe(true)
    expect((calls.answer[0][2] as { answers: Array<{ selected: string[] }> }).answers[0].selected).toEqual(['Keep planning'])
    dispose()
  })

  it('无待审批/服务缺失/官方拒绝都返回可读错误', async () => {
    const empty = fakeCtx({ questions: [] })
    const d1 = installHtmlPlanActions(empty.ctx, { appendText: async () => 'ok' })
    expect((await answerPlanReview('s1', true)).ok).toBe(false)
    d1()

    const noService = fakeCtx({ questions: REVIEW, questionsService: null })
    const d2 = installHtmlPlanActions(noService.ctx, { appendText: async () => 'ok' })
    const failed = await answerPlanReview('s1', true)
    expect(failed.ok).toBe(false)
    expect(String(failed.error)).toContain('不支持')
    d2()

    const rejected = fakeCtx({ questions: REVIEW, answerResult: { ok: false, error: { message: 'gone' } } })
    const d3 = installHtmlPlanActions(rejected.ctx, { appendText: async () => 'ok' })
    const rejectedResult = await answerPlanReview('s1', true)
    expect(rejectedResult).toEqual({ ok: false, error: 'gone' })
    d3()
  })
})

describe('exitPlanMode / reveal / fillComposer', () => {
  it('退出走官方 /plan off 命令', async () => {
    const { ctx, calls } = fakeCtx()
    const dispose = installHtmlPlanActions(ctx, { appendText: async () => 'ok' })
    expect(await exitPlanMode('s1')).toEqual({ ok: true })
    expect(calls.execute).toEqual([['s1', '/plan off', []]])
    dispose()
  })

  it('命令服务缺失时给出提示而非抛错', async () => {
    const { ctx } = fakeCtx({ commandsService: null })
    const dispose = installHtmlPlanActions(ctx, { appendText: async () => 'ok' })
    const result = await exitPlanMode('s1')
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('不支持')
    dispose()
  })

  it('兜底打开官方审批卡片', () => {
    const { ctx, calls } = fakeCtx({ questions: REVIEW })
    const dispose = installHtmlPlanActions(ctx, { appendText: async () => 'ok' })
    expect(revealPlanReview('s1')).toBe(true)
    expect(calls.reveal).toEqual([['s1', 'c1']])
    dispose()
  })

  it('填稿只调注入的 appendText，不自动发送', async () => {
    const filled: Array<[string | undefined, string]> = []
    const { ctx } = fakeCtx()
    const dispose = installHtmlPlanActions(ctx, {
      appendText: async (id, text) => { filled.push([id, text]); return 'ok' },
    })
    expect(await fillComposer('s1', '答复正文')).toEqual({ ok: true })
    expect(filled).toEqual([['s1', '答复正文']])
    const failed = await fillComposer('s1', '   ')
    expect(failed.ok).toBe(false)
    dispose()
  })
})
describe('submitPlanResponse（一键回复）', () => {
  it('发送成功：把答复交给注入的 sendTask', async () => {
    const sent: Array<[string | undefined, string]> = []
    const { ctx } = fakeCtx()
    const dispose = installHtmlPlanActions(ctx, {
      appendText: async () => 'ok',
      sendTask: async (id, text) => { sent.push([id, text]); return { status: 'accepted' } },
    })
    expect(await submitPlanResponse('s1', '  答复正文  ')).toEqual({ ok: true })
    expect(sent).toEqual([['s1', '答复正文']])
    dispose()
  })

  it('空答复拒绝，且不调用发送', async () => {
    const sent: string[] = []
    const { ctx } = fakeCtx()
    const dispose = installHtmlPlanActions(ctx, {
      appendText: async () => 'ok',
      sendTask: async (_id, text) => { sent.push(text); return { status: 'accepted' } },
    })
    expect((await submitPlanResponse('s1', '   ')).ok).toBe(false)
    expect(sent).toEqual([])
    dispose()
  })

  it('待审批：先「同意执行」再发送，顺序正确', async () => {
    const { ctx, calls } = fakeCtx({ questions: REVIEW })
    const answerAtSend: number[] = []
    const dispose = installHtmlPlanActions(ctx, {
      appendText: async () => 'ok',
      sendTask: async () => { answerAtSend.push(calls.answer.length); return { status: 'submitted' } },
    })
    expect(await submitPlanResponse('s1', '反馈正文')).toEqual({ ok: true })
    expect(calls.answer).toHaveLength(1)
    expect((calls.answer[0][2] as { answers: Array<{ selected: string[] }> }).answers[0].selected).toEqual(['Approve'])
    expect(answerAtSend).toEqual([1])
    dispose()
  })

  it('「同意执行」失败时不发送答复', async () => {
    const { ctx } = fakeCtx({ questions: REVIEW, answerResult: { ok: false, error: { message: 'gone' } } })
    let sent = 0
    const dispose = installHtmlPlanActions(ctx, {
      appendText: async () => 'ok',
      sendTask: async () => { sent += 1; return { status: 'accepted' } },
    })
    const result = await submitPlanResponse('s1', '反馈')
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('gone')
    expect(sent).toBe(0)
    dispose()
  })

  it('发送被拒/不可用返回可读原因', async () => {
    const { ctx } = fakeCtx()
    const dispose = installHtmlPlanActions(ctx, {
      appendText: async () => 'ok',
      sendTask: async () => ({ status: 'rejected', message: 'composer busy' }),
    })
    const rejected = await submitPlanResponse('s1', '答复')
    expect(rejected.ok).toBe(false)
    expect(String(rejected.error)).toContain('composer busy')
    dispose()

    const unavailable = fakeCtx()
    const d2 = installHtmlPlanActions(unavailable.ctx, {
      appendText: async () => 'ok',
      sendTask: async () => ({ status: 'unavailable' }),
    })
    const result = await submitPlanResponse('s1', '答复')
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('不可用')
    d2()
  })


  it('在线卡片：标签取自 intent，且不依赖投影', async () => {
    const answers: unknown[] = []
    const pending = livePending(answers)
    const { ctx, calls } = fakeCtx({
      uiSession: { sessionStatus: { getSnapshot: () => new Map([['s1', { pendingInteraction: pending }]]) } },
    })
    const dispose = installHtmlPlanActions(ctx, { appendText: async () => 'ok' })
    const review = readPendingReview('s1')
    expect(review?.approveLabel).toBe('Approve')
    expect(review?.keepLabel).toBe('Keep planning')
    expect(review?.callId).toBe('c1')
    expect(await answerPlanReview('s1', true)).toEqual({ ok: true })
    expect(answers).toEqual([{ answers: [{ id: 'plan-review', selected: ['Approve'] }] }])
    expect(calls.answer).toEqual([])
    dispose()
  })

  it('在线卡片 + 回复：先同意执行再发送；失败则不发送', async () => {
    const answers: unknown[] = []
    const sequence: string[] = []
    const pending = livePending(answers)
    const first = fakeCtx({
      uiSession: {
        sessionStatus: {
          getSnapshot: () => new Map([['s1', { pendingInteraction: { ...pending, answer: async (value: unknown) => { sequence.push('approve'); answers.push(value) } } }]]),
        },
      },
    })
    const dispose = installHtmlPlanActions(first.ctx, {
      appendText: async () => 'ok',
      sendTask: async () => { sequence.push('send'); return { status: 'accepted' } },
    })
    expect(await submitPlanResponse('s1', '答复')).toEqual({ ok: true })
    expect(sequence).toEqual(['approve', 'send'])
    dispose()

    const failing = fakeCtx({
      uiSession: {
        sessionStatus: {
          getSnapshot: () => new Map([['s1', { pendingInteraction: { ...pending, answer: async () => { throw new Error('gone') } } }]]),
        },
      },
    })
    const d2 = installHtmlPlanActions(failing.ctx, {
      appendText: async () => 'ok',
      sendTask: async () => { sequence.push('send'); return { status: 'accepted' } },
    })
    const result = await submitPlanResponse('s1', '答复')
    expect(result.ok).toBe(false)
    expect(sequence).toEqual(['approve', 'send'])
    d2()
  })
  it('动作桥未安装时失败', async () => {
    const result = await submitPlanResponse('s1', '答复')
    expect(result.ok).toBe(false)
  })
})
