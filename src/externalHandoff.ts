import { randomUUID } from 'node:crypto'
import { OPEN_TTL_MS } from './shared/externalOpen.js'

export interface ExternalOpenRequest { paths: string[]; line?: number; column?: number }
export interface OpenClaim extends ExternalOpenRequest { token: string; leaseId: string }
export interface OpenReceipt { token: string; clientId: string; leaseId: string; success: boolean; error?: string }
interface Pending extends ExternalOpenRequest {
  token: string; at: number; clientId?: string; leaseId?: string; leaseAt?: number
  success?: boolean; error?: string
}
const pending = new Map<string, Pending>()
const LEASE_MS = 30_000
let lastPollAt = 0

/** @public @author ddj 2026年09月28号
 * Queue a bounded request without replacing earlier opens.
 * @param req Paths and navigation coordinates.
 * @param token Optional inbox request ID.
 * @param createdAt Original producer timestamp; queue ingestion never extends it.
 * @returns Presence and stable request token.
 */
export function handoffOpen(req: ExternalOpenRequest, token: string = randomUUID(), createdAt = Date.now()): { clients: number; token: string } {
  prunePending()
  const clients = Date.now() - lastPollAt <= 15_000 ? 1 : 0
  if (!Number.isSafeInteger(createdAt) || createdAt + OPEN_TTL_MS <= Date.now()) return { token, clients }
  if (!pending.has(token)) {
    if (pending.size >= 128) throw new Error('外部打开队列已满')
    pending.set(token, { ...req, paths: [...req.paths], token, at: createdAt })
  }
  return { token, clients }
}

/** @public @author ddj 2026年09月28号
 * Claim one request; repeated heartbeats renew this client's active lease.
 * @param args Authenticated page identity.
 * @returns A leased request or null.
 */
export function pollPending(args: { clientId: string; busy?: boolean }): OpenClaim | null {
  lastPollAt = Date.now()
  prunePending()
  if (!args?.clientId || args.clientId.length > 128) return null
  const active = [...pending.values()].find((row) => row.clientId === args.clientId && row.success === undefined)
  if (active && Date.now() - (active.leaseAt ?? 0) < LEASE_MS) {
    active.leaseAt = Date.now()
    return null
  }
  if (args.busy) return null
  for (const row of pending.values()) {
    if (row.success !== undefined || (row.leaseAt && Date.now() - row.leaseAt < LEASE_MS)) continue
    row.clientId = args.clientId
    row.leaseId = randomUUID()
    row.leaseAt = Date.now()
    return { paths: row.paths, line: row.line, column: row.column, token: row.token, leaseId: row.leaseId }
  }
  return null
}

/** @public @author ddj 2026年09月28号
 * Accept only the current lease's actual editor completion.
 * @param receipt Claimed request identity and result.
 * @returns Whether the receipt was accepted.
 */
export function ackPending(receipt: OpenReceipt): boolean {
  prunePending()
  const row = pending.get(receipt.token)
  if (!row || Date.now() >= row.at + OPEN_TTL_MS || row.clientId !== receipt.clientId || row.leaseId !== receipt.leaseId) return false
  if (!row.leaseAt || Date.now() - row.leaseAt >= LEASE_MS) return false
  if (row.success !== undefined) return row.success === receipt.success
  row.success = receipt.success === true
  row.error = receipt.error?.slice(0, 1000)
  return true
}

/** @public @author ddj 2026年09月28号
 * Inspect completion; absence and mere delivery never imply success.
 * @param token Request identity.
 * @param take Legacy cancellation flag, only cancels unclaimed requests.
 * @returns Terminal completion state.
 */
export function pendingState(token: string, take = false): { delivered: boolean; completed: boolean; error?: string } {
  prunePending()
  const row = pending.get(token)
  if (take && row && !row.leaseId) cancelPending(token, '打开已取消')
  return { delivered: row?.success === true, completed: row?.success !== undefined, error: row?.error }
}

/** @public @author ddj 2026年09月28号
 * Cancel queued or claimed work while retaining its identity against replay.
 * @param token Original request ID.
 * @param error Terminal diagnostic.
 */
export function cancelPending(token: string, error = '打开超时，请重试'): void {
  const row = pending.get(token)
  if (!row) return
  if (row.success === undefined) { row.success = false; row.error = error }
  row.clientId = undefined
  row.leaseId = undefined
  row.leaseAt = undefined
}

/** @private @author ddj 2026年09月28号 Expire at the original deadline and retain bounded replay tombstones. */
function prunePending(): void {
  const now = Date.now()
  for (const [key, row] of pending) {
    if (now >= row.at + OPEN_TTL_MS && row.success === undefined) cancelPending(key)
    if (now >= row.at + OPEN_TTL_MS * 2) pending.delete(key)
  }
}

/** @public @author ddj 2026年09月28号 Release profile-scoped state during host disposal. */
export function clearPending(): void { pending.clear(); lastPollAt = 0 }
