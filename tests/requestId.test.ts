import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequestId } from '../src/client/requestId.js'

afterEach(() => vi.unstubAllGlobals())
describe('secure client request IDs', () => {
  it('uses the native UUID API', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'native-id' })
    expect(createRequestId()).toBe('native-id')
  })
  it.each([undefined, () => { throw new Error('unavailable') }])('uses secure bytes without a working UUID API', (randomUUID) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(255))
    vi.stubGlobal('crypto', { randomUUID, getRandomValues })
    expect(createRequestId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
    expect(getRandomValues).toHaveBeenCalledOnce()
  })
  it('fails closed without cryptographic randomness', () => {
    vi.stubGlobal('crypto', undefined)
    expect(createRequestId()).toBeUndefined()
  })
})
