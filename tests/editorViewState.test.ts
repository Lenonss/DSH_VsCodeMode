/** Model-owned editor lifecycle regression tests; ddj 2026年10月09号. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createViewKeeper } from '../src/client/state/editorViewState.js'
import { viewStatesLoad, viewStatesSave } from '../src/client/state/viewStateCache.js'

/** @private @author ddj 2026年10月09号 @param top Scroll position. @returns View with unchanged cursor, selection and fold data. */
function viewOf(top: number) {
  return { cursorState: [{ position: { lineNumber: 1, column: 1 }, selectionStart: { lineNumber: 1, column: 1 } }],
    viewState: { scrollTop: top, scrollLeft: 12 }, contributionsState: { folding: { collapsed: [8] } } }
}

/** @private @author ddj 2026年10月09号 @returns Editor double recording actual disposal order and per-model resets. */
function makeEditor() {
  let model: unknown = null
  let state = viewOf(0)
  const events: string[] = []
  const editor = {
    getContribution: vi.fn(() => null),
    getModel: vi.fn(() => model),
    setModel: vi.fn((next: unknown) => { model = next; state = viewOf(0) }),
    saveViewState: vi.fn(() => { events.push('save'); return state }),
    restoreViewState: vi.fn((next: ReturnType<typeof viewOf>) => { events.push('restore'); state = next }),
    dispose: vi.fn(() => { events.push('dispose'); model = null }),
  }
  return { editor, events, scroll: (top: number) => { state = viewOf(top) }, current: () => state }
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } })
})
afterEach(() => vi.unstubAllGlobals())

describe('editor view lifecycle', () => {
  it('ref detach saves scroll-only changes before dispose; later effect cleanup is idempotent', () => {
    const fake = makeEditor()
    const keeper = createViewKeeper(fake.editor)
    keeper.bind('ws', 'a.ts', {})
    fake.scroll(1800) // Cursor stays at line one, only the viewport changes.
    keeper.dispose()
    keeper.dispose()
    keeper.save()
    expect(fake.events).toEqual(['save', 'dispose'])
    expect(fake.editor.dispose).toHaveBeenCalledTimes(1)
    expect(viewStatesLoad('ws')['a.ts']).toEqual(viewOf(1800))
  })

  it('same-workspace conversation remount restores full view on the retained model', () => {
    const model = {}
    const old = makeEditor()
    const first = createViewKeeper(old.editor)
    first.bind('same-cwd', 'a.ts', model)
    old.scroll(2700)
    first.dispose()
    const next = makeEditor()
    createViewKeeper(next.editor).bind('same-cwd', 'a.ts', model)
    expect(next.current()).toEqual(viewOf(2700))
    expect(next.editor.restoreViewState).toHaveBeenCalledTimes(1)
  })

  it('A → B → A preserves independent file positions without consuming saved cache', () => {
    const fake = makeEditor()
    const keeper = createViewKeeper(fake.editor)
    const a = {}; const b = {}
    keeper.bind('ws', 'a.ts', a)
    fake.scroll(1200)
    keeper.bind('ws', 'b.ts', b)
    fake.scroll(3400)
    keeper.bind('ws', 'a.ts', a)
    expect(fake.current().viewState.scrollTop).toBe(1200)
    expect(viewStatesLoad('ws')['b.ts']).toEqual(viewOf(3400))
    keeper.bind('ws', 'b.ts', b)
    expect(fake.current().viewState.scrollTop).toBe(3400)
  })

  it('ordinary rerender/content effect does not replay an old position or override explicit navigation', () => {
    viewStatesSave('ws', { 'a.ts': viewOf(1200) })
    const fake = makeEditor()
    const keeper = createViewKeeper(fake.editor)
    const model = {}
    keeper.bind('ws', 'a.ts', model)
    fake.scroll(4200) // An explicit reveal/line jump after model restoration wins.
    keeper.bind('ws', 'a.ts', model)
    keeper.bind('ws', 'a.ts', model)
    expect(fake.current().viewState.scrollTop).toBe(4200)
    expect(fake.editor.restoreViewState).toHaveBeenCalledTimes(1)
  })

  it('pending active path cannot write old model state under the new file', () => {
    const fake = makeEditor()
    const keeper = createViewKeeper(fake.editor)
    keeper.bind('old-ws', 'old.ts', {})
    fake.scroll(1900)
    keeper.save('new.ts')
    expect(viewStatesLoad('old-ws')).toEqual({})
    keeper.save()
    expect(viewStatesLoad('old-ws')).toEqual({ 'old.ts': viewOf(1900) })
  })

  it('workspace change with same path writes to previous scope and restores only the new scope', () => {
    viewStatesSave('second', { 'a.ts': viewOf(2100) })
    const fake = makeEditor()
    const keeper = createViewKeeper(fake.editor)
    keeper.bind('first', 'a.ts', {})
    fake.scroll(700)
    keeper.bind('second', 'a.ts', {})
    expect(viewStatesLoad('first')['a.ts']).toEqual(viewOf(700))
    expect(fake.current()).toEqual(viewOf(2100))
  })

  it('missing or externally replaced model cannot overwrite a valid snapshot', () => {
    viewStatesSave('ws', { 'a.ts': viewOf(1700) })
    const fake = makeEditor()
    const keeper = createViewKeeper(fake.editor)
    keeper.bind('ws', 'a.ts', {})
    fake.editor.setModel(null)
    keeper.save()
    keeper.dispose()
    expect(viewStatesLoad('ws')['a.ts']).toEqual(viewOf(1700))
  })

  it('invalid view snapshot and empty bind are ignored', () => {
    viewStatesSave('ws', { 'a.ts': viewOf(1700) })
    const fake = makeEditor()
    const keeper = createViewKeeper(fake.editor)
    keeper.bind('ws', '', {})
    keeper.bind('ws', 'a.ts', null)
    expect(fake.editor.setModel).not.toHaveBeenCalled()
    keeper.bind('ws', 'a.ts', {})
    fake.editor.saveViewState.mockReturnValueOnce(null as never)
    keeper.save()
    expect(viewStatesLoad('ws')['a.ts']).toEqual(viewOf(1700))
  })

  it('save merges latest cache rather than replacing other files with a stale local map', () => {
    const fake = makeEditor()
    const keeper = createViewKeeper(fake.editor)
    keeper.bind('ws', 'a.ts', {})
    viewStatesSave('ws', { 'other.ts': viewOf(2600) })
    fake.scroll(1400)
    keeper.save()
    expect(Object.keys(viewStatesLoad('ws'))).toEqual(['other.ts', 'a.ts'])
  })

  it('invalid fold restoration degrades gracefully and editor stays disposable', () => {
    viewStatesSave('ws', { 'a.ts': viewOf(1700) })
    const fake = makeEditor()
    fake.editor.restoreViewState.mockImplementationOnce(() => { throw new Error('stale fold') })
    const keeper = createViewKeeper(fake.editor)
    expect(() => keeper.bind('ws', 'a.ts', {})).not.toThrow()
    expect(() => keeper.dispose()).not.toThrow()
    expect(fake.editor.dispose).toHaveBeenCalledTimes(1)
  })

  it('preview/editor recreation restores the most recently captured position', () => {
    const model = {}
    for (const top of [1300, 2400, 3500]) {
      const fake = makeEditor()
      const keeper = createViewKeeper(fake.editor)
      keeper.bind('ws', 'a.md', model)
      fake.scroll(top)
      keeper.dispose()
    }
    const final = makeEditor()
    createViewKeeper(final.editor).bind('ws', 'a.md', model)
    expect(final.current()).toEqual(viewOf(3500))
  })
})
