/**
 * LSP 服务器在已就绪后异常退出时应有限重启，释放引用后不可复活。
 * 作者 ddj 2026年09月24号
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLspManager } from '../src/lsp/manager.js'
import { createLspServer } from '../src/lsp/server.js'
import type { LspServerStatus } from '../src/shared/lsp.js'

vi.mock('../src/lsp/server.js', () => ({ createLspServer: vi.fn() }))

/**
 * 假服务器：可在已就绪状态发出意外退出事件。
 * @author ddj 2026年09月24号
 * @returns 带启动计数和崩溃操作的服务器桩
 */
function fakeServer() {
  let phase: LspServerStatus['phase'] = 'idle'
  let reason = ''
  let starts = 0
  const server = {
    languageId: 'csharp', root: '/root',
    onStateChange: null as ((status: LspServerStatus) => void) | null,
    get phase() { return phase },
    get starts() { return starts },
    status(): LspServerStatus { return { languageId: 'csharp', root: '/root', phase, source: 'discover', reason } },
    async start() {
      starts++
      phase = 'ready'
      reason = ''
      server.onStateChange?.(server.status())
      return true
    },
    crash() {
      phase = 'idle'
      reason = '服务器已退出（3762504530/null），等待重启'
      server.onStateChange?.(server.status())
    },
    async dispose() { phase = 'stopped' as const },
  }
  return server
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LSP manager 异常退出', () => {
  it('保留文档引用时自动重启，连续失败至多重试两次并显示不可用', async () => {
    const server = fakeServer()
    vi.mocked(createLspServer).mockReturnValue(server as never)
    const manager = createLspManager()
    manager.acquire('/root', 'csharp', () => ({ languageId: 'csharp', kind: 'discover', argv: ['dotnet'], ready: true }))
    expect(server.starts).toBe(1)

    server.crash()
    await vi.advanceTimersByTimeAsync(1000)
    expect(server.starts).toBe(2)
    server.crash()
    await vi.advanceTimersByTimeAsync(5000)
    expect(server.starts).toBe(3)
    server.crash()
    expect(manager.statusAll()[0]).toMatchObject({ phase: 'unavailable', reason: expect.stringContaining('停止自动重试') })
    await vi.advanceTimersByTimeAsync(30000)
    expect(server.starts).toBe(3)
    await manager.disposeAll()
  })

  it('关闭最后一个文档会取消排队中的重启', async () => {
    const server = fakeServer()
    vi.mocked(createLspServer).mockReturnValue(server as never)
    const manager = createLspManager()
    manager.acquire('/root', 'csharp', () => ({ languageId: 'csharp', kind: 'discover', argv: ['dotnet'], ready: true }))
    server.crash()
    manager.release('/root', 'csharp')
    await vi.advanceTimersByTimeAsync(30000)
    expect(server.starts).toBe(1)
    expect(manager.statusAll()).toEqual([])
    await manager.disposeAll()
  })

  it('长期稳定运行后重新计算失败次数', async () => {
    const server = fakeServer()
    vi.mocked(createLspServer).mockReturnValue(server as never)
    const manager = createLspManager()
    manager.acquire('/root', 'csharp', () => ({ languageId: 'csharp', kind: 'discover', argv: ['dotnet'], ready: true }))
    server.crash()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(60000)
    server.crash()
    await vi.advanceTimersByTimeAsync(1000)
    expect(server.starts).toBe(3)
    await manager.disposeAll()
  })
})
