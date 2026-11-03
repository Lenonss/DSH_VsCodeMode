/**
 * 批量 Keep：一次完整快照 + 一次批量 RPC，单条基线问题只跳过自己，不再整批中止。
 * Undo 仍走 reviewBatch.ts 的逐条通道（写盘要逐项校验并在冲突处停止）。
 * @author ddj 2026年11月03号
 */
import type { KeepAllItem, KeepAllResult, ReviewItem, ReviewPage, ReviewResult } from '../shared/review.js'
import { loadPending } from './reviewBatch.js'

/** 批量 Keep 的 RPC 适配器；guard 在取快照前后各校验一次会话寿命。 */
export interface KeepAllPort {
  snapshot: () => Promise<ReviewPage>
  keepAll: (items: KeepAllItem[], batchId: string) => Promise<ReviewResult<{ result: KeepAllResult }>>
  guard: () => void
}

/**
 * @private
 * @author ddj 2026年11月03号
 * @description: 取一次完整待审快照；完整性校验失败时重取一次，避免瞬时漂移被当成不可恢复错误。
 * @param port 已鉴权的 RPC 适配器
 * @returns 冻结的批量目标
 * @throws 两次都取不到一致快照时抛出原始原因
 */
async function snapshotOnce(port: KeepAllPort): Promise<KeepAllItem[]> {
  try {
    return toItems(await loadPending(port))
  } catch {
    // 分页期间数量漂移多为瞬时：guard 仍有效就重新取一次，仍不一致才放弃
    port.guard()
    return toItems(await loadPending(port))
  }
}

/**
 * @private
 * @author ddj 2026年11月03号
 * @description: 把快照条目裁成批量目标，只带 host 需要的身份与版本线索。
 * @param items 完整待审集
 * @returns 批量目标
 */
function toItems(items: ReviewItem[]): KeepAllItem[] {
  return items.map((item) => ({ id: item.id, display: item.display, seq: item.seq, revision: item.revision }))
}

/**
 * @public
 * @author ddj 2026年11月03号
 * @description: 批量保留全部待审记录（Keep 不改写磁盘）。一次往返完成，跳过项只进 skipped，
 * 段级异常才写 error；guard 失效时保留已完成计数交给调用方呈现。
 * @param port 已鉴权的 RPC 适配器
 * @returns 与 BatchResult 同构的批量结果（含跳过明细）
 */
export async function runKeepAll(port: KeepAllPort): Promise<KeepAllResult> {
  const result: KeepAllResult = { completed: 0, total: 0, paths: [], skipped: [], error: '' }
  try {
    port.guard()
    const items = await snapshotOnce(port)
    result.total = items.length
    if (!items.length) return result

    port.guard()
    const reply = await port.keepAll(items, crypto.randomUUID())
    if (!reply.ok) {
      result.error = reply.error
      return result
    }
    return reply.result
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : String(cause)
    return result
  }
}
