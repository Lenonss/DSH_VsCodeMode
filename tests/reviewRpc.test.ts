import { describe, expect, it, vi } from 'vitest'
import { reviewHandlers } from '../src/reviewRpc.js'
import type { Ctx } from '../src/store.js'
import { decideReview, keepOfficialAll, reviewDetail, reviewPage } from '../src/reviewDb.js'
import { undoReview } from '../src/reviewUndo.js'
import { keepAll, loadPage } from '../src/pending/store.js'
import type { PendingItem, PendingPage } from '../src/shared/pendingReview.js'
import type { KeepAllItem, KeepAllResult, ReviewDetail, ReviewItem, ReviewPage } from '../src/shared/review.js'
vi.mock('../src/reviewUndo.js', () => ({ undoReview: vi.fn() }))
vi.mock('../src/reviewDb.js', () => ({
  reviewPage: vi.fn(), reviewDetail: vi.fn(), decideReview: vi.fn(), keepOfficialAll: vi.fn(), addedFiles: vi.fn(() => new Set()),
}))
vi.mock('../src/pending/store.js', () => ({
  loadPage: vi.fn(() => ({ items: [], pending: 0, nextCursor: null, gaps: [] })),
  loadDetail: vi.fn(() => null),
  applyDecide: vi.fn(),
  keepAll: vi.fn(async () => ({ kept: [], skipped: [] })),
}))

