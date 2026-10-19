/**
 * client state/recordsFeed.ts 共享订阅层测试。
 * 覆盖：单会话单定时器、多订阅者共享一次 RPC、退订清理、edrv:refresh 立即拉取、
 * 错误分发、纯心跳订阅不制造 RPC。
 * @author ddj 2026年10月19号
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordView } from '../src/shared/types.js'

const rpcMock = vi.fn()

vi.mock('../src/client/rpc.js', () => ({ rpc: rpcMock }))

/** 构造一条最小差异记录。 */
function rec(partial: Partial<RecordView> = {}): RecordView {
  return {
    callId: 'c1',
    toolName: 'edit',
    path: '/ws/a.ts',
    beforeLen: 3,
    create: false,
    callHunk: null,
    hunks: [{ oldText: 'a', newText: 'b' }],
    decisions: { call: 'pending', perHunk: ['pending'] },
    note: null,
    superseded: false,
    at: '2026-10-19T00:00:00.000Z',
    ...partial,
  }
}

/** 让成功的 rpc promise 链 flush 完。 */
function flush(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve())
}

type FeedModule = typeof import('../src/client/state/recordsFeed.js')
let feed: FeedModule

beforeEach(async () => {
  vi.useFakeTimers()
  rpcMock.mockReset()
  rpcMock.mockResolvedValue({ ok: true, records: [rec()] })
  feed = await import('../src/client/state/recordsFeed.js')
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('recordsFeed 共享订阅', () => {
  it('首个订阅者立即拉取一次，并把记录回调出去', async () => {
    const seen: RecordView[][] = []
    const off = feed.subscribeRecords('s1', (list) => seen.push(list))
    await flush()

    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenCalledWith('edrv.list', { sessionId: 's1' })
    expect(seen).toHaveLength(1)
    expect(seen[0][0].callId).toBe('c1')
    off()
  })

  it('同会话 3 个订阅者一轮只产生 1 次 RPC', async () => {
    const offs = [
      feed.subscribeRecords('s1', () => {}),
      feed.subscribeRecords('s1', () => {}),
      feed.subscribeRecords('s1', () => {}),
    ]
    await flush()
    expect(rpcMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(feed.FEED_INTERVAL_MS)
    expect(rpcMock).toHaveBeenCalledTimes(2)

    for (const off of offs) off()
  })

  it('不同会话各自独立拉取（分桶不串数据）', async () => {
    const a: RecordView[][] = []
    const b: RecordView[][] = []
    rpcMock.mockImplementation((_method: string, payload: { sessionId: string }) =>
      Promise.resolve({ ok: true, records: [rec({ callId: payload.sessionId + '-c' })] }))

    const offA = feed.subscribeRecords('sA', (list) => a.push(list))
    const offB = feed.subscribeRecords('sB', (list) => b.push(list))
    await flush()

    expect(a[0][0].callId).toBe('sA-c')
    expect(b[0][0].callId).toBe('sB-c')
    offA()
    offB()
  })

  it('第二个订阅者直接拿到缓存快照，不重复拉取', async () => {
    const first: RecordView[][] = []
    const off1 = feed.subscribeRecords('s1', (list) => first.push(list))
    await flush()
    expect(rpcMock).toHaveBeenCalledTimes(1)

    const second: RecordView[][] = []
    const off2 = feed.subscribeRecords('s1', (list) => second.push(list))
    expect(second).toHaveLength(1)
    expect(rpcMock).toHaveBeenCalledTimes(1)

    off1()
    off2()
  })

  it('退订到 0 后定时器清理，不再产生 RPC', async () => {
    const off = feed.subscribeRecords('s1', () => {})
    await flush()
    expect(rpcMock).toHaveBeenCalledTimes(1)

    off()
    await vi.advanceTimersByTimeAsync(feed.FEED_INTERVAL_MS * 3)
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(feed.readRecords('s1')).toBeNull()
  })

  it('edrv:refresh 事件触发立即拉取', async () => {
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
      removeEventListener: (name: string) => listeners.delete(name),
    })

    const off = feed.subscribeRecords('s1', () => {})
    await flush()
    expect(rpcMock).toHaveBeenCalledTimes(1)

    listeners.get('edrv:refresh')?.()
    await flush()
    expect(rpcMock).toHaveBeenCalledTimes(2)

    off()
    expect(listeners.has('edrv:refresh')).toBe(false)
  })

  it('拉取失败时分发错误且保留上次快照', async () => {
    const errors: string[] = []
    const offErr = feed.subscribeErrors('s1', (message) => errors.push(message))
    const offRec = feed.subscribeRecords('s1', () => {})
    await flush()
    expect(feed.readRecords('s1')?.[0].callId).toBe('c1')

    rpcMock.mockRejectedValueOnce(new Error('boom'))
    await vi.advanceTimersByTimeAsync(feed.FEED_INTERVAL_MS)
    expect(errors).toEqual(['Error: boom'])
    expect(feed.readRecords('s1')?.[0].callId).toBe('c1')

    offErr()
    offRec()
  })

  it('纯心跳订阅不制造记录 RPC，且复用同一周期', async () => {
    let ticks = 0
    const off = feed.subscribeTick('s1', () => { ticks++ })
    await flush()
    expect(rpcMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(feed.FEED_INTERVAL_MS)
    expect(ticks).toBe(1)
    expect(rpcMock).not.toHaveBeenCalled()

    off()
    await vi.advanceTimersByTimeAsync(feed.FEED_INTERVAL_MS * 2)
    expect(ticks).toBe(1)
  })

  it('一个订阅者抛错不影响其他订阅者', async () => {
    const seen: number[] = []
    const off1 = feed.subscribeRecords('s1', () => {
      throw new Error('subscriber boom')
    })
    const off2 = feed.subscribeRecords('s1', () => seen.push(1))
    await flush()

    expect(seen).toHaveLength(1)
    off1()
    off2()
  })

  it('disposeFeed 释放定时器与监听', async () => {
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
      removeEventListener: (name: string) => listeners.delete(name),
    })

    feed.subscribeRecords('s1', () => {})
    await flush()
    feed.disposeFeed('s1')

    expect(feed.readRecords('s1')).toBeNull()
    expect(listeners.has('edrv:refresh')).toBe(false)
    rpcMock.mockClear()
    await vi.advanceTimersByTimeAsync(feed.FEED_INTERVAL_MS * 2)
    expect(rpcMock).not.toHaveBeenCalled()
  })
})
