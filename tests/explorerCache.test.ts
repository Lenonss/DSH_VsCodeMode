/**
 * client explorerCache 纯函数测试（展开路径持久化：序列化/解析/清洗/容量）。
 * 作者 ddj 2026-08-28
 */
import { describe, expect, it } from 'vitest'
import {
  EXPANDED_CAP,
  normalizeExpanded,
  parseExplorer,
  sanitizeExpanded,
  serializeExplorer,
} from '../src/client/state/explorerCache.js'

describe('normalizeExpanded', () => {
  it('空/点 → 根', () => {
    expect(normalizeExpanded('')).toBe('')
    expect(normalizeExpanded('  ')).toBe('')
    expect(normalizeExpanded('.')).toBe('')
    expect(normalizeExpanded('/')).toBe('')
    expect(normalizeExpanded(undefined)).toBe('')
    expect(normalizeExpanded(null)).toBe('')
  })
  it('反斜杠与首尾斜杠归一化', () => {
    expect(normalizeExpanded('a\\b\\c')).toBe('a/b/c')
    expect(normalizeExpanded('/a/b/')).toBe('a/b')
  })
  it('.. 段拒绝', () => {
    expect(normalizeExpanded('a/../b')).toBeNull()
    expect(normalizeExpanded('../x')).toBeNull()
  })
})

describe('sanitizeExpanded', () => {
  it('去重且保序', () => {
    expect(sanitizeExpanded(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c'])
  })
  it('丢弃非法项与非数组', () => {
    expect(sanitizeExpanded(['ok', '../x', 42, null, ''])).toEqual(['ok', ''])
    expect(sanitizeExpanded('nope')).toEqual([])
    expect(sanitizeExpanded(undefined)).toEqual([])
  })
  it('容量上限裁剪', () => {
    const big = []
    for (let i = 0; i < EXPANDED_CAP + 100; i++) big.push('d' + i)
    expect(sanitizeExpanded(big)).toHaveLength(EXPANDED_CAP)
  })
})

describe('serialize/parseExplorer', () => {
  it('往返一致（含 root）', () => {
    const data = { root: 'C:/ws', expanded: ['src', 'src/client'] }
    expect(parseExplorer(serializeExplorer(data))).toEqual(data)
  })
  it('root 为 null 时往返', () => {
    expect(parseExplorer(serializeExplorer({ root: null, expanded: ['a'] }))).toEqual({ root: null, expanded: ['a'] })
  })
  it('损坏/格式不符 → null；缺字段 → 空缓存', () => {
    expect(parseExplorer(null)).toBeNull()
    expect(parseExplorer('not json')).toBeNull()
    expect(parseExplorer('{"v":1}')).toEqual({ root: null, expanded: [] })
    expect(parseExplorer('{"v":1,"expanded":"nope"}')).toEqual({ root: null, expanded: [] })
  })
})
