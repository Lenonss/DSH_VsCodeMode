import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dropFloat, floatLayer, floatVersion, initialFloat, moveFloat, raiseFloat, watchFloats } from '../src/client/state/floatingWindow.js'
import { FloatingWindow } from '../src/client/ui/FloatingWindow.js'

const harness = vi.hoisted(() => ({ effects: [] as Array<() => void>, setBounds: vi.fn() }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, default: { ...actual.default,
    useId: () => 'test-window', useRef: (current: unknown) => ({ current }),
    useState: (init: () => unknown) => [init(), harness.setBounds],
    useSyncExternalStore: vi.fn(), useEffect: (effect: () => () => void) => harness.effects.push(effect()),
  } }
})
vi.mock('react-dom', () => ({ createPortal: (element: unknown) => element }))

const listeners = new Map<string, Set<(event: any) => void>>()
const frames = new Map<number, () => void>()
let frameId = 0
/** @private @author ddj 2026年10月14号 @param type Event name. @param event Synthetic pointer data. Dispatch through real production subscriptions. */
function dispatch(type: string, event: any = {}): void { for (const listener of [...(listeners.get(type) ?? [])]) listener(event) }
/** @private @author ddj 2026年10月14号 @returns Actual rendered floating chrome with mocked hook lifecycle, not a browser DOM. */
function mount(props: Record<string, unknown> = {}): any {
  return FloatingWindow({ title: 'SVN test', ...props }) as unknown as React.ReactElement
}
/** @private @author ddj 2026年10月14号 @returns Primary pointer press. */
function press(): any { return { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 10, preventDefault: vi.fn(), target: { closest: () => null } } }

beforeEach(() => {
  harness.setBounds.mockClear(); listeners.clear(); frames.clear()
  vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800,
    addEventListener: (type: string, fn: (event: any) => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn) },
    removeEventListener: (type: string, fn: (event: any) => void) => listeners.get(type)?.delete(fn),
  })
  vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frames.set(++frameId, fn); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => { for (const cleanup of harness.effects.splice(0)) cleanup(); vi.unstubAllGlobals(); dropFloat('test-window') })

describe('shared floating geometry and layers', () => {
  it('centers preferred bounds and clamps small viewports', () => {
    expect(initialFloat(760, 600, 1200, 800)).toEqual({ left: 220, top: 100, width: 760, height: 600 })
    const small = initialFloat(1320, 680, 320, 240)
    expect(small.left).toBeGreaterThanOrEqual(0); expect(small.top).toBeGreaterThanOrEqual(0)
    expect(small.left + small.width).toBeLessThanOrEqual(320)
    expect(small.top + small.height).toBeLessThanOrEqual(240)
  })
  it('moves or resizes without moving outside viewport', () => {
    const rect = initialFloat(760, 600, 1200, 800)
    expect(moveFloat(rect, 20, 30, false, 1200, 800)).toEqual({ ...rect, left: 240, top: 130 })
    expect(moveFloat(rect, 20, 30, true, 1200, 800)).toEqual({ ...rect, width: 780, height: 630 })
    expect(moveFloat(rect, -9999, -9999, false, 1200, 800).left).toBeGreaterThanOrEqual(0)
  })
  it('raises on activation, avoids redundant notifications, and stays below modal layers', () => {
    const notify = vi.fn(); const off = watchFloats(notify)
    raiseFloat('a'); raiseFloat('b'); expect(floatLayer('b')).toBeGreaterThan(floatLayer('a'))
    raiseFloat('a'); expect(floatLayer('a')).toBeGreaterThan(floatLayer('b'))
    const version = floatVersion(); raiseFloat('a'); expect(floatVersion()).toBe(version)
    for (let i = 0; i < 150; i++) raiseFloat('w' + i)
    expect(floatLayer('w149')).toBeLessThan(190)
    off(); dropFloat('a'); dropFloat('b'); for (let i = 0; i < 150; i++) dropFloat('w' + i)
  })
})

describe('production floating chrome callbacks', () => {
  it('renders only the nonmodal window and scoped portal, never a page mask', () => {
    const tree = mount()
    expect(tree.props.role).toBe('dialog'); expect(tree.props['aria-modal']).toBe(false)
    expect(tree.props.className).toBe('edrv-floating'); expect(tree.props['data-edrv-view']).toBe('1')
    expect(React.Children.count(tree.props.children)).toBe(3)
  })
  it('handles Escape only in its own window and preserves disabled close', () => {
    const onClose = vi.fn(); const tree = mount({ onClose }); const root = {}
    tree.ref.current = root
    const event = { key: 'Escape', target: { closest: () => root }, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    tree.props.onKeyDown({ ...event, target: { closest: () => ({}) } }); expect(onClose).not.toHaveBeenCalled()
    tree.props.onKeyDown(event); expect(onClose).toHaveBeenCalledTimes(1)
    mount({ onClose, closeOnEsc: false }).props.onKeyDown(event); expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('does not drag title buttons and ignores secondary pointers', () => {
    const title = mount().props.children[0]
    title.props.onPointerDown({ ...press(), target: { closest: () => ({}) } })
    title.props.onPointerDown({ ...press(), button: 2 })
    expect(listeners.get('pointermove')?.size ?? 0).toBe(0)
  })
  it.each(['pointerup', 'pointercancel', 'blur', 'unmount'])('cleans gesture listeners after %s and commits last geometry', (end) => {
    const tree = mount(); harness.setBounds.mockClear()
    tree.props.children[0].props.onPointerDown(press())
    dispatch('pointermove', { pointerId: 2, clientX: 30, clientY: 40, preventDefault: vi.fn() }); expect(frames.size).toBe(0)
    dispatch('pointermove', { pointerId: 1, clientX: 30, clientY: 40, preventDefault: vi.fn() })
    dispatch('pointermove', { pointerId: 1, clientX: 50, clientY: 60, preventDefault: vi.fn() }); expect(frames.size).toBe(1)
    if (end === 'unmount') for (const cleanup of harness.effects.splice(0)) cleanup()
    else dispatch(end, { pointerId: 1 })
    expect(harness.setBounds).toHaveBeenLastCalledWith({ left: 260, top: 150, width: 760, height: 600 })
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'blur']) expect(listeners.get(type)?.size ?? 0).toBe(0)
    expect(frames.size).toBe(0)
  })
  it('uses the same gesture for resizing and controlled editor geometry', () => {
    const onBounds = vi.fn(); const rect = initialFloat(760, 600, 1200, 800); const tree = mount({ rect, onBounds })
    onBounds.mockClear(); tree.props.children[2].props.onPointerDown(press())
    dispatch('pointermove', { pointerId: 1, clientX: 30, clientY: 40, preventDefault: vi.fn() }); dispatch('pointerup', { pointerId: 1 })
    expect(onBounds).toHaveBeenLastCalledWith({ ...rect, width: 780, height: 630 })
  })
})
