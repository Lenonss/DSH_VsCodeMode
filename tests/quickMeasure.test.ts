import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchQuickSize } from '../src/client/ui/quickMeasure.js'

describe('quick menu measurement scheduling', () => {
  let frames: Map<number, FrameRequestCallback>
  let anchors: Element[]
  let resize: () => void
  let notify: ResizeObserverCallback
  let observe: ReturnType<typeof vi.fn>
  let unobserve: ReturnType<typeof vi.fn>
  let disconnect: ReturnType<typeof vi.fn>
  let nextId: number

  /** @private @author ddj 2026年11月06号 @description 执行当前帧任务，模拟浏览器下一帧。 */
  function flushFrame(): void {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(0))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    frames = new Map()
    anchors = [{} as Element]
    nextId = 0
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
    vi.stubGlobal('document', { querySelectorAll: () => anchors, body: null })
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++nextId, callback)
        return nextId
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      addEventListener: (_event: string, listener: () => void) => { resize = listener },
      removeEventListener: vi.fn(),
      setTimeout, clearTimeout, setInterval, clearInterval,
    })
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { notify = callback }
      observe = observe
      unobserve = unobserve
      disconnect = disconnect
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('coalesces initial, resize, observer and explicit open requests', () => {
    const measure = vi.fn()
    const watcher = watchQuickSize(measure)
    resize()
    notify([], {} as ResizeObserver)
    watcher.request()
    expect(frames.size).toBe(1)
    expect(measure).not.toHaveBeenCalled()
    flushFrame()
    expect(measure).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith(anchors[0])
    watcher.dispose()
  })

  it('rebinds replaced anchors and polls only once per five seconds after startup', () => {
    const measure = vi.fn()
    const watcher = watchQuickSize(measure)
    flushFrame()
    vi.advanceTimersByTime(2000)
    flushFrame()
    measure.mockClear()
    const previous = anchors[0]
    anchors = [{} as Element, {} as Element]
    vi.advanceTimersByTime(2999)
    expect(frames.size).toBe(0)
    vi.advanceTimersByTime(1)
    flushFrame()
    expect(measure).toHaveBeenCalledTimes(1)
    expect(unobserve).toHaveBeenCalledWith(previous)
    expect(observe).toHaveBeenCalledWith(anchors[0])
    expect(observe).toHaveBeenCalledWith(anchors[1])
    watcher.dispose()
  })

  it('cancels queued work and late notifications on disposal, allowing remount', () => {
    const measure = vi.fn()
    const watcher = watchQuickSize(measure)
    watcher.dispose()
    watcher.request()
    notify([], {} as ResizeObserver)
    vi.advanceTimersByTime(10000)
    flushFrame()
    expect(measure).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalledTimes(1)
    const replacement = watchQuickSize(measure)
    flushFrame()
    expect(measure).toHaveBeenCalledTimes(1)
    replacement.dispose()
  })

  it('keeps fallback and explicit measurement without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const measure = vi.fn()
    const watcher = watchQuickSize(measure)
    flushFrame()
    watcher.request()
    flushFrame()
    expect(measure).toHaveBeenCalledTimes(2)
    watcher.dispose()
  })
})
