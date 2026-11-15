import { describe, it, expect } from 'vitest'
import { reviewAddress, activeWorktree } from '../src/client/univer/routing.js'
import type { UniverFileState } from '../src/shared/univer.js'

describe('independent Univer review navigation', () => {
  const state: UniverFileState = { ok: true, file: 'book.univer', viewerUrl: '/trunk', worktrees: [
    { worktreeId: 'draft', status: 'draft', units: [], worktreeUrl: '/draft' },
    { worktreeId: 'ready', status: 'ready', units: [], mergeUrl: '/review' },
    { worktreeId: 'merged', status: 'merged', units: [], mergeUrl: '/stale' },
  ] }
  it('uses supplied draft and semantic review URLs, not text diffs', () => {
    expect(reviewAddress(state, 'draft')).toBe('/draft')
    expect(reviewAddress(state, 'ready')).toBe('/review')
    expect(reviewAddress(state, 'merged')).toBe('/trunk')
    expect(state.worktrees.filter(activeWorktree)).toHaveLength(2)
  })
})
