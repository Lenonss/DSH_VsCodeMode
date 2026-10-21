/** Deterministic connection ownership and scheduling. @author ddj 2026年10月20号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpPool, waitMcp } from '../src/mcpPool.js'
import { McpBridge } from '../src/mcpBridge.js'
import { parseMcpPolicy } from '../src/shared/mcp.js'
import type { PoolSpec } from '../src/mcpPool.js'

const pools: McpPool[] = []
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.dispose()
  vi.useRealTimers()
})

/** @private @author ddj 2026年10月20号 @param sharing Sharing choice. @param owner Agent identity. @returns Stable fake request. */
function spec(sharing: 'agent' | 'workspace' = 'workspace', owner = {}): PoolSpec {
  return { workspace: '/alpha', owner, config: { serverName: 'alpha', transport: 'stdio', command: 'ok' }, policy: parseMcpPolicy({ sharing }) }
}

/** @private @author ddj 2026年10月20号 @param gates Per-name startup barriers. @returns Pool plus isolated bridge records. */
function fixture(gates = new Map<string, Promise<void>>()) {
  const bridges: any[] = []
  const make = async (): Promise<McpBridge> => {
    const registered = new Map()
    const ctx: any = {
      isolate: () => ctx,
      provide: (name: string, provider: any) => registered.set(name, provider),
      plugin: vi.fn((_official: any, config: any) => gates.get(config.serverName) ?? Promise.resolve()),
    }
    const scope = { ctx, dispose: vi.fn(async () => undefined) }
    const bridge = await McpBridge.create({} as any, () => scope)
    bridges.push({ bridge, scope })
    return bridge
  }
  const pool = new McpPool({} as any, async () => ({}), make)
  pools.push(pool)
  return { pool, bridges }
}

describe('MCP policies', () => {
  it('defaults legacy definitions to on-demand agent isolation and rejects malformed controls', () => {
    expect(parseMcpPolicy()).toEqual({ startup: 'on-demand', sharing: 'agent', startupTimeoutMs: 60000 })
    for (const policy of [null, [], { startup: 'eager' }, { sharing: 'all' }, { startupTimeoutMs: 1 }, { startupTimeoutMs: 300001 }, { startupTimeoutMs: '1000' }]) {
      expect(() => parseMcpPolicy(policy)).toThrow()
    }
  })
})