describe('official review workspace boundary', () => {
  it('rejects unknown sessions before accessing any database', async () => {
    const ctx = { get: () => ({ get: () => undefined }) } as unknown as Ctx
    const handlers = reviewHandlers(ctx, new Map())
    await expect(handlers['edrv.review.list']!({ sessionId: 'missing' })).rejects.toThrow('会话不存在')
    expect(reviewPage).not.toHaveBeenCalled()
  })

  it('resolves current workspace from host session, never a supplied cwd or source session', async () => {
    const session = { id: 'view', header: { cwd: '/original' } }
    const ctx = { get: (name: string) => name === 'sessions' ? { get: () => session }
      : name === 'workingDirectory' ? { get: () => '/current' } : undefined } as unknown as Ctx
    const registry = new Map([['/current', new Map()]])
    const handlers = reviewHandlers(ctx, registry)
    vi.mocked(reviewPage).mockReturnValue({ items: [], pending: 0, gaps: [], nextCursor: null })
    await handlers['edrv.review.list']!({ sessionId: 'view' })
    expect(reviewPage).toHaveBeenLastCalledWith('/current', undefined, undefined, undefined)
    await handlers['edrv.review.list']!({ sessionId: 'view', path: '/current/file.lua', history: true, cursor: 50 })
    expect(reviewPage).toHaveBeenLastCalledWith('/current', 50, true, '/current/file.lua')
    vi.mocked(reviewDetail).mockReturnValue(null)
    expect(await handlers['edrv.review.detail']!({ sessionId: 'view', id: 'other-workspace-id' })).toEqual({ ok: false, error: '官方审查记录不存在' })
    expect(reviewDetail).toHaveBeenLastCalledWith('/current', 'other-workspace-id')
    vi.mocked(decideReview).mockReturnValue({ revision: 1 })
    const request = { sessionId: 'view', id: 'immutable', seq: 1, revision: 0, operationId: 'operation', decision: 'accepted' as const }
    expect(await handlers['edrv.review.decide']!(request)).toEqual({ ok: true, revision: 1 })
    expect(decideReview).toHaveBeenLastCalledWith('/current', request)
    vi.mocked(decideReview).mockImplementationOnce(() => { throw new Error('审查版本冲突，请刷新后重试') })
    expect(await handlers['edrv.review.decide']!(request)).toEqual({ ok: false, error: '审查版本冲突，请刷新后重试' })
    const conflict = '当前文件已被后续编辑，版本与回滚证据冲突，未修改文件'
    vi.mocked(undoReview).mockRejectedValueOnce(new Error(conflict))
    expect(await handlers['edrv.review.decide']!({ ...request, decision: 'rejected' })).toEqual({ ok: false, error: conflict })
  })

  it('crosses Host instances for reads and Keep: persisted sessions may accept, never undo or judge pending', async () => {
    const query = { filterSessions: async () => [{ header: { id: 'remote', cwd: '/remote-repo' } }] }
    const ctx = {
      get: (name: string) => (name === 'sessionQuery' ? query : name === 'sessions' ? { get: () => undefined } : undefined),
    } as unknown as Ctx
    const handlers = reviewHandlers(ctx, new Map([['/remote-repo', new Map()]]))
    vi.mocked(reviewPage).mockReturnValue({ items: [], pending: 0, gaps: [], nextCursor: null })
    expect(await handlers['edrv.review.list']!({ sessionId: 'remote' }))
      .toEqual({ ok: true, page: { items: [], pending: 0, gaps: [], nextCursor: null } })
    expect(reviewPage).toHaveBeenLastCalledWith('/remote-repo', undefined, undefined, undefined)
    vi.mocked(reviewDetail).mockReturnValue(null)
    expect(await handlers['edrv.review.detail']!({ sessionId: 'remote', id: 'remote-id' }))
      .toEqual({ ok: false, error: '官方审查记录不存在' })
    expect(reviewDetail).toHaveBeenLastCalledWith('/remote-repo', 'remote-id')

    // Keep 只写共享审查库（CAS + 幂等键）：冷读端可执行，写入仍由数据库版本校验兜底
    const accept = { sessionId: 'remote', id: 'remote-id', seq: 1, revision: 1, operationId: 'operation', decision: 'accepted' as const }
    vi.mocked(decideReview).mockReturnValue({ revision: 2 })
    expect(await handlers['edrv.review.decide']!(accept)).toEqual({ ok: true, revision: 2 })
    expect(decideReview).toHaveBeenLastCalledWith('/remote-repo', accept)

    // Undo 要写回源文件并校验证据，仍要求本端活跃会话
    vi.mocked(undoReview).mockClear()
    const undo = await handlers['edrv.review.decide']!({ ...accept, decision: 'rejected' })
    expect(undo.ok).toBe(false)
    expect((undo as { error: string }).error).toContain('活跃的会话')
    expect(undoReview).not.toHaveBeenCalled()

    // 待审条目判定写本机待审库，冷端会与另一端 agent 抢写，故一律拒绝
    const pending = await handlers['edrv.review.decide']!({ ...accept, id: 'pending:1' })
    expect(pending.ok).toBe(false)
    expect((pending as { error: string }).error).toContain('待审条目')
  })

  it('reports cold-end capabilities: Keep stays open, Undo closes with the cross-instance reason', async () => {
    const record = {
      item: row(1), diff: {}, capturedAt: '', blocks: [],
      capability: { keep: true, undo: true, reason: 'Undo 将校验原始字节后写回' },
    } as unknown as ReviewDetail
    const query = { filterSessions: async () => [{ header: { id: 'remote', cwd: '/remote-repo' } }] }
    const cold = {
      get: (name: string) => (name === 'sessionQuery' ? query : name === 'sessions' ? { get: () => undefined } : undefined),
    } as unknown as Ctx
    vi.mocked(reviewDetail).mockReturnValue(record)
    const coldRead = await reviewHandlers(cold, new Map([['/remote-repo', new Map()]]))['edrv.review.detail']!({ sessionId: 'remote', id: '1' })
    expect((coldRead as { detail: ReviewDetail }).detail.capability)
      .toEqual({ keep: true, undo: false, reason: expect.stringContaining('另一端'), live: false })

    const liveRead = await reviewHandlers(snapshotCtx(), new Map([['/current', new Map()]]))['edrv.review.detail']!({ sessionId: 'view', id: '1' })
    expect((liveRead as { detail: ReviewDetail }).detail.capability)
      .toEqual({ keep: true, undo: true, reason: 'Undo 将校验原始字节后写回', live: true })
  })

  it('drops settled pending projections so the official record stays the review target', async () => {
    const handlers = reviewHandlers(snapshotCtx(), new Map([['/current', new Map()]]))
    const settled = { id: 'pending:/current/file1', path: '/current/file1', settled: true, added: 0, deleted: 0 } as unknown as PendingItem
    const live = { id: 'pending:/current/file2', path: '/current/file2', settled: false, added: 1, deleted: 0 } as unknown as PendingItem
    vi.mocked(loadPage).mockReturnValueOnce({ items: [settled, live], pending: 1, nextCursor: null, gaps: [] } as unknown as PendingPage)
    vi.mocked(reviewPage).mockReturnValue({ items: [row(1)], pending: 1, gaps: [], nextCursor: null })

    const listed = await handlers['edrv.review.list']!({ sessionId: 'view', path: '/current/file1' })
    const ids = (listed as { page: ReviewPage }).page.items.map((item) => item.id)
    expect(ids).toEqual(['1'])
  })
})

