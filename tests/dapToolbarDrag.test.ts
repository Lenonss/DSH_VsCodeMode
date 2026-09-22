/** 调试工具条拖拽位置测试。作者 ddj 2026年09月29号 */
import { describe, expect, it } from 'vitest'
import { clampToolbarPosition } from '../src/client/dap/toolbarDrag.js'

describe('clampToolbarPosition', () => {
  const bounds = { width: 1000, height: 600, barWidth: 300, barHeight: 30, margin: 6 }

  it('限制负坐标与超出边界坐标', () => {
    expect(clampToolbarPosition({ left: -20, top: -1 }, bounds)).toEqual({ left: 6, top: 6 })
    expect(clampToolbarPosition({ left: 900, top: 590 }, bounds)).toEqual({ left: 694, top: 564 })
  })

  it('保留合法位置', () => {
    expect(clampToolbarPosition({ left: 300, top: 120 }, bounds)).toEqual({ left: 300, top: 120 })
  })
})
