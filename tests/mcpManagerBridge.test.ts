/** 官方 mcpManager 适配桥：条目映射、视图映射与端口降级。@author ddj 2026年11月23号 */
import { describe, expect, it } from 'vitest'
import { credentialKeyOf, managerPort, toManagerEntry, toView, viewOf } from '../src/mcpManagerBridge.js'
import { managerServers } from '../src/mcp.js'
import type { MpcConfig } from '../src/shared/mcp.js'

/** @author ddj 2026年11月23号 @param overrides 配置覆盖 @returns stdio 配置 */
function stdio(overrides: Partial<MpcConfig> = {}): MpcConfig {
  return { serverName: 'demo', transport: 'stdio', command: 'node', args: ['server.js'], env: { A: '1' }, cwd: 'C:\\w', ...overrides }
}

describe('toManagerEntry', () => {
  it('keeps process fields for stdio and clears endpoint fields', () => {
    const entry = toManagerEntry(stdio({ url: 'http://x', headers: { H: '1' } }), 'demo', 'on-demand')
    expect(entry.transport).toBe('stdio')
    expect(entry.command).toBe('node')
    expect(entry.args).toEqual(['server.js'])
    expect(entry.env).toEqual({ A: '1' })
    expect(entry.cwd).toBe('C:\\w')
    expect(entry.url).toBe('')
    expect(entry.headers).toEqual({})
    expect(entry.toolLoading).toBe('on-demand')
    expect(entry.startupTimeoutMs).toBe(30000)
  })

  it('keeps endpoint fields for streamable-http and clears process fields', () => {
    const config: MpcConfig = { serverName: 'web', transport: 'streamable-http', url: 'https://h/mcp', headers: { Authorization: 'x' }, command: 'node', env: { B: '2' } }
    const entry = toManagerEntry(config, 'web')
    expect(entry.command).toBe('')
    expect(entry.args).toEqual([])
    expect(entry.env).toEqual({})
    expect(entry.cwd).toBe('')
    expect(entry.url).toBe('https://h/mcp')
    expect(entry.headers).toEqual({ Authorization: 'x' })
    expect(entry.toolLoading).toBe('eager')
  })

  it('registers a credential key only for an explicit oauth block on http', () => {
    expect(toManagerEntry(stdio(), 'demo').oauth).toBeUndefined()
    // 官方只允许 streamable-http 配 OAuth：stdio 上带 oauth 一律不登记，否则 register 会抛。
    expect(toManagerEntry(stdio({ oauth: { client: 'x' } } as never), 'demo').oauth).toBeUndefined()
    const http: MpcConfig = { serverName: 'web', transport: 'streamable-http', url: 'https://h/mcp', oauth: { client: 'x' } }
    expect(toManagerEntry(http, 'web').oauth).toEqual({ credentialKey: credentialKeyOf('web') })
  })

  it('drops non-string pairs and honours an explicit startup budget', () => {
    const entry = toManagerEntry(stdio({ env: { A: '1', B: 2 } as never, vscodeMode: { startupTimeoutMs: 1500 } } as never))
    expect(entry.env).toEqual({ A: '1' })
    expect(entry.startupTimeoutMs).toBe(1500)
  })
})

describe('toView', () => {
  it('maps a connected view and its authorization phase', () => {
    expect(toView({ name: 'demo', configured: true, status: { state: 'connected' }, authorization: { phase: 'authorizing' } }))
      .toEqual({ name: 'demo', configured: true, state: 'connected', phase: 'authorizing' })
  })

  it('maps a cleanup failure to a readable error', () => {
    const view = toView({ name: 'demo', configured: false, status: { state: 'failed', reason: 'cleanup', result: { message: 'socket stuck' } } })
    expect(view.state).toBe('failed')
    expect(view.error).toBe('socket stuck')
  })

  it('never throws on unknown shapes', () => {
    expect(toView(undefined).state).toBe('unknown')
    expect(toView({ status: 'broken' }).name).toBe('')
    expect(toView(42).configured).toBe(false)
  })
})

