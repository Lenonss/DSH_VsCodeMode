/** LSP 进程环境与退出回收回归。作者 ddj 2026年09月28号。 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), killTree: vi.fn(), stopTree: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/processTree.js', () => ({ killTree: mocks.killTree, stopTree: mocks.stopTree }))
import { disposeAllServers, liveChildren, spawnServer } from '../src/lsp/transport.js'

/**
 * 构造支持双向协议的子进程替身。
 * @private
 * @author ddj 2026年09月28号
 * @returns 子进程事件及管道
 */
function fakeChild() {
  return Object.assign(new EventEmitter(), { pid: 43210, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
}
afterEach(() => { disposeAllServers(); vi.clearAllMocks(); vi.unstubAllEnvs() })

describe('LSP transport lifecycle', () => {
  it('scrubs host secrets but retains explicitly configured server env', () => {
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    vi.stubEnv('DEEPSEEK_API_KEY', 'host')
    vi.stubEnv('DSH_HOME', '/private')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    spawnServer({ argv: ['server'], env: { API_TOKEN: 'configured' } }, vi.fn())
    const options = mocks.spawn.mock.calls[0]![2]
    expect(options.env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(options.env.DSH_HOME).toBeUndefined()
    expect(options.env.API_TOKEN).toBe('configured')
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(options.detached).toBe(process.platform !== 'win32')
    child.emit('exit', 0, null)
  })
  it('finishes descendant cleanup even when the root exits before grace expires', () => {
    const child = fakeChild()
    const finish = vi.fn()
    mocks.spawn.mockReturnValue(child)
    mocks.stopTree.mockReturnValue(finish)
    const transport = spawnServer({ argv: ['server'] }, vi.fn())
    const onExit = vi.fn()
    transport.onExit = onExit
    transport.dispose()
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    transport.dispose()
    expect(finish).toHaveBeenCalledTimes(1)
    expect(mocks.stopTree).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(transport.alive).toBe(false)
    expect(liveChildren().has(child as any)).toBe(false)
  })
  it('reclaims an unexpectedly exited root and handles asynchronous stdin errors', () => {
    const child = fakeChild()
    const logger = vi.fn()
    mocks.spawn.mockReturnValue(child)
    spawnServer({ argv: ['server'] }, vi.fn(), logger)
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow()
    child.emit('exit', 1, null)
    expect(mocks.killTree).toHaveBeenCalledWith(child, logger)
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('EPIPE'))
  })
  it('passes synchronous cleanup through for a host exit', () => {
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    spawnServer({ argv: ['server'] }, vi.fn())
    disposeAllServers(true)
    expect(mocks.killTree).toHaveBeenCalledWith(child, undefined, true)
    child.emit('exit', 0, null)
  })
})
