/** Official bulk decisions use persisted metadata, never the visible history page. @author ddj 2026年10月27号 */
import type { ReviewDetail, ReviewItem, ReviewPage, ReviewResult } from '../shared/review.js'
import { PENDING_PREFIX } from '../shared/pendingReview.js'

export interface BatchPort {
  snapshot: () => Promise<ReviewPage>
  detail: (id: string) => Promise<ReviewDetail>
  decide: (detail: ReviewDetail, reject: boolean, operationId: string) => Promise<ReviewResult<{ revision: number }>>
  guard: () => void
  operation: (detail: ReviewDetail, reject: boolean) => string
}
export interface BatchResult { completed: number; total: number; paths: string[]; error: string }

/**
 * @public
 * @author ddj 2026年10月31号
 * @description: 取一次完整待审快照。分页计数只用于展示，批量写入必须一次取全，避免把页内数字当成总数。
 * @param port 已鉴权的 RPC 适配器
 * @returns 冻结的完整待审集；任何不一致都在首个写入前中止
 * @throws 快照重复、版本已变或数量不完整
 */
export async function loadPending(port: Pick<BatchPort, 'snapshot'>): Promise<ReviewItem[]> {
  const page = await port.snapshot()
  const seen = new Set<string>()
  for (const item of page.items) {
    if (seen.has(item.id) || !item.current || item.decision !== 'pending') throw new Error('待审快照发生重复或版本变化，请刷新后重试')
    seen.add(item.id)
  }
  if (page.nextCursor !== null || page.items.length !== page.pending) throw new Error('待审记录数量不完整，未执行批量操作')
  return page.items
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
      // 待审条目判定要在会话活跃的一端做：冷端能力位已关闭，这里给出比「版本变化」更准确的原因
      if (detail.capability.live === false && item.id.startsWith(PENDING_PREFIX)) {
        throw new Error(`${item.display}：待审条目需要在会话活跃的一端判定，请先在那一端处理或在本端打开该会话`)
      }
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
