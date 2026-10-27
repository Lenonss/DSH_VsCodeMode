import { describe, expect, it } from 'vitest'
import { reviewBlocks, reviewRegions } from '../src/shared/reviewRegions.js'
import type { OfficialDiff } from '../src/shared/review.js'
const diff: OfficialDiff = { kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4,
    lines: [' head', '-old', '+new', ' mid', '-gone', '+added'] }] }
describe('official source regions', () => {
  it('splits contextual change runs and applies independent decisions', () => {
    const blocks = reviewBlocks(diff)
    expect(blocks).toHaveLength(2)
    const regions = reviewRegions(diff, 'record', [{ id: blocks[0].id, decision: 'accepted' }], 'head\nnew\nmid\nadded')
    expect(regions.map((region) => [region.start, region.end, region.status])).toEqual([[2, 3, 'accepted'], [4, 5, 'pending']])
    expect(regions[0].oldLines).toEqual(['old'])
  })
  it('marks repeated contexts and missing files as conflicts instead of guessing historical line numbers', () => {
    const repeated = 'head\nnew\nmid\nadded\nhead\nnew\nmid\nadded'
    expect(reviewRegions(diff, 'r', [], repeated).every((region) => region.stale)).toBe(true)
    expect(reviewRegions(diff, 'r', [], null).every((region) => region.stale)).toBe(true)
  })
  it('locates pure deletions using unique context with BOM and CRLF', () => {
    const deleted: OfficialDiff = { ...diff, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 2,
      lines: [' head', '-old', ' tail'] }] }
    expect(reviewRegions(deleted, 'r', [], '\uFEFFhead\r\ntail')[0]).toMatchObject({ start: 2, end: 2, stale: false, oldLines: ['old'], newLines: [] })
  })
})
