/**
 * Markdown 预览态缓存（client state/mdPreviewCache.ts）纯函数测试：不触 localStorage。
 * 覆盖：归一化（丢弃坏值/去重/保序/超限截断）与解析容错。
 * 作者 ddj 2026-09-28
 */
import { describe, expect, it } from 'vitest'
import { MD_PREVIEW_CAP, normalizeMdPreview, parseMdPreview } from '../src/client/state/mdPreviewCache.js'

describe('normalizeMdPreview', () => {
  it('丢弃非字符串与空串，保留顺序', () => {
    expect(normalizeMdPreview(['/a/README.md', 42, '', null, undefined, '/b/x.md']))
      .toEqual(['/a/README.md', '/b/x.md'])
  })

  it('非数组 → 空表', () => {
    expect(normalizeMdPreview(null)).toEqual([])
    expect(normalizeMdPreview({ a: 1 })).toEqual([])
    expect(normalizeMdPreview('a.md')).toEqual([])
  })

  it('去重保留首次出现顺序', () => {
    expect(normalizeMdPreview(['/a.md', '/b.md', '/a.md'])).toEqual(['/a.md', '/b.md'])
  })

  it('超限截断到 MD_PREVIEW_CAP', () => {
    const many = Array.from({ length: MD_PREVIEW_CAP + 10 }, (_, i) => `/f${i}.md`)
    const out = normalizeMdPreview(many)
    expect(out).toHaveLength(MD_PREVIEW_CAP)
    expect(out[0]).toBe('/f0.md')
    expect(out.includes('/f' + MD_PREVIEW_CAP + '.md')).toBe(false)
  })
})

describe('parseMdPreview', () => {
  it('合法数组解析并归一化', () => {
    expect(parseMdPreview('["/a.md", 1, "/a.md", "/b.md"]')).toEqual(['/a.md', '/b.md'])
  })

  it('空/损坏/非数组 → 空表', () => {
    expect(parseMdPreview(null)).toEqual([])
    expect(parseMdPreview('')).toEqual([])
    expect(parseMdPreview('not json')).toEqual([])
    expect(parseMdPreview('{"a":1}')).toEqual([])
  })
})
