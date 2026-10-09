import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disposeOpenWait, finishOpen, hasOpen, peekOpen, requestOpen } from '../src/client/openReceipt.js'

vi.mock('../src/client/events.js', () => ({ openEditorView: vi.fn() }))
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', new EventTarget()) })
afterEach(() => { disposeOpenWait(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('actual editor receipt bridge', () => {
  it('requires the owning session to atomically claim before completing', async () => {
    const result = requestOpen('/a.cs', 12, 3, 'session-a')
    expect(peekOpen('session-b')).toBeUndefined()
    const request = peekOpen('session-a')!
    expect(request).toMatchObject({ path: '/a.cs', line: 12, column: 3, sessionId: 'session-a' })
    expect(peekOpen('session-a')).toBeUndefined()
    finishOpen(request.requestId, true)
    expect(await result).toBe(true)
  })

  it('never treats dispatch or unknown completion IDs as success', async () => {
    const result = requestOpen('/a.cs', undefined, undefined, 'session-a')
    finishOpen('unknown', true)
    const request = peekOpen('session-a')!
    expect(hasOpen(request.requestId)).toBe(true)
    vi.advanceTimersByTime(20_000)
    expect(await result).toBe(false)
    expect(hasOpen(request.requestId)).toBe(false)
    expect(peekOpen('session-a')).toBeUndefined()
  })

  it('disposal fails pending requests and clears their deadline', async () => {
    const result = requestOpen(null, undefined, undefined, 'session-a')
    disposeOpenWait()
    expect(await result).toBe(false)
    expect(peekOpen('session-a')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('carries explicit preview and virtual payload without passing an address as a file path', async () => {
    const plan = { address: 'dsh-resource://plan/s/c', markdown: '# Plan', title: 'Plan' }
    const result = requestOpen(null, undefined, undefined, 's', { preview: true, plan })
    const request = peekOpen('s')!
    expect(request).toMatchObject({ path: null, plan, preview: true })
    finishOpen(request.requestId, true)
    expect(await result).toBe(true)
  })

  it('cancels claimed requests on scope disposal and refuses already-aborted requests', async () => {
    const controller = new AbortController()
    const result = requestOpen('/plans/a.md', undefined, undefined, 's', { signal: controller.signal })
    const request = peekOpen('s')!
    controller.abort()
    expect(await result).toBe(false)
    expect(hasOpen(request.requestId)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(await requestOpen(null, undefined, undefined, 's', { signal: controller.signal })).toBe(false)
  })

  it('propagates editor failure after claim', async () => {
    const result = requestOpen('/a.cs', undefined, undefined, 'session-a')
    finishOpen(peekOpen('session-a')!.requestId, false, 'model load failed')
    expect(await result).toBe(false)
  })
})
