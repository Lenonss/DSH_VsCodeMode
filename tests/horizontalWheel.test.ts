/**
 * 页签栏滚轮横向滚动单测：pure `wheelScrollStep` 的接管条件与位移换算。
 * 全部为纯逻辑断言（node 环境无 DOM）。
 * 作者 ddj 2026年09月18号
 */
import { describe, expect, it } from 'vitest'
import { wheelScrollStep } from '../src/client/ui/horizontalWheel.js'

/** 造输入（默认像素模式、无 shift、垂直 deltaY）。 */
function input(patch: Partial<{ deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }> = {}) {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ...patch }
}

/** 造几何（默认横向溢出 200px）。 */
function geom(patch: Partial<{ scrollWidth: number; clientWidth: number }> = {}) {
  return { scrollWidth: 1200, clientWidth: 1000, ...patch }
}

describe('wheelScrollStep 接管条件', () => {
  it('内容不溢出 → 0（绝不劫持页面垂直滚动）', () => {
    expect(wheelScrollStep(input({ deltaY: 100 }), geom({ scrollWidth: 1000, clientWidth: 1000 }))).toBe(0)
    expect(wheelScrollStep(input({ deltaY: 100 }), geom({ scrollWidth: 800, clientWidth: 1000 }))).toBe(0)
  })

  it('Shift+滚轮 → 0（交给浏览器原生横滚，处理两次会翻倍）', () => {
    expect(wheelScrollStep(input({ deltaY: 100, shiftKey: true }), geom())).toBe(0)
    expect(wheelScrollStep(input({ deltaX: 100, shiftKey: true }), geom())).toBe(0)
  })

  it('位移全为 0 → 0（不吞掉空滚轮事件）', () => {
    expect(wheelScrollStep(input(), geom())).toBe(0)
  })
})

describe('wheelScrollStep 位移换算', () => {
  it('纵向滚轮（deltaY）驱动横向位移', () => {
    expect(wheelScrollStep(input({ deltaY: 120 }), geom())).toBe(120)
    expect(wheelScrollStep(input({ deltaY: -120 }), geom())).toBe(-120)
  })

  it('横向手势（deltaX）占优时取 deltaX', () => {
    expect(wheelScrollStep(input({ deltaX: 90, deltaY: 10 }), geom())).toBe(90)
  })

  it('纵向分量更大时取 deltaY（普通鼠标滚轮 + 微小横向抖动）', () => {
    expect(wheelScrollStep(input({ deltaX: 3, deltaY: 100 }), geom())).toBe(100)
  })

  it('行模式（deltaMode=1）按 16px/行折算', () => {
    expect(wheelScrollStep(input({ deltaY: 3, deltaMode: 1 }), geom())).toBe(48)
  })

  it('页模式（deltaMode=2）按可视宽度折算', () => {
    expect(wheelScrollStep(input({ deltaY: 1, deltaMode: 2 }), geom({ clientWidth: 600 }))).toBe(600)
  })

  it('结果取整（触控板会给小数 delta）', () => {
    expect(wheelScrollStep(input({ deltaY: 12.7 }), geom())).toBe(13)
  })
})
