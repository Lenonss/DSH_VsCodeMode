import { describe, expect, it } from 'vitest'
import { classifyEncoding, decodePreview, COMPAT_PREVIEW_BYTES } from '../src/textEncoding.js'

describe('encoding edge cases', () => {
  it('treats an empty file as UTF-8', () => {
    expect(classifyEncoding(new Uint8Array(0)).kind).toBe('utf-8')
  })

  it('flags previews longer than the cap', () => {
    const big = new Uint8Array(COMPAT_PREVIEW_BYTES + 1).fill(0x61)
    const preview = decodePreview(big, classifyEncoding(big))
    expect(preview.truncated).toBe(true)
    expect(preview.text.length).toBe(COMPAT_PREVIEW_BYTES)
  })
})
