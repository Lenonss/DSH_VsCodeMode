/** HTTP route trust and transport regressions. @author ddj 2026年09月28号 */
import { Readable } from 'node:stream'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { admitRoute, readRpc, RPC_BODY_CAP } from '../src/httpGuard.js'
import { registerRoutes } from '../src/routes.js'
import { handleRpc } from '../src/rpc.js'
import { BINARY_READ_CAP, READ_CAP } from '../src/store.js'

/** @author ddj 2026年09月28号 @param body Wire body. @param method HTTP method. @returns Test request stream. */
function request(body: string, method = 'POST'): IncomingMessage {
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  req.method = method
  req.url = '/edrv/rpc'
  req.headers = { 'content-type': 'application/json; charset=utf-8' }
  return req
}

/** @author ddj 2026年09月28号 @returns Inspectable HTTP response stub. */
function response() {
  const headers = new Map<string, unknown>()
  const output = { statusCode: 0, headersSent: false, setHeader: vi.fn((key, value) => headers.set(key, value)), end: vi.fn() }
  return { output, headers, res: output as unknown as ServerResponse }
}

/** @author ddj 2026年09月28号 @param rejection Host admission result. @returns Route registry and business call spy. */
function setup(rejection?: number) {
  const routes = new Map<string, { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }>()
  const dispatch = vi.fn(async () => ({ ok: true }))
  const trust = vi.fn(() => rejection)
  const web = { register: vi.fn((route) => { routes.set(route.path, route); return vi.fn() }) }
  const ctx = { get: (name: string) => name === 'webServer' ? web : name === 'connection' ? { requestRejection: trust } : undefined, effect: (run: () => unknown) => run() }
  registerRoutes(ctx, undefined, dispatch)
  return { routes, dispatch, trust }
}

describe('plugin HTTP admission', () => {
  it.each(['constructor', '__proto__', 'toString'])('does not dispatch inherited method %s', async (method) => {
    const result = await handleRpc({ get: () => undefined }, new Map(), method as never, {} as never)
    expect(result).toMatchObject({ ok: false, error: '未知方法: ' + method })
  })
  it.each([401, 403])('refuses %s before consuming or dispatching a sensitive MCP request', async (status) => {
    const { routes, dispatch, trust } = setup(status)
    const req = request('{"method":"mcp.save","args":{"config":{"command":"never-run"}}}')
    const { res, output } = response()
    await routes.get('/edrv/rpc')!.handler(req, res)
    expect(trust).toHaveBeenCalledWith(req)
    expect(dispatch).not.toHaveBeenCalled()
    expect(output.statusCode).toBe(status)
    expect(req.readableEnded).toBe(false)
    req.destroy()
  })

  it('fails closed when the host has no authentication capability', () => {
    const { res, output } = response()
    const req = request('{}')
    expect(admitRoute({ get: () => undefined }, req, res, ['POST'])).toBe(false)
    expect(output.statusCode).toBe(503)
    req.destroy()
  })

  it('does not admit requests when authentication throws', () => {
    const { res, output } = response()
    const req = request('{}')
    expect(admitRoute({ get: () => ({ requestRejection: () => { throw new Error('offline') } }) }, req, res, ['POST'])).toBe(false)
    expect(output.statusCode).toBe(503)
    req.destroy()
  })

  it('allows only POST for RPC', async () => {
    const { routes, dispatch } = setup()
    const { res, output, headers } = response()
    const req = request('{}', 'GET')
    await routes.get('/edrv/rpc')!.handler(req, res)
    expect(output.statusCode).toBe(405)
    expect(headers.get('allow')).toBe('POST')
    expect(dispatch).not.toHaveBeenCalled()
    req.destroy()
  })

  it.each(['[]', 'null', '{', '{"method":"mcp.list","args":[]}', '{"method":1}', '{"method":"mcp.list","args":null}'])('rejects invalid envelopes: %s', async (body) => {
    const { routes, dispatch } = setup()
    const { res, output } = response()
    await routes.get('/edrv/rpc')!.handler(request(body), res)
    expect(output.statusCode).toBe(400)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches the existing single-segment compat method', async () => {
    const { routes, dispatch } = setup()
    const { res, output } = response()
    await routes.get('/edrv/rpc')!.handler(request('{"method":"compat","args":{}}'), res)
    expect(dispatch).toHaveBeenCalledWith('compat', {})
    expect(output.statusCode).toBe(200)
  })

  it('retains object arguments and omitted-args compatibility', async () => {
    const { routes, dispatch } = setup()
    const { res, headers, output } = response()
    await routes.get('/edrv/rpc')!.handler(request('{"method":"mcp.list"}'), res)
    expect(dispatch).toHaveBeenCalledWith('mcp.list', {})
    expect(output.statusCode).toBe(200)
    expect(headers.get('cache-control')).toBe('no-store')
  })

  it('applies the fence to every static asset route as well', async () => {
    const { routes, dispatch } = setup(401)
    for (const [path, route] of routes) {
      const req = request('', 'GET')
      req.url = path
      const { res, output } = response()
      await route.handler(req, res)
      expect(output.statusCode).toBe(401)
      req.destroy()
    }
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('bounded RPC input', () => {
  it('returns HTTP 413 over a real chunked socket without dispatching', async () => {
    let dispatched = 0
    const server = createServer(async (req, res) => {
      const result = await readRpc(req, 64)
      if ('input' in result) dispatched += 1
      res.statusCode = 'status' in result ? result.status : 200
      res.end('bounded')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const status = await new Promise<number>((resolve, reject) => {
        const client = httpRequest({ host: '127.0.0.1', port: address.port, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
          res.on('error', reject)
        })
        client.on('error', reject)
        client.write('x'.repeat(100))
        client.end('tail')
      })
      expect(status).toBe(413)
      expect(dispatched).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('supports existing maximum text escaping and base64 file sizes', () => {
    expect(RPC_BODY_CAP).toBeGreaterThan(READ_CAP * 6)
    expect(RPC_BODY_CAP).toBeGreaterThan(Math.ceil(BINARY_READ_CAP / 3) * 4)
  })
  it('rejects non-JSON media types', async () => {
    const req = request('{}')
    req.headers['content-type'] = 'text/plain'
    expect(await readRpc(req)).toMatchObject({ status: 415 })
  })
  it('rejects an oversized declared body without dispatch', async () => {
    const req = request('{}')
    req.headers['content-length'] = '1000'
    expect(await readRpc(req, 100)).toMatchObject({ status: 413 })
  })
  it('bounds chunked bodies even without content-length', async () => {
    expect(await readRpc(request('x'.repeat(101)), 100)).toMatchObject({ status: 413 })
  })
})
