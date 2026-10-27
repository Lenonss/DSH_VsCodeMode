/** Official bulk decisions use persisted metadata, never the visible history page. @author ddj 2026年10月27号 */
import type { ReviewDetail, ReviewItem, ReviewPage, ReviewResult } from '../shared/review.js'

export interface BatchPort {
  list: (cursor?: number) => Promise<ReviewPage>
  detail: (id: string) => Promise<ReviewDetail>
  decide: (detail: ReviewDetail, reject: boolean, operationId: string) => Promise<ReviewResult<{ revision: number }>>
  guard: () => void
  operation: (detail: ReviewDetail, reject: boolean) => string
}
export interface BatchResult { completed: number; total: number; paths: string[]; error: string }

/** @public @author ddj 2026年10月27号 @param port Authenticated RPC adapter. @returns Frozen complete pending set; aborts before any decision if pagination shifts. @throws Incomplete or changing pages. */
export async function loadPending(port: Pick<BatchPort, 'list'>): Promise<ReviewItem[]> {
  const items: ReviewItem[] = []
  const seen = new Set<string>()
  const cursors = new Set<number>()
  let cursor: number | undefined
  let expected: number | undefined
  do {
    const page = await port.list(cursor)
    expected ??= page.pending
    if (page.pending !== expected) throw new Error('待审记录在分页期间变化，请刷新后重试')
    for (const item of page.items) {
      if (seen.has(item.id) || !item.current || item.decision !== 'pending') throw new Error('待审分页发生重复或版本变化，请刷新后重试')
      seen.add(item.id); items.push(item)
    }
    if (page.nextCursor === null) break
    if (cursors.has(page.nextCursor) || page.items.length === 0) throw new Error('待审分页未完整返回，请刷新后重试')
    cursor = page.nextCursor; cursors.add(cursor)
  } while (true)
  if (items.length !== expected) throw new Error('待审记录数量不完整，未执行批量操作')
  return items
}

/** @public @author ddj 2026年10月27号 @param port Guarded existing per-file decision adapter. @param reject Undo instead of Keep. @returns Precise partial result; Undo stops at first conflict, never claims atomic multi-file rollback. */
export async function runReviewBatch(port: BatchPort, reject: boolean): Promise<BatchResult> {
  const result: BatchResult = { completed: 0, total: 0, paths: [], error: '' }
  try {
    port.guard()
    const items = await loadPending(port)
    result.total = items.length
    const details: ReviewDetail[] = []
    // Preflight the entire frozen set before the first mutation. Disk CAS remains authoritative at execution.
    for (const item of items) {
      port.guard()
      const detail = await port.detail(item.id)
      if (!detail.item.current || detail.item.seq !== item.seq || detail.item.revision !== item.revision
        || !detail.capability.keep) throw new Error(`${item.display}：审查版本变化，请刷新后重试`)
      if (reject && !detail.capability.undo) throw new Error(`${item.display}：${detail.capability.reason}`)
      details.push(detail)
    }
    // Reverse chronological snapshots allow a newer round's result to expose the previous round's endpoint.
    details.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || right.item.seq - left.item.seq)
    for (const detail of details) {
      port.guard()
      const reply = await port.decide(detail, reject, port.operation(detail, reject))
      if (!reply.ok) throw new Error(`${detail.item.display}：${reply.error}`)
      result.completed++
      result.paths.push(detail.item.currentPath)
    }
  } catch (cause) { result.error = cause instanceof Error ? cause.message : String(cause) }
  return result
}
