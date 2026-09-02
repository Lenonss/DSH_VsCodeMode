/**
 * client navHistory 纯函数测试（导航历史：记录去重/后退/前进/容量边界）。
 * 作者 ddj 2026-09-04
 */
import { describe, expect, it } from 'vitest'
import { createNavHistory, NAV_HISTORY_CAP } from '../src/client/navHistory.js'

describe('createNavHistory record', () => {
  it('pushes entries and clears future on new navigation', () => {
    const nav = createNavHistory()
    nav.record({ path: 'a.ts', line: 1, column: 1 })
    nav.record({ path: 'b.ts', line: 5, column: 3 })
    expect(nav.canBack()).toBe(true)
    expect(nav.forward()).toBeNull()
    nav.back()
    nav.record({ path: 'c.ts', line: 2, column: 1 })
    expect(nav.forward()).toBeNull()
    expect(nav.peekBack()).toEqual({ path: 'a.ts', line: 1, column: 1, viewState: undefined })
  })

  it('dedupes same path+line+column and keeps future intact', () => {
    const nav = createNavHistory()
    nav.record({ path: 'a.ts', line: 1, column: 1 })
    nav.record({ path: 'b.ts', line: 5, column: 3 })
    nav.record({ path: 'a.ts', line: 1, column: 1, viewState: { scrollTop: 42 } })
    // 与栈顶 b 不同 → 压栈
    expect(nav.back()).toEqual({ path: 'b.ts', line: 5, column: 3, viewState: undefined })
    expect(nav.forward()).toEqual({ path: 'a.ts', line: 1, column: 1, viewState: { scrollTop: 42 } })
  })

  it('updates viewState in place when same position (no extra entry)', () => {
    const nav = createNavHistory()
    nav.record({ path: 'a.ts', line: 1, column: 1 })
    nav.record({ path: 'a.ts', line: 1, column: 1, viewState: { scrollTop: 10 } })
    nav.record({ path: 'a.ts', line: 1, column: 1, viewState: { scrollTop: 20 } })
    expect(nav.forward()).toBeNull() // 同位置不带出 future
    nav.record({ path: 'b.ts' })
    // 栈 = [a(视图{20}), b]：a 的 viewState 被就地更新，未重复压栈
    expect(nav.peekBack()).toEqual({ path: 'a.ts', line: 1, column: 1, viewState: { scrollTop: 20 } })
    nav.back()
    expect(nav.forward()).toEqual({ path: 'b.ts', column: undefined, line: undefined, viewState: undefined })
  })

  it('ignores empty path entries', () => {
    const nav = createNavHistory()
    nav.record({ path: '' })
    nav.record(null as unknown as { path: string })
    expect(nav.canBack()).toBe(false)
  })

  it('caps back stack at capacity', () => {
    const nav = createNavHistory(3)
    for (let i = 0; i < 6; i++) nav.record({ path: 'f' + i + '.ts', line: i, column: 1 })
    // 栈 = [f3, f4, f5]（逐出 f0..f2）
    expect(nav.peekBack()).toEqual({ path: 'f4.ts', line: 4, column: 1, viewState: undefined })
    expect(nav.back()).toEqual({ path: 'f4.ts', line: 4, column: 1, viewState: undefined })
    expect(nav.back()).toEqual({ path: 'f3.ts', line: 3, column: 1, viewState: undefined })
    expect(nav.back()).toBeNull()
  })
})

describe('back / forward', () => {
  it('walks back then forward in order', () => {
    const nav = createNavHistory()
    nav.record({ path: 'a.ts', line: 1 })
    nav.record({ path: 'b.ts', line: 2 })
    nav.record({ path: 'c.ts', line: 3 })
    expect(nav.back()).toEqual({ path: 'b.ts', line: 2, column: undefined, viewState: undefined })
    expect(nav.back()).toEqual({ path: 'a.ts', line: 1, column: undefined, viewState: undefined })
    expect(nav.back()).toBeNull()
    expect(nav.forward()).toEqual({ path: 'b.ts', line: 2, column: undefined, viewState: undefined })
    expect(nav.forward()).toEqual({ path: 'c.ts', line: 3, column: undefined, viewState: undefined })
    expect(nav.forward()).toBeNull()
  })

  it('reports canBack/canForward and peek targets', () => {
    const nav = createNavHistory()
    expect(nav.canBack()).toBe(false)
    expect(nav.canForward()).toBe(false)
    expect(nav.peekBack()).toBeNull()
    expect(nav.peekForward()).toBeNull()
    nav.record({ path: 'a.ts' })
    expect(nav.canBack()).toBe(false) // 单条记录无后退意义
    nav.record({ path: 'b.ts' })
    expect(nav.canBack()).toBe(true)
    expect(nav.peekBack()).toEqual({ path: 'a.ts', column: undefined, line: undefined, viewState: undefined })
    expect(nav.peekForward()).toBeNull()
    nav.back()
    expect(nav.canForward()).toBe(true)
    expect(nav.peekForward()).toEqual({ path: 'b.ts', column: undefined, line: undefined, viewState: undefined })
    expect(nav.peekBack()).toBeNull()
  })

  it('defines a nonzero default capacity', () => {
    expect(NAV_HISTORY_CAP).toBeGreaterThan(0)
  })
})
