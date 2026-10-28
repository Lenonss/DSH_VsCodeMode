import { describe, expect, it } from 'vitest'
import { reviewBlocks, reviewRegions } from '../src/shared/reviewRegions.js'
import type { OfficialDiff } from '../src/shared/review.js'
const diff: OfficialDiff = { kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4,
    lines: [' head', '-old', '+new', ' mid', '-gone', '+added'] }] }
/** @private @author ddj 2026年10月28号 @param lines Physical patch lines. @returns Single-hunk patch for boundary tests. */
function patchOf(lines: string[]): OfficialDiff {
  return { ...diff, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines }] }
}

describe('logical line matrix', () => {
  const endings = ['', '\r', '\n', '\r\n']
  const contents = ['head\nnew\nmid\nadded', 'head\r\nnew\r\nmid\r\nadded', 'head\rnew\rmid\radded', 'head\r\nnew\nmid\radded']
  it.each(endings.flatMap((ending) => contents.map((content) => ({ ending, content }))))('locates patch ending $ending against $content', ({ ending, content }) => {
    const patch = { ...diff, hunks: diff.hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => line + ending) })) }
    const regions = reviewRegions(patch, 'r', [{ id: '0:2:2', decision: 'accepted' }], content)
    expect(regions.map((region) => [region.id, region.start, region.end, region.status])).toEqual([
      ['0:2:2', 2, 3, 'accepted'], ['0:4:4', 4, 5, 'pending'],
    ])
    expect(reviewBlocks(patch)).toEqual(reviewBlocks(diff))
    expect(JSON.stringify(patch)).toContain(JSON.stringify(' head' + ending).slice(1, -1))
  })
})

describe('unique contextual fallback', () => {
  it('locates trailing whitespace differences only after strict absence', () => {
    expect(reviewRegions(patchOf([' head', '-old', '+new']), 'r', [], 'head  \nnew  ')[0]).toMatchObject({ start: 2, end: 3, stale: false })
  })
  it('prefers a strict unique match even when fallback would be ambiguous', () => {
    expect(reviewRegions(patchOf([' head', '+new']), 'r', [], 'head\nnew\nhead  \nnew  ')[0]).toMatchObject({ start: 2, stale: false })
  })
  it('rejects strict and fallback ambiguity without historical coordinates', () => {
    const patch = patchOf([' head', '+new'])
    expect(reviewRegions(patch, 'r', [], 'head\nnew\nhead\nnew')[0].staleReason).toBe('ambiguous')
    expect(reviewRegions(patch, 'r', [], 'head \nnew \nhead  \nnew  ')[0].staleReason).toBe('ambiguous')
  })
  it('does not relax all-whitespace patterns or leading indentation', () => {
    expect(reviewRegions(patchOf(['+  ']), 'r', [], ' ')[0].staleReason).toBe('missing')
    expect(reviewRegions(patchOf(['+  new']), 'r', [], 'new  ')[0].staleReason).toBe('missing')
  })
  it('keeps EOF deletion zero-length and empty patterns missing', () => {
    expect(reviewRegions(patchOf([' head', '-old']), 'r', [], 'head')[0]).toMatchObject({ start: 2, end: 2, stale: false })
    expect(reviewRegions(patchOf(['-old']), 'r', [], '')[0].staleReason).toBe('missing')
  })
  it('does not confuse coarse with missing blocks', () => {
    expect(reviewRegions({ ...diff, coarse: true }, 'r', [], 'head\nnew\nmid\nadded').every((region) => !region.stale)).toBe(true)
  })
})

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
    expect(reviewRegions(diff, 'r', [], repeated).every((region) => region.staleReason === 'ambiguous')).toBe(true)
    expect(reviewRegions(diff, 'r', [], null).every((region) => region.staleReason === 'no-content')).toBe(true)
  })
  it('locates pure deletions using unique context with BOM and CRLF', () => {
    const deleted: OfficialDiff = { ...diff, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 2,
      lines: [' head\r', '-old\r', ' tail\r'] }] }
    expect(reviewRegions(deleted, 'r', [], '\uFEFFhead\r\ntail')[0]).toMatchObject({ start: 2, end: 2, stale: false, oldLines: ['old'], newLines: [] })
  })
})
