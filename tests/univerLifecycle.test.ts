import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
vi.mock('../src/client/rpc.js', () => ({ rpc: vi.fn() }))
import { rpc } from '../src/client/rpc.js'
import { activateUniver, confirmUniver, refreshUniver, subscribeUniver, univerSnapshot } from '../src/client/univer/store.js'

describe('Univer lifecycle boundaries', () => {
  it('coalesces capability requests and resets consent on session changes', async () => {
    vi.mocked(rpc).mockResolvedValue({ ok: true, capability: { available: true, writable: true, gateway: 'running' } } as never)
    const listener = vi.fn()
    const dispose = subscribeUniver('coalesced', listener)
    await Promise.all([refreshUniver('coalesced'), refreshUniver('coalesced')])
    expect(rpc).toHaveBeenCalledTimes(1)
    activateUniver('coalesced')
    confirmUniver('coalesced', true)
    expect(univerSnapshot('coalesced').confirmed).toBe(true)
    activateUniver('another')
    expect(univerSnapshot('coalesced').confirmed).toBe(false)
    dispose()
    const count = listener.mock.calls.length
    confirmUniver('coalesced', false)
    expect(listener).toHaveBeenCalledTimes(count)
  })
  it('removes capability and consent when provider becomes unavailable', async () => {
    vi.mocked(rpc).mockResolvedValue({ ok: true, capability: { available: false, writable: false } } as never)
    await refreshUniver('gone')
    confirmUniver('gone', true)
    expect(univerSnapshot('gone').confirmed).toBe(false)
  })
  it('guards text load, save, passive pane and model warming', () => {
    const source = readFileSync(new URL('../src/client/ui/EditorView.ts', import.meta.url), 'utf8')
    expect(source).toContain('if (useOffice(path)) {')
    expect(source).toContain('if (useOffice(path)) return Promise.resolve({ ok: false })')
    expect(source).toContain('if (useOffice(path)) continue')
    expect(source).toContain('if (useOffice(path) || isExcelPath(path)')
    expect(source).toContain('contentReady || useOffice(active)')
  })
})
