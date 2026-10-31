import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/client/openReceipt.js', () => ({ requestOpen: vi.fn().mockResolvedValue(true) }))
import { requestOpen } from '../src/client/openReceipt.js'
import { installPlanDirect } from '../src/client/planDirect.js'
import { clearPlanState, rememberPlan } from '../src/client/planState.js'
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); clearPlanState() })

/** @private @author ddj 2026年10月31号 @param initial Snapshot. @returns Observable fixture with explicit synchronous publication. */
function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    publish: (next: T) => { value = next; for (const fn of [...listeners]) fn() }, listeners }
}
/** @private @author ddj 2026年10月31号 @param status Resource state. @param value Resource value. @returns Resource stream fixture. */
function stream(status: string, value?: unknown) {
  const state = store<{ status: string; value?: unknown }>({ status, value })
  return { getSnapshot: state.getSnapshot, subscribe: state.subscribe, publish: state.publish, listeners: state.listeners }
}
/** @private @author ddj 2026年10月31号 @param resources Optional resources service. @returns Context fixture and independent scope/session stores. */
function harness(resources?: unknown) {
  const scope = store({ key: 's' })
  const list = store({ byId: { s: { cwd: '/work' }, other: { cwd: '/work' } } })
  const original = vi.fn()
  const service = { openResource: original }
  const services: Record<string, unknown> = { uiSession: { current: scope }, sessions: { list }, resources }
  const ctx = { get: (name: string) => services[name] }
  return { ctx, scope, list, service, original }
}
const PLAN = 'dsh-resource://plan/s/c'
const REVIEW = 'dsh-resource://plan-review/s/window%3A1'

describe('plan direct routing', () => {
  it('passes non-plan addresses through without touching the editor', () => {
    const h = harness()
    const direct = installPlanDirect(h.ctx, h.service)
    h.service.openResource('dsh-resource://file/s/README.md', { kind: 'file' })
    expect(h.original).toHaveBeenCalledWith('dsh-resource://file/s/README.md', { kind: 'file' })
    expect(requestOpen).not.toHaveBeenCalled()
    direct.dispose()
  })

  it('routes transient review payloads into the editor instead of opening a sidebar tab', () => {
    const h = harness()
    const direct = installPlanDirect(h.ctx, h.service)
    const params = { planReview: { markdown: '# 待审批\n完整计划' } }
    h.service.openResource(REVIEW, { kind: 'plan', params })
    expect(h.original).not.toHaveBeenCalled()
    expect(requestOpen).toHaveBeenCalledWith(null, undefined, undefined, 's', expect.objectContaining({
      preview: true, timeoutMs: 5_000,
      plan: { address: REVIEW, markdown: '# 待审批\n完整计划', title: '待审批' },
    }))
    direct.dispose()
  })

  it('reuses a cached plan for submitted plan addresses without a resource lookup', () => {
    const h = harness()
    const plan = { address: PLAN, markdown: '# 实施计划\n正文', title: '实施计划' }
    rememberPlan(plan)
    const direct = installPlanDirect(h.ctx, h.service)
    h.service.openResource(PLAN)
    expect(h.original).not.toHaveBeenCalled()
    expect(vi.mocked(requestOpen).mock.calls[0][4]!.plan).toEqual(plan)
    direct.dispose()
  })

  it('defers cross-session and subagent addresses to the official method', () => {
    const h = harness()
    const direct = installPlanDirect(h.ctx, h.service)
    for (const address of ['dsh-resource://plan/other/c', 'dsh-resource://plan/subagent/s/k/one-shot/c']) {
      rememberPlan({ address, markdown: '# 计划\n正文', title: '计划' })
      h.service.openResource(address)
    }
    expect(h.original).toHaveBeenCalledTimes(2)
    expect(requestOpen).not.toHaveBeenCalled()
    h.scope.publish({ key: 'other' })
    h.service.openResource(PLAN)
    expect(h.original).toHaveBeenCalledTimes(3)
    expect(requestOpen).not.toHaveBeenCalled()
    direct.dispose()
  })

  it('resolves a live resource snapshot and routes it', () => {
    const h = harness({ source: () => stream('live', { markdown: '# 计划\n正文' }) })
    const direct = installPlanDirect(h.ctx, h.service)
    h.service.openResource(PLAN)
    expect(h.original).not.toHaveBeenCalled()
    expect(vi.mocked(requestOpen).mock.calls[0][4]!.plan).toEqual({ address: PLAN, markdown: '# 计划\n正文', title: '计划' })
    direct.dispose()
  })

  it('stops waiting for a loading resource and falls back after the deadline', () => {
    vi.useFakeTimers()
    const streamed = stream('loading')
    const h = harness({ source: () => streamed })
    const direct = installPlanDirect(h.ctx, h.service)
    h.service.openResource(PLAN)
    expect(h.original).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_500)
    expect(h.original).toHaveBeenCalledWith(PLAN, undefined)
    expect(streamed.listeners.size).toBe(0)
    streamed.publish({ status: 'live', value: { markdown: '# 计划\n正文' } })
    expect(requestOpen).not.toHaveBeenCalled()
    direct.dispose()
  })

  it('falls back when the editor never reports readiness', async () => {
    vi.mocked(requestOpen).mockResolvedValueOnce(false)
    const h = harness()
    rememberPlan({ address: PLAN, markdown: '# 计划\n正文', title: '计划' })
    const direct = installPlanDirect(h.ctx, h.service)
    h.service.openResource(PLAN, { kind: 'plan' })
    expect(h.original).not.toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.original).toHaveBeenCalledWith(PLAN, { kind: 'plan' })
    direct.dispose()
  })

  it('coalesces repeated clicks and aborts in-flight routing on disposal', async () => {
    let complete!: (ok: boolean) => void
    vi.mocked(requestOpen).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const h = harness()
    rememberPlan({ address: PLAN, markdown: '# 计划\n正文', title: '计划' })
    const direct = installPlanDirect(h.ctx, h.service)
    h.service.openResource(PLAN)
    h.service.openResource(PLAN)
    expect(requestOpen).toHaveBeenCalledTimes(1)
    const signal = vi.mocked(requestOpen).mock.calls[0][4]!.signal!
    direct.dispose()
    expect(signal.aborted).toBe(true)
    expect(h.service.openResource).toBe(h.original)
    complete(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(h.original).not.toHaveBeenCalled()
  })

  it('keeps the native bypass usable when the service refuses the wrapper', () => {
    const h = harness()
    Object.defineProperty(h.service, 'openResource', { get: () => h.original, set: () => { throw new Error('readonly') }, configurable: true })
    const direct = installPlanDirect(h.ctx, h.service)
    expect(h.service.openResource).toBe(h.original)
    direct.native(PLAN, { kind: 'plan' })
    expect(h.original).toHaveBeenCalledWith(PLAN, { kind: 'plan' })
    direct.dispose()
  })
})
