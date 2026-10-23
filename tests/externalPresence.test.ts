import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupExtOpen } from '../src/client/externalOpen.js'
import { rpc } from '../src/client/rpc.js'
vi.mock('../src/client/rpc.js', () => ({ rpc: vi.fn(async () => ({ ok: true })) }))
vi.mock('../src/client/openFlow.js', () => ({ openDeepLink: vi.fn() }))
vi.mock('../src/client/log.js', () => ({ log: { warn: vi.fn() } }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers() })
describe('presence on insecure HTTP origins', () => {
  it('starts with secure bytes alone and releases its interval', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setInterval, clearInterval })
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(1) })
    const dispose = setupExtOpen({}, { search: '' })
    await Promise.resolve()
    expect(rpc).toHaveBeenCalledWith('edrv.external.pending', expect.objectContaining({ clientId: '01010101-0101-4101-8101-010101010101' }))
    expect(vi.getTimerCount()).toBe(1)
    dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not abort plugin startup without a secure random source', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('crypto', undefined)
    expect(() => setupExtOpen({}, { search: '' })()).not.toThrow()
    expect(rpc).not.toHaveBeenCalled()
  })
})
