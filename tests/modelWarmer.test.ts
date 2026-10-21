/**
 * Monaco model 预热调度层（state/modelWarmer.ts）单测。
 *
 * 背景：Ctrl+hover 定义链接预览会走 Monaco 的 createModelReference，该路径只挂 then
 * 没有 catch；目标 edrv:// 文件未打开时必抛未捕获异常「Model not found」。
 * 修法是在 provideDefinition 返回前预热目标 model，本文件锁定的正是预热调度层的契约：
 * 未安装实现时纯降级、并发单飞、失败冷却、超时放行、卸载不误伤新实现。
 * 作者 ddj 2026年10月20号
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearModelWarmer, setModelWarmer, warmModelFor,
  WARM_COOLDOWN_MS, WARM_TIMEOUT_MS,
} from '../src/client/state/modelWarmer.js'

/** 释放 fake timers 与模块级状态（impl/inFlight/cooled 都是模块级，必须逐例复位）。 */
beforeEach(() => {
  vi.useFakeTimers()
  setModelWarmer(null)
})

afterEach(() => {
  setModelWarmer(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('未安装实现：纯降级', () => {
  it('没有实现时立即返回 false，且不接受空路径', async () => {
    await expect(warmModelFor('src/a.lua')).resolves.toBe(false)

    setModelWarmer(() => Promise.resolve(true))
    await expect(warmModelFor('')).resolves.toBe(false)
  })
})

describe('并发单飞', () => {
  it('同一路径并发预热只读一次盘，两个调用拿到同一结果', async () => {
    let release: (value: boolean) => void = () => {}
    const impl = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve }))
    setModelWarmer(impl)

    const first = warmModelFor('src/a.lua')
    const second = warmModelFor('src/a.lua')
    await vi.advanceTimersByTimeAsync(0)

    expect(impl).toHaveBeenCalledTimes(1)
    expect(impl).toHaveBeenCalledWith('src/a.lua')

    release(true)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
  })

  it('不同路径各自独立预热', async () => {
    const impl = vi.fn(async () => true)
    setModelWarmer(impl)

    await expect(warmModelFor('src/a.lua')).resolves.toBe(true)
    await expect(warmModelFor('src/b.lua')).resolves.toBe(true)

    expect(impl).toHaveBeenCalledTimes(2)
  })
})

describe('失败冷却', () => {
  it('失败后冷却窗口内不再重试，窗口过期后恢复', async () => {
    const impl = vi.fn(async () => false)
    setModelWarmer(impl)

    await expect(warmModelFor('src/a.lua')).resolves.toBe(false)
    expect(impl).toHaveBeenCalledTimes(1)

    await expect(warmModelFor('src/a.lua')).resolves.toBe(false)
    expect(impl).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(WARM_COOLDOWN_MS + 1)
    await expect(warmModelFor('src/a.lua')).resolves.toBe(false)
    expect(impl).toHaveBeenCalledTimes(2)
  })

  it('实现抛错折叠成 false 且进入冷却，不向调用方抛异常', async () => {
    const impl = vi.fn(() => Promise.reject(new Error('read failed')))
    setModelWarmer(impl)

    await expect(warmModelFor('src/a.lua')).resolves.toBe(false)
    await expect(warmModelFor('src/a.lua')).resolves.toBe(false)
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('成功后清除该路径冷却', async () => {
    const impl = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
    setModelWarmer(impl)

    await expect(warmModelFor('src/a.lua')).resolves.toBe(false)
    vi.advanceTimersByTime(WARM_COOLDOWN_MS + 1)
    await expect(warmModelFor('src/a.lua')).resolves.toBe(true)
    // 成功已清冷却，紧接着再调用应直达实现而不是被冷却挡下
    await expect(warmModelFor('src/a.lua')).resolves.toBe(true)
    expect(impl).toHaveBeenCalledTimes(3)
  })
})

describe('等待上限', () => {
  it('实现迟迟不返回时按 WARM_TIMEOUT_MS 放行 false', async () => {
    const impl = vi.fn(() => new Promise<boolean>(() => {}))
    setModelWarmer(impl)

    const pending = warmModelFor('src/slow.lua')
    let settled = false
    void pending.then(() => { settled = true })

    // 上限未到：必须仍在等（此时提前放行会让 hover 预览扑空）
    await vi.advanceTimersByTimeAsync(WARM_TIMEOUT_MS - 10)
    expect(settled).toBe(false)

    // 上限到点：放行 false，不等底层
    await vi.advanceTimersByTimeAsync(10)
    await expect(pending).resolves.toBe(false)
    expect(settled).toBe(true)
  })

  it('底层随后成功不会改变已放行的 false（也不重复读盘）', async () => {
    let release: (value: boolean) => void = () => {}
    const impl = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve }))
    setModelWarmer(impl)

    const pending = warmModelFor('src/slow.lua')
    await vi.advanceTimersByTimeAsync(WARM_TIMEOUT_MS + 1)
    await expect(pending).resolves.toBe(false)

    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(impl).toHaveBeenCalledTimes(1)
  })
})

describe('安装与卸载', () => {
  it('用旧实现卸载不会清掉新挂载的实现', async () => {
    const installed = vi.fn(async () => true)
    const other = vi.fn(async () => true)
    setModelWarmer(installed)
    setModelWarmer(other)

    clearModelWarmer(installed)
    await expect(warmModelFor('src/a.lua')).resolves.toBe(true)
    expect(other).toHaveBeenCalledTimes(1)
    expect(installed).not.toHaveBeenCalled()
  })

  it('用同一实现卸载后回到纯降级，并清空冷却状态', async () => {
    const impl = vi.fn(async () => false)
    setModelWarmer(impl)

    await expect(warmModelFor('src/a.lua')).resolves.toBe(false)
    clearModelWarmer(impl)
    await expect(warmModelFor('src/a.lua')).resolves.toBe(false)
    expect(impl).toHaveBeenCalledTimes(1)

    // 冷却随卸载清空：重新挂载后同一路径可立即再次尝试
    setModelWarmer(impl)
    await expect(warmModelFor('src/a.lua')).resolves.toBe(false)
    expect(impl).toHaveBeenCalledTimes(2)
  })
})
