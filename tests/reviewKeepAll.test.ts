import { describe, expect, it, vi } from 'vitest'
import { runKeepAll, type KeepAllPort } from '../src/client/reviewKeepAll.js'
import type { KeepAllResult, ReviewItem, ReviewPage } from '../src/shared/review.js'

/** @private @author ddj 2026年11月03号 @param index 条目序号 @returns 最小待审条目夹具 */
function item(index: number): ReviewItem {
  return { id: String(index), current: true, decision: 'pending', revision: 1, seq: index, display: `file${index}`, currentPath: `/file${index}` } as ReviewItem
}

/** @private @author ddj 2026年11月03号 @param page 快照 @param result 批量回复 @returns 只记录调用的适配器 */
function fixture(page: ReviewPage, result: KeepAllResult): KeepAllPort {
  return {
    snapshot: vi.fn(async () => page),
    keepAll: vi.fn(async () => ({ ok: true as const, result })),
    guard: vi.fn(),
  }
}

/** @private @author ddj 2026年11月03号 @param count 条目数 @returns 完整快照 */
function pageOf(count = 51): ReviewPage {
  return { items: Array.from({ length: count }, (_, index) => item(index)), pending: count, nextCursor: null, gaps: [] }
}

/** @private @author ddj 2026年11月03号 @param total 目标数 @returns 全成功的批量结果 */
function kept(total: number): KeepAllResult {
  return { completed: total, total, paths: [], skipped: [], error: '' }
}

describe('workspace Keep All', () => {
  it('freezes one complete snapshot and finishes the whole batch in a single RPC', async () => {
    const page = pageOf(107)
    const port = fixture(page, kept(107))
    const result = await runKeepAll(port)
    expect(result).toMatchObject({ completed: 107, total: 107, error: '' })
    expect(port.snapshot).toHaveBeenCalledTimes(1)
    expect(port.keepAll).toHaveBeenCalledTimes(1)
    const [items] = vi.mocked(port.keepAll).mock.calls[0]
    expect(items).toHaveLength(107)
    expect(items[0]).toEqual({ id: '0', display: 'file0', seq: 0, revision: 1 })
  })

  it('retries the snapshot once when paging drifted, then keeps the batch going', async () => {
    const port = fixture(pageOf(2), kept(2))
    vi.mocked(port.snapshot).mockResolvedValueOnce({ items: [item(0)], pending: 2, nextCursor: 50, gaps: [] })
    expect(await runKeepAll(port)).toMatchObject({ completed: 2, total: 2, error: '' })
    expect(port.snapshot).toHaveBeenCalledTimes(2)
    expect(port.keepAll).toHaveBeenCalledTimes(1)
  })

  it('reports the snapshot reason when even the retry stays inconsistent', async () => {
    const port = fixture(pageOf(2), kept(2))
    vi.mocked(port.snapshot).mockResolvedValue({ items: [item(0), item(0)], pending: 2, nextCursor: null, gaps: [] })
    const result = await runKeepAll(port)
    expect(result.error).toContain('重复')
    expect(port.keepAll).not.toHaveBeenCalled()
  })

  it('checks the guard before touching any record', async () => {
    const port = fixture(pageOf(3), kept(3))
    port.guard = () => { throw new Error('编辑器或会话已切换，批量操作已停止') }
    expect(await runKeepAll(port)).toMatchObject({ completed: 0, error: '编辑器或会话已切换，批量操作已停止' })
    expect(port.snapshot).not.toHaveBeenCalled()
  })

  it('keeps skipped baselines as data, never as a batch-level failure', async () => {
    const skipped = [{ id: '2', display: 'file2', reason: '审查版本冲突，请刷新后重试' }]
    const port = fixture(pageOf(3), { completed: 2, total: 3, paths: ['/file0', '/file1'], skipped, error: '' })
    const result = await runKeepAll(port)
    expect(result.error).toBe('')
    expect(result.completed).toBe(2)
    expect(result.skipped).toEqual(skipped)
  })

  it('surfaces a host-level refusal as the batch error', async () => {
    const port = fixture(pageOf(2), kept(2))
    port.keepAll = vi.fn(async () => ({ ok: false as const, error: '待审记录过多（2001 条，上限 2000），请先分批处理后重试' }))
    expect(await runKeepAll(port)).toMatchObject({ completed: 0, total: 2, error: '待审记录过多（2001 条，上限 2000），请先分批处理后重试' })
  })

  it('does nothing when the workspace has no pending records', async () => {
    const port = fixture(pageOf(0), kept(0))
    expect(await runKeepAll(port)).toMatchObject({ completed: 0, total: 0, error: '' })
    expect(port.keepAll).not.toHaveBeenCalled()
  })
})
