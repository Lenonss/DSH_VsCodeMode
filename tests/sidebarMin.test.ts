/**
 * dsh-vscode-mode client — 侧边栏最小宽度归一化测试。
 * 覆盖：默认回退 / 边界夹取（180–560）/ 非法输入（NaN、字符串、负数、零）/ 取整。
 * 作者 ddj 2026年09月04号
 */
import { describe, expect, it } from 'vitest'
import { normalizeSidebarMinWidth, sidebarMinApply, getSidebarMinWidth, SIDEBAR_MIN_DEFAULT } from '../src/client/sidebarMin.js'

describe('normalizeSidebarMinWidth', () => {
  it('合法值原样保留（含四舍五入）', () => {
    expect(normalizeSidebarMinWidth(300)).toBe(300)
    expect(normalizeSidebarMinWidth(450.4)).toBe(450)
    expect(normalizeSidebarMinWidth(450.6)).toBe(451)
  })

  it('低于下界 180 夹取到 180', () => {
    expect(normalizeSidebarMinWidth(100)).toBe(180)
    expect(normalizeSidebarMinWidth(0.5)).toBe(180)
  })

  it('高于上界 560 夹取到 560（与侧边栏最大宽一致）', () => {
    expect(normalizeSidebarMinWidth(800)).toBe(560)
    expect(normalizeSidebarMinWidth(561)).toBe(560)
  })

  it('非法输入回退默认 300', () => {
    expect(normalizeSidebarMinWidth(undefined)).toBe(SIDEBAR_MIN_DEFAULT)
    expect(normalizeSidebarMinWidth(null)).toBe(SIDEBAR_MIN_DEFAULT)
    expect(normalizeSidebarMinWidth('abc')).toBe(SIDEBAR_MIN_DEFAULT)
    expect(normalizeSidebarMinWidth(-3)).toBe(SIDEBAR_MIN_DEFAULT)
    expect(normalizeSidebarMinWidth(0)).toBe(SIDEBAR_MIN_DEFAULT)
    expect(normalizeSidebarMinWidth(Number.NaN)).toBe(SIDEBAR_MIN_DEFAULT)
    expect(normalizeSidebarMinWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_MIN_DEFAULT)
  })

  it('数字字符串可解析', () => {
    expect(normalizeSidebarMinWidth('360')).toBe(360)
  })
})

describe('sidebarMinApply / getSidebarMinWidth', () => {
  it('apply 写入模块状态，get 读取同值', () => {
    expect(sidebarMinApply(420)).toBe(420)
    expect(getSidebarMinWidth()).toBe(420)
    sidebarMinApply(undefined)
    expect(getSidebarMinWidth()).toBe(SIDEBAR_MIN_DEFAULT)
  })
})
