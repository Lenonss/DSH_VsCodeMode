/**
 * client/ui/menuPosition.ts 纯函数测试（锚点与 viewport clamp）。
 * 作者 ddj 2026-08-28
 */
import { describe, expect, it } from 'vitest'
import { clampMenuPosition, rowMenuPosition } from '../src/client/ui/menuPosition.js'

describe('rowMenuPosition', () => {
  it('将菜单放在目标行右侧并对齐行顶部', () => {
    expect(rowMenuPosition({ top: 120, right: 260, width: 220, height: 22 }, 100, 100)).toEqual({ left: 264, top: 120 })
  })

  it('测量不到目标行时回退到鼠标坐标', () => {
    expect(rowMenuPosition(undefined, 100, 200)).toEqual({ left: 100, top: 200 })
    expect(rowMenuPosition({ top: 0, right: 260, width: 0, height: 22 }, 100, 200)).toEqual({ left: 100, top: 200 })
  })
})

describe('clampMenuPosition', () => {
  it('限制左下角菜单不越出 viewport', () => {
    expect(clampMenuPosition(900, 700, 1000, 800, 224, 176)).toEqual({ left: 776, top: 624 })
  })

  it('限制负坐标并保留最小边距', () => {
    expect(clampMenuPosition(-20, -10, 1000, 800, 224, 176)).toEqual({ left: 4, top: 4 })
  })
})
