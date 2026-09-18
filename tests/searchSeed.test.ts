/**
 * 搜索选区种子单测：种子推导（单行/多行/空白/超长）与一次性槽语义。
 * 纯逻辑断言，不触 DOM/React。
 * 作者 ddj 2026年09月18号
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SEED_MAX, clearSearchSeed, seedQueryOf, setSearchSeed, takeSearchSeed } from '../src/client/searchSeed.js'

describe('seedQueryOf 选区 → 搜索词', () => {
  it('单行选区去首尾空白后原样返回', () => {
    expect(seedQueryOf('  resolveOutline  ')).toBe('resolveOutline')
    expect(seedQueryOf('foo.bar')).toBe('foo.bar')
  })

  it('多行选区只取首行（搜索框是单行 input，整段作为 query 必无匹配）', () => {
    expect(seedQueryOf('const a = 1\nconst b = 2')).toBe('const a = 1')
    expect(seedQueryOf('first\r\nsecond')).toBe('first')
    expect(seedQueryOf('\nsecond')).toBe('')
  })

  it('空值/纯空白/首行空 → 空串（调用方据此保持原搜索词）', () => {
    expect(seedQueryOf('')).toBe('')
    expect(seedQueryOf('   ')).toBe('')
    expect(seedQueryOf('\n\tabc')).toBe('')
    expect(seedQueryOf(null)).toBe('')
    expect(seedQueryOf(undefined)).toBe('')
  })

  it('超长选区截断到 SEED_MAX', () => {
    const long = 'x'.repeat(SEED_MAX + 50)
    expect(seedQueryOf(long).length).toBe(SEED_MAX)
    expect(seedQueryOf('x'.repeat(SEED_MAX))).toBe('x'.repeat(SEED_MAX))
  })

  it('保留正则特殊字符原文（是否按正则解释由面板的 regex 开关决定）', () => {
    expect(seedQueryOf('a.*b(c)')).toBe('a.*b(c)')
  })
})

describe('一次性种子槽', () => {
  beforeEach(() => clearSearchSeed())

  it('set 后 take 取到；再 take 为空（取后即清，防两条消费路径重复应用）', () => {
    setSearchSeed('keepAwake')
    expect(takeSearchSeed()).toBe('keepAwake')
    expect(takeSearchSeed()).toBe('')
  })

  it('写入空选区等价于清除（不覆盖已存在的有效种子时也不例外地消费掉）', () => {
    setSearchSeed('alpha')
    setSearchSeed('   ')
    expect(takeSearchSeed()).toBe('')
  })

  it('未写入时 take 返回空串（无选区 → 面板只聚焦，行为与改动前一致）', () => {
    expect(takeSearchSeed()).toBe('')
  })

  it('多行选区经槽消费时仍是首行', () => {
    setSearchSeed('lineOne\nlineTwo\nlineThree')
    expect(takeSearchSeed()).toBe('lineOne')
  })
})
