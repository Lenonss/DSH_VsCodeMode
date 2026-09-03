/**
 * client/ui/menuPosition.ts 纯函数测试（viewport clamp）。
 * 作者 ddj 2026-08-28 / 2026-09-03
 */
import { describe, expect, it } from 'vitest'
import { clampMenuPosition } from '../src/client/ui/menuPosition.js'

describe('clampMenuPosition', () => {
  it('限制左下角菜单不越出 viewport', () => {
    expect(clampMenuPosition(900, 700, 1000, 800, 224, 176)).toEqual({ left: 776, top: 624 })
  })

  it('限制负坐标并保留最小边距', () => {
    expect(clampMenuPosition(-20, -10, 1000, 800, 224, 176)).toEqual({ left: 4, top: 4 })
  })
})
