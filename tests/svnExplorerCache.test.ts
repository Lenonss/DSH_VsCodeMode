/** Deterministic queue/subtree regression; no whole-suite execution. @author ddj 2026年10月10号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExplorerIndex, ExplorerQueue, explorerKey, scanRootsOf } from '../src/svnExplorerCache.js'
import type { ExplorerScan } from '../src/svnExplorerCache.js'
import type { SvnChangeEntry, SvnItemStatus } from '../src/shared/svn.js'

/** @private @author ddj 2026年10月10号 @param path Entry path. @param status Local status. @returns Authoritative fixture. */
function entry(path: string, status: SvnItemStatus = 'normal'): SvnChangeEntry {
  return { path, status, versioned: status !== 'ignored' && status !== 'unversioned', props: 'none' }
}
/** @private @author ddj 2026年10月10号 @param entries Entries. @returns Complete result. */
function result(entries: SvnChangeEntry[]): ExplorerScan { return { entries, truncated: false } }
/** @private @author ddj 2026年10月10号 @returns Controllable in-flight scan. */
function deferred() {
  let resolve!: (value: ExplorerScan) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ExplorerScan>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000) })
afterEach(() => { vi.useRealTimers() })

describe('incremental subtree index', () => {
  it('uses segment-bound case-normalized subtree roots and merges parents', () => {
    expect(explorerKey('Assets\\Scripts/A.cs', true)).toBe('assets/scripts/a.cs')
    expect(scanRootsOf(['a/b/c', 'a/x', 'a/b/d', 'ab/x'], false)).toEqual(['a', 'ab'])
    expect(scanRootsOf(['root.cs', 'a/b'], false)).toEqual([''])
  })
  it('decrements strongest contribution and removes last dirty descendant', () => {
    const index = new ExplorerIndex(false)
    index.replace([''], result([entry('a'), entry('a/b'), entry('a/b/x', 'conflicted'), entry('a/y', 'modified')]))
    expect(index.mark('a', true).mark?.kind).toBe('conflict')
    index.replace(['a/b'], result([entry('a/b'), entry('a/b/x')]))
    expect(index.mark('a', true)).toMatchObject({ count: 1, mark: { kind: 'modified' } })
    index.replace(['a'], result([entry('a'), entry('a/b'), entry('a/b/x'), entry('a/y')]))
    expect(index.mark('a', true)).toMatchObject({ count: 0, mark: { kind: 'clean' } })
  })
  it('subtree replacement deletes vanished paths, preserves siblings and accepts rename endpoints', () => {
    const index = new ExplorerIndex(false)
    index.replace([''], result([entry('a/old', 'modified'), entry('ab/sibling', 'conflicted')]))
    index.replace(['a'], result([entry('a/new', 'added')]))
    expect(index.mark('a/old', false).mark).toBeNull()
    expect(index.mark('a/new', false).mark?.kind).toBe('added')
    expect(index.mark('ab/sibling', false).mark?.kind).toBe('conflict')
  })
  it('ignored/unversioned ancestors and properties preserve existing icon semantics', () => {
    const index = new ExplorerIndex(true)
    index.replace([''], result([entry('Cache', 'ignored'), entry('New', 'unversioned'), { ...entry('A/X'), props: 'conflicted' }]))
    expect(index.mark('CACHE/f', false).mark?.kind).toBe('ignored')
    expect(index.mark('new/f', false).mark?.kind).toBe('unversioned')
    expect(index.mark('a', true).mark?.kind).toBe('conflict')
  })
  it('rejects incomplete partial replace before deleting trusted data', () => {
    const index = new ExplorerIndex(false)
    index.replace([''], result([entry('a/x', 'modified')]))
    expect(() => index.replace(['a'], { entries: [], truncated: true })).toThrow('全量校准')
    expect(index.mark('a/x', false).mark?.kind).toBe('modified')
  })
})

