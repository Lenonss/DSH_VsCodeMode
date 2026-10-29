/** Isolated evidence for non-cooperative startup cleanup, not a production root-cause claim. @author ddj 2026年10月29号 */
import { describe, expect, it, vi } from 'vitest'
import { McpBridge } from '../src/mcpBridge.js'
import { McpPool } from '../src/mcpPool.js'
import { parseMcpPolicy } from '../src/shared/mcp.js'
import type { BridgeScope } from '../src/mcpBridge.js'
import type { PoolEntry, PoolSpec } from '../src/mcpPool.js'
import type { MpcConfig } from '../src/shared/mcp.js'
import type { Ctx } from '../src/store.js'

// A diagnostic fixture must not write synthetic timeout evidence into the real Host log.
vi.mock('../src/debugLog.js', () => ({ debugRecord: vi.fn() }))

type StallKind = 'work' | 'dispose'
type ReadyState = 'pending' | 'fulfilled' | 'rejected'
interface Gate {
  promise: Promise<void>
  settled: boolean
  release(): void
}
interface StartupControl {
  work: Gate
  close: Gate
  closeCalls: number
}
interface TrackedEntry {
  entry: PoolEntry
  readyState: ReadyState
  observed: Promise<void>
}
interface StallFixture {
  pool: McpPool
  controls: Map<string, StartupControl>
  bridges: McpBridge[]
  tracked: TrackedEntry[]
}

/** @private @author ddj 2026年10月29号 @returns Idempotent barrier whose settlement is independently observable. */
function createGate(): Gate {
  let resolveGate!: () => void
  const pending = new Promise<void>((resolve) => { resolveGate = resolve })
  const gate: Gate = { promise: pending, settled: false, release: resolveGate }
  gate.promise = pending.then(() => { gate.settled = true })
  return gate
}

/** @private @author ddj 2026年10月29号 @param serverName Isolated fake service identity. @returns Request with a one-second deadline. */
function requestFor(serverName: string): PoolSpec {
  return {
    workspace: '/mcp-stall-fixture', owner: {},
    config: { serverName, transport: 'stdio', command: 'fixture-only-never-spawned' },
    policy: parseMcpPolicy({ sharing: 'workspace', startupTimeoutMs: 1000 }),
  }
}

/** @private @author ddj 2026年10月29号 @param controls Per-service independent work and closure barriers. @returns Real bridge around a process-free private scope. */
async function makeBridge(controls: Map<string, StartupControl>): Promise<McpBridge> {
  let startup: StartupControl | undefined
  /** @private @author ddj 2026年10月29号 @param _official Unused fake module. @param config Pool-selected service. @returns Controlled activation work. */
  function plugin(_official: unknown, config: MpcConfig): Promise<void> {
    startup = controls.get(config.serverName)!
    return startup.work.promise
  }
  /** @private @author ddj 2026年10月29号 @returns Independent private-scope closure barrier. */
  async function dispose(): Promise<void> {
    if (!startup) return
    startup.closeCalls += 1
    await startup.close.promise
  }
  const privateCtx = { isolate: () => privateCtx, provide: () => undefined, plugin }
  const scope: BridgeScope = { ctx: privateCtx, dispose }
  return McpBridge.create({} as Ctx, () => scope)
}

/** @private @author ddj 2026年10月29号 @param stall Which independent barrier remains blocked after deadline. @returns In-memory pool and complete cleanup ownership. */
function createFixture(stall: StallKind): StallFixture {
  const controls = new Map<string, StartupControl>()
  for (const serverName of ['alpha', 'beta', 'gamma']) {
    const control = { work: createGate(), close: createGate(), closeCalls: 0 }
    controls.set(serverName, control)
    if (stall === 'work' || serverName === 'gamma') control.close.release()
    if (serverName === 'gamma') control.work.release()
  }
  const bridges: McpBridge[] = []
  /** @private @author ddj 2026年10月29号 @returns Observable private bridge without external MCP activity. */
  async function make(): Promise<McpBridge> {
    const bridge = await makeBridge(controls)
    bridges.push(bridge)
    return bridge
  }
  const pool = new McpPool({} as Ctx, async () => ({}), make)
  return { pool, controls, bridges, tracked: [] }
}

