/**
 * 会话引用语法测试：格式化/解析往返、路径归一、选区→行范围判定。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import { formatRef, normalizeRefPath, parseRef, refBasename, selectionRange } from '../src/shared/refSyntax.js'

describe('引用格式化', () => {
  it('无行范围 / 单行 / 多行', () => {
    expect(formatRef('src/a.ts')).toBe('@src/a.ts')
    expect(formatRef('src/a.ts', { startLine: 3, endLine: 3 })).toBe('@src/a.ts L3')
    expect(formatRef('src/a.ts', { startLine: 3, endLine: 9 })).toBe('@src/a.ts L3-L9')
  })

  it('统一分隔符并去掉 @ / ./ 前缀', () => {
    expect(formatRef('@./src\\a.ts')).toBe('@src/a.ts')
    expect(normalizeRefPath('.\\src\\a.ts')).toBe('src/a.ts')
  })

  it('空路径返回空串；行号夹到 >=1 且 end 不小于 start', () => {
    expect(formatRef('')).toBe('')
    expect(formatRef('a.ts', { startLine: 0, endLine: 0 })).toBe('@a.ts L1')
    expect(formatRef('a.ts', { startLine: 5, endLine: 2 })).toBe('@a.ts L5')
  })
})

describe('引用解析', () => {
  it('解析路径与行范围', () => {
    expect(parseRef('@src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(parseRef('@src/a.ts L3')).toEqual({ path: 'src/a.ts', range: { startLine: 3, endLine: 3 } })
    expect(parseRef('@src/a.ts L3-L9')).toEqual({ path: 'src/a.ts', range: { startLine: 3, endLine: 9 } })
    expect(parseRef('@src/a.ts L3-9')).toEqual({ path: 'src/a.ts', range: { startLine: 3, endLine: 9 } })
  })

  it('容忍无 @、首尾空白与引号路径（含空格）', () => {
    expect(parseRef('  src/a.ts  ')).toEqual({ path: 'src/a.ts' })
    expect(parseRef('@"my folder/a b.ts" L2-L4')).toEqual({ path: 'my folder/a b.ts', range: { startLine: 2, endLine: 4 } })
  })

  it('格式化与解析往返一致', () => {
    const text = formatRef('a/b/c.ts', { startLine: 12, endLine: 20 })
    expect(parseRef(text)).toEqual({ path: 'a/b/c.ts', range: { startLine: 12, endLine: 20 } })
  })

  it('非引用文本/多行文本/非法行号回落', () => {
    expect(parseRef('普通的一段话')).toEqual({ path: '普通的一段话' })
    expect(parseRef('line one\nline two')).toBeNull()
    expect(parseRef('')).toBeNull()
    // 行号 < 1 视为无效：只保留路径，不带范围（调用方再按路径解析，解析不到就提示）
    expect(parseRef('@a.ts L0')).toEqual({ path: 'a.ts L0'.replace(' L0', '') })
  })
})

describe('选区 → 行范围', () => {
  it('跨行一律是引用（含首尾半行）', () => {
    expect(selectionRange({ startLine: 2, endLine: 5, startColumn: 7, endColumn: 3, lineLength: 40 })).toEqual({ startLine: 2, endLine: 5 })
  })

  it('单行必须整行选中', () => {
    expect(selectionRange({ startLine: 1, endLine: 1, startColumn: 1, endColumn: 11, lineLength: 10 })).toEqual({ startLine: 1, endLine: 1 })
    expect(selectionRange({ startLine: 1, endLine: 1, startColumn: 2, endColumn: 11, lineLength: 10 })).toBeNull()
    expect(selectionRange({ startLine: 1, endLine: 1, startColumn: 1, endColumn: 10, lineLength: 10 })).toBeNull()
  })

  it('空行整选不算引用（无内容可引用）', () => {
    expect(selectionRange({ startLine: 4, endLine: 4, startColumn: 1, endColumn: 1, lineLength: 0 })).toBeNull()
  })
})

describe('文件名', () => {
  it('取末段并归一分隔符', () => {
    expect(refBasename('a\\b\\c.ts')).toBe('c.ts')
    expect(refBasename('c.ts')).toBe('c.ts')
    expect(refBasename('')).toBe('')
  })
})
