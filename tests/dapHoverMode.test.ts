/** hover 修饰键（Alt）状态机 + 安装/卸载幂等 + 显示层同步测试。作者 ddj 2026年09月21号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** hoverTree 显示层同步桩（真实实现依赖 DOM，node 环境只验证调用契约）。 */
const layer = vi.hoisted(() => ({ apply: vi.fn(), hasDebugHover: vi.fn(() => false) }))

vi.mock('../src/client/dap/hoverTree.js', () => ({ applyAltToHovers: layer.apply, hasDebugHover: layer.hasDebugHover }))

import { consumesBareAlt, disposeHoverMode, installHoverMode, isAltHeld, onAltChange, setAltHeld } from '../src/client/dap/hoverMode.js'

/** 事件处理器。 */
type Handler = (ev: unknown) => void

/** 最小 window 桩：只记监听器，可手动派发（node 环境无 DOM）。 */
function fakeWindow() {
  const listeners = new Map<string, Set<Handler>>()
  return {
    addEventListener: (type: string, fn: Handler): void => {
      const set = listeners.get(type) ?? new Set<Handler>()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, fn: Handler): void => { listeners.get(type)?.delete(fn) },
    dispatch: (type: string, ev: unknown): void => { for (const fn of Array.from(listeners.get(type) ?? [])) fn(ev) },
    count: (): number => Array.from(listeners.values()).reduce((sum, set) => sum + set.size, 0),
  }
}

let win: ReturnType<typeof fakeWindow>