/** @private @author ddj 2026年10月29号 @param fixture Owns every ready observer. @param serverName Service to acquire. @returns Entry plus a non-rejecting settlement observer. */
function trackEntry(fixture: StallFixture, serverName: string): TrackedEntry {
  const lease = fixture.pool.acquire(requestFor(serverName))
  const tracked: TrackedEntry = { entry: lease.entry, readyState: 'pending', observed: Promise.resolve() }
  /** @private @author ddj 2026年10月29号 Records successful settlement without changing pool work. */
  function fulfilled(): void { tracked.readyState = 'fulfilled' }
  /** @private @author ddj 2026年10月29号 Consumes the expected timeout/cancellation rejection for all assertion paths. */
  function rejected(): void { tracked.readyState = 'rejected' }
  tracked.observed = lease.entry.ready.then(fulfilled, rejected)
  fixture.tracked.push(tracked)
  return tracked
}

/** @private @author ddj 2026年10月29号 @param fixture Resource owner. Releases both independent barriers, including queued-service controls. */
function releaseGates(fixture: StallFixture): void {
  for (const control of fixture.controls.values()) {
    control.work.release()
    control.close.release()
  }
}

/** @private @author ddj 2026年10月29号 @param fixture Resource owner. Releases all barriers before waiting, even after a failed assertion. */
async function cleanFixture(fixture: StallFixture): Promise<void> {
  try {
    releaseGates(fixture)
    await Promise.all(fixture.tracked.map((tracked) => tracked.observed))
    await fixture.pool.dispose()
  } finally {
    vi.useRealTimers()
  }
}

/** @private @author ddj 2026年10月29号 @param fixture Pool under observation. @param stall Independent stalled barrier. Verifies the other barrier has actually completed. */
function assertBarriers(fixture: StallFixture, stall: StallKind): void {
  for (const serverName of ['alpha', 'beta']) {
    const control = fixture.controls.get(serverName)!
    const tracked = fixture.tracked.find((item) => item.entry.spec.config.serverName === serverName)!
    expect(control.closeCalls).toBe(1)
    if (stall === 'work') {
      expect(control.work.settled).toBe(false)
      expect(control.close.settled).toBe(true)
      expect(tracked.entry.bridge).toBeUndefined()
      expect(tracked.entry.close).toBeUndefined()
    } else {
      expect(control.work.settled).toBe(true)
      expect(control.close.settled).toBe(false)
      expect(tracked.entry.bridge).toBeDefined()
      expect(tracked.entry.close).toBeDefined()
    }
  }
}

/** @private @author ddj 2026年10月29号 @param fixture Pool under observation. @param stall Independent stalled barrier. @param elapsedMs Fake elapsed time. Emits bounded, secret-free observations. */
function assertStalled(fixture: StallFixture, stall: StallKind, elapsedMs: number): void {
  assertBarriers(fixture, stall)
  for (const tracked of fixture.tracked.slice(0, 2)) {
    expect(tracked.entry).toMatchObject({ phase: 'stopping', live: false })
    expect(tracked.entry.retryAt).toBeUndefined()
    expect(tracked.readyState).toBe('rejected')
    expect(() => fixture.pool.acquire(tracked.entry.spec)).toThrow('MCP 初始化失败或超时')
  }
  expect(fixture.tracked[2].entry.phase).toBe('queued')
  expect(fixture.tracked[2].entry.startAt).toBeUndefined()
  expect(fixture.tracked[2].readyState).toBe('pending')
  expect(fixture.bridges).toHaveLength(2)
  emitObservation(fixture, stall, elapsedMs)
}

/** @private @author ddj 2026年10月29号 @param fixture Pool under observation. @param stall Independent stalled barrier. @param elapsedMs Fake elapsed time. Writes JSON only to test stdout. */
function emitObservation(fixture: StallFixture, stall: StallKind, elapsedMs: number): void {
  const entries = fixture.tracked.map((tracked) => ({
    name: tracked.entry.spec.config.serverName, phase: tracked.entry.phase,
    live: tracked.entry.live, ready: tracked.readyState, retryAtSet: tracked.entry.retryAt !== undefined,
  }))
  const barriers = [...fixture.controls].slice(0, 2).map(([name, control]) => ({
    name, workSettled: control.work.settled, closeSettled: control.close.settled, closeCalls: control.closeCalls,
  }))
  console.log(JSON.stringify({ fixture: 'mcp-pool-stall', stall, elapsedMs, bridges: fixture.bridges.length, barriers, entries }))
}

