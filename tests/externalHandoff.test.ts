import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ackPending, cancelPending, clearPending, handoffOpen, pendingState, pollPending } from '../src/externalHandoff.js'
import { parseInboxOpen, OPEN_TTL_MS } from '../src/shared/externalOpen.js'

afterEach(() => { clearPending(); vi.useRealTimers() })

describe('leased external handoff', () => {
  it('queues requests without replacement and does not equate claims with success', () => {
    const first = handoffOpen({ paths: ['/a'] })
    const second = handoffOpen({ paths: ['/b'] })
    const a = pollPending({ clientId: 'a' })!
    const b = pollPending({ clientId: 'b' })!
    expect([a.token, b.token]).toEqual([first.token, second.token])
    expect(pendingState(a.token).delivered).toBe(false)
    expect(pendingState('unknown')).toEqual({ delivered: false, completed: false })
    expect(ackPending({ ...a, clientId: 'a', success: true })).toBe(true)
    expect(pendingState(a.token).delivered).toBe(true)
  })

  it('rejects wrong pages, stale leases, and post-expiry completion', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    const { token } = handoffOpen({ paths: ['/a'] })
    const first = pollPending({ clientId: 'a' })!
    expect(ackPending({ ...first, clientId: 'other', success: true })).toBe(false)
    vi.advanceTimersByTime(30_001)
    const second = pollPending({ clientId: 'b' })!
    expect(second.token).toBe(token)
    expect(second.leaseId).not.toBe(first.leaseId)
    expect(ackPending({ ...first, clientId: 'a', success: true })).toBe(false)
    vi.advanceTimersByTime(30_000)
    expect(ackPending({ ...second, clientId: 'b', success: true })).toBe(false)
    expect(pendingState(token).delivered).toBe(false)
  })

  it('renews an active lease without redelivering or claiming another request', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    handoffOpen({ paths: ['/a'] }); handoffOpen({ paths: ['/b'] })
    const claim = pollPending({ clientId: 'a' })!
    vi.advanceTimersByTime(20_000)
    expect(pollPending({ clientId: 'a' })).toBeNull()
    vi.advanceTimersByTime(20_000)
    expect(ackPending({ ...claim, clientId: 'a', success: true })).toBe(true)
    expect(pollPending({ clientId: 'a' })?.paths).toEqual(['/b'])
  })

  it('keeps failure terminal and refuses a later success rewrite', () => {
    handoffOpen({ paths: ['/a'] })
    const claim = pollPending({ clientId: 'a' })!
    expect(ackPending({ ...claim, clientId: 'a', success: false, error: 'open failed' })).toBe(true)
    expect(ackPending({ ...claim, clientId: 'a', success: true })).toBe(false)
    expect(pendingState(claim.token)).toEqual({ delivered: false, completed: true, error: 'open failed' })
    expect(pollPending({ clientId: 'b' })).toBeNull()
  })

  it('bounds queue growth', () => {
    for (let index = 0; index < 128; index++) handoffOpen({ paths: ['/a'] })
    expect(() => handoffOpen({ paths: ['/overflow'] })).toThrow('队列已满')
  })
})

describe('open-only inbox validation', () => {
  const now = 1_000_000
  const good = { version: 1, requestId: randomUUID(), profile: '/profile', paths: ['/a'], createdAt: now }
  it('accepts exact profiles, Windows paths, Unicode and navigation', () => {
    expect(parseInboxOpen({ ...good, paths: ['D:\\项目\\a.cs'], line: 4, column: 9 }, '/profile', now)).not.toBeNull()
  })
  it.each([
    { profile: '/other' }, { version: 2 }, { method: 'edrv.write' }, { requestId: '../escape' },
    { paths: ['relative'] }, { paths: ['/a\u0000b'] }, { paths: [] }, { paths: Array(21).fill('/a') },
    { paths: ['/' + 'a'.repeat(8192)] }, { line: 0 }, { column: 1.5 },
    { createdAt: now - OPEN_TTL_MS - 1 }, { createdAt: now + 5001 },
  ])('rejects malformed or excessive input %j', (patch) => {
    expect(parseInboxOpen({ ...good, ...patch }, '/profile', now)).toBeNull()
  })
})


describe('original request deadline', () => {
  it('accepts a 50-second-old request for only its remaining ten seconds', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    const id = randomUUID()
    handoffOpen({ paths: ['/a'] }, id, Date.now() - 50_000)
    const claim = pollPending({ clientId: 'a' })!
    expect(claim.token).toBe(id)
    vi.advanceTimersByTime(10_000)
    expect(pollPending({ clientId: 'b' })).toBeNull()
    expect(ackPending({ ...claim, clientId: 'a', success: true })).toBe(false)
    expect(pendingState(id)).toMatchObject({ completed: true, delivered: false })
  })

  it('never delivers an old unclaimed request after its original deadline', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    handoffOpen({ paths: ['/a'] }, randomUUID(), Date.now() - 50_000)
    vi.advanceTimersByTime(10_000)
    expect(pollPending({ clientId: 'a' })).toBeNull()
  })

  it('does not resurrect an original ID when its request file is read again', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    const id = randomUUID()
    const createdAt = Date.now() - 50_000
    handoffOpen({ paths: ['/a'] }, id, createdAt)
    vi.advanceTimersByTime(10_000)
    expect(pendingState(id).delivered).toBe(false)
    handoffOpen({ paths: ['/a'] }, id, createdAt)
    handoffOpen({ paths: ['/a'] }, id, Date.now())
    expect(pollPending({ clientId: 'a' })).toBeNull()
    vi.advanceTimersByTime(OPEN_TTL_MS)
    handoffOpen({ paths: ['/a'] }, id, createdAt)
    expect(pollPending({ clientId: 'a' })).toBeNull()
  })

  it('invalidates the lease before terminal failure is published', () => {
    const id = randomUUID()
    handoffOpen({ paths: ['/a'] }, id)
    const claim = pollPending({ clientId: 'a' })!
    cancelPending(id, 'cancelled')
    expect(ackPending({ ...claim, clientId: 'a', success: true })).toBe(false)
    handoffOpen({ paths: ['/a'] }, id)
    expect(pollPending({ clientId: 'b' })).toBeNull()
    expect(pendingState(id)).toEqual({ completed: true, delivered: false, error: 'cancelled' })
  })
})
