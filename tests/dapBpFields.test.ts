/** 断点编辑字段（条件/命中次数/日志）纯函数与持久化测试。作者 ddj 2026年09月29号 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { loadBpMap, saveBpMap, toggleBp, updateBpFields, type BpMap } from '../src/client/dap/breakpoints.js'
import { dapStore } from '../src/client/dap/store.js'

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

describe('updateBpFields', () => {
  const base: BpMap = { 'a/b.lua': [{ line: 10, enabled: true }] }

  it('写入条件/命中次数/日志字段', () => {
    const next = updateBpFields(base, 'a/b.lua', 10, { condition: 'count % 10 == 0', hitCondition: '>=5', logMessage: 'hit count={count}' })
    expect(next['a/b.lua'][0]).toMatchObject({
      line: 10, enabled: true, condition: 'count % 10 == 0', hitCondition: '>=5', logMessage: 'hit count={count}',
    })
  })

  it('空串与纯空白清除字段', () => {
    const withFields = updateBpFields(base, 'a/b.lua', 10, { condition: 'x > 1', logMessage: 'log' })
    const cleared = updateBpFields(withFields, 'a/b.lua', 10, { condition: '   ', logMessage: '' })
    expect(cleared['a/b.lua'][0].condition).toBeUndefined()
    expect(cleared['a/b.lua'][0].logMessage).toBeUndefined()
  })

  it('未提供的字段保持不变（稀疏更新）', () => {
    const withFields = updateBpFields(base, 'a/b.lua', 10, { condition: 'x > 1' })
    const next = updateBpFields(withFields, 'a/b.lua', 10, { hitCondition: '3' })
    expect(next['a/b.lua'][0]).toMatchObject({ condition: 'x > 1', hitCondition: '3' })
  })

  it('不触碰其它行与其它文件', () => {
    const multi: BpMap = { 'a/b.lua': [{ line: 10, enabled: true }, { line: 20, enabled: true }], 'c/d.lua': [{ line: 5, enabled: true }] }
    const next = updateBpFields(multi, 'a/b.lua', 20, { condition: 'y' })
    expect(next['a/b.lua'][0].condition).toBeUndefined()
    expect(next['a/b.lua'][1].condition).toBe('y')
    expect(next['c/d.lua'][0]).toEqual({ line: 5, enabled: true })
  })

  it('目标行不存在时表结构不变', () => {
    const next = updateBpFields(base, 'a/b.lua', 999, { condition: 'z' })
    expect(next['a/b.lua']).toHaveLength(1)
    expect(next['a/b.lua'][0].condition).toBeUndefined()
  })
})

describe('断点字段持久化往返', () => {
  it('save → load 保留条件字段', () => {
    const map = updateBpFields({ 'a/b.lua': [{ line: 3, enabled: true }] }, 'a/b.lua', 3, { condition: 'i > 2', logMessage: 'msg' })
    saveBpMap('scope-x', map)
    const loaded = loadBpMap('scope-x')
    expect(loaded['a/b.lua'][0]).toMatchObject({ line: 3, enabled: true, condition: 'i > 2', logMessage: 'msg' })
  })

  it('旧格式（无字段）仍可装载', () => {
    localStorage.setItem('edrv.dap.bp.legacy', JSON.stringify({ 'x.lua': [{ line: 7, enabled: false }] }))
    const loaded = loadBpMap('legacy')
    expect(loaded['x.lua'][0]).toEqual({ line: 7, enabled: false })
  })

  it('toggle 删除后字段随条目一并消失', () => {
    const map = updateBpFields({ 'a/b.lua': [{ line: 3, enabled: true }] }, 'a/b.lua', 3, { condition: 'i > 2' })
    const { map: after } = toggleBp(map, 'a/b.lua', 3)
    expect(after['a/b.lua']).toBeUndefined()
  })
})

describe('pointsOf → DAP 断点载荷', () => {
  it('只发启用条目，并携带条件字段', () => {
    const list = [
      { line: 3, enabled: true, condition: 'i > 2', hitCondition: '>=3' },
      { line: 9, enabled: false, condition: 'x' },
      { line: 12, enabled: true, logMessage: 'hit {i}' },
    ]
    const points = dapStore.pointsOf('a/b.lua', list)
    expect(points).toHaveLength(2)
    expect(points[0]).toEqual({ path: 'a/b.lua', line: 3, condition: 'i > 2', hitCondition: '>=3', logMessage: undefined })
    expect(points[1]).toEqual({ path: 'a/b.lua', line: 12, condition: undefined, hitCondition: undefined, logMessage: 'hit {i}' })
  })

  it('禁用全部时载荷为空（清空 host 断点）', () => {
    expect(dapStore.pointsOf('a/b.lua', [{ line: 1, enabled: false }])).toEqual([])
  })
})
