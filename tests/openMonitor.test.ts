/** External opens must wait for actual editor completion. @author ddj 2026年09月28号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/client/events.js', () => ({ openEditorView: vi.fn() }))
import { OpenMonitor } from '../src/client/useOpenReceipt.js'
import { disposeOpenWait, requestOpen } from '../src/client/openReceipt.js'

let frames: Map<number, FrameRequestCallback>
let sequence = 0
beforeEach(() => {
  vi.useFakeTimers()
  frames = new Map()
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => { const id = ++sequence; frames.set(id, run); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => { disposeOpenWait(); vi.useRealTimers(); vi.unstubAllGlobals() })

/** @author ddj 2026年09月28号 Advance one paint frame after React/model changes. */
function frame(): void {
  const batch = [...frames.entries()]
  for (const [id, run] of batch) { frames.delete(id); run(0) }
}

describe('editor open completion monitor', () => {
  it('keeps an open unresolved until content and navigation become ready', async () => {
    let ready = false
    const open = vi.fn()
    const monitor = new OpenMonitor(() => ({ sessionId: 's', open, ready: () => ready, error: () => null }))
    monitor.start()
    const settled = vi.fn()
    const promise = requestOpen('a.ts', 10, 2, 's').then(settled)
    expect(open).toHaveBeenCalledOnce()
    frame()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    ready = true
    frame()
    await promise
    expect(settled).toHaveBeenCalledWith(true)
    monitor.stop()
  })

  it('consumes a pre-mount request only in its owning session', async () => {
    const promise = requestOpen('a.ts', undefined, undefined, 'owner')
    const wrongOpen = vi.fn()
    const wrong = new OpenMonitor(() => ({ sessionId: 'other', open: wrongOpen, ready: () => true, error: () => null }))
    wrong.start()
    expect(wrongOpen).not.toHaveBeenCalled()
    const right = new OpenMonitor(() => ({ sessionId: 'owner', open: vi.fn(), ready: () => true, error: () => null }))
    right.start()
    frame()
    await expect(promise).resolves.toBe(true)
    right.stop()
    wrong.stop()
  })

  it('returns failure on read errors and component disposal', async () => {
    let error: string | null = 'missing file'
    const monitor = new OpenMonitor(() => ({ sessionId: 's', open: vi.fn(), ready: () => false, error: () => error }))
    monitor.start()
    const failed = requestOpen('missing.ts', undefined, undefined, 's')
    frame()
    await expect(failed).resolves.toBe(false)
    error = null
    const disposed = requestOpen('loading.ts', undefined, undefined, 's')
    monitor.stop()
    await expect(disposed).resolves.toBe(false)
    expect(frames.size).toBe(0)
  })

  it.each(['ready', 'error'] as const)('fails a throwing %s predicate without uncaught errors and continues the queued request', async (method) => {
    const host = { sessionId: 's', open: vi.fn(), ready: vi.fn(() => true), error: vi.fn(() => null) }
    host[method].mockImplementationOnce(() => { throw new Error('disposed model') })
    const monitor = new OpenMonitor(() => host)
    monitor.start()
    const failed = requestOpen('first.ts', undefined, undefined, 's')
    const next = requestOpen('next.ts', undefined, undefined, 's')
    expect(() => frame()).not.toThrow()
    await expect(failed).resolves.toBe(false)
    frame(); frame()
    await expect(next).resolves.toBe(true)
    monitor.stop()
  })

  it('continues a preexisting queue after synchronous open throws', async () => {
    const failed = requestOpen('first.ts', undefined, undefined, 's')
    const next = requestOpen('next.ts', undefined, undefined, 's')
    const open = vi.fn().mockImplementationOnce(() => { throw new Error('open failed') }).mockImplementation(() => {})
    const monitor = new OpenMonitor(() => ({ sessionId: 's', open, ready: () => true, error: () => null }))
    expect(() => monitor.start()).not.toThrow()
    await expect(failed).resolves.toBe(false)
    frame(); frame()
    await expect(next).resolves.toBe(true)
    monitor.stop()
  })

  it('waits for async startup and converts rejection to a correlated failure', async () => {
    let reject!: (reason: unknown) => void
    const monitor = new OpenMonitor(() => ({ sessionId: 's', open: () => new Promise<void>((_resolve, fail) => { reject = fail }), ready: () => true, error: () => null }))
    monitor.start()
    const result = requestOpen('a.ts', undefined, undefined, 's')
    const settled = vi.fn()
    void result.then(settled)
    frame(); await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    reject(new Error('startup failed'))
    await expect(result).resolves.toBe(false)
    monitor.stop()
  })

  it.each(['resolve', 'reject'] as const)('ignores late async %s after timeout and continues an already queued request', async (completion) => {
    let complete!: () => void
    let ready = false
    const open = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      complete = completion === 'resolve' ? resolve : () => reject(new Error('old failure'))
    })).mockImplementation(() => {})
    const monitor = new OpenMonitor(() => ({ sessionId: 's', open, ready: () => ready, error: () => null }))
    monitor.start()
    const old = requestOpen('old.ts', undefined, undefined, 's')
    await vi.advanceTimersByTimeAsync(10_000)
    const next = requestOpen('next.ts', undefined, undefined, 's')
    const settled = vi.fn()
    void next.then(settled)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(old).resolves.toBe(false)
    frame()
    expect(open).toHaveBeenCalledTimes(2)
    complete(); await Promise.resolve(); frame(); await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    ready = true; frame()
    await expect(next).resolves.toBe(true)
    monitor.stop()
  })

  it('does not schedule or complete again after unmount during async startup', async () => {
    let resolve!: () => void
    const monitor = new OpenMonitor(() => ({ sessionId: 's', open: () => new Promise<void>((done) => { resolve = done }), ready: () => true, error: () => null }))
    monitor.start()
    const result = requestOpen('a.ts', undefined, undefined, 's')
    monitor.stop()
    await expect(result).resolves.toBe(false)
    resolve(); await Promise.resolve()
    expect(frames.size).toBe(0)
  })

  it('fails a claimed request when reading the host snapshot throws', async () => {
    let broken = false
    const monitor = new OpenMonitor(() => {
      if (broken) throw new Error('component gone')
      return { sessionId: 's', open: () => {}, ready: () => false, error: () => null }
    })
    monitor.start()
    const result = requestOpen('a.ts', undefined, undefined, 's')
    broken = true
    expect(() => frame()).not.toThrow()
    await expect(result).resolves.toBe(false)
    monitor.stop()
  })

  it('releases timed-out claims so the next request can complete', async () => {
    let ready = false
    const monitor = new OpenMonitor(() => ({ sessionId: 's', open: vi.fn(), ready: () => ready, error: () => null }))
    monitor.start()
    const old = requestOpen('slow.ts', undefined, undefined, 's')
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(old).resolves.toBe(false)
    ready = true
    const next = requestOpen('next.ts', undefined, undefined, 's')
    frame()
    await expect(next).resolves.toBe(true)
    monitor.stop()
  })
})
