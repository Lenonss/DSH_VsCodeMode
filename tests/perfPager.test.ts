/**
 * PerfSettings 分页纯函数测试（paginate / pageSlice：页码夹取、边界、切片）。
 * 作者 ddj 2026-09-02
 */
import { describe, expect, it } from 'vitest'
import { pageSlice, paginate } from '../src/client/ui/PerfSettings.js'

describe('paginate', () => {
  it('空数据 → 单页，范围全 0', () => {
    expect(paginate(0, 7, 1)).toEqual({ page: 1, pages: 1, pageSize: 7, start: 0, end: 0, total: 0 })
  })
  it('总条数整除：两页', () => {
    expect(paginate(14, 7, 1)).toMatchObject({ pages: 2, start: 0, end: 7 })
    expect(paginate(14, 7, 2)).toMatchObject({ pages: 2, start: 7, end: 14 })
  })
  it('不满一页：末页 end 夹到 total', () => {
    expect(paginate(10, 7, 2)).toMatchObject({ page: 2, pages: 2, start: 7, end: 10 })
  })
  it('页码越界被夹取', () => {
    expect(paginate(10, 7, 0).page).toBe(1)
    expect(paginate(10, 7, -3).page).toBe(1)
    expect(paginate(10, 7, 99).page).toBe(2)
  })
  it('非整数/非法页码回落 1', () => {
    expect(paginate(10, 7, NaN).page).toBe(1)
    expect(paginate(10, 7, undefined).page).toBe(1)
    expect(paginate(10, 7, null).page).toBe(1)
  })
  it('pageSize 非法时回落 1（不除零）', () => {
    expect(paginate(10, 0, 1).pageSize).toBe(1)
    expect(paginate(10, -5, 1).pageSize).toBe(1)
    expect(paginate(10, undefined, 1).pageSize).toBe(1)
  })
})

describe('pageSlice', () => {
  const items = Array.from({ length: 16 }, (_, i) => 'ws' + i)
  it('首页取前 7 条', () => {
    expect(pageSlice(items, 1, 7)).toEqual(items.slice(0, 7))
  })
  it('次页取第 8–14 条', () => {
    expect(pageSlice(items, 2, 7)).toEqual(items.slice(7, 14))
  })
  it('末页取剩余不足 7 条', () => {
    expect(pageSlice(items, 3, 7)).toEqual(items.slice(14, 16))
  })
  it('越界页码夹到末页而非空', () => {
    expect(pageSlice(items, 99, 7)).toEqual(items.slice(14, 16))
  })
  it('空列表/null → 空数组', () => {
    expect(pageSlice([], 1, 7)).toEqual([])
    expect(pageSlice(null, 1, 7)).toEqual([])
    expect(pageSlice(undefined, 1, 7)).toEqual([])
  })
})
