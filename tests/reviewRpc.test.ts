import { describe, expect, it, vi } from 'vitest'
import { reviewHandlers } from '../src/reviewRpc.js'
import type { Ctx } from '../src/store.js'
import { reviewPage, reviewDetail, decideReview } from '../src/reviewDb.js'
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
  })
})
