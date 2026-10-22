/** Sidebar drag cleanup through the real component handlers, without a DOM package. @author ddj 2026年10月22号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ refs: [] as any[], cursor: 0, effects: [] as any[], effectCursor: 0 }))
vi.mock('react', () => ({ default: {
  Component: class {},
  createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
  useRef: (initial: any) => hooks.refs[hooks.cursor++] ?? (hooks.refs[hooks.cursor - 1] = { current: initial }),
  useEffect: (effect: any, deps: any[]) => {
    const index = hooks.effectCursor++
    const previous = hooks.effects[index]
    if (previous && deps.length === previous.deps.length && deps.every((entry, i) => entry === previous.deps[i])) return
    previous?.cleanup?.(); hooks.effects[index] = { cleanup: effect(), deps }
  },
} }))
import { SidebarView } from '../src/client/sidebar/SidebarView.js'

let props: any
let listeners: Map<string, Set<any>>
/** @private @author ddj 2026年10月22号 @param type Event kind. @param pointerId Pointer identity. @param clientX Screen coordinate. @description Deliver a window event to registered handlers. */
function dispatch(type: string, pointerId = 1, clientX = 100) {
  for (const handler of [...(listeners.get(type) ?? [])]) handler({ pointerId, clientX })
}
/** @private @author ddj 2026年10月22号 @returns Real component resize handler. */
function render() { hooks.cursor = 0; hooks.effectCursor = 0; return (SidebarView(props) as any).children.at(-1).props.onPointerDown }
/** @private @author ddj 2026年10月22号 @description Execute every registered component teardown. */
function unmount() { for (const effect of hooks.effects) effect?.cleanup?.() }
/** @private @author ddj 2026年10月22号 @description Begin one owning-pointer drag. */
function start() { render()({ pointerId: 1, clientX: 100, preventDefault: vi.fn() }) }

beforeEach(() => {
  hooks.refs = []; hooks.cursor = 0; hooks.effects = []; hooks.effectCursor = 0
  listeners = new Map()
  vi.stubGlobal('window', {
    addEventListener: (type: string, handler: any) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(handler) },
    removeEventListener: (type: string, handler: any) => listeners.get(type)?.delete(handler),
  })
  props = { width: 350, minWidth: 300, visible: true, onWidth: vi.fn(), onHide: vi.fn(), onShow: vi.fn() }
})
afterEach(() => { unmount(); vi.unstubAllGlobals() })

describe('sidebar drag lifecycle', () => {
  it('resizes only for the owning pointer and clamps maximum width', () => {
    start(); dispatch('pointermove', 2, 200); expect(props.onWidth).not.toHaveBeenCalled()
    dispatch('pointerup', 2); dispatch('pointermove', 1, 800); expect(props.onWidth).toHaveBeenLastCalledWith(560)
  })
  it.each(['pointerup', 'pointercancel', 'blur'])('releases every listener on %s', (kind) => {
    start(); dispatch(kind); dispatch('pointermove', 1, 200)
    expect(props.onWidth).not.toHaveBeenCalled()
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true)
  })
  it('collapses below minimum and ends the drag', () => {
    start(); dispatch('pointermove', 1, 0); dispatch('pointermove', 1, 200)
    expect(props.onHide).toHaveBeenCalledTimes(1); expect(props.onWidth).not.toHaveBeenCalled()
  })
  it('replaces a previous drag and releases it on unmount', () => {
    start(); start(); expect(listeners.get('pointermove')?.size).toBe(1)
    unmount(); dispatch('pointermove', 1, 200); expect(props.onWidth).not.toHaveBeenCalled()
  })
  it('ends a drag on visible-state transition', () => {
    start(); props.visible = false; render(); dispatch('pointermove', 1, 200)
    expect(props.onWidth).not.toHaveBeenCalled()
  })
  it('preserves the hidden seam threshold and remembered width', () => {
    props.visible = false; start(); dispatch('pointermove', 1, 111); expect(props.onShow).not.toHaveBeenCalled()
    dispatch('pointermove', 1, 112); expect(props.onShow).toHaveBeenCalledTimes(1)
    props.visible = true; render()
    dispatch('pointermove', 1, 132); expect(props.onWidth).toHaveBeenLastCalledWith(370)
    dispatch('pointercancel'); expect(listeners.get('pointermove')?.size).toBe(0)
  })
})
