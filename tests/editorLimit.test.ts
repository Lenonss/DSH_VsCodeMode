/**
 * 页签数量上限归一化测试。
 * 覆盖：默认回退 / **0 合法（不限制）** / 负数与非法输入 / 边界夹取（0–50）/ 取整 / 数字字符串。
 * 重点钉住与 normalizeSidebarMinWidth 的语义差异：0 不得被当作非法值回退默认。
 * 作者 ddj 2026年09月18号
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { EDITOR_LIMIT_CEIL, EDITOR_LIMIT_DEFAULT, normalizeMaxOpenEditors } from '../src/shared/editorLimit.js'
import { editorLimitApply, getMaxOpenEditors } from '../src/client/editorLimit.js'

describe('normalizeMaxOpenEditors', () => {
  it('合法值原样保留（含四舍五入）', () => {
    expect(normalizeMaxOpenEditors(10)).toBe(10)
    expect(normalizeMaxOpenEditors(3.4)).toBe(3)
    expect(normalizeMaxOpenEditors(3.6)).toBe(4)
  })

  it('0 是合法值：语义为「不限制」，不得回退默认', () => {
    expect(normalizeMaxOpenEditors(0)).toBe(0)
  })

  it('高于上界夹取到 50', () => {
    expect(normalizeMaxOpenEditors(51)).toBe(EDITOR_LIMIT_CEIL)
    expect(normalizeMaxOpenEditors(9999)).toBe(EDITOR_LIMIT_CEIL)
  })

  it('负数与非法输入回退默认 10', () => {
    expect(normalizeMaxOpenEditors(-1)).toBe(EDITOR_LIMIT_DEFAULT)
    expect(normalizeMaxOpenEditors(undefined)).toBe(EDITOR_LIMIT_DEFAULT)
    expect(normalizeMaxOpenEditors(null)).toBe(EDITOR_LIMIT_DEFAULT)
    expect(normalizeMaxOpenEditors('abc')).toBe(EDITOR_LIMIT_DEFAULT)
    expect(normalizeMaxOpenEditors(Number.NaN)).toBe(EDITOR_LIMIT_DEFAULT)
    expect(normalizeMaxOpenEditors(Number.POSITIVE_INFINITY)).toBe(EDITOR_LIMIT_DEFAULT)
  })

  it('非数字类型不得被 Number() 强制转换误判成 0（否则一个坏值就关掉上限）', () => {
    // Number(null)/Number([])/Number(false)/Number('') 皆为 0，全都必须回退默认
    expect(normalizeMaxOpenEditors(null)).toBe(EDITOR_LIMIT_DEFAULT)
    expect(normalizeMaxOpenEditors([])).toBe(EDITOR_LIMIT_DEFAULT)
    expect(normalizeMaxOpenEditors(false)).toBe(EDITOR_LIMIT_DEFAULT)
    expect(normalizeMaxOpenEditors('')).toBe(EDITOR_LIMIT_DEFAULT)
    expect(normalizeMaxOpenEditors({})).toBe(EDITOR_LIMIT_DEFAULT)
  })

  it('空串/纯空白串不得被解释成 0（否则会被误判为「不限制」）', () => {
    expect(normalizeMaxOpenEditors('')).toBe(EDITOR_LIMIT_DEFAULT)
    expect(normalizeMaxOpenEditors('   ')).toBe(EDITOR_LIMIT_DEFAULT)
  })

  it('数字字符串可解析（设置输入框可能给字符串）', () => {
    expect(normalizeMaxOpenEditors('8')).toBe(8)
    expect(normalizeMaxOpenEditors('0')).toBe(0)
  })
})

describe('editorLimitApply / getMaxOpenEditors', () => {
  beforeEach(() => editorLimitApply(EDITOR_LIMIT_DEFAULT))

  it('apply 写入模块状态，get 读取同值', () => {
    expect(editorLimitApply(6)).toBe(6)
    expect(getMaxOpenEditors()).toBe(6)
  })

  it('apply 0 生效为「不限制」并在 get 中保持', () => {
    expect(editorLimitApply(0)).toBe(0)
    expect(getMaxOpenEditors()).toBe(0)
  })

  it('apply 非法值回退默认（设置缺失/损坏时不锁死编辑器）', () => {
    editorLimitApply(6)
    expect(editorLimitApply(undefined)).toBe(EDITOR_LIMIT_DEFAULT)
    expect(getMaxOpenEditors()).toBe(EDITOR_LIMIT_DEFAULT)
  })
})
