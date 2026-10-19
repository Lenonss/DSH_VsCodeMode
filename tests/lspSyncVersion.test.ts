/**
 * LSP 文档版本必须是逐文档递增的 Int32；Roslyn 遇时间戳会崩溃。
 * 作者 ddj 2026年09月24号
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rpc } from '../src/client/rpc.js'
import { closeDoc, setLspSession, syncDoc } from '../src/client/monaco/lsp/lspClient.js'
import { createLspServer, lspDocVersion } from '../src/lsp/server.js'

const serverMocks = vi.hoisted(() => ({ notifications: [] as Array<{ method: string; payload: any }> }))

vi.mock('../src/client/rpc.js', () => ({
  rpc: vi.fn(async (method: string) => method === 'edrv.lsp.status' ? { ok: true, servers: [] } : { ok: true }),
  dbg: vi.fn(),
}))
vi.mock('../src/lsp/transport.js', () => ({
  spawnServer: vi.fn(() => ({ dispose() {}, stderr: () => '', onExit: null })),
}))
vi.mock('../src/lsp/client.js', () => ({
  createLspClient: vi.fn((_transport: unknown, events: { onReady?: (caps: object) => void }) => ({
    async initialize() {
      const caps = { completion: true }
      events.onReady?.(caps)
      return caps
    },
    notify(method: string, payload: unknown) { serverMocks.notifications.push({ method, payload }) },
    async shutdown() {},
  })),
}))

/**
 * 从 RPC 桩中提取本轮文档同步版本。
 * @author ddj 2026年09月24号
 * @returns 按调用顺序排列的版本
 */
function syncVersions(): number[] {
  return vi.mocked(rpc).mock.calls
    .filter(([method]) => method === 'edrv.lsp.sync')
    .map(([, payload]) => (payload as { version: number }).version)
}

/**
 * 从 RPC 桩中提取本轮同步载荷（惰性文本路径的断言用）。
 * @author ddj 2026年10月15号
 * @returns 按调用顺序排列的 edrv.lsp.sync 载荷
 */
function syncPayloads(): Array<{ text?: string }> {
  return vi.mocked(rpc).mock.calls
    .filter(([method]) => method === 'edrv.lsp.sync')
    .map(([, payload]) => payload as { text?: string })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
  vi.clearAllMocks()
  serverMocks.notifications.length = 0
  setLspSession('version-test-' + Math.random())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('client 文档版本', () => {
  it('不使用时间戳，按文档递增且新文档从 1 开始', async () => {
    await syncDoc('a.cs', 'class A {}', true)
    await syncDoc('a.cs', 'class A { }', true)
    await syncDoc('b.lua', 'local b', true)
    expect(syncVersions()).toEqual([1, 2, 1])
    expect(syncVersions().every((version) => version >= 1 && version <= 2147483647)).toBe(true)
  })

  it('去抖覆盖旧内容，立即查询取消待发；关闭与切会话清版本', async () => {
    await syncDoc('a.cs', 'old')
    await syncDoc('a.cs', 'new')
    await vi.advanceTimersByTimeAsync(250)
    expect(syncVersions()).toEqual([1])
    await syncDoc('a.cs', 'immediate', true)
    expect(syncVersions()).toEqual([1, 2])
    await syncDoc('a.cs', 'pending')
    setLspSession('another-session')
    await vi.advanceTimersByTimeAsync(250)
    expect(syncVersions()).toEqual([1, 2])
    await syncDoc('a.cs', 'new-session', true)
    closeDoc('a.cs')
    await syncDoc('a.cs', 'reopen', true)
    expect(syncVersions()).toEqual([1, 2, 1, 1])
  })

  it('惰性文本：去抖窗口内不取值，只在实际发送前求值一次', async () => {
    let reads = 0
    const text = () => { reads += 1; return 'lazy-' + reads }
    await syncDoc('a.cs', text)
    await syncDoc('a.cs', text)
    expect(reads).toBe(0)
    await vi.advanceTimersByTimeAsync(250)
    expect(reads).toBe(1)
    const calls = syncPayloads()
    expect(calls[calls.length - 1].text).toBe('lazy-1')
  })

  it('惰性文本取值抛错（model 已销毁）→ 放弃本次同步，不退化成空内容上传', async () => {
    await syncDoc('a.cs', 'baseline', true)
    const before = syncPayloads().length
    await syncDoc('a.cs', () => { throw new Error('model disposed') })
    await vi.advanceTimersByTimeAsync(250)
    expect(syncPayloads().length).toBe(before)
  })
})

describe('host LSP 出口', () => {
  it('旧时间戳和非法版本规范成逐文档递增的 Int32', () => {
    expect(lspDocVersion(Date.now())).toBe(1)
    expect(lspDocVersion(Date.now(), 1)).toBe(2)
    expect(lspDocVersion(7, 2)).toBe(7)
    expect(lspDocVersion(2, 7)).toBe(8)
    expect(lspDocVersion(-1)).toBe(1)
  })

  it('didOpen/didChange 实际发送合法版本，关闭后重开从 1 开始', async () => {
    const server = createLspServer({ languageId: 'csharp', kind: 'discover', argv: ['dotnet'], ready: true }, 'C:/ws', 'csharp')
    try {
      server.sync('a.cs', 'class A {}', Date.now())
      await server.start()
      server.sync('a.cs', 'class A { }', Date.now())
      server.close('a.cs')
      server.sync('a.cs', 'class B {}', Date.now())
      const versions = serverMocks.notifications
        .filter(({ method }) => method === 'textDocument/didOpen' || method === 'textDocument/didChange')
        .map(({ payload }) => payload.textDocument.version)
      expect(versions).toEqual([1, 2, 1])
    } finally {
      await server.dispose()
    }
  })

  it('csharp 启动后发 solution/open（根有 sln），lua 不发', async () => {
    // 根目录无 sln（C:/ws 非真实目录，readdir 失败按无 sln 跳过）→ 不发
    const noSln = createLspServer({ languageId: 'csharp', kind: 'discover', argv: ['dotnet'], ready: true }, 'C:/ws', 'csharp')
    try {
      await noSln.start()
      expect(serverMocks.notifications.some(({ method }) => method === 'solution/open')).toBe(false)
    } finally {
      await noSln.dispose()
    }
    // 根目录恰有 sln → 发 solution/open（file:// URI），加载元数据上下文
    const dir = mkdtempSync(join(tmpdir(), 'edrv-lsp-sln-'))
    writeFileSync(join(dir, 'Proj.sln'), '')
    try {
      const server = createLspServer({ languageId: 'csharp', kind: 'discover', argv: ['dotnet'], ready: true }, dir, 'csharp')
      try {
        await server.start()
        const opens = serverMocks.notifications.filter(({ method }) => method === 'solution/open')
        expect(opens).toHaveLength(1)
        expect(opens[0].payload.solution).toMatch(/^file:\/\/\//)
        expect(opens[0].payload.solution.endsWith('Proj.sln')).toBe(true)
      } finally {
        await server.dispose()
      }
      // lua 即使根有 sln 也不发（Roslyn 专有通知）
      serverMocks.notifications.length = 0
      const lua = createLspServer({ languageId: 'lua', kind: 'discover', argv: ['lua'], ready: true }, dir, 'lua')
      try {
        await lua.start()
        expect(serverMocks.notifications.some(({ method }) => method === 'solution/open')).toBe(false)
      } finally {
        await lua.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
