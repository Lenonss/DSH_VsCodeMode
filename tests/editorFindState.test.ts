/** Workspace Ctrl+F bridge regression tests; ddj 2026年10月09号. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFindBridge, type FindSnapshot } from '../src/client/state/editorFindState.js'
import { createViewKeeper } from '../src/client/state/editorViewState.js'

/** @private @author ddj 2026年10月09号 @returns Native controller double; model resets mimic vendored Monaco options/scope changes. */
function makeFind() {
  const listeners = new Set<() => void>()
  const changes: { value: Record<string, unknown>; moveCursor: boolean }[] = []
  const state = {
    searchString: '', isRevealed: false, matchCase: false, wholeWord: false, isRegex: false,
    searchScope: null as unknown, matchesPosition: 0,
    change: vi.fn((value: Record<string, unknown>, moveCursor: boolean) => {
      changes.push({ value, moveCursor })
      Object.assign(state, value)
      for (const listener of listeners) listener()
    }),
    onFindReplaceStateChange: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
  }
  const controller = {
    getState: () => state,
    start: vi.fn((options: Record<string, unknown>, value: FindSnapshot & { searchScope: null }) => {
      state.change(value, false)
      return Promise.resolve()
    }),
  }
  return { state, controller, changes, listeners,
    editor: { getContribution: vi.fn(() => controller) } }
}

/** @private @author ddj 2026年10月09号 @param scope Unique workspace name. @returns Revealed search query with all user options on. */
function queryOf(scope: string): FindSnapshot {
  return { searchString: scope + '.*', isRevealed: true, matchCase: true, wholeWord: true, isRegex: true }
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } })
})
afterEach(() => vi.unstubAllGlobals())

