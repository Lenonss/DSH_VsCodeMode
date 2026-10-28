/** Logical comparison leaves raw storage and patch payloads untouched. @author ddj 2026年10月28号 */
import { describe, expect, it } from 'vitest'
import { logicalLine, logicalLines, stripBom } from '../src/shared/lineEndings.js'

describe('logicalLine', () => {
  it.each([
    ['a', 'a'], ['a\n', 'a'], ['a\r', 'a'], ['a\r\n', 'a'], ['', ''],
    ['a  \r', 'a  '], ['  a\n', '  a'], ['a\r\r', 'a\r'], ['\uFEFFa\r', '\uFEFFa'],
  ])('strips one terminal EOL from %j', (physical, expected) => {
    expect(logicalLine(physical)).toBe(expected)
  })
})

describe('logicalLines', () => {
  it.each([
    { text: 'a\nb', expected: ['a', 'b'] },
    { text: 'a\r\nb', expected: ['a', 'b'] },
    { text: 'a\rb', expected: ['a', 'b'] },
    { text: 'a\r\nb\nc\rd', expected: ['a', 'b', 'c', 'd'] },
    { text: '\uFEFFa\r\nb', expected: ['a', 'b'] },
    { text: 'a\r\n', expected: ['a', ''] },
    { text: '', expected: [''] },
    { text: '\uFEFF', expected: [''] },
    { text: 'a\uFEFFb', expected: ['a\uFEFFb'] },
  ])('splits $text preserving EOF semantics', ({ text, expected }) => {
    expect(logicalLines(text)).toEqual(expected)
  })
  it('strips only the first leading BOM', () => {
    expect(stripBom('\uFEFF\uFEFFa')).toBe('\uFEFFa')
    expect(stripBom('a\uFEFF')).toBe('a\uFEFF')
  })
})
