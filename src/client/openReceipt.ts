import { openEditorView } from './events.js'

import type { PlanDocument } from './planState.js'

export interface EditorRequest { requestId: string; sessionId: string; path: string | null; line?: number; column?: number; preview?: boolean; plan?: PlanDocument }
export interface OpenOptions { preview?: boolean; plan?: PlanDocument; signal?: AbortSignal }
interface Waiter { request: EditorRequest; finish: (success: boolean) => void; claimed?: boolean }
const waiters = new Map<string, Waiter>()

/** @public @author ddj 2026年09月28号
 * Atomically claim the pending request for this editor's session on mount.
 * @param sessionId Owning session.
 * @returns Unclaimed request, if any.
 */
export function peekOpen(sessionId: string): EditorRequest | undefined {
  const row = [...waiters.values()].find((item) => item.request.sessionId === sessionId && !item.claimed)
  if (!row) return undefined
  row.claimed = true
  return row.request
}

/** @public @author ddj 2026年09月28号
 * Complete an actual editor open by its unguessable local request ID.
 * @param requestId Claimed request identity.
 * @param success Whether content and navigation are ready.
 * @param error Optional diagnostic for the caller.
 */
export function finishOpen(requestId: string, success: boolean, error?: string): void {
  const row = waiters.get(requestId)
  if (row?.claimed) row.finish(success === true)
}

/** @public @author ddj 2026年09月28号
 * Route an editor open and await a correlated model-ready completion.
 * @param path File path, or null to mount the editor.
 * @param line Optional target line.
 * @param column Optional target column.
 * @param sessionId Owning session, required for routing.
 * @param options Explicit preview, read-only plan document and optional cancellation signal.
 * @returns Actual completion; timeout and disposal are false.
 */
export function requestOpen(path: string | null, line?: number, column?: number, sessionId = '', options: OpenOptions = {}): Promise<boolean> {
  if (typeof window === 'undefined' || !sessionId || options.signal?.aborted) return Promise.resolve(false)
  const request: EditorRequest = { requestId: crypto.randomUUID(), sessionId, path, line, column }
  if (options.preview !== undefined) request.preview = options.preview
  if (options.plan) request.plan = options.plan
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    /** @private @author ddj 2026年09月28号 Complete once and release the deadline. */
    function finish(success: boolean): void {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      waiters.delete(request.requestId)
      resolve(success)
    }
    /** @private @author ddj 2026年10月08号 Cancel a stale plan open on scope change or disposal. */
    function abort(): void { finish(false) }
    options.signal?.addEventListener('abort', abort, { once: true })
    waiters.set(request.requestId, { request, finish })
    timer = setTimeout(() => finish(false), 20_000)
    openEditorView(null)
    window.dispatchEvent(new CustomEvent('edrv:open-request', { detail: request }))
  })
}

/** @public @author ddj 2026年09月28号
 * Check that an editor receipt is still awaited after timeout or disposal.
 * @param requestId Local request identity.
 * @returns Whether this request may still be completed.
 */
export function hasOpen(requestId: string): boolean { return waiters.has(requestId) }

/** @public @author ddj 2026年09月28号 Cancel outstanding receipts when the client plugin unloads. */
export function disposeOpenWait(): void { for (const waiter of [...waiters.values()]) waiter.finish(false) }