/** @private @author ddj 2026年10月31号 @param index Record identity. @returns Minimal official pending row. */
function row(index: number): ReviewItem {
  return { id: String(index), current: true, decision: 'pending', revision: 1, seq: index, display: `file${index}`, path: `/current/file${index}`, currentPath: `/current/file${index}` } as ReviewItem
}
/** @private @author ddj 2026年10月31号 @returns Live session context bound to /current. */
function snapshotCtx(): Ctx {
  return {
    get: (name: string) => (name === 'sessions' ? { get: () => ({ id: 'view', header: { cwd: '/current' } }) }
      : name === 'workingDirectory' ? { get: () => '/current' } : undefined),
  } as unknown as Ctx
}
describe('bulk review snapshot', () => {
  it('pages the official store once and reports items and pending from the same snapshot', async () => {
    const handlers = reviewHandlers(snapshotCtx(), new Map([['/current', new Map()]]))
    vi.mocked(reviewPage).mockClear().mockReturnValueOnce({ items: [row(1), row(2)], pending: 3, gaps: [], nextCursor: 50 })
      .mockReturnValue({ items: [row(3)], pending: 3, gaps: [], nextCursor: null })
    const listed = await handlers['edrv.review.list']!({ sessionId: 'view', all: true })
    expect(listed).toMatchObject({ ok: true, page: { pending: 3, nextCursor: null } })
    const page = (listed as { page: ReviewPage }).page
    expect(page.items.map((entry) => entry.id)).toEqual(['1', '2', '3'])
    expect(reviewPage).toHaveBeenLastCalledWith('/current', 50)
  })
  it('refuses an oversized pending backlog instead of starting unbounded writes', async () => {
    const handlers = reviewHandlers(snapshotCtx(), new Map([['/current', new Map()]]))
    vi.mocked(reviewPage).mockReset().mockReturnValue({ items: [], pending: 2001, gaps: [], nextCursor: null })
    const listed = await handlers['edrv.review.list']!({ sessionId: 'view', all: true })
    expect(listed).toMatchObject({ ok: false })
    expect((listed as { error: string }).error).toContain('上限 2000')
  })
})

describe('batch Keep across both stores', () => {
  /** @private @author ddj 2026年11月03号 @param id 条目身份 @param display 展示名 @returns 批量目标 */
  function target(id: string, display: string): KeepAllItem {
    return { id, display, seq: 1, revision: 1 }
  }

  it('keeps official rows on a cold end and only skips pending projections', async () => {
    const query = { filterSessions: async () => [{ header: { id: 'remote', cwd: '/remote-repo' } }] }
    const cold = {
      get: (name: string) => (name === 'sessionQuery' ? query : name === 'sessions' ? { get: () => undefined } : undefined),
    } as unknown as Ctx
    vi.mocked(keepOfficialAll).mockReturnValue({ paths: ['/remote-repo/a.lua'], skipped: [] })
    const handlers = reviewHandlers(cold, new Map([['/remote-repo', new Map()]]))
    const reply = await handlers['edrv.review.keepAll']!({
      sessionId: 'remote', batchId: 'batch-1', items: [target('official-1', 'a.lua'), target('pending:7', 'b.lua')],
    })
    expect(reply.ok).toBe(true)
    const result = (reply as { result: KeepAllResult }).result
    expect(result).toMatchObject({ completed: 1, total: 2, paths: ['/remote-repo/a.lua'] })
    expect(result.skipped).toEqual([{ id: 'pending:7', display: 'b.lua', reason: '待审条目需要在会话活跃的一端判定' }])
    expect(keepAll).not.toHaveBeenCalled()
    expect(keepOfficialAll).toHaveBeenCalledWith('/remote-repo', [
      { id: 'official-1', seq: 1, revision: 1, operationId: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
  })

  it('keeps pending projections on the live end and reports conflicts as skips', async () => {
    vi.mocked(keepOfficialAll).mockReturnValue({ paths: [], skipped: [] })
    vi.mocked(keepAll).mockResolvedValueOnce({ kept: [{ id: '7', path: '/current/b.lua' }],
      skipped: [{ id: '8', display: 'c.lua', reason: '待审条目已变化，请重试' }] })
    const handlers = reviewHandlers(snapshotCtx(), new Map([['/current', new Map()]]))
    const reply = await handlers['edrv.review.keepAll']!({
      sessionId: 'view', batchId: 'batch-2', items: [target('pending:7', 'b.lua'), target('pending:8', 'c.lua')],
    })
    expect(reply).toMatchObject({ ok: true, result: { completed: 1, total: 2, error: '' } })
    const result = (reply as { result: KeepAllResult }).result
    expect(result.paths).toEqual(['/current/b.lua'])
    expect(result.skipped).toEqual([{ id: 'pending:8', display: 'c.lua', reason: '待审条目已变化，请重试' }])
    expect(vi.mocked(keepAll).mock.calls[0][1].map((item) => item.id)).toEqual(['7', '8'])
  })

  it('refuses an empty batch and a batch beyond the shared limit', async () => {
    vi.mocked(keepOfficialAll).mockClear()
    const handlers = reviewHandlers(snapshotCtx(), new Map([['/current', new Map()]]))
    expect(await handlers['edrv.review.keepAll']!({ sessionId: 'view', batchId: 'empty', items: [] }))
      .toMatchObject({ ok: false, error: '没有可保留的待审记录' })
    const items = Array.from({ length: 2001 }, (_, index) => target(`official-${index}`, `f${index}`))
    const oversized = await handlers['edrv.review.keepAll']!({ sessionId: 'view', batchId: 'big', items })
    expect(oversized).toMatchObject({ ok: false })
    expect((oversized as { error: string }).error).toContain('上限 2000')
    expect(keepOfficialAll).not.toHaveBeenCalled()
  })
})
