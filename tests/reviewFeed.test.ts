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

  it('unchanged five-second polls preserve feed identity and do not notify editors', async () => {
    vi.useFakeTimers()
    vi.mocked(rpc).mockImplementation(async () => ({ ok: true, page: { items: [], pending: 0, nextCursor: null, gaps: [], overview: { files: [], coveredPaths: [] } } }))
    const listener = vi.fn()
    cleanups.push(subscribeReview('stable', listener))
    await vi.advanceTimersByTimeAsync(0)
    const published = listener.mock.lastCall![0]
    await vi.advanceTimersByTimeAsync(15000)
    expect(rpc).toHaveBeenCalledTimes(4)
    expect(listener).toHaveBeenCalledTimes(2) // initial empty state and first metadata only
    expect(listener.mock.lastCall![0]).toBe(published)
    refreshReview('stable')
    await vi.advanceTimersByTimeAsync(0)
    expect(listener).toHaveBeenCalledTimes(3) // explicit invalidation still reloads evidence/detail
    expect(listener.mock.lastCall![0]).not.toBe(published)
  })

  it('real changes and recovery from an error are still published', async () => {
    vi.useFakeTimers()
    const page = { items: [], pending: 0, nextCursor: null, gaps: [] }
    vi.mocked(rpc).mockResolvedValueOnce({ ok: true, page })
      .mockResolvedValueOnce({ ok: false, error: 'temporary failure' })
      .mockResolvedValueOnce({ ok: true, page })
      .mockResolvedValueOnce({ ok: true, page: { ...page, pending: 1 } })
    const listener = vi.fn()
    cleanups.push(subscribeReview('changes', listener))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(listener.mock.lastCall![0].error).toBe('temporary failure')
    await vi.advanceTimersByTimeAsync(5000)
    expect(listener.mock.lastCall![0].error).not.toBe('temporary failure')
    await vi.advanceTimersByTimeAsync(5000)
    expect(listener.mock.lastCall![0].page.pending).toBe(1)
    expect(listener).toHaveBeenCalledTimes(5)
  })

  it('explicit refresh does not overlap an active metadata request', async () => {
    vi.useFakeTimers()
    vi.mocked(rpc).mockImplementation(() => new Promise(() => {}))
    cleanups.push(subscribeReview('busy', vi.fn()))
    refreshReview('busy'); refreshReview('busy')
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
