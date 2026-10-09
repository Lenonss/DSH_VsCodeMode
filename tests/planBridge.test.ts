import { afterEach, describe, expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }))
vi.mock('react', () => ({ default: {
  useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => void) => hooks.effects.push(effect),
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
} }))
vi.mock('../src/client/openReceipt.js', () => ({ requestOpen: vi.fn().mockResolvedValue(true) }))
import { requestOpen } from '../src/client/openReceipt.js'
import { installPlanBridge } from '../src/client/planBridge.js'
import type { PlanWindow } from '../src/client/planState.js'
afterEach(() => { vi.clearAllMocks(); hooks.effects.length = 0 })

/** @private @author ddj 2026年10月08号 @param initial Snapshot. @returns Observable fixture with explicit synchronous publication. */
function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    publish: (next: T) => { value = next; for (const fn of [...listeners]) fn() }, listeners }
}
/** @private @author ddj 2026年10月08号 @returns Optional-service context and independent scope/event stores. */
function harness() {
  const scope = store({ key: 's' })
  const feed = store<PlanWindow>({ revision: 0, entries: [], change: { kind: 'replace' } })
  const list = store({ byId: { s: { cwd: '/work' }, other: { cwd: '/work' } } })
  let body: any
  const offType = vi.fn(), offBody = vi.fn()
  const register = vi.fn(() => offType)
  const service = { openTab: vi.fn(), openResource: vi.fn() }
  const services: Record<string, unknown> = {
    uiSession: { current: scope }, sessions: { list, binding: () => ({ eventSource: feed }) },
    sidebarRightTabs: { register }, sidebarRight: service,
  }
  const ctx = { get: (name: string) => services[name], slots: {
    inject: (_name: string, fn: () => unknown) => fn(),
    register: (_spec: object, render: unknown) => { body = render; return offBody },
  } }
  return { ctx, scope, feed, list, services, service, register, offType, offBody, body: () => body }
}
/** @private @author ddj 2026年10月08号 @param revision Revision. @param id Call id. @returns Successful live plan file write. */
function written(revision: number, id: string): PlanWindow {
  const entries = [{ type: 'event', event: { type: 'tool/call', seq: revision * 2, data: { callId: id, name: 'write', arguments: '{"file_path":"plans/a.md","content":"# Plan"}' } } },
    { type: 'event', event: { type: 'tool/result', seq: revision * 2 + 1, data: { message: { toolCallId: id, isError: false } } } }]
  return { revision, entries, change: { kind: 'append', entries } }
}

describe('plan bridge lifecycle', () => {
  it('claims only plan resources and opens live writes with preview receipts', () => {
    const h = harness()
    const off = installPlanBridge(h.ctx, vi.fn())
    const definition = h.register.mock.calls[0][0] as any
    expect(definition.kind).toBe('edrvPlan')
    expect(definition.canOpen('dsh-resource://file/session/s/README.md')).toBe(false)
    expect(definition.canOpen('dsh-resource://plan/s/c')).toBe(true)
    h.feed.publish(written(1, 'w'))
    expect(requestOpen).toHaveBeenCalledWith('plans/a.md', undefined, undefined, 's', expect.objectContaining({ preview: true, signal: expect.any(AbortSignal) }))
    off()
    expect(h.offType).toHaveBeenCalledOnce()
    expect(h.offBody).toHaveBeenCalledOnce()
    expect(h.feed.listeners.size).toBe(0)
    expect(h.scope.listeners.size).toBe(0)
  })
  it('cancels pending opens on session changes and baselines the replacement binding', () => {
    const h = harness()
    const off = installPlanBridge(h.ctx, vi.fn())
    h.feed.publish(written(1, 'w'))
    const options = vi.mocked(requestOpen).mock.calls[0][4]!
    h.scope.publish({ key: 'other' })
    expect(options.signal!.aborted).toBe(true)
    expect(requestOpen).toHaveBeenCalledTimes(1)
    h.feed.publish(written(2, 'new'))
    expect(vi.mocked(requestOpen).mock.calls[1][3]).toBe('other')
    off()
  })
  it('does not re-open hydrated writes after HMR', () => {
    const h = harness()
    const off = installPlanBridge(h.ctx, vi.fn())
    h.feed.publish(written(1, 'w'))
    off()
    const again = installPlanBridge(h.ctx, vi.fn())
    expect(requestOpen).toHaveBeenCalledTimes(1)
    again()
  })
  it('degrades when older sessions lack the binding/feed API', () => {
    const h = harness()
    h.services.sessions = { list: h.list }
    const off = installPlanBridge(h.ctx, vi.fn())
    expect(h.register).toHaveBeenCalledOnce()
    expect(h.feed.listeners.size).toBe(0)
    off()
  })

  it('has bounded optional retries and cannot register after disposal', () => {
    const h = harness()
    delete h.services.sidebarRight
    const queued: Array<() => void> = []
    const off = installPlanBridge(h.ctx, (fn) => queued.push(fn))
    for (let i = 0; i < queued.length; i++) queued[i]()
    expect(queued).toHaveLength(14)
    off()
    h.services.sidebarRight = h.service
    queued[0]()
    expect(h.register).not.toHaveBeenCalled()
  })
})

