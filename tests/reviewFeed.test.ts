import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshReview, subscribeReview } from '../src/client/state/reviewFeed.js'
import { rpc } from '../src/client/rpc.js'
vi.mock('../src/client/rpc.js', () => ({ rpc: vi.fn() }))
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach((dispose) => dispose()); vi.useRealTimers(); vi.resetAllMocks() })

describe('official shared metadata feed', () => {
  it('shares one request and timer between mounted observers and cancels when unused', async () => {
    vi.useFakeTimers()
    vi.mocked(rpc).mockResolvedValue({ ok: true, page: { items: [], pending: 4, nextCursor: null, gaps: [] } })
    const first = vi.fn(), second = vi.fn()
    const removeFirst = subscribeReview('view', first)
    const removeSecond = subscribeReview('view', second)
    cleanups.push(removeSecond)
    await vi.advanceTimersByTimeAsync(0)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenLastCalledWith(expect.objectContaining({ page: expect.objectContaining({ pending: 4 }) }))
    removeFirst()
    await vi.advanceTimersByTimeAsync(5000)
    expect(rpc).toHaveBeenCalledTimes(2)
    removeSecond()
    await vi.advanceTimersByTimeAsync(15000)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('late completion cannot notify or reschedule an abandoned session generation', async () => {
    vi.useFakeTimers()
    let finish!: (result: never) => void
    vi.mocked(rpc).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const listener = vi.fn()
    const remove = subscribeReview('old', listener)
    remove()
    finish({ ok: true, page: { items: [], pending: 1, nextCursor: null, gaps: [] } } as never)
    await vi.advanceTimersByTimeAsync(15000)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('queues one follow-up refresh when a decision completes during an in-flight list', async () => {
    vi.useFakeTimers()
    let finish!: (result: never) => void
    vi.mocked(rpc).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    vi.mocked(rpc).mockResolvedValue({ ok: true, page: { items: [], pending: 0, nextCursor: null, gaps: [] } })
    const listener = vi.fn()
    cleanups.push(subscribeReview('again', listener))
    refreshReview('again'); refreshReview('again')
    expect(rpc).toHaveBeenCalledTimes(1)
    finish({ ok: true, page: { items: [], pending: 1, nextCursor: null, gaps: [] } } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ page: expect.objectContaining({ pending: 0 }) }))
  })

  it('explicit refresh does not overlap an active metadata request', async () => {
    vi.useFakeTimers()
    vi.mocked(rpc).mockImplementation(() => new Promise(() => {}))
    cleanups.push(subscribeReview('busy', vi.fn()))
    refreshReview('busy'); refreshReview('busy')
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
