import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshReview, subscribeReview } from '../src/client/state/reviewFeed.js'
import { rpc } from '../src/client/rpc.js'
vi.mock('../src/client/rpc.js', () => ({ rpc: vi.fn() }))
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach((dispose) => dispose()); vi.useRealTimers(); vi.resetAllMocks() })

/** 列表调用：版本号轮询也在用 rpc，计数必须按方法过滤，否则两者互相干扰。 */
function listCalls(): unknown[] {
  return vi.mocked(rpc).mock.calls.filter(([method]) => method === 'edrv.review.list')
}
/** 版本号调用次数。 */
function versionCalls(): unknown[] {
  return vi.mocked(rpc).mock.calls.filter(([method]) => method === 'edrv.pending.version')
}
const PAGE = { items: [], pending: 4, nextCursor: null, gaps: [] }

/**
 * @description: 按方法分发的 mock：列表按队列依次返回，版本号固定返回给定版本。
 * 一条队列返回 promise 时不入队后续，便于测"在途请求"。
 * @param queue 列表响应队列（可含 promise）
 * @param version 版本号序列（缺省恒定 0）
 * @returns 无
 */
function mockByMethod(queue: unknown[], version: number[] = []): void {
  let index = 0
  let versionIndex = 0
  vi.mocked(rpc).mockImplementation(async (method: string) => {
    if (method === 'edrv.pending.version') {
      const value = version.length ? version[Math.min(versionIndex, version.length - 1)] : 0
      versionIndex += 1
      return { ok: true, version: value } as never
    }
    const next = queue.length ? queue[Math.min(index, queue.length - 1)] : { ok: true, page: PAGE }
    index += 1
    return (await next) as never
  })
}

describe('official shared metadata feed', () => {
  it('shares one request and timer between mounted observers and cancels when unused', async () => {
    vi.useFakeTimers()
    mockByMethod([{ ok: true, page: PAGE }])
    const first = vi.fn(), second = vi.fn()
    const removeFirst = subscribeReview('view', first)
    const removeSecond = subscribeReview('view', second)
    cleanups.push(removeSecond)
    await vi.advanceTimersByTimeAsync(0)
    expect(listCalls()).toHaveLength(1)
    expect(first).toHaveBeenLastCalledWith(expect.objectContaining({ page: expect.objectContaining({ pending: 4 }) }))
    removeFirst()
    await vi.advanceTimersByTimeAsync(5000)
    expect(listCalls()).toHaveLength(2)
    removeSecond()
    await vi.advanceTimersByTimeAsync(15000)
    expect(listCalls()).toHaveLength(2)
  })

  it('late completion cannot notify or reschedule an abandoned session generation', async () => {
    vi.useFakeTimers()
    let finish!: (result: never) => void
    mockByMethod([new Promise((resolve) => { finish = resolve as never })])
    const listener = vi.fn()
    const remove = subscribeReview('old', listener)
    remove()
    finish({ ok: true, page: PAGE } as never)
    await vi.advanceTimersByTimeAsync(15000)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listCalls()).toHaveLength(1)
  })

  it('queues one follow-up refresh when a decision completes during an in-flight list', async () => {
    vi.useFakeTimers()
    let finish!: (result: never) => void
    mockByMethod([new Promise((resolve) => { finish = resolve as never }), { ok: true, page: { ...PAGE, pending: 0 } }])
    const listener = vi.fn()
    cleanups.push(subscribeReview('again', listener))
    refreshReview('again'); refreshReview('again')
    expect(listCalls()).toHaveLength(1)
    finish({ ok: true, page: PAGE } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(listCalls()).toHaveLength(2)
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ page: expect.objectContaining({ pending: 0 }) }))
  })

  it('unchanged five-second polls preserve feed identity and do not notify editors', async () => {
    vi.useFakeTimers()
    mockByMethod([{ ok: true, page: { items: [], pending: 0, nextCursor: null, gaps: [], overview: { files: [], coveredPaths: [] } } }])
    const listener = vi.fn()
    cleanups.push(subscribeReview('stable', listener))
    await vi.advanceTimersByTimeAsync(0)
    const published = listener.mock.lastCall![0]
    await vi.advanceTimersByTimeAsync(15000)
    expect(listCalls()).toHaveLength(4)
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
    mockByMethod([
      { ok: true, page },
      { ok: false, error: 'temporary failure' },
      { ok: true, page },
      { ok: true, page: { ...page, pending: 1 } },
    ])
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
    mockByMethod([new Promise(() => {})])
    cleanups.push(subscribeReview('busy', vi.fn()))
    refreshReview('busy'); refreshReview('busy')
    expect(listCalls()).toHaveLength(1)
  })

  it('待审版本号变化在 1s 轮询内触发整页重读', async () => {
    vi.useFakeTimers()
    // 版本号先在首次探测记下基准 1，随后变成 2：应当拉起一次整页重读
    mockByMethod([{ ok: true, page: PAGE }], [1, 1, 2, 2, 2])
    const listener = vi.fn()
    cleanups.push(subscribeReview('bump', listener))
    await vi.advanceTimersByTimeAsync(0)
    expect(versionCalls().length).toBeGreaterThanOrEqual(1)
    expect(listCalls()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1600)
    expect(listCalls()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(listCalls()).toHaveLength(2)
    expect(listener.mock.lastCall![0].page.pending).toBe(4)
  })
})
