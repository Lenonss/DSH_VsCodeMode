/**
 * client viewStateCache 纯函数测试（编辑器视图状态持久化：序列化/解析/合并/容量）。
 * 作者 ddj 2026-08-28
 */
import { describe, expect, it } from 'vitest'
import {
  VIEWSTATE_CAP,
  isViewStateLike,
  parseViewStates,
  serializeViewStates,
  upsertViewState,
} from '../src/client/state/viewStateCache.js'

describe('isViewStateLike', () => {
  it('合法形状通过', () => {
    expect(isViewStateLike({ cursorState: [{ lineNumber: 5, column: 3 }] })).toBe(true)
    expect(isViewStateLike({ viewState: { scrollTop: 100 } })).toBe(true)
    expect(isViewStateLike({ contributionsState: [] })).toBe(true)
  })
  it('非法形状拒绝', () => {
    expect(isViewStateLike(null)).toBe(false)
    expect(isViewStateLike(undefined)).toBe(false)
    expect(isViewStateLike('str')).toBe(false)
    expect(isViewStateLike(42)).toBe(false)
    expect(isViewStateLike({})).toBe(false)
    expect(isViewStateLike([])).toBe(false)
  })
})

describe('serialize/parseViewStates', () => {
  const state = { cursorState: [{ lineNumber: 3, column: 1 }] }
  it('往返一致', () => {
    const parsed = parseViewStates(serializeViewStates({ 'src/a.ts': state }))
    expect(parsed).toEqual({ 'src/a.ts': state })
  })
  it('损坏/格式不符 → null/空映射', () => {
    expect(parseViewStates(null)).toBeNull()
    expect(parseViewStates('oops')).toBeNull()
    expect(parseViewStates('{"v":1}')).toBeNull()
    expect(parseViewStates('{"v":1,"states":[]}')).toBeNull()
  })
  it('非法条目丢弃', () => {
    const parsed = parseViewStates(serializeViewStates({ 'ok.ts': state, 'bad.ts': {} }))
    expect(parsed).toEqual({ 'ok.ts': state })
  })
})

describe('upsertViewState', () => {
  it('新增与覆盖（同 path 更新内容）', () => {
    let m = upsertViewState({}, 'a.ts', { cursorState: [{ lineNumber: 1 }] })
    m = upsertViewState(m, 'b.ts', { cursorState: [{ lineNumber: 2 }] })
    m = upsertViewState(m, 'a.ts', { cursorState: [{ lineNumber: 9 }] })
    expect(Object.keys(m)).toEqual(['b.ts', 'a.ts']) // a 排到最末（近似 LRU）
    expect(m['a.ts']).toEqual({ cursorState: [{ lineNumber: 9 }] })
  })
  it('容量上限裁剪最旧', () => {
    let m = {}
    for (let i = 0; i < VIEWSTATE_CAP + 10; i++) m = upsertViewState(m, 'f' + i + '.ts', { cursorState: [{ lineNumber: i }] })
    expect(Object.keys(m)).toHaveLength(VIEWSTATE_CAP)
    expect(m['f0.ts']).toBeUndefined()
    expect(m['f' + (VIEWSTATE_CAP + 9) + '.ts']).toBeDefined()
  })
  it('非法状态不写入', () => {
    expect(upsertViewState({}, 'a.ts', null)).toEqual({})
    expect(upsertViewState({}, 'a.ts', {})).toEqual({})
    expect(upsertViewState({ 'b.ts': { cursorState: [] } }, 'b.ts', null)).toEqual({ 'b.ts': { cursorState: [] } })
  })
  it('超大状态拒绝（体积上限）', () => {
    const huge = { cursorState: [{ lineNumber: 1 }], blob: 'x'.repeat(80 * 1024) }
    expect(upsertViewState({}, 'huge.ts', huge)).toEqual({})
  })
})
