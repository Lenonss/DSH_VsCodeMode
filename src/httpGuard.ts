/** HTTP admission and bounded RPC decoding. @author ddj 2026年09月28号 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BINARY_READ_CAP, READ_CAP } from './store.js'
import type { Ctx } from './store.js'

/** Text JSON can expand each byte into a six-character escape; binary uses base64. */
export const RPC_BODY_CAP = Math.max(READ_CAP * 6, Math.ceil(BINARY_READ_CAP / 3) * 4) + 64 * 1024
export interface RpcInput { method: string; args: Record<string, unknown> }
type InputResult = { input: RpcInput } | { status: number; error: string }

/**
 * Send a JSON response without allowing credential-dependent results to be cached.
 * @author ddj 2026年09月28号
 * @param res HTTP response.
 * @param status HTTP status code.
 * @param value JSON payload.
 */
export function replyJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/**
 * Admit a request through the Host connection fence before inspecting its body.
 * @author ddj 2026年09月28号
 * @param ctx Host context; connection is an optional capability on older hosts.
 * @param req Original Node request, including authentication headers.
 * @param res Response receiving a refusal when unavailable or unauthorized.
 * @param methods Allowed HTTP methods for this route.
 * @returns Whether the request may proceed.
 */
export function admitRoute(ctx: Ctx, req: IncomingMessage, res: ServerResponse, methods: string[]): boolean {
  let rejection: number | undefined = 503
  try {
    const connection = ctx.get('connection')
    if (typeof connection?.requestRejection === 'function') rejection = connection.requestRejection(req)
  } catch { /* A missing or failed authentication service must not admit the request. */ }
  if (rejection !== undefined) {
    const status = rejection === 401 || rejection === 403 ? rejection : 503
    replyJson(res, status, { ok: false, error: status === 503 ? 'Host authentication service unavailable' : 'Host authentication rejected this request' })
    return false
  }
  if (!methods.includes(req.method ?? '')) {
    res.setHeader('allow', methods.join(', '))
    replyJson(res, 405, { ok: false, error: 'Method not allowed' })
    return false
  }
  return true
}

/**
 * Decode the RPC envelope without coercing scalar or array arguments into objects.
 * @author ddj 2026年09月28号
 * @param text Bounded UTF-8 JSON document.
 * @returns Valid envelope or an HTTP 400 diagnostic.
 */
function parseRpc(text: string): InputResult {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid envelope')
    const { method, args = {} } = value as { method?: unknown; args?: unknown }
    if (typeof method !== 'string' || !/^[\w]+(?:\.[\w]+)*$/.test(method)) throw new Error('Invalid method')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid arguments')
    return { input: { method, args: args as Record<string, unknown> } }
  } catch {
    return { status: 400, error: 'Expected a JSON RPC object with method and object arguments' }
  }
}

/**
 * Read a bounded JSON body; reject headers and streamed overruns before RPC dispatch.
 * @author ddj 2026年09月28号
 * @param req Authenticated HTTP request.
 * @param cap Maximum encoded bytes, including JSON escaping and base64 overhead.
 * @returns Parsed input or an HTTP validation error.
 */
export async function readRpc(req: IncomingMessage, cap = RPC_BODY_CAP): Promise<InputResult> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? '')) {
    req.resume()
    return { status: 415, error: 'Content-Type must be application/json' }
  }
  const length = req.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > cap)) {
    req.resume()
    return { status: 413, error: 'RPC request exceeds the supported file size' }
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Uint8Array
    bytes += data.byteLength
    if (bytes > cap) {
      req.resume()
      return { status: 413, error: 'RPC request exceeds the supported file size' }
    }
    chunks.push(data)
  }
  return parseRpc(Buffer.concat(chunks, bytes).toString('utf8'))
}