describe('hoverMode Alt 状态', () => {
  beforeEach(() => {
    win = fakeWindow()
    ;(globalThis as unknown as { window: unknown }).window = win
    disposeHoverMode()
    setAltHeld(false)
    layer.apply.mockClear()
    layer.hasDebugHover.mockReturnValue(false)
  })

  afterEach(() => {
    disposeHoverMode()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('初始未按住；setAltHeld 注入并同步显示层', () => {
    expect(isAltHeld()).toBe(false)
    setAltHeld(true)
    expect(isAltHeld()).toBe(true)
    expect(layer.apply).toHaveBeenLastCalledWith(true)
    setAltHeld(false)
    expect(layer.apply).toHaveBeenLastCalledWith(false)
  })

  it('keydown/keyup Alt 切换并同步显示层，其它键不影响', () => {
    installHoverMode()
    layer.apply.mockClear()
    win.dispatch('keydown', { key: 'Control', type: 'keydown' })
    expect(isAltHeld()).toBe(false)
    expect(layer.apply).not.toHaveBeenCalled()
    // 真实事件语义：Alt keydown 时 altKey 已为 true，keyup 时为 false
    win.dispatch('keydown', { key: 'Alt', type: 'keydown', altKey: true })
    expect(isAltHeld()).toBe(true)
    expect(layer.apply).toHaveBeenLastCalledWith(true)
    win.dispatch('keyup', { key: 'Alt', type: 'keyup', altKey: false })
    expect(isAltHeld()).toBe(false)
    expect(layer.apply).toHaveBeenLastCalledWith(false)
  })

  it('mousemove 校正 Alt（宿主吞键 / 窗口失焦期间漏按都可自愈）', () => {
    installHoverMode()
    layer.apply.mockClear()
    win.dispatch('mousemove', { altKey: true })
    expect(isAltHeld()).toBe(true)
    expect(layer.apply).toHaveBeenLastCalledWith(true)
    win.dispatch('mousemove', { altKey: true }) // 状态未变：不重复同步
    expect(layer.apply).toHaveBeenCalledTimes(1)
    win.dispatch('mousemove', { altKey: false })
    expect(layer.apply).toHaveBeenLastCalledWith(false)
  })

  it('blur 复位 Alt（避免切窗后残留）', () => {
    installHoverMode()
    setAltHeld(true)
    win.dispatch('blur', {})
    expect(isAltHeld()).toBe(false)
    expect(layer.apply).toHaveBeenLastCalledWith(false)
  })

  it('刚按下 Alt 后的 blur 不复位（宿主菜单抢焦点不打回状态）', () => {
    installHoverMode()
    layer.apply.mockClear()
    win.dispatch('keydown', { key: 'Alt', type: 'keydown', altKey: true })
    expect(isAltHeld()).toBe(true)
    win.dispatch('blur', {})
    expect(isAltHeld()).toBe(true) // 仍在 Alt 态，不需要等鼠标移动再切
  })

  it('任意输入事件按 altKey 校正（宿主吞掉 Alt 键也能自愈）', () => {
    installHoverMode()
    layer.apply.mockClear()
    win.dispatch('mousedown', { altKey: true })
    expect(isAltHeld()).toBe(true)
    expect(layer.apply).toHaveBeenLastCalledWith(true)
    win.dispatch('wheel', { altKey: false })
    expect(isAltHeld()).toBe(false)
    win.dispatch('keydown', { key: 'a', altKey: true })
    expect(isAltHeld()).toBe(true)
  })

  it('安装时按当前状态对齐一次已存在的 hover', () => {
    setAltHeld(true)
    layer.apply.mockClear()
    setAltHeld(false)
    layer.apply.mockClear()
    installHoverMode()
    expect(layer.apply).toHaveBeenCalledWith(false)
  })

  it('安装幂等、卸载彻底', () => {
    installHoverMode()
    const after1 = win.count()
    installHoverMode()
    expect(win.count()).toBe(after1)
    disposeHoverMode()
    expect(win.count()).toBe(0)
    setAltHeld(true)
    win.dispatch('keyup', { key: 'Alt', type: 'keyup' })
    expect(isAltHeld()).toBe(true) // 已卸载：监听不再生效
  })

  it('onAltChange 订阅可退订', () => {
    installHoverMode()
    const seen: boolean[] = []
    const off = onAltChange((held) => seen.push(held))
    setAltHeld(true)
    setAltHeld(false)
    off()
    setAltHeld(true)
    expect(seen).toEqual([true, false])
  })

  it('consumesBareAlt：仅调试浮层可见时消费裸 Alt（组合键不消费）', () => {
    expect(consumesBareAlt({ key: 'Alt' }, true)).toBe(true)
    expect(consumesBareAlt({ key: 'Alt' }, false)).toBe(false)
    expect(consumesBareAlt({ key: 'Alt', ctrlKey: true }, true)).toBe(false)
    expect(consumesBareAlt({ key: 'Alt', shiftKey: true }, true)).toBe(false)
    expect(consumesBareAlt({ key: 'Alt', metaKey: true }, true)).toBe(false)
    expect(consumesBareAlt({ key: 'Control' }, true)).toBe(false)
  })

  it('调试浮层可见时消费裸 Alt（preventDefault + stopPropagation，避免焦点被浏览器菜单键抢走）', () => {
    installHoverMode()
    layer.hasDebugHover.mockReturnValue(true)
    const seen = { prevented: false, stopped: false }
    win.dispatch('keydown', {
      key: 'Alt',
      type: 'keydown',
      altKey: true,
      preventDefault: () => { seen.prevented = true },
      stopPropagation: () => { seen.stopped = true },
    })
    expect(seen.prevented).toBe(true)
    expect(seen.stopped).toBe(true)
    expect(isAltHeld()).toBe(true)
  })

  it('无调试浮层时不消费（不劫持全局 Alt）', () => {
    installHoverMode()
    layer.hasDebugHover.mockReturnValue(false)
    const seen = { prevented: false }
    win.dispatch('keydown', { key: 'Alt', type: 'keydown', altKey: true, preventDefault: () => { seen.prevented = true } })
    expect(seen.prevented).toBe(false)
    expect(isAltHeld()).toBe(true)
  })
})
