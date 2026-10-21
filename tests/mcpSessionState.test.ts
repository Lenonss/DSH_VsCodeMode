/** Shared poller lifetime regressions. @author ddj 2026年10月20号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpSessionState } from '../src/client/mcpSessionState.js'

const stores: McpSessionState[] = []
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.useRealTimers() })

/** @private @author ddj 2026年10月20号 @param fetchStatus Stub transport. @param page Optional visibility fixture. @returns Tracked poller for test cleanup. */
function makeStore(fetchStatus: ConstructorParameters<typeof McpSessionState>[0], page?: Document): McpSessionState {
  const store = new McpSessionState(fetchStatus, page)
  stores.push(store)
  return store
}

const ready = { sessionId: 'A', phase: 'ready' as const, startedAt: 1, phaseAt: 2, finishedAt: 3, servers: [] }

describe('session MCP shared subscriptions', () => {
  it('shares one transport for rows and hovers and clears detached owners', async () => {
    vi.useFakeTimers()
    const fetchStatus = vi.fn().mockResolvedValue({ sessions: [ready], sampledAt: 3 })
    const store = makeStore(fetchStatus)
    const off = store.subscribe('A', vi.fn())
    const offHover = store.subscribe('A', vi.fn())
    const offOther = store.subscribe('B', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(store.get('A')).toMatchObject({ stale: false, status: ready })
    expect(store.get('B')).toEqual({ stale: false })
    fetchStatus.mockResolvedValue({ sessions: [], sampledAt: 4 })
    await vi.advanceTimersByTimeAsync(2500)
    expect(store.get('A')).toEqual({ stale: false })
    off(); offHover(); offOther()
    await vi.advanceTimersByTimeAsync(20000)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  it('retains prior observations as stale after failure and recovers', async () => {
    vi.useFakeTimers()
    const fetchStatus = vi.fn().mockResolvedValueOnce({ sessions: [ready], sampledAt: 3 }).mockRejectedValueOnce(new Error('old Host'))
      .mockResolvedValue({ sessions: [], sampledAt: 4 })
    const store = makeStore(fetchStatus)
    store.subscribe('A', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2500)
    expect(store.get('A')).toEqual({ status: ready, stale: true })
    await vi.advanceTimersByTimeAsync(2500)
    expect(store.get('A')).toEqual({ stale: false })
  })

  it('aborts overdue requests without overlap or accepting a late response', async () => {
    vi.useFakeTimers()
    let release!: (snapshot: unknown) => void
    let signal!: AbortSignal
    const fetchStatus = vi.fn((input: AbortSignal) => { signal = input; return new Promise<any>((resolve) => { release = resolve }) })
    const store = makeStore(fetchStatus)
    store.subscribe('A', vi.fn())
    await vi.advanceTimersByTimeAsync(15000)
    expect(signal.aborted).toBe(true)
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    release({ sessions: [ready], sampledAt: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get('A')).toEqual({ stale: true })
    await vi.advanceTimersByTimeAsync(2500)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    release({ sessions: [], sampledAt: 4 })
    await vi.advanceTimersByTimeAsync(0)
  })

  it('pauses hidden pages and ignores responses from an abandoned subscription', async () => {
    vi.useFakeTimers()
    const page = new EventTarget() as Document
    Object.defineProperty(page, 'hidden', { value: true, writable: true })
    let release!: (snapshot: unknown) => void
    const fetchStatus = vi.fn(() => new Promise<any>((resolve) => { release = resolve }))
    const store = makeStore(fetchStatus, page)
    const off = store.subscribe('A', vi.fn())
    expect(fetchStatus).not.toHaveBeenCalled()
    Object.defineProperty(page, 'hidden', { value: false })
    page.dispatchEvent(new Event('visibilitychange'))
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    off()
    store.subscribe('A', vi.fn())
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    release({ sessions: [ready], sampledAt: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get('A').stale).toBe(true)
    await vi.advanceTimersByTimeAsync(2500)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    release({ sessions: [], sampledAt: 4 })
    await vi.advanceTimersByTimeAsync(0)
  })
})
