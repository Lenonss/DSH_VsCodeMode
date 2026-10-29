/** Connection ownership, bounded cold starts and workspace leases. @author ddj 2026年10月20号 */
import { createHash } from 'node:crypto'
import { McpBridge } from './mcpBridge.js'
import { debugRecord } from './debugLog.js'
import { mcpErrorText } from './mcpDiagnostic.js'
import type { McpPolicy, McpPhase, MpcConfig } from './shared/mcp.js'
import type { Ctx } from './store.js'

export interface PoolSpec {
  workspace: string
  owner: object
  config: MpcConfig
  policy: McpPolicy
}
/** Startup caller settlement, independent from the owned resource lifetime. */
interface StartupResult {
  resolve(): void
  reject(error: unknown): void
}
export interface PoolEntry {
  key: string
  spec: PoolSpec
  refs: number
  phase: McpPhase
  queuedAt: number
  phaseAt: number
  finishedAt?: number
  startAt?: number
  connectedAt?: number
  error?: string
  retryAt?: number
  bridge?: McpBridge
  fiber?: any
  ready: Promise<void>
  /** Entire queued mount/cleanup lifetime; rejection means closure remains unconfirmed. */
  quiescence: Promise<void>
  cleanupFailed?: boolean
  close?: Promise<void>
  idle?: ReturnType<typeof setTimeout>
  live: boolean
  calls: Promise<unknown>
}
export interface PoolLease {
  entry: PoolEntry
  release(): void
}
export type BridgeMaker = () => Promise<McpBridge>

/** @private @author ddj 2026年10月20号 @param input Plain effective configuration. @returns Stable secret-bearing identity used only as digest input. */
function stableConfig(input: unknown): string {
  if (Array.isArray(input)) return '[' + input.map(stableConfig).join(',') + ']'
  if (input && typeof input === 'object') {
    const config = input as Record<string, unknown>
    return '{' + Object.keys(config).sort().map((key) => JSON.stringify(key) + ':' + stableConfig(config[key])).join(',') + '}'
  }
  return JSON.stringify(input) ?? 'null'
}

