import { describe, expect, it } from 'vitest'
import { annotateHunk, annotateHunks, applyLocations, fingerprint, locateHunks, normalizeForCompare, normalizeHunk } from '../src/shared/diff.js'

describe('shared diff helpers', () => {
  it('locates repeated new text without reusing the first match', () => {
    const locations = locateHunks('same\nkeep\nsame', [
      { oldText: 'one', newText: 'same' },
      { oldText: 'two', newText: 'same' },
    ])
    expect(locations.map((item) => [item.start, item.end, item.matched])).toEqual([
      [0, 4, true],
      [10, 14, true],
    ])
  })

  it('handles a pure deletion without treating empty newText as offset zero', () => {
    const hunk = annotateHunk({ oldText: 'before', newText: '' }, 'before\nafter', 'after')
    const locations = locateHunks('after', [hunk])
    expect(locations[0].matched).toBe(true)
    expect(locations[0].start).toBe(0)
    expect(locations[0].end).toBe(0)
    expect(applyLocations('after', locations, true).content).toBe('beforeafter')
  })

  it('keeps an empty-file insertion location explicit', () => {
    const locations = locateHunks('', [{ oldText: null, newText: '' }])
    expect(locations[0]).toMatchObject({ start: 0, end: 0, matched: true })
  })

  it('annotates repeated hunk coordinates in order', () => {
    const hunks = annotateHunks([
      { oldText: 'a', newText: 'same' },
      { oldText: 'b', newText: 'same' },
    ], 'a\nb', 'same\nkeep\nsame')
    expect(hunks.map((hunk) => [hunk.afterStart, hunk.afterEnd])).toEqual([[0, 4], [10, 14]])
  })

  it('respects snapshot priority and fallback to the earliest unoccupied repeated text', () => {
    const locations = locateHunks('same--same--same', [
      { oldText: 'a', newText: 'same', afterStart: 6, afterEnd: 10 },
      { oldText: 'b', newText: 'same', afterStart: 6, afterEnd: 10 },
      { oldText: 'c', newText: 'same', afterStart: 12, afterEnd: 16 },
    ])
    expect(locations.map(({ start, matched }) => [start, matched])).toEqual([[6, true], [-1, false], [12, true]])
    expect(locateHunks('same--same--same', [
      { oldText: 'a', newText: 'same', afterStart: 6, afterEnd: 10 },
      { oldText: 'b', newText: 'same' },
      { oldText: 'c', newText: 'same' },
    ]).map(({ start }) => start)).toEqual([6, 12, 0])
  })

  it('keeps the original non-overlapping occurrence sequence for repeated needles', () => {
    const locations = locateHunks('aaaaa', Array.from({ length: 3 }, () => ({ oldText: 'x', newText: 'aa' })))
    expect(locations.map(({ start, matched }) => [start, matched])).toEqual([[0, true], [2, true], [-1, false]])
  })

  it('applies distant replacements and zero-length insertions in descending order', () => {
    const content = 'a--b--c'
    const locations = locateHunks(content, [
      { oldText: 'A', newText: 'a' },
      { oldText: 'B', newText: 'b' },
      { oldText: 'C', newText: 'c' },
    ])
    expect(applyLocations(content, locations, true)).toEqual({ content: 'A--B--C', stale: [] })
    const points = locateHunks('abc', [
      { oldText: 'x', newText: '', afterStart: 1, afterEnd: 1 },
      { oldText: 'y', newText: '', afterStart: 2, afterEnd: 2 },
    ])
    expect(applyLocations('abc', points, true).content).toBe('axbyc')
  })

  it('fingerprint distinguishes equal content from unavailable content', () => {
    expect(fingerprint('')).toBe(fingerprint(''))
    expect(fingerprint(null)).toBeNull()
    expect(fingerprint('a')).not.toBe(fingerprint('b'))
  })
})

describe('normalizeForCompare / normalizeHunk', () => {
  it('剥 BOM 并统一 CRLF 为 LF', () => {
    expect(normalizeForCompare('\uFEFFa\r\nb\r\n')).toBe('a\nb\n')
    expect(normalizeForCompare('a\r\nb')).toBe('a\nb')
    expect(normalizeForCompare('plain')).toBe('plain')
  })
  it('normalizeHunk 两侧同口径归一化，null oldText 保持', () => {
    expect(normalizeHunk({ oldText: null, newText: '\uFEFFx\r\n' })).toEqual({ oldText: null, newText: 'x\n' })
    expect(normalizeHunk({ oldText: 'a\r\n', newText: 'b\r\n' })).toEqual({ oldText: 'a\n', newText: 'b\n' })
  })
  it('BOM/CRLF 不同但语义相同的文本指纹一致', () => {
    expect(fingerprint(normalizeForCompare('\uFEFFa\r\nb'))).toBe(fingerprint(normalizeForCompare('a\nb')))
  })
})
