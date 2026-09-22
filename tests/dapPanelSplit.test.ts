/** 调试面板四段分栏高度（夹取/归一化/相邻重分配/持久化）测试。作者 ddj 2026年09月21号 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  clampSectionHeight, redistribute, sanitizeHeights, loadSectionHeights, saveSectionHeights,
  DEFAULT_HEIGHTS, MAX_H, MIN_H,
} from '../src/client/dap/panelSplit.js'

/** 最小 localStorage 替身（node 环境无 DOM）。 */
function installStorage(): void {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
  })
}

beforeEach(() => {
  installStorage()
})

describe('clampSectionHeight', () => {
  it('夹取到 [MIN_H, MAX_H] 并取整', () => {
    expect(clampSectionHeight(10)).toBe(MIN_H)
    expect(clampSectionHeight(99999)).toBe(MAX_H)
    expect(clampSectionHeight(200.4)).toBe(200)
    expect(clampSectionHeight(200.6)).toBe(201)
  })

  it('非有限数回退 MIN_H', () => {
    expect(clampSectionHeight(Number.NaN)).toBe(MIN_H)
    expect(clampSectionHeight(Number.POSITIVE_INFINITY)).toBe(MIN_H)
  })
})

describe('sanitizeHeights', () => {
  it('空/非对象/数组回退默认值', () => {
    expect(sanitizeHeights(null)).toEqual(DEFAULT_HEIGHTS)
    expect(sanitizeHeights('x')).toEqual(DEFAULT_HEIGHTS)
    expect(sanitizeHeights([1, 2])).toEqual(DEFAULT_HEIGHTS)
  })

  it('合法值夹取、缺 key 回默认、非法值丢弃', () => {
    const out = sanitizeHeights({ variables: 500, watch: 5, stack: 'x', breakpoints: Number.NaN })
    expect(out.variables).toBe(500)
    expect(out.watch).toBe(MIN_H)
    expect(out.stack).toBe(DEFAULT_HEIGHTS.stack)
    expect(out.breakpoints).toBe(DEFAULT_HEIGHTS.breakpoints)
  })
})

describe('redistribute', () => {
  const base = { variables: 300, watch: 200, stack: 200, breakpoints: 300 }

  it('向下拖（dy>0）：上段增高、下段等量减矮', () => {
    const next = redistribute(base, 'variables', 'watch', 80)
    expect(next.variables).toBe(380)
    expect(next.watch).toBe(120)
    expect(next.stack).toBe(200)
    expect(next.breakpoints).toBe(300)
  })

  it('向上拖（dy<0）：上段减矮、下段增高', () => {
    const next = redistribute(base, 'watch', 'stack', -60)
    expect(next.watch).toBe(140)
    expect(next.stack).toBe(260)
  })

  it('上段已到 MAX：拖动被吸收，两段都不动', () => {
    const pinned = { ...base, variables: MAX_H }
    const next = redistribute(pinned, 'variables', 'watch', 100)
    expect(next.variables).toBe(MAX_H)
    expect(next.watch).toBe(200)
  })

  it('下段已到 MIN：拖动量全由上段承担', () => {
    const pinned = { ...base, watch: MIN_H }
    const next = redistribute(pinned, 'variables', 'watch', 200)
    expect(next.variables).toBe(500)
    expect(next.watch).toBe(MIN_H)
  })

  it('上段接近 MAX：吃满剩余空间后余量转给下段（分隔条停在可行位置）', () => {
    const near = { ...base, variables: 1100, watch: 400 }
    const next = redistribute(near, 'variables', 'watch', 200)
    expect(next.variables).toBe(MAX_H)
    expect(next.watch).toBe(300)
  })

  it('非有限 dy 原样不动；不修改入参', () => {
    const next = redistribute(base, 'variables', 'watch', Number.NaN)
    expect(next).toEqual(base)
    expect(base.variables).toBe(300)
  })
})

describe('loadSectionHeights / saveSectionHeights', () => {
  it('写入后读回一致（按 scope 隔离）', () => {
    saveSectionHeights('ws-a', { variables: 420, watch: 160, stack: 240, breakpoints: 300 })
    expect(loadSectionHeights('ws-a').variables).toBe(420)
    expect(loadSectionHeights('ws-b')).toEqual(DEFAULT_HEIGHTS)
  })

  it('损坏 JSON 回退默认值', () => {
    localStorage.setItem('edrv.dap.split.ws-broken', '{oops')
    expect(loadSectionHeights('ws-broken')).toEqual(DEFAULT_HEIGHTS)
  })

  it('空 scope 直接回默认值', () => {
    expect(loadSectionHeights('')).toEqual(DEFAULT_HEIGHTS)
  })
})
