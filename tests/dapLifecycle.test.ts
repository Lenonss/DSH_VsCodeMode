/** DAP 适配器环境及进程回收回归。作者 ddj 2026年09月28号。 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), stopTree: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/processTree.js', () => ({ stopTree: mocks.stopTree }))
import { DapSession } from '../src/dap/manager.js'
import type { DapAdapterSpec } from '../src/dap/provider.js'
import type { DapDebugConfig } from '../src/shared/dap.js'
const spec: DapAdapterSpec = { type: 'test', command: 'adapter', args: [], extensionPath: '/extension', extensionId: 'test.adapter', exts: [], detail: 'test' }
const config: DapDebugConfig = { name: 'test', type: 'test', request: 'attach', raw: { env: { API_TOKEN: 'explicit' } } } as DapDebugConfig
let session: DapSession

/**
 * 创建不启动真实 OS 进程的适配器替身。
 * @private
 * @author ddj 2026年09月28号
 * @returns 事件源与协议管道
 */
function fakeChild() {
  return Object.assign(new EventEmitter(), { pid: 56789, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
}
beforeEach(() => {
  vi.spyOn(DapSession.prototype as any, 'handshake').mockResolvedValue(undefined)
  session = new DapSession({ findFiles: async () => [] })
})
afterEach(() => { session.dispose(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs() })

describe('DAP adapter lifecycle', () => {
  it('scrubs parent credentials while retaining explicit config env and Electron Node mode', () => {
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    vi.stubEnv('DEEPSEEK_API_KEY', 'host')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    session.start(spec, config, '/workspace')
    const options = mocks.spawn.mock.calls[0]![2]
    expect(options.env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(options.env.API_TOKEN).toBe('explicit')
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(options.detached).toBe(process.platform !== 'win32')
    session.dispose()
    expect(mocks.stopTree).toHaveBeenCalledWith(child, expect.any(Function))
  })
  it('reclaims the adapter tree when its root exits unexpectedly', () => {
    const child = fakeChild()
    mocks.spawn.mockReturnValue(child)
    session.start(spec, config, '/workspace')
    child.emit('exit', 3)
    expect(mocks.stopTree).toHaveBeenCalledWith(child, expect.any(Function))
    expect(session.stateOf().phase).toBe('terminated')
  })
  it('ignores an old adapter error after a replacement owns the session', () => {
    const old = fakeChild()
    const next = fakeChild()
    mocks.spawn.mockReturnValueOnce(old).mockReturnValueOnce(next)
    session.start(spec, config, '/workspace')
    session.start(spec, config, '/workspace')
    expect(() => old.emit('error', new Error('old failure'))).not.toThrow()
    expect(session.stateOf().phase).toBe('starting')
    expect(mocks.stopTree).toHaveBeenCalledTimes(1)
  })
})