describe('managerPort', () => {
  it('degrades to empty reads and explicit failures without the service', async () => {
    const port = managerPort({ get: () => undefined })
    expect(port.available()).toBe(false)
    expect(port.list()).toEqual([])
    expect(() => port.register('x', toManagerEntry(stdio()))).toThrow('mcpManager 不可用')
    await expect(port.restart('x')).rejects.toThrow('mcpManager 不可用')
    await expect(port.authorize('x')).rejects.toThrow('mcpManager 不可用')
  })

  it('delegates register/list/restart to the official surface', async () => {
    const calls: string[] = []
    const service = {
      register: (name: string) => { calls.push('register:' + name); return () => calls.push('dispose:' + name) },
      list: () => [{ name: 'demo', configured: true, status: { state: 'connecting' } }],
      restart: async (name: string) => { calls.push('restart:' + name) },
      startAuthorization: async (name: string) => { calls.push('authorize:' + name); return { phase: 'waiting' } },
      cancelAuthorization: async (name: string, id: string) => { calls.push('cancel:' + name + ':' + id) },
      signOut: async (name: string) => { calls.push('signout:' + name) },
      probe: async (name: string) => { calls.push('probe:' + name); return { stage: 'ok' } },
    }
    const port = managerPort({ get: () => service })
    expect(port.available()).toBe(true)
    const dispose = port.register('demo', toManagerEntry(stdio()))
    dispose()
    expect(port.list()).toEqual([{ name: 'demo', configured: true, state: 'connecting' }])
    await port.restart('demo')
    await port.authorize('demo')
    await port.cancelAuthorize('demo', 'a1')
    await port.signOut('demo')
    await port.probe('demo')
    expect(calls).toEqual(['register:demo', 'dispose:demo', 'restart:demo', 'authorize:demo', 'cancel:demo:a1', 'signout:demo', 'probe:demo'])
  })

  it('reports a missing method instead of swallowing it', async () => {
    const port = managerPort({ get: () => ({ register: () => () => {}, list: () => [] }) })
    await expect(port.restart('demo')).rejects.toThrow('缺少 restart')
  })

  it('streams mapped views from the official watch', async () => {
    const service = {
      register: () => () => {},
      list: () => [],
      async *watch() {
        yield [{ name: 'demo', configured: true, status: { state: 'connected' } }]
      },
    }
    const frames: unknown[] = []
    for await (const views of managerPort({ get: () => service }).watch(new AbortController().signal)) frames.push(views)
    expect(frames).toEqual([[{ name: 'demo', configured: true, state: 'connected' }]])
  })

  it('keeps the official connected time for the session card', () => {
    expect(toView({ name: 'demo', configured: true, status: { state: 'connected', connectedAt: 7000 } }))
      .toEqual({ name: 'demo', configured: true, state: 'connected', connectedAt: 7000 })
    expect(toView({ name: 'demo', configured: true, status: { state: 'connecting', connectedAt: 'oops' } }))
      .toEqual({ name: 'demo', configured: true, state: 'connecting' })
  })

  it('gives an empty stream when watch is missing or the service is absent', async () => {
    const withoutWatch = managerPort({ get: () => ({ register: () => () => {}, list: () => [] }) })
    const frames: unknown[] = []
    for await (const views of withoutWatch.watch(new AbortController().signal)) frames.push(views)
    for await (const views of managerPort({ get: () => undefined }).watch(new AbortController().signal)) frames.push(views)
    expect(frames).toEqual([])
  })
})

describe('credentialKeyOf / viewOf', () => {
  it('derives a stable mcp-client scoped key per server name', () => {
    expect(credentialKeyOf('demo')).toBe(credentialKeyOf('demo'))
    expect(credentialKeyOf('demo')).not.toBe(credentialKeyOf('other'))
    // 官方 oauth schema 要求 ^mcp-client/，且必须是 <scope>/<id> 两段。
    expect(credentialKeyOf('demo')).toMatch(/^mcp-client\/vsm-[0-9a-f]{8}$/)
    expect(credentialKeyOf('demo').split('/')).toHaveLength(2)
  })

  it('finds a view by name', () => {
    expect(viewOf([{ name: 'a', configured: true, state: 'connected' }], 'a')?.state).toBe('connected')
    expect(viewOf([], 'a')).toBeUndefined()
  })
})

describe('managerServers', () => {
  /** @author ddj 2026年11月23号 @param manager 官方 manager 桩 @returns 只实现 get 的宿主上下文 */
  function host(manager: unknown) {
    return { get: (name: string) => (name === 'mcpManager' ? manager : undefined) } as never
  }

  it('is empty on a host without the officially managed fleet', () => {
    expect(managerServers(host(undefined), new Set())).toEqual([])
  })

  it('lists managed servers that no loader entry covers, mapping state', () => {
    const manager = {
      register: () => () => {},
      list: () => [
        { name: 'kept', configured: true, status: { state: 'connected' } },
        { name: 'fresh', configured: true, status: { state: 'failed', lastError: 'boom' }, authorization: { phase: 'authorizing' } },
      ],
    }
    const servers = managerServers(host(manager), new Set(['kept']))
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({
      serverName: 'fresh', managed: true, managerState: 'failed', status: 'error', error: 'boom', phase: 'authorizing',
    })
  })
})