describe('single-flight generation queue', () => {
  it('coalesces repeated events, projects unaffected rows and follows in-flight changes', async () => {
    const first = deferred(), second = deferred(), third = deferred()
    const scan = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
    const queue = new ExplorerQueue(scan, Date.now, false)
    const start = queue.initial()
    first.resolve(result([entry('a'), entry('a/x'), entry('b/y')]))
    await start
    queue.invalidate({ paths: ['a/x'], event: 'one' })
    queue.invalidate({ paths: ['a/x'], event: 'one' })
    expect(queue.stale('a/x', false)).toBe(true)
    expect(queue.stale('b/y', false)).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(scan).toHaveBeenCalledTimes(2)
    queue.invalidate({ paths: ['a/x'], event: 'two' })
    second.resolve(result([entry('a'), entry('a/x', 'modified')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.state().complete).toBe(false)
    expect(queue.stale('a/x', false)).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(scan).toHaveBeenCalledTimes(3)
    expect(scan.mock.calls[2][0]).toEqual(['a'])
    third.resolve(result([entry('a'), entry('a/x')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.state()).toMatchObject({ complete: true, observedGeneration: 3, revision: 3 })
    expect(queue.data.mark('a/x', false).mark?.kind).toBe('clean')
    queue.dispose()
  })
  it('starts within max wait despite continued events and never runs parallel scans', async () => {
    const active = deferred()
    const scan = vi.fn().mockResolvedValueOnce(result([entry('a/x')])).mockReturnValue(active.promise)
    const queue = new ExplorerQueue(scan, Date.now, false)
    await queue.initial()
    for (let i = 0; i < 10; i++) { queue.invalidate({ paths: ['a/x'], event: String(i) }); await vi.advanceTimersByTimeAsync(100) }
    expect(scan).toHaveBeenCalledTimes(2)
    for (let i = 10; i < 100; i++) queue.invalidate({ paths: ['a/x'], event: String(i) })
    await vi.advanceTimersByTimeAsync(1000)
    expect(scan).toHaveBeenCalledTimes(2)
    active.resolve(result([entry('a/x')]))
    await vi.advanceTimersByTimeAsync(0)
    expect(scan).toHaveBeenCalledTimes(3)
    expect(queue.state().complete).toBe(true)
    queue.dispose()
  })
  it('falls back to full scan for too many subtrees or paths', async () => {
    const scan = vi.fn().mockResolvedValue(result([entry('a/x')]))
    const queue = new ExplorerQueue(scan, Date.now, false)
    await queue.initial()
    queue.invalidate({ paths: Array.from({ length: 33 }, (_, i) => 'dir' + i + '/x') })
    await vi.advanceTimersByTimeAsync(300)
    expect(scan.mock.calls[1][0]).toEqual([''])
    queue.dispose()
  })
  it('rejects false freshness after failure and retries only on explicit later invalidation', async () => {
    const scan = vi.fn().mockResolvedValueOnce(result([entry('a/x')])).mockRejectedValueOnce(new Error('offline'))
    const queue = new ExplorerQueue(scan, Date.now, false)
    await queue.initial()
    queue.invalidate({ paths: ['a/x'] })
    await vi.advanceTimersByTimeAsync(300)
    expect(queue.state()).toMatchObject({ complete: false, refreshing: false, error: 'Error: offline' })
    expect(queue.stale('a/x', false)).toBe(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect(scan).toHaveBeenCalledTimes(2)
    queue.dispose()
  })
  it('disposes owned timers/process signal and cannot publish late completion', async () => {
    const active = deferred()
    const scan = vi.fn().mockReturnValue(active.promise)
    const queue = new ExplorerQueue(scan, Date.now, false)
    const start = queue.initial()
    expect(scan.mock.calls[0][1].aborted).toBe(false)
    queue.dispose()
    expect(scan.mock.calls[0][1].aborted).toBe(true)
    active.resolve(result([entry('a/x')]))
    await start
    expect(queue.state().revision).toBe(0)
    expect(queue.data.index.entries.size).toBe(0)
  })
})
