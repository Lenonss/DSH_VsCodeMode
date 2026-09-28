/** Application URL and RPC response contracts. @author ddj 2026年09月28号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appUrl } from '../src/shared/appUrl.js'
import { rpc } from '../src/client/rpc.js'

afterEach(() => vi.unstubAllGlobals())

describe('application URLs', () => {
  it.each([
    ['http://127.0.0.1:9131/?token=private', 'http://127.0.0.1:9131/edrv/rpc'],
    ['https://example.test/tools/dsh/', 'https://example.test/tools/dsh/edrv/rpc'],
    ['https://example.test/tools/dsh/index.html?session=x', 'https://example.test/tools/dsh/edrv/rpc'],
    ['dsh-app://app/', 'dsh-app://app/edrv/rpc'],
  ])('keeps the application base and drops launch query: %s', (base, expected) => {
    expect(appUrl('/edrv/rpc', base)).toBe(expected)
  })
  it('uses document base for vendor assets including worker paths', () => {
    vi.stubGlobal('document', { baseURI: 'https://example.test/prefix/' })
    expect(appUrl('/edrv/vendor/pdfjs/build/pdf.worker.mjs')).toBe('https://example.test/prefix/edrv/vendor/pdfjs/build/pdf.worker.mjs')
  })
  it('refuses external and unsupported origins', () => {
    expect(() => appUrl('//evil.test/')).toThrow()
    expect(() => appUrl('https://evil.test/')).toThrow()
    expect(() => appUrl('/edrv/rpc', 'file:///tmp/index.html')).toThrow()
  })
})

describe('RPC transport', () => {
  it('posts under the document base and retains cancellation', async () => {
    vi.stubGlobal('document', { baseURI: 'dsh-app://app/' })
    const fetcher = vi.fn(async () => Response.json({ ok: true, servers: [] }))
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    await expect(rpc('mcp.list', {}, controller.signal)).resolves.toEqual({ ok: true, servers: [] })
    expect(fetcher).toHaveBeenCalledWith('dsh-app://app/edrv/rpc', expect.objectContaining({ method: 'POST', credentials: 'same-origin', signal: controller.signal }))
  })
  it.each([401, 403, 413, 503])('reports HTTP %s without trying to parse an authentication page', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private diagnostics', { status })))
    await expect(rpc('mcp.list', {})).rejects.toThrow(/DSH|请求/)
  })
  it('rejects HTML and malformed response envelopes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>proxy</html>', { headers: { 'content-type': 'text/html' } })))
    await expect(rpc('mcp.list', {})).rejects.toThrow('非 JSON')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ result: 'wrong endpoint' })))
    await expect(rpc('mcp.list', {})).rejects.toThrow('响应格式')
  })
  it('retains explicit business failures as results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, error: 'not found' })))
    await expect(rpc('mcp.list', {})).resolves.toEqual({ ok: false, error: 'not found' })
  })
})