describe('MCP connection pool', () => {
  it('single-flights explicit workspace sharing but separates agents, workspaces and credentials', async () => {
    const { pool, bridges } = fixture()
    const request = spec()
    const first = pool.acquire(request)
    const second = pool.acquire({ ...request, owner: {} })
    expect(first.entry).toBe(second.entry)
    await first.entry.ready
    expect(bridges).toHaveLength(1)
    expect(first.entry.refs).toBe(2)
    const different = [spec('agent'), spec('agent'), { ...spec(), workspace: '/beta' }, { ...spec(), config: { ...request.config, env: { TOKEN: 'secret' } } }]
    await Promise.all(different.map((item) => pool.acquire(item).entry.ready))
    expect(bridges).toHaveLength(5)
    expect([...pool.entries.keys()].join()).not.toContain('secret')
    first.release()
    expect(second.entry.live).toBe(true)
  })

  it('cancels only one waiter while the shared connection and second lease complete', async () => {
    let finish!: () => void
    const { pool } = fixture(new Map([['alpha', new Promise<void>((resolve) => { finish = resolve })]]))
    const first = pool.acquire(spec())
    const second = pool.acquire(spec())
    const controller = new AbortController()
    const waiting = waitMcp(first.entry.ready, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow('取消')
    first.release()
    finish()
    await second.entry.ready
    expect(second.entry).toMatchObject({ phase: 'ready', live: true, refs: 1 })
  })

  it('limits cold starts to two and releases the next FIFO item after a slot settles', async () => {
    let finish!: () => void
    const gates = new Map([['alpha', new Promise<void>((resolve) => { finish = resolve })]])
    let finishBeta!: () => void
    gates.set('beta', new Promise<void>((resolve) => { finishBeta = resolve }))
    const { pool, bridges } = fixture(gates)
    const first = pool.acquire(spec())
    const second = pool.acquire({ ...spec(), config: { ...spec().config, serverName: 'beta' } })
    const third = pool.acquire({ ...spec(), config: { ...spec().config, serverName: 'gamma' } })
    await vi.waitFor(() => expect(bridges).toHaveLength(2))
    expect(third.entry.phase).toBe('queued')
    finishBeta()
    await second.entry.ready
    await third.entry.ready
    expect(bridges).toHaveLength(3)
    expect(first.entry.phase).toBe('starting')
    finish()
    await first.entry.ready
  })

  it('retains the last workspace connection for sixty seconds and reuses it without restarting', async () => {
    vi.useFakeTimers()
    const { pool, bridges } = fixture()
    const first = pool.acquire(spec())
    await first.entry.ready
    first.release()
    await vi.advanceTimersByTimeAsync(59999)
    expect(pool.entries.size).toBe(1)
    const second = pool.acquire(spec())
    expect(second.entry).toBe(first.entry)
    second.release()
    await vi.advanceTimersByTimeAsync(60000)
    expect(pool.entries.size).toBe(0)
    expect(bridges[0].scope.dispose).toHaveBeenCalledOnce()
  })

  it('times out cooperatively, closes the private owner before retry and observes five-second cooldown', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const { pool, bridges } = fixture(new Map([['alpha', new Promise<void>((resolve) => { finish = resolve })]]))
    const request = { ...spec(), policy: parseMcpPolicy({ sharing: 'workspace', startupTimeoutMs: 1000 }) }
    const first = pool.acquire(request)
    const failure = expect(first.entry.ready).rejects.toThrow('初始化失败')
    await vi.advanceTimersByTimeAsync(1001)
    expect(first.entry.phase).toBe('stopping')
    expect(bridges[0].scope.dispose).toHaveBeenCalledOnce()
    // A transport not yet quiescent cannot be replaced, even after the user wait budget.
    expect(() => pool.acquire(request)).toThrow()
    finish()
    await failure
    expect(first.entry.phase).toBe('error')
    expect(() => pool.acquire(request)).toThrow()
    await vi.advanceTimersByTimeAsync(5000)
    const second = pool.acquire(request)
    await second.entry.ready
    expect(second.entry).not.toBe(first.entry)
    expect(bridges).toHaveLength(2)
  })

  it('fences disposal failures instead of starting overlapping replacements', async () => {
    const { pool, bridges } = fixture()
    const request = spec()
    const first = pool.acquire(request)
    await first.entry.ready
    bridges[0].scope.dispose.mockRejectedValue(new Error('cleanup failed'))
    await expect(pool.retire(first.entry)).rejects.toThrow('cleanup failed')
    expect(first.entry.live).toBe(false)
    expect(() => pool.acquire(request)).toThrow('释放未确认')
    expect(bridges).toHaveLength(1)
    // This deliberately unrecoverable fake scope is fenced; remove only from the fixture cleanup list.
    pools.splice(pools.indexOf(pool), 1)
  })

  it('serializes shared business calls and honors cancellation before dispatch', async () => {
    const { pool } = fixture()
    const lease = pool.acquire(spec())
    await lease.entry.ready
    let finish!: () => void
    const calls: string[] = []
    const first = pool.run(lease.entry, async () => { calls.push('first'); await new Promise<void>((resolve) => { finish = resolve }); return 1 })
    await vi.waitFor(() => expect(calls).toEqual(['first']))
    const controller = new AbortController()
    const second = pool.run(lease.entry, async () => { calls.push('second'); return 2 }, controller.signal)
    controller.abort()
    finish()
    expect(await first).toBe(1)
    await expect(second).rejects.toThrow('取消')
    expect(calls).toEqual(['first'])
  })
})
