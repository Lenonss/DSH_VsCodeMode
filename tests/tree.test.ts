/**
 * host tree.ts 纯函数测试（目录树归一化与整形，不触 fs）。
 * 覆盖：normalizeRel（分隔符/首尾斜杠/.. 拒绝）/ toTreeEntries（相对路径/目录优先/大小写排序）。
 * 作者 ddj 2026-08-26
 */
import { describe, expect, it } from 'vitest'
import { normalizeRel, toTreeEntries } from '../src/tree.js'

describe('normalizeRel', () => {
  it('空/undefined/null → 根', () => {
    expect(normalizeRel('')).toBe('')
    expect(normalizeRel(undefined)).toBe('')
    expect(normalizeRel(null)).toBe('')
    expect(normalizeRel('   ')).toBe('')
  })
  it('`.` → 根', () => {
    expect(normalizeRel('.')).toBe('')
  })
  it('反斜杠→斜杠、去首尾斜杠', () => {
    expect(normalizeRel('src\\client')).toBe('src/client')
    expect(normalizeRel('/src/client/')).toBe('src/client')
    expect(normalizeRel('  /a/b  ')).toBe('a/b')
  })
  it('中间多斜杠保留', () => {
    expect(normalizeRel('a//b')).toBe('a//b')
  })
  it('含 `..` 段拒绝', () => {
    expect(normalizeRel('..')).toBeNull()
    expect(normalizeRel('a/../b')).toBeNull()
    expect(normalizeRel('a\\..\\b')).toBeNull()
  })
})

describe('toTreeEntries', () => {
  const children = [
    { name: 'b.ts', type: 'file', size: 10 },
    { name: 'a.ts', type: 'file', size: 5 },
    { name: 'Src', type: 'directory' },
    { name: 'src', type: 'directory' },
    { name: 'link', type: 'other' },
  ]
  it('根目录：相对路径无前缀 + 目录优先 + 名称小写排序', () => {
    const out = toTreeEntries('', children)
    // 目录优先；名称小写相等时保持原输入顺序（sort 稳定）
    expect(out.map((e) => e.name)).toEqual(['Src', 'src', 'a.ts', 'b.ts', 'link'])
    expect(out[0].path).toBe('Src')
    expect(out[0].type).toBe('directory')
    expect(out[2].path).toBe('a.ts')
    expect(out[4].type).toBe('other')
  })
  it('子目录：相对路径拼接前缀', () => {
    const out = toTreeEntries('src/client', children)
    expect(out[0].path).toBe('src/client/Src')
    expect(out[2].path).toBe('src/client/a.ts')
  })
  it('size 透传、非法项跳过', () => {
    const out = toTreeEntries('', [children[0], null as never, { name: '', type: 'file' }])
    expect(out.length).toBe(1)
    expect(out[0].size).toBe(10)
  })
})
