import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDocStore, type SaveResult } from '../src/client/state/documentStore.js'

afterEach(() => vi.useRealTimers())

describe('document save owner', () => {
  it('saves the edited path regardless of active group changes', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async () => ({ ok: true, rev: '2' }))
    const store = createDocStore({ save })
    store.bind('a', { getValue: () => 'edited a' }, '1')
    store.bind('b', { getValue: () => 'b' }, '1')
    store.edit('a')
    await vi.advanceTimersByTimeAsync(700)
    expect(save).toHaveBeenCalledExactlyOnceWith({ path: 'a', content: 'edited a', rev: '1' })
    expect(store.state('a').dirty).toBe(false)
  })
  it('deduplicates concurrent saves and queues only changed content', async () => {
    vi.useFakeTimers()
    let complete!: (result: SaveResult) => void
    let text = 'one'
    const save = vi.fn(() => new Promise<SaveResult>((resolve) => { complete = resolve }))
    const store = createDocStore({ save })
    store.bind('a', { getValue: () => text })
    store.edit('a')
    const first = store.save('a')
    await Promise.resolve()
    text = 'two'
    store.edit('a')
    expect(store.save('a')).toBe(first)
    complete({ ok: true, rev: '2' })
    await first
    expect(store.state('a').dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(700)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[0]).toEqual({ path: 'a', content: 'two', rev: '2' })
    complete({ ok: true, rev: '3' })
    await store.state('a').saving
    expect(store.state('a').dirty).toBe(false)
  })
  it('does not clear dirty on edit-then-undo version changes during save', async () => {
    let complete!: (result: SaveResult) => void
    let version = 1
    const store = createDocStore({ save: () => new Promise<SaveResult>((resolve) => { complete = resolve }) })
    store.bind('a', { getValue: () => 'same', getVersionId: () => version })
    store.edit('a')
    const pending = store.save('a')
    await Promise.resolve()
    version = 3
    complete({ ok: true })
    await pending
    expect(store.state('a').dirty).toBe(true)
    store.dispose()
  })
  it('blocks automatic conflict saves but allows version-guarded manual attempt', async () => {
    const save = vi.fn(async () => ({ ok: false, conflict: true }))
    const store = createDocStore({ save })
    store.bind('a', { getValue: () => 'local' })
    store.baseline('a', 'old', true)
    store.edit('a')
    expect((await store.save('a')).conflict).toBe(true)
    expect(save).not.toHaveBeenCalled()
    await store.save('a', true)
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.state('a').dirty).toBe(true)
    expect(store.release('a')).toBe(false)
  })
  it('ignores completion for a replaced model', async () => {
    let complete!: (result: SaveResult) => void
    const saved = vi.fn()
    const store = createDocStore({ save: () => new Promise<SaveResult>((resolve) => { complete = resolve }), saved })
    store.bind('a', { getValue: () => 'first' })
    store.edit('a')
    const pending = store.save('a')
    await Promise.resolve()
    store.bind('a', { getValue: () => 'new buffer' })
    complete({ ok: true })
    await pending
    expect(saved).not.toHaveBeenCalled()
    expect(store.state('a').dirty).toBe(true)
    store.dispose()
  })
  it('retains dirty content on IO errors and cancels timers at disposal', async () => {
    vi.useFakeTimers()
    const save = vi.fn(async () => { throw new Error('offline') })
    const store = createDocStore({ save })
    store.bind('a', { getValue: () => 'keep' })
    store.edit('a')
    expect(store.unsafe()).toBe(true)
    await store.flush()
    expect(store.state('a').dirty).toBe(true)
    store.edit('a')
    store.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
