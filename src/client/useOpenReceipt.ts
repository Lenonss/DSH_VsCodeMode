/** Correlated editor readiness for external file opens. @author ddj 2026年09月28号 */
import React from 'react'
import { finishOpen, hasOpen, peekOpen } from './openReceipt.js'
import type { EditorRequest } from './openReceipt.js'

export interface ReceiptHost {
  sessionId: string
  open(request: EditorRequest): void | Promise<void>
  ready(request: EditorRequest): boolean
  error(request: EditorRequest): string | null
}

/** One mounted editor owns at most one claimed external request. */
export class OpenMonitor {
  private pending: EditorRequest | undefined
  private frame: number | undefined
  private stopped = false
  private opening = false
  /** @private @author ddj 2026年09月28号 Claim a request arriving after mount. */
  private listener = (): void => { this.claim() }

  /** @author ddj 2026年09月28号 @param read Read current component state without a stale closure. */
  constructor(private readonly read: () => ReceiptHost) {}

  /** @public @author ddj 2026年09月28号 Attach the listener and claim a pre-mount request. */
  start(): void {
    window.addEventListener('edrv:open-request', this.listener)
    this.claim()
  }

  /** @public @author ddj 2026年09月28号 Fail claimed work and cancel the frame on unmount. */
  stop(): void {
    this.stopped = true
    window.removeEventListener('edrv:open-request', this.listener)
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    this.frame = undefined
    if (this.pending) finishOpen(this.pending.requestId, false, '编辑器已关闭')
    this.pending = undefined
  }

  /** @private @author ddj 2026年09月28号 Schedule at most one readiness/queue check. */
  private arm(): void {
    if (!this.stopped && this.frame === undefined) this.frame = requestAnimationFrame(this.check)
  }

  /**
   * Settle only the request this instance still owns; queued work runs next frame.
   * @private @author ddj 2026年09月28号
   * @param request Claimed request, captured before asynchronous work.
   * @param success Whether actual readiness was confirmed.
   * @param error Failure description.
   */
  private finish(request: EditorRequest, success: boolean, error?: string): void {
    if (this.stopped || this.pending !== request) return
    this.pending = undefined
    this.opening = false
    if (hasOpen(request.requestId)) finishOpen(request.requestId, success, error)
    this.arm()
  }

  /**
   * Observe startup without letting a late completion affect a new claim.
   * @private @author ddj 2026年09月28号
   * @param request Startup's request identity.
   * @param operation Optional asynchronous editor startup.
   */
  private watchOpen(request: EditorRequest, operation: void | Promise<void>): void {
    if (!operation) return
    this.opening = true
    /** @author ddj 2026年09月28号 Release readiness only for this live claim. */
    const ready = (): void => {
      if (!this.stopped && this.pending === request) this.opening = false
    }
    /** @author ddj 2026年09月28号 @param error Correlated startup rejection. */
    const fail = (error: unknown): void => this.finish(request, false, String(error))
    void Promise.resolve(operation).then(ready, fail)
  }

  /** @private @author ddj 2026年09月28号 Claim this session; exceptions fail the exact request. */
  private claim(): void {
    if (this.stopped || (this.pending && hasOpen(this.pending.requestId))) return
    this.pending = undefined
    this.opening = false
    try {
      const host = this.read()
      const request = peekOpen(host.sessionId)
      if (!request) return
      this.pending = request
      this.watchOpen(request, host.open(request))
      this.arm()
    } catch (error) {
      if (this.pending) this.finish(this.pending, false, String(error))
    }
  }

  /** @private @author ddj 2026年09月28号 Check readiness; expired claims and exceptions cannot ACK later work. */
  private check = (): void => {
    this.frame = undefined
    if (this.stopped) return
    const request = this.pending
    if (!request || !hasOpen(request.requestId)) { this.pending = undefined; this.claim(); return }
    try {
      const host = this.read()
      if (request.sessionId !== host.sessionId) { this.finish(request, false, '会话已切换'); return }
      if (this.opening) { this.arm(); return }
      const error = host.error(request)
      if (error || host.ready(request)) { this.finish(request, !error, error ?? undefined); return }
      this.arm()
    } catch (error) { this.finish(request, false, String(error)) }
  }
}

/**
 * Bind a component while reading its latest model state.
 * @author ddj 2026年09月28号
 * @param host Mounted editor actions and readiness checks.
 */
export function useOpenReceipt(host: ReceiptHost): void {
  const latest = React.useRef(host)
  latest.current = host
  /** @author ddj 2026年09月28号 @returns Listener and animation-frame cleanup. */
  function mount(): () => void {
    const monitor = new OpenMonitor(() => latest.current)
    monitor.start()
    return () => monitor.stop()
  }
  React.useEffect(mount, [host.sessionId])
}
