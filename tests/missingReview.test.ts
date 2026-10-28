import { describe, expect, it, vi } from 'vitest'
import { missingBatch, missingRegion } from '../src/client/missingReview.js'
import type { MissingReview } from '../src/shared/types.js'

const preview: MissingReview = { token: 'token', path: '/missing', content: 'one\r\ntwo\r\n', callIds: ['a', 'b'], at: '2026-10-28' }

describe('whole-file missing preview', () => {
  it('renders every historical line as removed with no invented current lines', () => {
    expect(missingRegion(preview)).toMatchObject({ oldLines: ['one', 'two', ''], newLines: [], start: 1, end: 1, whole: true, sourceKind: 'missing', status: 'pending' })
    expect(missingRegion({ ...preview, content: '' }).newLines).toEqual([])
  })

  it('preflights all paths, deduplicates and separates missing files from legacy hunks', async () => {
    const events: string[] = []
    const result = await missingBatch(['/missing', '/normal', '/missing'], {
      query: async (path) => { events.push('query:' + path); return { ok: true, review: path === '/missing' ? preview : null } },
      decide: async (review, id) => { events.push('decide:' + review.path); expect(id).toBe('stable'); return { ok: true, callIds: review.callIds } },
      guard: vi.fn(), operation: () => 'stable', committed: vi.fn(),
    })
    expect([...result]).toEqual(['/missing'])
    expect(events).toEqual(['query:/missing', 'query:/normal', 'decide:/missing'])
  })

  it('does not mutate anything when a preflight fails', async () => {
    const decide = vi.fn()
    await expect(missingBatch(['/missing', '/invalid'], {
      query: async (path) => path === '/missing' ? { ok: true, review: preview } : { ok: false, error: 'no evidence' },
      decide, guard: vi.fn(), operation: () => 'id', committed: vi.fn(),
    })).rejects.toThrow('no evidence')
    expect(decide).not.toHaveBeenCalled()
  })

  it('stops before the next mutation when session or local-buffer guard changes', async () => {
    const decide = vi.fn()
    const guard = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('session changed') })
    await expect(missingBatch(['/missing'], {
      query: async () => ({ ok: true, review: preview }), decide, guard, operation: () => 'id', committed: vi.fn(),
    })).rejects.toThrow('session changed')
    expect(decide).not.toHaveBeenCalled()
  })
})
