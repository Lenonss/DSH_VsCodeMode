// @ts-nocheck
/**
 * agent 工具输出归一单测（22-agent-tools-and-commit）。
 * 守护：0.2.x 会因 undefined/NaN/稀疏数组整次失败——归一后必须是无损 JSON。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import { TOOL_TOTAL_MAX, toolJsonText, toLosslessJson } from '../src/svnToolJson.js'

describe('toLosslessJson', () => {
  it('剔除 undefined/函数，NaN 与 Infinity → null', () => {
    const value = toLosslessJson({ a: undefined, b: () => 1, c: NaN, d: Infinity, e: 'ok' })
    expect(value).toEqual({ c: null, d: null, e: 'ok' })
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })

  it('数组空洞补 null，循环引用断开', () => {
    const sparse = [1, , 3]
    expect(toLosslessJson(sparse)).toEqual([1, null, 3])
    const cyclic = { name: 'x' }
    cyclic.self = cyclic
    expect(toLosslessJson(cyclic)).toEqual({ name: 'x', self: null })
  })

  it('超长字符串截断到字段上限', () => {
    const text = 'x'.repeat(9000)
    expect(toLosslessJson(text).length).toBe(8 * 1024)
  })
})

describe('toolJsonText', () => {
  it('正常载荷输出 JSON 文本', () => {
    expect(JSON.parse(toolJsonText({ ok: true, entries: [] }))).toEqual({ ok: true, entries: [] })
  })

  it('超总上限时返回截断提示（仍是合法 JSON）', () => {
    const huge = {}
    for (let i = 0; i < 40; i++) huge['field' + i] = 'y'.repeat(8 * 1024)
    const text = toolJsonText(huge)
    const parsed = JSON.parse(text)
    expect(parsed.ok).toBe(false)
    expect(parsed.truncated).toBe(true)
  })
})
