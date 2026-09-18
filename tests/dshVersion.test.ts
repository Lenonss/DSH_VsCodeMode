/**
 * dsh-vscode-mode 版本模块测试：解析 / 比较 / 区间 / 版本线标签。
 * 作者 ddj 2026-09-02
 */
import { describe, expect, it } from 'vitest'
import { compareDshVersions, familyLabel, inDshRange, parseDshVersion } from '../src/dshVersion.js'

const parse = (input: string) => parseDshVersion(input)!

describe('parseDshVersion', () => {
  it('解析常规 / rc / alpha / v 前缀 / build 元数据', () => {
    expect(parse('0.1.1-rc.2')).toEqual({ major: 0, minor: 1, patch: 1, pre: ['rc', '2'] })
    expect(parse('0.1.2-alpha.4')).toEqual({ major: 0, minor: 1, patch: 2, pre: ['alpha', '4'] })
    expect(parse('v0.1.0-rc.7')).toEqual({ major: 0, minor: 1, patch: 0, pre: ['rc', '7'] })
    expect(parse('0.1.2')).toEqual({ major: 0, minor: 1, patch: 2, pre: [] })
    expect(parse('0.1.2-alpha.1+build.5').pre).toEqual(['alpha', '1'])
  })

  it('非法输入返回 null 不抛错', () => {
    expect(parseDshVersion('')).toBeNull()
    expect(parseDshVersion('1.2')).toBeNull()
    expect(parseDshVersion('a.b.c')).toBeNull()
    expect(parseDshVersion('0.1')).toBeNull()
  })
})

describe('compareDshVersions', () => {
  it('rc 线低于 alpha 线（补丁位主导）', () => {
    expect(compareDshVersions(parse('0.1.1-rc.2'), parse('0.1.2-alpha.1'))).toBeLessThan(0)
    expect(compareDshVersions(parse('0.1.2-alpha.1'), parse('0.1.1-rc.2'))).toBeGreaterThan(0)
  })

  it('预发布标识数字按值比较（alpha.10 > alpha.9）', () => {
    expect(compareDshVersions(parse('0.1.2-alpha.9'), parse('0.1.2-alpha.10'))).toBeLessThan(0)
    expect(compareDshVersions(parse('0.1.2-alpha.10'), parse('0.1.2-alpha.2'))).toBeGreaterThan(0)
  })

  it('正式版高于同基座预发布；alpha 高于 rc（同补丁位时按标识字典）', () => {
    expect(compareDshVersions(parse('0.1.2'), parse('0.1.2-alpha.1'))).toBeGreaterThan(0)
    expect(compareDshVersions(parse('0.1.2-alpha.1'), parse('0.1.1-rc.99'))).toBeGreaterThan(0)
    expect(compareDshVersions(parse('0.1.2-alpha.1'), parse('0.1.2-alpha.1'))).toBe(0)
    expect(compareDshVersions(parse('0.1.2-alpha.4'), parse('0.1.2-alpha.4'))).toBe(0)
  })
})

describe('inDshRange', () => {
  it('alpha 线上界开区间判定（>=0.1.2-alpha.1 无上界）', () => {
    expect(inDshRange(parse('0.1.2-alpha.1'), { from: '0.1.2-alpha.1' })).toBe(true)
    expect(inDshRange(parse('0.1.2-alpha.4'), { from: '0.1.2-alpha.1' })).toBe(true)
    expect(inDshRange(parse('0.1.1-rc.2'), { from: '0.1.2-alpha.1' })).toBe(false)
    expect(inDshRange(parse('0.1.2'), { from: '0.1.2-alpha.1' })).toBe(true)
  })

  it('含端点的上界与双界', () => {
    expect(inDshRange(parse('0.1.1-rc.2'), { to: '0.1.1-rc.2' })).toBe(true)
    expect(inDshRange(parse('0.1.2-alpha.1'), { to: '0.1.1-rc.2' })).toBe(false)
    expect(inDshRange(parse('0.1.2-alpha.2'), { from: '0.1.2-alpha.1', to: '0.1.2-alpha.4' })).toBe(true)
    expect(inDshRange(parse('0.1.2-alpha.5'), { from: '0.1.2-alpha.1', to: '0.1.2-alpha.4' })).toBe(false)
  })

  it('空/非法版本不命中', () => {
    expect(inDshRange(null, {})).toBe(false)
    expect(inDshRange(parseDshVersion('bad'), {})).toBe(false)
    expect(inDshRange(parse('0.1.1'), { from: 'garbage' })).toBe(false)
  })
})

describe('familyLabel', () => {
  it('rc 线 / alpha 线 / 未知', () => {
    expect(familyLabel('0.1.1-rc.2')).toContain('rc 线')
    expect(familyLabel('0.1.2-alpha.4')).toContain('0.1.2-alpha')
    expect(familyLabel('not-a-version')).toBe('未知')
    expect(familyLabel('')).toBe('未知')
  })

  it('0.1.5 / 0.1.6 版本线', () => {
    expect(familyLabel('0.1.6-alpha.1')).toContain('0.1.6-alpha')
    expect(familyLabel('0.1.5-alpha.1')).toContain('0.1.5-alpha')
    expect(familyLabel('0.1.5-rc.1')).toContain('0.1.5-alpha')
  })

  it('0.1.6-alpha.2 独立成线（多实例共存等新增点）', () => {
    expect(familyLabel('0.1.6-alpha.2')).toContain('0.1.6-alpha.2')
    expect(familyLabel('0.1.6-alpha.2')).toContain('多实例')
    // 更高版本仍归该线（区间无上界，先命中先返回）
    expect(familyLabel('0.1.6-alpha.3')).toContain('0.1.6-alpha.2')
    // alpha.1 不被 alpha.2 线吞掉
    expect(familyLabel('0.1.6-alpha.1')).not.toContain('多实例')
  })

  it('中间线仍归 0.1.3 版本线', () => {
    expect(familyLabel('0.1.4-rc.1')).toContain('0.1.3-alpha')
    expect(familyLabel('0.1.3-alpha.2')).toContain('0.1.3-alpha')
  })
})
