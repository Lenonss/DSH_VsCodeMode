import { describe, expect, it } from 'vitest'
import { annotateHunk, annotateHunks, applyLocations, fingerprint, locateHunks } from '../src/shared/diff.js'

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

  it('fingerprint distinguishes equal content from unavailable content', () => {
    expect(fingerprint('')).toBe(fingerprint(''))
    expect(fingerprint(null)).toBeNull()
    expect(fingerprint('a')).not.toBe(fingerprint('b'))
  })
})
