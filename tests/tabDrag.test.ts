import { describe, expect, it, vi } from 'vitest'
import { createTabDrag, dragStarted, edgeAt, hitTarget, splitRect, type HitRegion } from '../src/client/tabDrag.js'

const rect = { left: 10, top: 10, width: 800, height: 600 }
const region: HitRegion = { group: 'main', rect, tabRect: { ...rect, height: 32 }, tabs: [{ path: 'a', rect: { left: 10, top: 10, width: 100, height: 32 } }, { path: 'b', rect: { left: 110, top: 10, width: 100, height: 32 } }] }
const base = { viewport: { width: 1200, height: 900 }, regions: [region], blank: false, allowCreate: true }
// Browser DOMRect geometry is inherited, unlike the old plain-object fixtures.
const browserRect = Object.create({ get left() { return 10 }, get top() { return 10 }, get width() { return 800 }, get height() { return 600 } })
const browserBase = { ...base, regions: [{ ...region, rect: browserRect }] }

/** @private @author ddj 2026年10月14号 @param type Gesture event. @param values Pointer/key fields. @returns Node-compatible browser event. */
function gesture(type: string, values: Record<string, unknown>): Event {
  return Object.assign(new Event(type, { cancelable: true }), values)
}

describe('drag preview lifecycle', () => {
  it.each(['pointerup', 'pointercancel', 'blur', 'keydown'])('clears the rectangle on %s', (ending) => {
    vi.stubGlobal('Element', class {})
    try {
      const host = new EventTarget() as Window
      let frame: FrameRequestCallback | null = null
      host.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => { frame = callback; return 1 })
      host.cancelAnimationFrame = vi.fn()
      const preview = vi.fn(), drop = vi.fn()
      const controller = createTabDrag({ hit: (point) => hitTarget({ ...browserBase, point }), preview, drop }, host)
      controller.start('a', { button: 0, isPrimary: true, pointerId: 1, clientX: 200, clientY: 300, currentTarget: null } as unknown as PointerEvent)
      host.dispatchEvent(gesture('pointermove', { pointerId: 1, clientX: 410, clientY: 310 }))
      ;(frame as FrameRequestCallback | null)?.(0)
      expect(preview.mock.lastCall?.[0]?.rect).toEqual(rect)
      expect({ ...preview.mock.lastCall?.[0]?.rect }).toEqual(rect)
      host.dispatchEvent(gesture(ending, { pointerId: 1, clientX: 410, clientY: 310, key: 'Escape' }))
      expect(preview.mock.lastCall?.[0]).toBeNull()
      expect(drop).toHaveBeenCalledTimes(ending === 'pointerup' ? 1 : 0)
      controller.cancel()
    } finally { vi.unstubAllGlobals() }
  })
})

describe('internal tab drop hit testing', () => {
  it('previews the whole target page at its center, including a single page', () => {
    const hit = hitTarget({ ...base, point: { x: 410, y: 310 } })
    expect(hit?.rect).toEqual(rect)
    expect(hit?.target).toEqual({ kind: 'group', group: 'main' })
  })
  it.each([
    ['left', { x: 20, y: 300 }, { left: 10, top: 10, width: 400, height: 600 }],
    ['right', { x: 800, y: 300 }, { left: 410, top: 10, width: 400, height: 600 }],
    ['top', { x: 400, y: 60 }, { left: 10, top: 10, width: 800, height: 300 }],
    ['bottom', { x: 400, y: 600 }, { left: 10, top: 310, width: 800, height: 300 }],
  ] as const)('previews precisely the %s half, not an outline', (edge, point, expected) => {
    expect(Object.keys(browserRect)).toEqual([])
    const hit = hitTarget({ ...browserBase, point })
    expect(hit?.rect).toEqual(expected)
    expect({ ...hit?.rect }).toEqual(expected)
    expect(hit?.target).toEqual({ kind: 'split', group: 'main', edge })
  })
  it('uses the other page bounds for center and each edge', () => {
    const other = { ...region, group: 'other', rect: { left: 850, top: 10, width: 800, height: 600 }, tabRect: undefined, tabs: [] }
    const input = { ...base, viewport: { width: 1800, height: 900 }, regions: [region, other] }
    expect(hitTarget({ ...input, point: { x: 1250, y: 310 } })?.rect).toEqual(other.rect)
    for (const [edge, point] of [['left', { x: 860, y: 310 }], ['right', { x: 1640, y: 310 }], ['top', { x: 1250, y: 20 }], ['bottom', { x: 1250, y: 600 }]] as const) {
      const hit = hitTarget({ ...input, point })
      expect(hit?.target).toEqual({ kind: 'split', group: 'other', edge })
      expect(hit?.rect).toEqual(splitRect(other.rect, edge))
    }
  })
  it('distinguishes click from drag at six pixels', () => {
    expect(dragStarted({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(false)
    expect(dragStarted({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true)
  })
  it('prioritizes current composer over overlapping editor geometry', () => {
    const hit = hitTarget({ ...base, point: { x: 100, y: 100 }, composer: rect })
    expect(hit?.target.kind).toBe('reference')
  })
  it('uses tab insertion slots before edge splitting', () => {
    expect(hitTarget({ ...base, point: { x: 20, y: 20 } })?.target).toEqual({ kind: 'group', group: 'main', index: 0 })
    expect(hitTarget({ ...base, point: { x: 130, y: 20 } })?.target).toEqual({ kind: 'group', group: 'main', index: 1 })
    expect(hitTarget({ ...base, point: { x: 300, y: 20 } })?.target).toEqual({ kind: 'group', group: 'main', index: 2 })
  })
  it.each([
    ['left', { x: 20, y: 300 }], ['right', { x: 800, y: 300 }],
    ['top', { x: 400, y: 60 }], ['bottom', { x: 400, y: 600 }],
  ] as const)('targets %s edge', (edge, point) => {
    expect(edgeAt(point, rect)).toBe(edge)
    expect(hitTarget({ ...base, point })?.target).toEqual({ kind: 'split', group: 'main', edge })
    expect(splitRect(rect, edge).width).toBe(edge === 'left' || edge === 'right' ? 400 : 800)
  })
  it('moves centrally instead of splitting a window or exceeding the cap', () => {
    expect(hitTarget({ ...base, point: { x: 400, y: 300 } })?.target).toEqual({ kind: 'group', group: 'main' })
    expect(hitTarget({ ...base, allowCreate: false, point: { x: 20, y: 300 } })?.target.kind).toBe('group')
    expect(hitTarget({ ...base, regions: [{ ...region, floating: true }], point: { x: 20, y: 300 } })?.target.kind).toBe('group')
  })
  it('only creates floats in explicit blank areas inside the viewport', () => {
    expect(hitTarget({ ...base, point: { x: 1000, y: 800 } })).toBeNull()
    expect(hitTarget({ ...base, blank: true, point: { x: 1000, y: 800 } })?.target.kind).toBe('float')
    expect(hitTarget({ ...base, blank: true, point: { x: -1, y: 800 } })).toBeNull()
    expect(hitTarget({ ...base, blank: true, allowCreate: false, point: { x: 1000, y: 800 } })).toBeNull()
  })
  it('does not split an undersized group', () => {
    expect(hitTarget({ ...base, regions: [{ group: 'main', rect: { left: 0, top: 0, width: 300, height: 200 } }], point: { x: 5, y: 100 } })?.target.kind).toBe('group')
  })
})
