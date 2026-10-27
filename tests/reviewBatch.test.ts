import { describe, expect, it, vi } from 'vitest'
import { loadPending, runReviewBatch, type BatchPort } from '../src/client/reviewBatch.js'
import type { ReviewDetail, ReviewItem } from '../src/shared/review.js'

/** @private @author ddj 2026年10月27号 @param index Record identity. @returns Minimal persisted metadata fixture. */
function item(index: number): ReviewItem {
  return { id: String(index), current: true, decision: 'pending', revision: 1, seq: index, display: `file${index}`, currentPath: `/file${index}` } as ReviewItem
}
/** @private @author ddj 2026年10月27号 @param count Pending records. @returns Isolated adapter with 50-row paging and guarded decisions. */
function fixture(count = 51): BatchPort {
  const items = Array.from({ length: count }, (_, index) => item(index))
  return {
    list: vi.fn(async (cursor = 0) => ({ items: items.slice(cursor, cursor + 50), pending: count, nextCursor: cursor + 50 < count ? cursor + 50 : null, gaps: [] })),
    detail: vi.fn(async (id) => ({ item: items[Number(id)], capability: { keep: true, undo: true }, capturedAt: '2026-10-27' } as ReviewDetail)),
    decide: vi.fn(async () => ({ ok: true, revision: 2 })), guard: vi.fn(), operation: vi.fn((detail) => `op-${detail.item.id}`),
  }
}
describe('workspace official bulk actions', () => {
  it('loads every page and decides all records, not only visible 50', async () => {
    const port = fixture(107)
    const result = await runReviewBatch(port, false)
    expect(result).toMatchObject({ completed: 107, total: 107, error: '' })
    expect(port.list).toHaveBeenCalledTimes(3)
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
  it('rejects shifted pagination and duplicate records without decisions', async () => {
    const port = fixture(51)
    port.list = vi.fn().mockResolvedValueOnce({ items: Array.from({ length: 50 }, (_, index) => item(index)), pending: 51, nextCursor: 50 })
      .mockResolvedValueOnce({ items: [item(0)], pending: 51, nextCursor: null })
    await expect(loadPending(port)).rejects.toThrow('重复')
    expect(port.decide).not.toHaveBeenCalled()
  })
  it('dirty buffer or expired session guard prevents all writes', async () => {
    const port = fixture()
    port.guard = () => { throw new Error('未保存文件') }
    expect(await runReviewBatch(port, true)).toMatchObject({ completed: 0, error: '未保存文件' })
    expect(port.list).not.toHaveBeenCalled()
  })
  it('checks the guard again after each awaited decision', async () => {
    const port = fixture(2)
    let expired = false
    port.guard = () => { if (expired) throw new Error('会话已切换') }
    port.decide = vi.fn(async () => { expired = true; return { ok: true, revision: 2 } })
    expect(await runReviewBatch(port, true)).toMatchObject({ completed: 1, error: '会话已切换' })
  })
})
