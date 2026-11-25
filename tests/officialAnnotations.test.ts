/** 官方变更视图的行级注解源：块映射、详情拉取与失效回收。作者 ddj 2026年11月23号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OfficialDiff, ReviewItem, ReviewPage } from '../src/shared/review.js'
import { reviewBlocks } from '../src/shared/reviewRegions.js'

/** 轮询入口与详情接口的替身记录表。 */
const state = vi.hoisted(() => ({
  feeds: new Map<string, (feed: { page: unknown; error: string }) => void>(),
  stops: [] as string[],
  calls: [] as string[],
  details: new Map<string, unknown>(),
  failing: new Set<string>(),
}))

vi.mock('../src/client/state/reviewFeed.js', () => ({
  subscribeReview: (sessionId: string, listener: (feed: { page: unknown; error: string }) => void) => {
    state.feeds.set(sessionId, listener)
    return () => {
      state.stops.push(sessionId)
      state.feeds.delete(sessionId)
    }
  },
}))

vi.mock('../src/client/rpc.js', () => ({
  rpc: async (_method: string, args: { sessionId: string; id: string }) => {
    state.calls.push(args.id)
    if (state.failing.has(args.id)) throw new Error('detail RPC failed')
    const detail = state.details.get(args.id)
    return detail ? { ok: true, detail } : { ok: false, error: 'missing' }
  },
}))

const { annotationSource, placesOf, sessionOf } = await import('../src/client/officialAnnotations.js')

/**
 * 造一份只有文本差异的条目。
 * @author ddj 2026年11月23号
 * @param id 条目身份
 * @param revision 修订号
 * @param patch 覆盖字段
 * @returns 待审条目
 */
function itemOf(id: string, revision: number, patch: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id, sessionId: 's1', turn: 1, seq: 1, path: 'src/a.ts', currentPath: 'src/a.ts', display: 'a.ts',
    added: 2, deleted: 1, kind: 'text', decision: 'pending', revision, current: true, ...patch,
  }
}

/**
 * 造一份待审页。
 * @author ddj 2026年11月23号
 * @param items 条目
 * @returns 待审页
 */
function pageOf(items: ReviewItem[]): ReviewPage {
  return { items, pending: items.length, nextCursor: null, gaps: [] } as unknown as ReviewPage
}

/**
 * 造一份含一个修改块的文本差异：块从第 11 行起，新增两行、删掉一行。
 * @author ddj 2026年11月23号
 * @returns 文本差异
 */
function modifyDiff(): OfficialDiff {
  return {
    kind: 'text', path: 'src/a.ts', display: 'a.ts', before: true, after: true, coarse: false,
    hunks: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [' ctx', '-old', '+new1', '+new2', ' ctx'] }],
  }
}

/**
 * 造一份只删一行的文本差异：块落在旧侧第 6 行。
 * @author ddj 2026年11月23号
 * @returns 文本差异
 */
function deleteDiff(): OfficialDiff {
  return {
    kind: 'text', path: 'src/a.ts', display: 'a.ts', before: true, after: true, coarse: false,
    hunks: [{ oldStart: 5, oldLines: 3, newStart: 5, newLines: 2, lines: [' ctx', '-gone', ' ctx'] }],
  }
}

