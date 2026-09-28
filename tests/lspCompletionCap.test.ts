/**
 * lsp/completionCap.ts 单测 — 补全结果的前缀感知截断。
 *
 * 背景：xLua 绑定桩（上万个 CS_*）会把项目全局（ECommon 等）顶到 500 条上限之外，
 * 旧实现按服务器原序硬切，导致用户正在输入的符号被永久丢弃。
 * 本文件锁定：未超限零变化、超限无前缀沿用旧语义、超限有前缀按分桶保留命中项。
 * 作者 ddj 2026-09-24
 */
import { describe, expect, it } from 'vitest'
import { capCompletions, COMPLETION_ITEM_CAP } from '../src/lsp/completionCap.js'

/** 构造 n 条 CS_* 桩 + 指定尾随条目（复现「项目全局排在桩之后」的现场）。 */
function withStubs(stubCount: number, tail: string[]) {
  return [
    ...Array.from({ length: stubCount }, (_, i) => ({ label: 'CS_UnityEngine_Fake_' + i })),
    ...tail.map((label) => ({ label })),
  ]
}

describe('capCompletions', () => {
  it('上限常量为 500（与 references 同口径）', () => {
    expect(COMPLETION_ITEM_CAP).toBe(500)
  })

  it('未超限 → 原样返回、truncated=false、顺序不变', () => {
    const items = [{ label: 'ECommon' }, { label: 'CS_Foo' }]
    const out = capCompletions(items, 'EC')
    expect(out.items).toBe(items)
    expect(out.truncated).toBe(false)
  })

  it('恰好等于上限 → 不截断', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ label: 'm' + i }))
    expect(capCompletions(items, '').truncated).toBe(false)
  })

  it('超限且无前缀 → 取前 cap 条（沿用旧行为）', () => {
    const items = Array.from({ length: 620 }, (_, i) => ({ label: 'm' + i }))
    const out = capCompletions(items)
    expect(out.items.length).toBe(500)
    expect(out.truncated).toBe(true)
    expect(out.items[0]!.label).toBe('m0')
    expect(out.items[499]!.label).toBe('m499')
  })

  it('超限 + 前缀命中尾部条目 → 命中项被保留且排首（ECommon 场景）', () => {
    const items = withStubs(10143, ['EChestCirculationState', 'ECommon'])
    const out = capCompletions(items, 'ECommon')
    expect(out.items.length).toBe(500)
    expect(out.truncated).toBe(true)
    const labels = out.items.map((i) => i.label)
    expect(labels).toContain('ECommon')
    expect(labels[0]).toBe('ECommon')
  })

  it('分桶顺序：startsWith > includes > 子序列 > 其余，桶内保原序', () => {
    // 必须多于 cap，否则走「未超限零变化」早退分支，测不到分桶
    const items = [
      { label: 'zzz' },                 // 其余
      { label: 'E_x_C' },               // 子序列（非子串：e…c 顺序出现）
      { label: 'aEcInside' },           // includes（含 'ec' 但非开头）
      { label: 'ECommon' },             // startsWith
      { label: 'aaa' },                 // 其余（填充，保证超限）
    ]
    const out = capCompletions(items, 'ec', 4)
    expect(out.items.map((i) => i.label)).toEqual(['ECommon', 'aEcInside', 'E_x_C', 'zzz'])
    expect(out.truncated).toBe(true)
  })

  it('filterText 优先于 label 参与匹配', () => {
    const items = [
      { label: 'display-a', filterText: 'CS_Foo' },
      { label: 'display-b', filterText: 'ECommon' },
      { label: 'display-c', filterText: 'EActivity' },
    ]
    // cap=2 迫使截断；ECommon 应进入 startsWith 桶并保留
    const out = capCompletions(items, 'ECommon', 2)
    expect(out.items[0]!.label).toBe('display-b')
    expect(out.truncated).toBe(true)
  })

  it('前缀大小写不敏感', () => {
    const items = withStubs(600, ['ECommon'])
    const lower = capCompletions(items, 'ecommon')
    const upper = capCompletions(items, 'ECOMMON')
    expect(lower.items[0]!.label).toBe('ECommon')
    expect(upper.items[0]!.label).toBe('ECommon')
  })

  it('无命中前缀时也不丢条目总量（仍返回 cap 条）', () => {
    const items = Array.from({ length: 620 }, (_, i) => ({ label: 'm' + i }))
    const out = capCompletions(items, 'ZZZZ')
    expect(out.items.length).toBe(500)
    expect(out.truncated).toBe(true)
  })

  it('空/非法输入安全', () => {
    expect(capCompletions([], 'EC')).toEqual({ items: [], truncated: false })
    expect(capCompletions(null as never, 'EC')).toEqual({ items: [], truncated: false })
    expect(capCompletions(undefined as never, 'EC')).toEqual({ items: [], truncated: false })
  })
})