/** @private @author ddj 2026年10月29号 @param fixture Resource owner. @param stall Independent stalled barrier. Verifies release, cooldown and safe replacement. */
async function assertRecovery(fixture: StallFixture, stall: StallKind): Promise<void> {
  releaseGates(fixture)
  await Promise.all(fixture.tracked.slice(0, 2).map((tracked) => tracked.entry.quiescence))
  await Promise.all(fixture.tracked.map((tracked) => tracked.observed))
  for (const tracked of fixture.tracked.slice(0, 2)) {
    expect(tracked.entry.phase).toBe('error')
    expect(tracked.readyState).toBe('rejected')
    expect(tracked.entry.close).toBeUndefined()
    expect(() => fixture.pool.acquire(tracked.entry.spec)).toThrow()
  }
  expect(fixture.tracked[2].entry.phase).toBe('ready')
  expect(fixture.bridges).toHaveLength(3)
  emitObservation(fixture, stall, 6000)

  await vi.advanceTimersByTimeAsync(5000)
  const replacement = trackEntry(fixture, 'alpha')
  await replacement.observed
  expect(replacement.readyState).toBe('fulfilled')
  expect(replacement.entry.phase).toBe('ready')
  expect(replacement.entry).not.toBe(fixture.tracked[0].entry)
  expect(fixture.bridges).toHaveLength(4)
  emitObservation(fixture, stall, 11000)
}

/** @private @author ddj 2026年10月29号 @param stall Independent barrier held after deadline. Exercises exactly two occupied slots and one queued key. */
async function runStallCase(stall: StallKind): Promise<void> {
  vi.useFakeTimers()
  const fixture = createFixture(stall)
  try {
    trackEntry(fixture, 'alpha')
    trackEntry(fixture, 'beta')
    trackEntry(fixture, 'gamma')
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.bridges).toHaveLength(2)
    expect(fixture.tracked.slice(0, 2).map((tracked) => tracked.entry.phase)).toEqual(['starting', 'starting'])
    expect(fixture.tracked[2].entry.phase).toBe('queued')

    await vi.advanceTimersByTimeAsync(1000)
    // For the dispose case only, finish work after the deadline has already invalidated both entries.
    if (stall === 'dispose') {
      fixture.controls.get('alpha')!.work.release()
      fixture.controls.get('beta')!.work.release()
      await vi.advanceTimersByTimeAsync(0)
    }
    assertStalled(fixture, stall, 1000)
    await vi.advanceTimersByTimeAsync(5000)
    assertStalled(fixture, stall, 6000)
    await assertRecovery(fixture, stall)
  } finally {
    await cleanFixture(fixture)
  }
}

/** @private @author ddj 2026年10月29号 @param stall Independent blocked resource. @param action Teardown API. Verifies rejected ready is not a quiescence signal. */
async function assertTeardown(stall: StallKind, action: 'retire' | 'dispose'): Promise<void> {
  vi.useFakeTimers()
  const fixture = createFixture(stall)
  let teardown: Promise<void> | undefined
  try {
    const tracked = trackEntry(fixture, 'alpha')
    await vi.advanceTimersByTimeAsync(1000)
    await tracked.observed
    expect(tracked.readyState).toBe('rejected')
    let finished = false
    /** @private @author ddj 2026年10月29号 Observes teardown without conflating it with caller settlement. */
    function completed(): void { finished = true }
    teardown = (action === 'retire' ? fixture.pool.retire(tracked.entry) : fixture.pool.dispose()).then(completed)
    await vi.advanceTimersByTimeAsync(5000)
    expect(finished).toBe(false)
    expect(fixture.pool.entries.has(tracked.entry.key)).toBe(true)
    releaseGates(fixture)
    await teardown
    expect(finished).toBe(true)
    expect(fixture.pool.entries.size).toBe(0)
  } finally {
    releaseGates(fixture)
    await teardown
    await cleanFixture(fixture)
  }
}

describe('MCP pool non-cooperative cleanup evidence', () => {
  it.each(['work', 'dispose'] as const)('retire waits for %s after ready rejection', async (stall) => {
    await assertTeardown(stall, 'retire')
  })

  it.each(['work', 'dispose'] as const)('dispose waits for %s after ready rejection', async (stall) => {
    await assertTeardown(stall, 'dispose')
  })
  it('keeps both slots fenced when close has finished but activation work remains pending', async () => {
    await runStallCase('work')
  })

  it('keeps both slots fenced when activation work has finished but disposal remains pending', async () => {
    await runStallCase('dispose')
  })
})
