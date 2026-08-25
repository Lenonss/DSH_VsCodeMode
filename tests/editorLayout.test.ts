import { describe, expect, it } from 'vitest'
import { editorHeight } from '../src/client/editorLayout.js'

describe('editorHeight', () => {
  it('uses the composer top as the lower boundary', () => {
    expect(editorHeight(100, 900, 700)).toBe(600)
  })

  it('falls back to the scrollport bottom without a composer', () => {
    expect(editorHeight(100, 900)).toBe(800)
  })

  it('uses the nearer boundary when composer extends below the scrollport', () => {
    expect(editorHeight(100, 900, 980)).toBe(800)
  })

  it('clamps an already covered editor to zero', () => {
    expect(editorHeight(700, 900, 650)).toBe(0)
  })

  it('normalizes invalid geometry without throwing', () => {
    expect(editorHeight(Number.NaN, 900, Number.NaN)).toBe(900)
  })
})