describe('official plan resource transfer', () => {
  it.each([false, true])('closes the transfer tab only after editor readiness=%s', async (ok) => {
    vi.mocked(requestOpen).mockResolvedValueOnce(ok)
    const h = harness(), close = vi.fn()
    const off = installPlanBridge(h.ctx, vi.fn())
    h.body()({ sessionId: 's', useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://plan/s/c', revision: 1 }, actions: { close } } }),
      useResource: () => ({ status: 'live', value: { markdown: '# 计划\n正文' } }) })
    const cleanup = hooks.effects[0]()
    await Promise.resolve()
    expect(close).toHaveBeenCalledTimes(ok ? 1 : 0)
    expect(requestOpen).toHaveBeenCalledWith(null, undefined, undefined, 's', expect.objectContaining({ preview: true, plan: { address: 'dsh-resource://plan/s/c', markdown: '# 计划\n正文', title: '计划' } }))
    if (typeof cleanup === 'function') cleanup()
    off()
  })
  it('reads transient review params and explicitly falls back to native kind without re-claiming', () => {
    const h = harness(), close = vi.fn()
    const off = installPlanBridge(h.ctx, vi.fn())
    const params = { planReview: { markdown: '# 待审批\n完整计划' } }
    const tree = h.body()({ sessionId: 's', useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://plan-review/s/r', revision: 1, params }, actions: { close } } }), useResource: () => ({ status: 'none' }) })
    const cleanup = hooks.effects[0]()
    expect(vi.mocked(requestOpen).mock.calls[0][4]!.plan!.title).toBe('待审批')
    tree.children[1].props.onClick()
    expect(h.service.openResource).toHaveBeenCalledWith('dsh-resource://plan-review/s/r', { kind: 'plan', params })
    expect(close).toHaveBeenCalledOnce()
    if (typeof cleanup === 'function') cleanup()
    off()
  })
  it('cancels hidden transfers when their session leaves or the plugin unloads', async () => {
    let complete!: (ok: boolean) => void
    vi.mocked(requestOpen).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const h = harness(), close = vi.fn()
    const off = installPlanBridge(h.ctx, vi.fn())
    h.body()({ sessionId: 's', useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://plan/s/c', revision: 1 }, actions: { close } } }), useResource: () => ({ status: 'live', value: { markdown: '# Plan' } }) })
    hooks.effects[0]()
    const signal = vi.mocked(requestOpen).mock.calls[0][4]!.signal!
    h.list.publish(h.list.getSnapshot())
    expect(signal.aborted).toBe(false)
    h.scope.publish({ key: 'other' })
    expect(signal.aborted).toBe(true)
    complete(true)
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    off()
  })

  it('keeps a cold-mount transfer alive when the editor hides its source tab', async () => {
    let complete!: (ok: boolean) => void
    vi.mocked(requestOpen).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const h = harness(), close = vi.fn()
    const off = installPlanBridge(h.ctx, vi.fn())
    h.body()({ sessionId: 's', useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://plan/s/c', revision: 1 }, actions: { close } } }), useResource: () => ({ status: 'live', value: { markdown: '# Plan' } }) })
    const cleanup = hooks.effects[0]()
    if (typeof cleanup === 'function') cleanup()
    complete(true)
    await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
    off()
  })
})
