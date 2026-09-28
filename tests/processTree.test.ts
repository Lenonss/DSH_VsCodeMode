/** 进程树生命周期回归，所有 OS 进程操作均替身。作者 ddj 2026年09月28号。 */
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('node:child_process', () => mocks)
import { killTree, stopTree } from '../src/processTree.js'
const child = { pid: 123456, kill: vi.fn() } as unknown as ChildProcess

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); mocks.spawn.mockReset(); mocks.spawnSync.mockReset() })

describe('process tree cleanup', () => {
  it('handles asynchronous taskkill spawn errors without throwing', () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() })
    mocks.spawn.mockReturnValue(killer)
    const log = vi.fn()
    killTree(child, log, false, 'win32')
    expect(mocks.spawn).toHaveBeenCalledWith('taskkill', ['/PID', '123456', '/T', '/F'], expect.objectContaining({ stdio: 'ignore', windowsHide: true }))
    expect(() => killer.emit('error', new Error('ENOENT'))).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOENT'))
    expect(child.kill).not.toHaveBeenCalled()
  })
  it('uses synchronous tree cleanup for host exit', () => {
    mocks.spawnSync.mockReturnValue({ status: 0 })
    killTree(child, undefined, true, 'win32')
    expect(mocks.spawnSync).toHaveBeenCalledWith('taskkill', expect.any(Array), expect.objectContaining({ timeout: 5000 }))
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('signals POSIX process groups instead of only the leader', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    killTree(child, undefined, false, 'linux')
    expect(kill).toHaveBeenCalledWith(-123456, 'SIGKILL')
  })
  it('still escalates after the root exits and stops only once', () => {
    vi.useFakeTimers()
    vi.spyOn(process, 'kill').mockReturnValue(true)
    const finish = stopTree(child, undefined, 'linux')
    expect(process.kill).toHaveBeenCalledWith(-123456, 'SIGTERM')
    vi.advanceTimersByTime(1500)
    finish()
    expect(process.kill).toHaveBeenCalledTimes(2)
    expect(process.kill).toHaveBeenLastCalledWith(-123456, 'SIGKILL')
  })
})
