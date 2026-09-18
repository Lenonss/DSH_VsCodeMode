/**
 * G7：AI 补全配置指向已下架模型时的判定（DSH 0.1.6-alpha.2 移除 V4 Flash 系列）。
 * 纯函数，node 可跑。
 * 作者 ddj 2026年09月18号
 */
import { describe, expect, it } from 'vitest'
import { DELISTED_MODEL_MARKERS, isDelistedModel } from '../src/shared/ai.js'

describe('isDelistedModel', () => {
  it('命中已下架的 V4 Flash 系列（大小写不敏感、含 -exp 后缀）', () => {
    expect(isDelistedModel('deepseek-v4-flash')).toBe(true)
    expect(isDelistedModel('DeepSeek-V4-Flash')).toBe(true)
    expect(isDelistedModel('deepseek-v4-flash-exp')).toBe(true)
    expect(isDelistedModel('  v4-flash  ')).toBe(true)
  })

  it('空 model = 自动路由，不提示', () => {
    expect(isDelistedModel('')).toBe(false)
    expect(isDelistedModel('   ')).toBe(false)
    expect(isDelistedModel(null)).toBe(false)
    expect(isDelistedModel(undefined)).toBe(false)
    expect(isDelistedModel(42)).toBe(false)
  })

  it('其他模型不误报', () => {
    expect(isDelistedModel('deepseek-v4')).toBe(false)
    expect(isDelistedModel('deepseek-chat')).toBe(false)
    expect(isDelistedModel('gpt-6-astra')).toBe(false)
  })

  it('下架标识清单非空且为小写（匹配前统一 lower）', () => {
    expect(DELISTED_MODEL_MARKERS.length).toBeGreaterThan(0)
    expect(DELISTED_MODEL_MARKERS.every((m) => m === m.toLowerCase())).toBe(true)
  })
})
