import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealTab, watchTabReveal } from '../src/client/ui/tabReveal.js'

/** @private @author ddj 2026年11月05号 @param left Tab viewport start. @param width Tab width. @returns Group-local fake layout and frame queue. */
function strip(left = 450, width = 100) {
  const tab = { getBoundingClientRect: () => ({ left, right: left + width, width }) }
  const view = { requestAnimationFrame: vi.fn(() => 7), cancelAnimationFrame: vi.fn() }
  const host = {
    clientWidth: 200, clientLeft: 2, scrollWidth: 900, scrollLeft: 100,
    getBoundingClientRect: () => ({ left: 300 }), querySelector: vi.fn(() => tab),
    ownerDocument: { defaultView: view },
  }
  return { host: host as unknown as HTMLDivElement, tab, view }
}

afterEach(() => vi.unstubAllGlobals())

describe('active tab visibility', () => {
  it.each([
    [450, 100, 148], [270, 100, 68], [320, 100, 100], [300, 300, 98],
  ])('reveals tab at %s of width %s with minimum horizontal movement', (left, width, expected) => {
    const { host } = strip(left, width)
    revealTab(host)
    expect(host.scrollLeft).toBe(expected)
  })
  it('does not write scrollLeft when fully visible', () => {
    const { host } = strip(320)
    const write = vi.fn()
    Object.defineProperty(host, 'scrollLeft', { get: () => 100, set: write })
    revealTab(host)
    expect(write).not.toHaveBeenCalled()
  })
  it('clamps movement to both legal scroll boundaries', () => {
    const { host } = strip(-500)
    revealTab(host)
    expect(host.scrollLeft).toBe(0)
    host.querySelector = vi.fn(() => ({ getBoundingClientRect: () => ({ left: 2000, right: 2100, width: 100 }) })) as any
    revealTab(host)
    expect(host.scrollLeft).toBe(700)
  })
  it('ignores hidden containers and missing selections', () => {
    const { host } = strip()
    Object.defineProperty(host, 'clientWidth', { value: 0 })
    revealTab(host)
    expect(host.scrollLeft).toBe(100)
    const empty = strip().host
    empty.querySelector = vi.fn(() => null)
    revealTab(empty)
    expect(empty.scrollLeft).toBe(100)
  })
  it('observes only its strip and selected tab, coalesces frames and cleans up', () => {
    let resize!: () => void
    const observe = vi.fn()
    const disconnect = vi.fn()
    class Observer {
      constructor(callback: () => void) { resize = callback }
      observe = observe
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', Observer)
    const { host, tab, view } = strip()
    const dispose = watchTabReveal(host)
    expect(host.scrollLeft).toBe(148)
    expect(observe.mock.calls).toEqual([[host], [tab]])
    resize(); resize()
    expect(view.requestAnimationFrame).toHaveBeenCalledTimes(1)
    dispose()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(view.cancelAnimationFrame).toHaveBeenCalledWith(7)
    resize()
    expect(view.requestAnimationFrame).toHaveBeenCalledTimes(1)
  })
  it('remeasures the latest selection and zero-width recovery without scroll listeners', () => {
    const { host, view } = strip(320)
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 0 })
    const dispose = watchTabReveal(host)
    expect(host.scrollLeft).toBe(100)
    Object.defineProperty(host, 'clientWidth', { value: 200 })
    host.querySelector = strip(450).host.querySelector
    const frame = view.requestAnimationFrame.mock.calls[0][0] as FrameRequestCallback
    frame(0)
    expect(host.scrollLeft).toBe(148)
    dispose()
  })
  it('does not move a different group or run a queued callback after disposal', () => {
    const first = strip()
    const second = strip()
    const dispose = watchTabReveal(first.host)
    expect(second.host.scrollLeft).toBe(100)
    dispose()
    first.host.scrollLeft = 0
    const frame = first.view.requestAnimationFrame.mock.calls[0][0] as FrameRequestCallback
    frame(0)
    expect(first.host.scrollLeft).toBe(0)
  })
})
