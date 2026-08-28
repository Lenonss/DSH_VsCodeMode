/**
 * client workspaceFoldCache 纯函数测试（性能优化页工作区展开态：序列化/解析/清洗/容量）。
 * 作者 ddj 2026-09-02
 */
import { describe, expect, it } from 'vitest'
import {
  FOLD_CAP,
  normalizeFoldKey,
  parseFold,
  sanitizeFolded,
  serializeFold,
} from '../src/client/state/workspaceFoldCache.js'

describe('normalizeFoldKey', () => {
  it('空值 → 空串', () => {
    expect(normalizeFoldKey('')).toBe('')
    expect(normalizeFoldKey('  ')).toBe('')
    expect(normalizeFoldKey(undefined)).toBe('')
    expect(normalizeFoldKey(null)).toBe('')
  })
  it('去首尾空白，保留内容原样（工作区键非路径，不改斜杠）', () => {
    expect(normalizeFoldKey('  /a/b  ')).toBe('/a/b')
    expect(normalizeFoldKey('D:\\Work\\proj')).toBe('D:\\Work\\proj')
  })
})

describe('sanitizeFolded', () => {
  it('非数组 → 空', () => {
    expect(sanitizeFolded(null)).toEqual([])
    expect(sanitizeFolded('x')).toEqual([])
    expect(sanitizeFolded({ a: 1 })).toEqual([])
  })
  it('丢弃空值与重复项，保持顺序', () => {
    expect(sanitizeFolded(['a', '', '  ', 'a', 'b'])).toEqual(['a', 'b'])
  })
  it('非字符串项按空值丢弃', () => {
    expect(sanitizeFolded(['a', 42, null, 'b'])).toEqual(['a', 'b'])
  })
  it('超容量截断到 FOLD_CAP', () => {
    const many = Array.from({ length: FOLD_CAP + 20 }, (_, i) => 'ws' + i)
    expect(sanitizeFolded(many)).toHaveLength(FOLD_CAP)
  })
})

describe('serializeFold / parseFold', () => {
  it('往返一致', () => {
    const keys = ['ws-a', 'ws-b']
    expect(parseFold(serializeFold(keys))).toEqual(keys)
  })
  it('带 v 版本号', () => {
    expect(JSON.parse(serializeFold(['a']))).toMatchObject({ v: 1 })
  })
  it('损坏文本 → 空集合', () => {
    expect(parseFold('')).toEqual([])
    expect(parseFold('not json')).toEqual([])
    expect(parseFold('null')).toEqual([])
    expect(parseFold('[]')).toEqual([])
    expect(parseFold('{"expanded":"x"}')).toEqual([])
  })
  it('缺失 expanded 字段 → 空集合', () => {
    expect(parseFold('{"v":1}')).toEqual([])
  })
})
