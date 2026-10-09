import { afterEach, describe, expect, it, vi } from 'vitest'

const effects = vi.hoisted(() => [] as Array<() => void | (() => void)>)
vi.mock('react', () => ({ default: {
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => void) => { effects.push(effect) },
  createElement: () => null,
} }))
vi.mock('../src/client/ui/EditorView.js', () => ({ EditorView: () => null }))
import { OfficialSideTab } from '../src/client/ui/OfficialSideTab.js'
import { isEditorTabActive, markEditorActive, markEditorMounted } from '../src/client/officialSidebar.js'

afterEach(() => { effects.length = 0; markEditorActive(false); vi.unstubAllGlobals() })

/**
 * Exercise the component's actual mount and deferred cleanup effects without Monaco.
 * @author ddj 2026年09月28号
 * @param props Current session reader or legacy snapshot sources.
 * @returns Deferred cleanup decision.
 */
function mount(props: Record<string, unknown>) {
  const scheduled: Array<() => void> = []
  OfficialSideTab({ sessionId: 'session-a', schedule: (fn: () => void) => scheduled.push(fn), ...props })
  const cleanup = effects[0]()
  expect(isEditorTabActive()).toBe(true)
  if (typeof cleanup === 'function') cleanup()
  return () => scheduled.forEach((decide) => decide())
}

describe('OfficialSideTab actual cleanup lifecycle', () => {
  it('propagates explicit Markdown preview while preserving line navigation', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    OfficialSideTab({ sessionId: 's', useTabInfo: () => ({ tab: { navigation: { revision: 1, params: { openPath: 'plans/a.md', preview: true, line: 10 } } } }) })
    effects[1]()
    expect(dispatchEvent.mock.calls[0][0].detail).toEqual({ path: 'plans/a.md', focusDiff: false, line: 10, preview: true })
  })

  it('clears activity when the same session closes the tab', () => {
    const finish = mount({ readSessionScope: () => ({ sessionId: 'session-a' }) })
    finish()
    expect(isEditorTabActive()).toBe(false)
  })

  it('preserves activity on a session switch using the injected current reader', () => {
    let sessionId = 'session-a'
    const finish = mount({ readSessionScope: () => ({ sessionId }), sessions: { list: { getSnapshot: () => ({ current: 'session-a' }) } } })
    sessionId = 'session-b'
    finish()
    expect(isEditorTabActive()).toBe(true)
  })

  it('falls back to retained mainView for newer snapshots without current', () => {
    const finish = mount({ sessions: { list: { getSnapshot: () => ({ byId: { 'session-b': { retainedBy: { mainView: 1 } } } }) } } })
    finish()
    expect(isEditorTabActive()).toBe(true)
  })

  it('does not clear a new mount during HMR replacement', () => {
    const finish = mount({ readSessionScope: () => ({ sessionId: 'session-a' }) })
    markEditorMounted()
    finish()
    expect(isEditorTabActive()).toBe(true)
  })

  it('clears activity when no current session remains', () => {
    const finish = mount({ readSessionScope: () => ({}) })
    finish()
    expect(isEditorTabActive()).toBe(false)
  })
})
