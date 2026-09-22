/** 断点 hover 预览判定测试。作者 ddj 2026年09月29号 */
import { describe, expect, it } from 'vitest'
import { hintLineFor, TARGET_GUTTER_GLYPH, TARGET_GUTTER_LINE } from '../src/client/dap/hintLine.js'

describe('hintLineFor', () => {
  it('glyph 区无断点 → 显示预览（对应 VS Code type=2 分支）', () => {
    expect(hintLineFor(TARGET_GUTTER_GLYPH, 20, [])).toBe(20)
  })

  it('行号区无断点 → 显示预览（对应 VS Code type=3 分支）', () => {
    expect(hintLineFor(TARGET_GUTTER_LINE, 7, [3, 9])).toBe(7)
  })

  it('已有断点的行 → 不显示预览（不与实心红点重叠）', () => {
    expect(hintLineFor(TARGET_GUTTER_GLYPH, 20, [20])).toBe(0)
  })

  it('其它区域（正文/滚动条等）→ 不显示', () => {
    expect(hintLineFor(6, 20, [])).toBe(0)  // CONTENT_TEXT
    expect(hintLineFor(11, 20, [])).toBe(0) // SCROLLBAR
    expect(hintLineFor(undefined, 20, [])).toBe(0)
  })

  it('无效行号 → 不显示', () => {
    expect(hintLineFor(TARGET_GUTTER_GLYPH, 0, [])).toBe(0)
    expect(hintLineFor(TARGET_GUTTER_GLYPH, undefined, [])).toBe(0)
  })

  it('行号区连续移动时不误判（不同行各自命中）', () => {
    expect(hintLineFor(TARGET_GUTTER_LINE, 5, [])).toBe(5)
    expect(hintLineFor(TARGET_GUTTER_LINE, 6, [])).toBe(6)
  })
})