describe('workspace Ctrl+F sharing', () => {
  it('shares query/options/open state across files and suppresses per-model reset events', () => {
    const fake = makeFind()
    const bridge = createFindBridge(fake.editor)
    bridge.resume('find-files')
    fake.state.change(queryOf('needle'), true)
    bridge.pause()
    fake.state.change({ matchCase: false, wholeWord: false, isRegex: false, searchScope: null }, false)
    bridge.resume('find-files')
    expect(fake.state).toMatchObject(queryOf('needle'))
    expect(fake.controller.start).toHaveBeenCalledTimes(1)
    bridge.dispose()
  })

  it('remount in same workspace restores the latest query without selection seeding or focus', () => {
    const old = makeFind()
    const first = createFindBridge(old.editor)
    first.resume('find-remount')
    old.state.change(queryOf('shared'), true)
    first.dispose()
    const next = makeFind()
    const second = createFindBridge(next.editor)
    second.resume('find-remount')
    expect(next.state).toMatchObject(queryOf('shared'))
    expect(next.controller.start.mock.calls[0][0]).toMatchObject({
      shouldFocus: 0, seedSearchStringFromSelection: 'none',
      seedSearchStringFromNonEmptySelection: false, seedSearchStringFromGlobalClipboard: false,
      updateSearchScope: false, shouldAnimate: false,
    })
    expect(next.changes.every(change => change.moveCursor === false)).toBe(true)
    second.dispose()
  })

  it('closed find stays closed across files; clearing the query is shared too', () => {
    const fake = makeFind()
    const bridge = createFindBridge(fake.editor)
    bridge.resume('find-closed')
    fake.state.change(queryOf('old'), true)
    fake.state.change({ searchString: '', isRevealed: false }, false)
    bridge.pause()
    fake.state.change(queryOf('stale'), false)
    bridge.resume('find-closed')
    expect(fake.state.searchString).toBe('')
    expect(fake.state.isRevealed).toBe(false)
    expect(fake.controller.start).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('revealed empty query is not seeded from a file selection', () => {
    const fake = makeFind()
    const bridge = createFindBridge(fake.editor)
    bridge.resume('find-empty')
    fake.state.change({ isRevealed: true, searchString: '' }, true)
    bridge.pause()
    bridge.resume('find-empty')
    expect(fake.controller.start.mock.calls[0][1].searchString).toBe('')
    expect(fake.state.isRevealed).toBe(true)
    bridge.dispose()
  })

  it('does not share selected search ranges or match indexes', () => {
    const fake = makeFind()
    const bridge = createFindBridge(fake.editor)
    bridge.resume('find-range')
    fake.state.change({ ...queryOf('scope'), searchScope: [{ startLineNumber: 1 }], matchesPosition: 9 }, true)
    bridge.pause()
    fake.state.change({ searchScope: null, matchesPosition: 0 }, false)
    bridge.resume('find-range')
    expect(fake.state.searchScope).toBeNull()
    const restored = fake.controller.start.mock.calls[0][1]
    expect(restored).not.toHaveProperty('matchesPosition')
    expect(restored).not.toHaveProperty('replaceString')
    bridge.dispose()
  })

  it('different workspaces isolate queries even for identical file paths', () => {
    const fake = makeFind()
    const bridge = createFindBridge(fake.editor)
    bridge.resume('find-first')
    fake.state.change(queryOf('first'), true)
    bridge.pause()
    bridge.resume('find-second')
    expect(fake.state).toMatchObject({ searchString: '', isRevealed: false, matchCase: false })
    fake.state.change(queryOf('second'), true)
    bridge.pause()
    bridge.resume('find-first')
    expect(fake.state).toMatchObject(queryOf('first'))
    bridge.dispose()
  })

  it('dispose unregisters listener exactly once and later events cannot rewrite cache', () => {
    const fake = makeFind()
    const bridge = createFindBridge(fake.editor)
    bridge.resume('find-dispose')
    fake.state.change(queryOf('saved'), true)
    bridge.dispose()
    bridge.dispose()
    expect(fake.listeners.size).toBe(0)
    fake.state.change(queryOf('after-dispose'), true)
    bridge.pause()
    bridge.resume('find-dispose')
    const next = makeFind()
    const fresh = createFindBridge(next.editor)
    fresh.resume('find-dispose')
    expect(next.state).toMatchObject(queryOf('saved'))
    fresh.dispose()
  })

  it('missing/unsupported find contribution degrades to native editing', () => {
    for (const value of [null, {}, { getState: () => ({}) }]) {
      const editor = { getContribution: () => value }
      const bridge = createFindBridge(editor)
      expect(() => { bridge.resume('unsupported'); bridge.pause(); bridge.dispose() }).not.toThrow()
    }
    const bridge = createFindBridge({ getContribution: () => { throw new Error('missing') } })
    expect(() => bridge.dispose()).not.toThrow()
  })

  it('listener registration, capture and teardown incompatibilities stay isolated from view lifecycle', () => {
    const fake = makeFind()
    fake.controller.getState = () => { throw new Error('late disposal') }
    const bridge = createFindBridge(fake.editor)
    expect(() => { bridge.resume('find-incompatible'); bridge.pause(); bridge.dispose() }).not.toThrow()
    const broken = makeFind()
    broken.state.onFindReplaceStateChange = () => { throw new Error('registration failed') }
    const unobserved = createFindBridge(broken.editor)
    expect(() => { unobserved.resume('find-registration'); unobserved.dispose() }).not.toThrow()
    const cleanup = makeFind()
    cleanup.state.onFindReplaceStateChange = () => ({ dispose: () => { throw new Error('native teardown') } }) as never
    const ending = createFindBridge(cleanup.editor)
    ending.resume('find-teardown')
    cleanup.controller.getState = () => { throw new Error('late disposal') }
    expect(() => ending.dispose()).not.toThrow()
  })

  it('find API throws/rejects do not break the editor lifecycle', async () => {
    const fake = makeFind()
    const bridge = createFindBridge(fake.editor)
    bridge.resume('find-errors')
    fake.state.change(queryOf('error'), true)
    bridge.pause()
    fake.controller.start.mockImplementationOnce(() => { throw new Error('unsupported') })
    expect(() => bridge.resume('find-errors')).not.toThrow()
    bridge.pause()
    fake.controller.start.mockRejectedValueOnce(new Error('disposed'))
    expect(() => bridge.resume('find-errors')).not.toThrow()
    await Promise.resolve()
    bridge.dispose()
  })

  it('integrated setModel keeps view restore ahead of find restore; rerenders do not reapply', () => {
    const fake = makeFind()
    let model: unknown = null
    const order: string[] = []
    const view = { viewState: { scrollTop: 2900 }, cursorState: [] }
    const editor = {
      ...fake.editor, getModel: () => model,
      setModel: (next: unknown) => {
        order.push('model'); model = next
        fake.state.change({ matchCase: false, wholeWord: false, isRegex: false, searchScope: null }, false)
      },
      saveViewState: () => view,
      restoreViewState: () => { order.push('view') }, dispose: vi.fn(),
    }
    const keeper = createViewKeeper(editor)
    const a = {}; const b = {}
    keeper.bind('find-integrated', 'a.ts', a)
    fake.state.change(queryOf('integrated'), true)
    keeper.bind('find-integrated', 'b.ts', b)
    keeper.bind('find-integrated', 'a.ts', a)
    expect(order.slice(-2)).toEqual(['model', 'view'])
    expect(fake.state).toMatchObject(queryOf('integrated'))
    const count = fake.controller.start.mock.calls.length
    keeper.bind('find-integrated', 'a.ts', a)
    expect(fake.controller.start).toHaveBeenCalledTimes(count)
    keeper.dispose()
    expect(fake.listeners.size).toBe(0)
  })
})
