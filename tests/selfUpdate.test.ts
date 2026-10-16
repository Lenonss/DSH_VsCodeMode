/**
 * selfUpdate 纯函数单测：compareVersion 语义化版本比较（不触网、不读文件系统）。
 * 作者 ddj 2026-10-16
 */
import { describe, expect, it } from 'vitest'
import { compareVersion } from '../src/selfUpdate.js'

describe('compareVersion', () => {
  it('相等版本返回 0', () => {
    expect(compareVersion('0.15.8', '0.15.8')).toBe(0)
  })

  it('主版本号更新判定有更新', () => {
    expect(compareVersion('1.0.0', '0.15.8')).toBeGreaterThan(0)
    expect(compareVersion('0.15.8', '1.0.0')).toBeLessThan(0)
  })

  it('次版本号/修订号逐段比较', () => {
    expect(compareVersion('0.16.0', '0.15.9')).toBeGreaterThan(0)
    expect(compareVersion('0.15.9', '0.15.10')).toBeLessThan(0)
  })

  it('段数不足按 0 补齐', () => {
    expect(compareVersion('0.16', '0.16.0')).toBe(0)
    expect(compareVersion('1.0', '0.9.9')).toBeGreaterThan(0)
  })

  it('v 前缀与非数字段兜底为 0', () => {
    expect(compareVersion('v0.15.8', '0.15.8')).toBe(0)
    expect(compareVersion('0.15.8-beta.1', '0.15.8')).toBeLessThanOrEqual(0)
  })

  it('非法输入按 0 处理不抛错', () => {
    expect(compareVersion('', '0.0.0')).toBe(0)
    expect(compareVersion('abc', '0.0.0')).toBe(0)
  })
})
