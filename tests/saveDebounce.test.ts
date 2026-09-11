/**
 * 防抖保存槽测试。
 *
 * 事故回顾（静默丢改动）：自动保存的定时器句柄是 cordis disposer（只 clearTimeout），
 * 旧实现却把它当「立即保存」调用 —— 700ms 窗口内切页签/关闭文件时保存被取消且不再重试。
 * 本文件钉住：flush 必须**真正执行保存**（而非取消），且取消/执行不重复、不残留。
 * 作者 ddj 2026-09-11
 */
import { describe, expect, it, vi } from 'vitest'
import { createSaveTimer } from '../src/client/saveDebounce.js'
import type { Scheduler } from '../src/client/saveDebounce.js'

/** 可控调度器：手动触发到点，记录取消次数。 */
function makeScheduler() {
  const timers: { fn: () => void; cancelled: boolean; ms: number }[] = []
  const schedule: Scheduler = (fn, ms) => {
    const entry = { fn, cancelled: false, ms }
    timers.push(entry)
    return () => { entry.cancelled = true }
  }
  /** 触发最后一个未取消的定时器。 */
  const fire = () => {
    const entry = timers.filter((t) => !t.cancelled).pop()
    if (!entry) throw new Error('没有可触发的定时器')
    entry.cancelled = true
    entry.fn()
  }
  return { schedule, timers, fire }
}

describe('createSaveTimer', () => {
  it('flush 真正执行保存（回归：旧实现只取消定时器，编辑静默丢失）', () => {
    const { schedule } = makeScheduler()
    const timer = createSaveTimer()
    const save = vi.fn()
    timer.arm(schedule, 700, save)
    expect(timer.isPending()).toBe(true)
    timer.flush()
    expect(save, 'flush 必须落盘，而不是取消').toHaveBeenCalledTimes(1)
    expect(timer.isPending(), 'flush 后清槽').toBe(false)
  })

  it('flush 幂等：连续两次只保存一次', () => {
    const { schedule } = makeScheduler()
    const timer = createSaveTimer()
    const save = vi.fn()
    timer.arm(schedule, 700, save)
    timer.flush()
    timer.flush()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush 后到点不再重复保存（定时器已被取消）', () => {
    const { schedule, fire } = makeScheduler()
    const timer = createSaveTimer()
    const save = vi.fn()
    timer.arm(schedule, 700, save)
    timer.flush()
    expect(() => fire()).toThrow('没有可触发的定时器')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('到点自动执行并清槽（正常自动保存路径）', () => {
    const { schedule, fire } = makeScheduler()
    const timer = createSaveTimer()
    const save = vi.fn()
    timer.arm(schedule, 700, save)
    fire()
    expect(save).toHaveBeenCalledTimes(1)
    expect(timer.isPending()).toBe(false)
  })

  it('重新计时取消上一轮：只有最后一次的保存会执行', () => {
    const { schedule, timers } = makeScheduler()
    const timer = createSaveTimer()
    const first = vi.fn()
    const second = vi.fn()
    timer.arm(schedule, 700, first)
    timer.arm(schedule, 700, second)
    expect(timers[0].cancelled, '上一轮被取消').toBe(true)
    expect(first).not.toHaveBeenCalled()
    timer.flush()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('cancel 纯取消：不保存且清槽', () => {
    const { schedule } = makeScheduler()
    const timer = createSaveTimer()
    const save = vi.fn()
    timer.arm(schedule, 700, save)
    timer.cancel()
    expect(save).not.toHaveBeenCalled()
    expect(timer.isPending()).toBe(false)
  })

  it('无待提交时 flush/cancel 为空操作', () => {
    const timer = createSaveTimer()
    expect(() => { timer.flush(); timer.cancel() }).not.toThrow()
    expect(timer.isPending()).toBe(false)
  })

  it('调度器不返回 canceller（旧实现）时仍能 flush 出保存', () => {
    const timer = createSaveTimer()
    const save = vi.fn()
    timer.arm(() => undefined, 700, save)
    timer.flush()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('透传防抖时长（700ms 自动保存契约）', () => {
    const { schedule, timers } = makeScheduler()
    const timer = createSaveTimer()
    timer.arm(schedule, 700, vi.fn())
    expect(timers[0].ms).toBe(700)
  })
})
