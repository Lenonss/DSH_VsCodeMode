import { describe, expect, it, vi } from 'vitest'
import { reviewHandlers } from '../src/reviewRpc.js'
import type { Ctx } from '../src/store.js'
import { reviewPage, reviewDetail, decideReview } from '../src/reviewDb.js'
import { undoReview } from '../src/reviewUndo.js'
import type { ReviewItem, ReviewPage } from '../src/shared/review.js'
vi.mock('../src/reviewUndo.js', () => ({ undoReview: vi.fn() }))
vi.mock('../src/reviewDb.js', () => ({ reviewPage: vi.fn(), reviewDetail: vi.fn(), decideReview: vi.fn() }))

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

  it('crosses Host instances for reads only: persisted sessions resolve through sessionQuery', async () => {
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
    // 写类操作仍要求 live 会话：另一端不得并发写同一工作区审查库
    await expect(handlers['edrv.review.decide']!({
      sessionId: 'remote', id: 'remote-id', seq: 1, revision: 1, operationId: 'operation', decision: 'accepted',
    })).rejects.toThrow('会话不存在')
    expect(decideReview).not.toHaveBeenCalledWith('/remote-repo', expect.anything())
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
