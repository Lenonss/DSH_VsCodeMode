import { describe, expect, it, vi } from 'vitest'
import { loadPending, runReviewBatch, type BatchPort } from '../src/client/reviewBatch.js'
import type { ReviewDetail, ReviewItem, ReviewPage } from '../src/shared/review.js'

/** @private @author ddj 2026年10月31号 @param index Record identity. @returns Minimal persisted metadata fixture. */
function item(index: number): ReviewItem {
  return { id: String(index), current: true, decision: 'pending', revision: 1, seq: index, display: `file${index}`, currentPath: `/file${index}` } as ReviewItem
}
/** @private @author ddj 2026年10月31号 @param count Pending records. @returns Adapter answering one complete snapshot. */
function fixture(count = 51): BatchPort {
  const items = Array.from({ length: count }, (_, index) => item(index))
  return {
    snapshot: vi.fn(async () => ({ items, pending: count, nextCursor: null, gaps: [] })),
    detail: vi.fn(async (id) => ({ item: items[Number(id)], capability: { keep: true, undo: true }, capturedAt: '2026-10-27' } as ReviewDetail)),
    decide: vi.fn(async () => ({ ok: true, revision: 2 })), guard: vi.fn(), operation: vi.fn((detail) => `op-${detail.item.id}`),
  }
}
/** @private @author ddj 2026年10月31号 @param page Snapshot the host should answer with. @returns Adapter with a fixed snapshot. */
function snapshotOf(page: ReviewPage): BatchPort {
  return { ...fixture(), snapshot: vi.fn(async () => page) }
}
describe('workspace official bulk actions', () => {
  it('freezes the complete snapshot once and decides every record, not only visible 50', async () => {
    const port = fixture(107)
    const result = await runReviewBatch(port, false)
    expect(result).toMatchObject({ completed: 107, total: 107, error: '' })
    expect(port.snapshot).toHaveBeenCalledTimes(1)
    expect(port.decide).toHaveBeenCalledTimes(107)
  })
  it('preflights every Undo capability before writing any file', async () => {
    const port = fixture(2)
    port.detail = vi.fn(async (id) => ({ item: item(Number(id)), capturedAt: '', capability: { keep: true, undo: id !== '1', reason: '缺少原始字节' } } as ReviewDetail))
    expect(await runReviewBatch(port, true)).toMatchObject({ completed: 0, error: 'file1：缺少原始字节' })
    expect(port.decide).not.toHaveBeenCalled()
  })
  it('stops on conflict and reports exact partial completion without marking the rest', async () => {
    const port = fixture(3)
    port.decide = vi.fn().mockResolvedValueOnce({ ok: true, revision: 2 }).mockResolvedValueOnce({ ok: false, error: 'CAS conflict' })
    const result = await runReviewBatch(port, true)
    expect(result.completed).toBe(1)
    expect(result.paths).toEqual(['/file2'])
    expect(result.error).toContain('CAS conflict')
    expect(port.decide).toHaveBeenCalledTimes(2)
  })
  it('rejects duplicate, half-paged or already settled snapshots before any decision', async () => {
    await expect(loadPending(snapshotOf({ items: [item(0), item(0)], pending: 2, nextCursor: null, gaps: [] }))).rejects.toThrow('重复')
    await expect(loadPending(snapshotOf({ items: [item(0)], pending: 2, nextCursor: 50, gaps: [] }))).rejects.toThrow('数量不完整')
    await expect(loadPending(snapshotOf({ items: [{ ...item(0), decision: 'accepted' }], pending: 1, nextCursor: null, gaps: [] }))).rejects.toThrow('重复或版本变化')
  })
  it('dirty buffer or expired session guard prevents all writes', async () => {
    const port = fixture()
    port.guard = () => { throw new Error('未保存文件') }
    expect(await runReviewBatch(port, true)).toMatchObject({ completed: 0, error: '未保存文件' })
    expect(port.snapshot).not.toHaveBeenCalled()
  })
  it('checks the guard again after each awaited decision', async () => {
    const port = fixture(2)
    let expired = false
    port.guard = () => { if (expired) throw new Error('会话已切换') }
    port.decide = vi.fn(async () => { expired = true; return { ok: true, revision: 2 } })
    expect(await runReviewBatch(port, true)).toMatchObject({ completed: 1, error: '会话已切换' })
  })
})