/** @public @author ddj 2026年10月20号 @param task Shared work that must remain alive for other waiters. @param signal One waiter's cancellation. @returns Caller-local wait without abandoning owned pool work. */
export function waitMcp<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  return new Promise<T>((resolve, reject) => {
    /** @author ddj 2026年10月20号 Rejects only this waiter. */
    const abort = (): void => { reject(new Error('MCP 等待已取消')) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** The pool owns private scopes independently from any first subscriber. */
export class McpPool {
  readonly entries = new Map<string, PoolEntry>()
  private readonly owners = new WeakMap<object, number>()
  private ownerSeq = 0
  private running = 0
  private readonly queue: Array<() => Promise<void>> = []
  private readonly jobs = new Set<Promise<void>>()
  private stopped = false

  /** @public @author ddj 2026年10月20号 @param ctx Host lifecycle owner. @param load Official plugin loader. @param make Private scope factory. */
  constructor(private readonly ctx: Ctx, private readonly load: () => Promise<any>, private readonly make: BridgeMaker = () => McpBridge.create(ctx)) {}

  /** @private @author ddj 2026年10月20号 @param spec Effective request. @returns Private digest; never emit configuration or secrets. */
  private keyOf(spec: PoolSpec): string {
    let owner = 0
    if (spec.policy.sharing === 'agent') {
      if (!this.owners.has(spec.owner)) this.owners.set(spec.owner, ++this.ownerSeq)
      owner = this.owners.get(spec.owner)!
    }
    const workspace = process.platform === 'win32' ? spec.workspace.replace(/\\/g, '/').toLowerCase() : spec.workspace
    return createHash('sha256').update(stableConfig([workspace, owner, spec.config, spec.policy])).digest('hex')
  }

  /** @public @author ddj 2026年10月20号 @param spec Authorized connection request. @returns Reference-counted single-flight lease. */
  acquire(spec: PoolSpec): PoolLease {
    if (this.stopped) throw new Error('MCP runtime is disposed')
    const key = this.keyOf(spec)
    let entry = this.entries.get(key)
    if (entry?.phase === 'error' && entry.retryAt !== undefined && Date.now() >= entry.retryAt && !entry.close) {
      this.entries.delete(key)
      entry = undefined
    }
    if (entry && !entry.live) throw new Error(entry.error ?? 'MCP 旧连接仍在释放，暂不能创建替代实例')
    if (!entry) {
      entry = { key, spec, refs: 0, phase: 'queued', queuedAt: Date.now(), phaseAt: Date.now(), ready: Promise.resolve(), quiescence: Promise.resolve(), live: true, calls: Promise.resolve() }
      this.entries.set(key, entry)
      entry.ready = this.schedule(entry)
      void entry.ready.catch(() => undefined)
    }
    if (entry.idle) clearTimeout(entry.idle)
    entry.idle = undefined
    entry.refs += 1
    let released = false
    return { entry, release: () => {
      if (released) return
      released = true
      this.release(entry!)
    } }
  }

  /** @private @author ddj 2026年10月29号 @param entry New entry. @returns Caller result, independent from the two-slot cleanup lifetime. */
  private schedule(entry: PoolEntry): Promise<void> {
    let result!: StartupResult
    const ready = new Promise<void>((resolve, reject) => { result = { resolve, reject } })
    let lifetime!: StartupResult
    entry.quiescence = new Promise<void>((resolve, reject) => { lifetime = { resolve, reject } })
    void entry.quiescence.catch(() => undefined)

    /** @private @author ddj 2026年10月29号 Runs and observes the complete owned mount even after caller rejection. */
    const run = async (): Promise<void> => {
      try {
        await this.start(entry, result)
        lifetime.resolve()
      } catch (error) {
        result.reject(error)
        lifetime.reject(error)
      }
    }
    this.queue.push(run)
    this.pump()
    return ready
  }

  /** @private @author ddj 2026年10月20号 Advances FIFO work; each task holds its slot until startup or cleanup quiesces. */
  private pump(): void {
    while (this.running < 2 && this.queue.length) {
      const run = this.queue.shift()!
      this.running += 1
      const job = run().finally(() => {
        this.running -= 1
        this.jobs.delete(job)
        this.pump()
      })
      this.jobs.add(job)
    }
  }

  /** @private @author ddj 2026年10月29号 @param entry Connection to initialize. @param result Caller settlement. @returns Full startup and cleanup lifetime. */
  private async start(entry: PoolEntry, result: StartupResult): Promise<void> {
    if (!entry.live || this.stopped) { result.reject(new Error('MCP 启动已取消')); return }
    entry.phase = 'loading'
    entry.phaseAt = Date.now()
    entry.startAt = entry.phaseAt
    let timer: ReturnType<typeof setTimeout> | undefined
    const work = this.mount(entry)
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('MCP 初始化超时')), entry.spec.policy.startupTimeoutMs)
      timer.unref?.()
    })
    try {
      await Promise.race([work, deadline])
      if (!entry.live) throw new Error('MCP 启动已取消')
      entry.phase = 'ready'
      entry.finishedAt = Date.now()
      entry.connectedAt = entry.finishedAt
      result.resolve()
    } catch (error) {
      if (!entry.cleanupFailed) entry.error = 'MCP 初始化失败或超时；旧连接清理尚未确认，暂不能重建，请查看 Host 日志'
      const diagnostic = 'MCP initialization failed; phase=' + entry.phase + '; transport=' + entry.spec.config.transport
        + '; elapsedMs=' + (Date.now() - entry.startAt) + '; ' + mcpErrorText(error, entry.spec.config)
      debugRecord(this.ctx, entry.spec.workspace, diagnostic, 'warn')
      // Invalidation precedes disposal; neither late module load nor callbacks may publish.
      entry.live = false
      entry.phase = 'stopping'
      result.reject(new Error(entry.error))
      await this.finishFailure(entry, work)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** @private @author ddj 2026年10月29号 @param entry Failed generation. @param work Entire mount, including late factory cleanup. @returns Confirmed quiescence; throws when closure is unconfirmed. */
  private async finishFailure(entry: PoolEntry, work: Promise<void>): Promise<void> {
    await Promise.allSettled([this.closeBridge(entry), work])
    if (entry.cleanupFailed) throw new Error(entry.error)

    entry.phase = 'error'
    entry.finishedAt = Date.now()
    entry.retryAt = entry.finishedAt + 5000
    entry.error = 'MCP 初始化失败或超时，请查看 Host 日志'
  }

  /** @private @author ddj 2026年10月20号 @param entry Owned generation. @returns Official initial sync; never publishes after invalidation. */
  private async mount(entry: PoolEntry): Promise<void> {
    const official = await this.load()
    if (!entry.live || this.stopped) return
    const bridge = await this.make()
    entry.bridge = bridge
    // Keep late factory ownership visible, including synchronous or rejected disposal failures.
    if (!entry.live || this.stopped) { await this.closeBridge(entry); return }
    entry.phase = 'starting'
    entry.phaseAt = Date.now()
    entry.fiber = bridge.scope.ctx.plugin(official, entry.spec.config)
    await entry.fiber
    if (entry.fiber?.state !== undefined && entry.fiber.state !== 2) throw new Error('MCP 插件未完成激活')
  }

  /** @private @author ddj 2026年10月29号 @param entry Connection to close. @returns Shared closure barrier; synchronous throws and rejections retain a fenced entry. */
  private async closeBridge(entry: PoolEntry): Promise<void> {
    if (entry.close) return entry.close
    const bridge = entry.bridge
    if (!bridge) return
    /** @private @author ddj 2026年10月29号 @returns Deferred disposal so synchronous throws are owned by the shared barrier. */
    const dispose = (): Promise<void> => bridge.dispose()
    const close = Promise.resolve().then(dispose)
    entry.close = close
    try {
      await close
      entry.bridge = undefined
      entry.fiber = undefined
      entry.close = undefined
    } catch (error) {
      entry.cleanupFailed = true
      entry.error = 'MCP 释放未确认，禁止重建，请查看 Host 日志'
      this.ctx.logger?.warn?.('MCP cleanup failed: ' + String(error))
      throw error
    }
  }

  /** @private @author ddj 2026年10月20号 @param entry One lease's owner. Arms workspace-only warm retention. */
  private release(entry: PoolEntry): void {
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs || !entry.live) return
    if (entry.spec.policy.sharing === 'agent') { void this.retire(entry).catch(() => undefined); return }
    entry.idle = setTimeout(() => { void this.retire(entry).catch(() => undefined) }, 60000)
    entry.idle.unref?.()
  }

  /** @public @author ddj 2026年10月20号 @param entry Invalid generation. @returns Quiescent close; callers may await before starting a replacement. */
  async retire(entry: PoolEntry): Promise<void> {
    entry.live = false
    entry.phase = 'stopping'
    if (entry.idle) clearTimeout(entry.idle)
    const closures = await Promise.allSettled([this.closeBridge(entry), entry.quiescence, entry.calls])
    const failure = closures.find((closure) => closure.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    // Only the whole mount barrier proves that no late factory can still create a scope.
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
  }

  /** @public @author ddj 2026年10月20号 @param entry Authorized connection. @param action Per-call work retaining original execution identity. @param signal Caller cancellation. @returns Serialized shared result; no direct registry bypass is introduced here. */
  run<T>(entry: PoolEntry, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    /** @author ddj 2026年10月20号 Checks cancellation and generation again at actual dispatch. */
    const invoke = async (): Promise<T> => {
      await waitMcp(entry.ready, signal)
      if (signal?.aborted || !entry.live || entry.phase !== 'ready') throw new Error('MCP 连接不可用或调用已取消')
      return action()
    }
    const result = entry.calls.then(invoke)
    entry.calls = result.catch(() => undefined)
    return result
  }

  /** @public @author ddj 2026年10月20号 @returns Full disposal of entries, queue, timers and owned work. */
  async dispose(): Promise<void> {
    this.stopped = true
    const closures = await Promise.allSettled([...this.entries.values()].map((entry) => this.retire(entry)))
    await Promise.all([...this.jobs])
    const failure = closures.find((closure) => closure.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