/** 等异步拉取链跑完（详情请求是 Promise 链，需要一次宏任务）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  state.feeds.clear()
  state.stops.length = 0
  state.calls.length = 0
  state.details.clear()
  state.failing.clear()
})

describe('sessionOf', () => {
  it('reads the session id from an official target', () => {
    expect(sessionOf({ sessionId: 's1', source: { kind: 'local' } })).toBe('s1')
  })

  it('never throws on unknown shapes', () => {
    expect(sessionOf(undefined)).toBeUndefined()
    expect(sessionOf('s1')).toBeUndefined()
    expect(sessionOf({ sessionId: 42 })).toBeUndefined()
    expect(sessionOf({ sessionId: '' })).toBeUndefined()
  })
})

describe('placesOf', () => {
  it('maps a modification block to the new side of the diff', () => {
    const annotations = placesOf({ diff: modifyDiff(), blocks: [] }, 'pending:item', 3)
    expect(annotations).toHaveLength(1)
    const blockId = reviewBlocks(modifyDiff())[0]!.id
    expect(annotations[0]).toEqual({
      key: 'vsm-pending:pending:item:' + blockId,
      place: { side: 'R', startLine: 11, endLine: 12 },
      version: '3:R:11-12',
    })
  })

  it('maps a pure deletion block to the old side', () => {
    const annotations = placesOf({ diff: deleteDiff(), blocks: [] }, 'pending:item', 1)
    expect(annotations[0].place).toEqual({ side: 'L', startLine: 6, endLine: 6 })
    expect(annotations[0].version).toBe('1:L:6-6')
  })

  it('skips blocks already accepted or rejected', () => {
    const diff = modifyDiff()
    const blockId = reviewBlocks(diff)[0]!.id
    const accepted = placesOf({ diff, blocks: [{ id: blockId, decision: 'accepted' }] }, 'item', 2)
    const rejected = placesOf({ diff, blocks: [{ id: blockId, decision: 'rejected' }] }, 'item', 2)
    expect(accepted).toHaveLength(0)
    expect(rejected).toHaveLength(0)
    expect(placesOf({ diff, blocks: [{ id: blockId, decision: 'pending' }] }, 'item', 2)).toHaveLength(1)
  })

  it('caps the annotations of one file', () => {
    const hunks = Array.from({ length: 12 }, (_, index) => ({
      oldStart: index * 10 + 1, oldLines: 1, newStart: index * 10 + 1, newLines: 1, lines: ['+line'],
    }))
    const diff: OfficialDiff = { kind: 'text', path: 'src/a.ts', display: 'a.ts', before: true, after: true, coarse: false, hunks }
    expect(placesOf({ diff, blocks: [] }, 'item', 1)).toHaveLength(8)
  })
})

describe('annotationSource', () => {
  it('fetches one detail per item and publishes line annotations by path', async () => {
    state.details.set('i1', { diff: modifyDiff(), blocks: [] })
    const source = annotationSource()
    expect(source.id).toBe('dsh-vscode-mode')
    expect(source.order).toBe(10)

    const feed = source.observe({ sessionId: 's-line', source: { kind: 'local' } })
    const stop = feed.subscribe(() => {})
    state.feeds.get('s-line')!({ page: pageOf([itemOf('i1', 1)]), error: '' })
    await tick()

    const annotations = feed.getSnapshot().get('src/a.ts')
    expect(annotations?.[0].place).toEqual({ side: 'R', startLine: 11, endLine: 12 })
    expect(state.calls).toEqual(['i1'])
    stop()
  })

  it('reuses the cached detail until the revision changes', async () => {
    state.details.set('i1', { diff: modifyDiff(), blocks: [] })
    const source = annotationSource()
    const feed = source.observe({ sessionId: 's-cache' })
    const stop = feed.subscribe(() => {})

    state.feeds.get('s-cache')!({ page: pageOf([itemOf('i1', 1)]), error: '' })
    await tick()
    state.feeds.get('s-cache')!({ page: pageOf([itemOf('i1', 1)]), error: '' })
    await tick()
    expect(state.calls).toEqual(['i1'])

    state.feeds.get('s-cache')!({ page: pageOf([itemOf('i1', 2)]), error: '' })
    await tick()
    expect(state.calls).toEqual(['i1', 'i1'])
    stop()
  })

  it('publishes nothing for binary items or failing details', async () => {
    state.failing.add('bad')
    const source = annotationSource()
    const feed = source.observe({ sessionId: 's-fail' })
    const stop = feed.subscribe(() => {})

    state.feeds.get('s-fail')!({ page: pageOf([itemOf('bin', 1, { kind: 'binary' }), itemOf('bad', 1)]), error: '' })
    await tick()

    expect(state.calls).toEqual(['bad'])
    expect(feed.getSnapshot().size).toBe(0)
    stop()
  })

  it('shares one stream per session and stops it after the last reader', () => {
    const source = annotationSource()
    const first = source.observe({ sessionId: 's-share' })
    const second = source.observe({ sessionId: 's-share' })
    const firstStop = first.subscribe(() => {})
    const secondStop = second.subscribe(() => {})
    expect(state.feeds.size).toBe(1)

    firstStop()
    expect(state.stops).toEqual([])
    secondStop()
    expect(state.stops).toEqual(['s-share'])
  })

  it('publishes an empty table when the target carries no session', () => {
    const feed = annotationSource().observe(undefined)
    expect(feed.getSnapshot().size).toBe(0)
    expect(feed.subscribe(() => {})).toBeTypeOf('function')
  })
})
