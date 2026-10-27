/** Shared, read-only sidebar MCP polling. @author ddj 2026年10月20号 */
import { rpc } from './rpc.js'
import type { McpSessionStatus } from '../shared/mcp.js'

export interface SessionMcpView {
  status?: McpSessionStatus
  stale: boolean
  /** Query lifecycle only; never a connection failure classification. */
  reason?: 'pending' | 'paused' | 'unavailable'
  /** Browser receipt time of the last accepted snapshot, in epoch milliseconds. */
  observedAt?: number
}
type Snapshot = { sessions: McpSessionStatus[]; sampledAt: number }
type FetchStatus = (signal: AbortSignal) => Promise<Snapshot>

/** One poller for all mounted row/hover consumers; never retains or activates sessions. */
export class McpSessionState {
  private views = new Map<string, SessionMcpView>()
  private listeners = new Map<string, Set<() => void>>()
  private timer?: ReturnType<typeof setTimeout>
  private request?: AbortController
  private epoch = 0
  private fallback: SessionMcpView = { stale: true, reason: 'pending' }
  private disposed = false

  /** @public @author ddj 2026年10月20号 @param fetchStatus Authenticated read-only query. @param page Visibility boundary, omitted for server tests. */
  constructor(private readonly fetchStatus: FetchStatus, private readonly page?: Document) {}

  /** @public @author ddj 2026年10月20号 @param sessionId Row identity. @returns Stable view until the next observation. */
  get(sessionId: string): SessionMcpView { return this.views.get(sessionId) ?? this.fallback }

  /** @public @author ddj 2026年10月20号 @param sessionId Row identity. @param listener React invalidation. @returns Idempotent unsubscribe; the last consumer stops polling. */
  subscribe(sessionId: string, listener: () => void): () => void {
    if (this.disposed) return () => undefined
    const first = this.listeners.size === 0
    const listeners = this.listeners.get(sessionId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    if (first) {
      this.page?.addEventListener('visibilitychange', this.visibility)
      if (this.page?.hidden) this.markStale('paused')
      else void this.poll()
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
      if (this.listeners.size === 0) this.pause()
    }
  }

  /** @private @author ddj 2026年10月20号 Stops pending work when hidden; resuming never accepts an old response. */
  private visibility = (): void => {
    if (this.page?.hidden) this.invalidate()
    else void this.poll()
  }

  /** @private @author ddj 2026年10月20号 Invalidates responses without allowing overlapping transport requests. */
  private invalidate(): void {
    this.epoch += 1
    clearTimeout(this.timer)
    this.timer = undefined
    this.request?.abort()
    this.markStale('paused')
  }

  /** @private @author ddj 2026年10月20号 Cleans listener lifetime as well as timers. */
  private pause(): void {
    this.page?.removeEventListener('visibilitychange', this.visibility)
    this.invalidate()
  }

  /** @public @author ddj 2026年10月20号 Permanently disposes HMR-owned polling. */
  dispose(): void { this.disposed = true; this.pause(); this.listeners.clear(); this.views.clear() }

  /** @private @author ddj 2026年10月27号 @param snapshot Fresh ledger. Records browser receipt time without changing the host protocol. */
  private publish(snapshot: Snapshot): void {
    const observedAt = Date.now()
    this.fallback = { stale: false, observedAt }
    this.views = new Map(snapshot.sessions.map((status) => [status.sessionId, { status, stale: false, observedAt }]))
    this.notify()
  }

  /** @private @author ddj 2026年10月27号 @param reason Query lifecycle, never a claim about connection health. Preserves stable references for unchanged observations. */
  private markStale(reason: NonNullable<SessionMcpView['reason']>): void {
    if (this.fallback.stale && this.fallback.reason === reason) return
    this.fallback = { ...this.fallback, stale: true, reason }
    for (const [id, view] of this.views) this.views.set(id, { ...view, stale: true, reason })
    this.notify()
  }

  /** @private @author ddj 2026年10月27号 Notifies mounted row and hover consumers after an observation changes. */
  private notify(): void {
    for (const listeners of this.listeners.values()) for (const listener of listeners) listener()
  }

  /** @private @author ddj 2026年10月20号 Queries once, with a 10-second deadline and a 2.5-second gap after settlement. */
  private async poll(): Promise<void> {
    if (this.disposed || this.request || !this.listeners.size || this.page?.hidden) return
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.fallback.reason === 'paused') this.markStale('pending')

    const request = new AbortController()
    const epoch = this.epoch
    this.request = request
    /** @author ddj 2026年10月20号 Marks overdue responses unusable even if a transport ignores cancellation. */
    const expire = (): void => { request.abort(); if (epoch === this.epoch) this.markStale('unavailable') }
    const deadline = setTimeout(expire, 10000)
    try {
      const snapshot = await this.fetchStatus(request.signal)
      if (epoch === this.epoch && !request.signal.aborted) this.publish(snapshot)
    } catch {
      if (epoch === this.epoch) this.markStale('unavailable')
    } finally {
      clearTimeout(deadline)
      this.request = undefined
      // A visibility/subscription change resumes promptly, but only after the old transport settles.
      if (!this.disposed && this.listeners.size && !this.page?.hidden) {
        const delay = epoch === this.epoch ? 2500 : 0
        this.timer = setTimeout(() => { void this.poll() }, delay)
      }
    }
  }
}

/** @public @author ddj 2026年10月20号 @returns Browser-owned singleton per plugin apply; legacy Hosts fail safely as stale. */
export function mcpSessionState(): McpSessionState {
  /** @author ddj 2026年10月20号 @param signal Fetch lifetime. @returns Current in-memory host ledger. @throws RPC errors. */
  const fetchStatus = async (signal: AbortSignal): Promise<Snapshot> => {
    const result = await rpc('mcp.sessionSnapshot', {}, signal)
    if (!result.ok) throw new Error('MCP 状态暂不可用')
    return result
  }
  return new McpSessionState(fetchStatus, document)
}
