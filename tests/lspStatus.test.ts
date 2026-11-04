/** Status single-flight and session-generation isolation. @author ddj 2026年11月04号 */
import { describe, it, expect, vi } from 'vitest'
vi.mock('../src/client/rpc.js', () => ({ rpc: vi.fn(), dbg: vi.fn() }))
import { rpc } from '../src/client/rpc.js'
import { setLspSession, refreshStatus } from '../src/client/monaco/lsp/lspClient.js'

describe('LSP status isolation', () => {
  it('serializes session changes and rejects stale results', async () => {
    let finish: (result: unknown) => void = () => {}
    vi.mocked(rpc).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }) as any)
      .mockResolvedValue({ ok: true, servers: [{ languageId: 'new' }] })
    setLspSession('old')
    const duplicate = refreshStatus(true)
    setLspSession('new')
    expect(rpc).toHaveBeenCalledTimes(1)
    finish({ ok: true, servers: [{ languageId: 'old' }] })
    await duplicate
    expect(await refreshStatus()).toEqual([{ languageId: 'new' }])
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})
