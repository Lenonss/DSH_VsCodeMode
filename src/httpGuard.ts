/** HTTP admission and bounded RPC decoding. @author ddj 2026年09月28号 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BINARY_READ_CAP, READ_CAP } from './store.js'
import type { Ctx } from './store.js'

/** Text JSON can expand each byte into a six-character escape; binary uses base64. */
export const RPC_BODY_CAP = Math.max(READ_CAP * 6, Math.ceil(BINARY_READ_CAP / 3) * 4) + 64 * 1024
export interface RpcInput { method: string; args: Record<string, unknown> }
type InputResult = { input: RpcInput } | { status: number; error: string }

/** Host 连接服务的旧版围栏（DSH 0.2.3 起已移除；存在时由插件自己调用）。 */
interface LegacyConnection {
  /**
   * 类方法：必须带服务实例作为 this 调用，方法体内部会读 this.admit()。
   * @param request 原始 Node 请求（含认证头）。
   * @returns 拒绝状态码；undefined 表示放行。
   */
  requestRejection?: (request: IncomingMessage) => number | undefined
}

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

/** 围栏异常只报一次：客户端会重试，逐次刷日志只会淹没真正的原因。 */
let fenceWarned = false

/**
 * Resolve the legacy Host connection fence, or undefined when the host no longer has one.
 * DSH 0.2.3 removed connection.requestRejection: the framework now authorizes a route
 * through WebRoute.auth (default required) before dispatch, so a host without the fence
 * must admit here and leave the decision to the framework.
 * @author ddj 2026年11月23号
 * @param ctx Host context.
 * @param req Original Node request, including authentication headers.
 * @returns The rejection status, or undefined when the host has no legacy fence.
 */
function legacyRejection(ctx: Ctx, req: IncomingMessage, warning?: (text: string) => void): number | undefined {
  let connection: LegacyConnection | undefined
  try {
    connection = ctx.get('connection') as LegacyConnection | undefined
  } catch {
    connection = undefined
  }
  const reject = connection?.requestRejection
  if (typeof reject !== 'function') return undefined
  try {
    // 必须以服务实例为接收者调用：requestRejection 是类方法，内部要走 this.admit()。
    // 取出方法再裸调（v0.33.0 的写法）会在 0.2.3 之前的宿主上抛 TypeError → 503。
    return reject.call(connection, req)
  } catch (error) {
    // 围栏本身坏掉时不再静默：把原因留给宿主日志，界面侧只看到 503。
    if (!fenceWarned) {
      fenceWarned = true
      warning?.('兼容性：旧版 connection.requestRejection 调用失败（' + String(error) + '）')
    }
    return 503
  }
}

/**
 * Report which party authorizes this plugin's routes on the running host.
 * @author ddj 2026年11月23号
 * @param ctx Host context.
 * @returns 'legacy' when the old connection fence exists, else the framework route auth.
 */
export function routeAuthMode(ctx: Ctx): 'legacy' | 'framework' {
  try {
    const reject = (ctx.get('connection') as { requestRejection?: unknown } | undefined)?.requestRejection
    return typeof reject === 'function' ? 'legacy' : 'framework'
  } catch {
    return 'framework'
  }
}

/**
 * Admit a request before inspecting its body, then enforce this route's methods.
 * @author ddj 2026年09月28号 / 2026年11月23号
 * @param ctx Host context; the legacy connection fence is optional and absent from 0.2.3.
 * @param req Original Node request, including authentication headers.
 * @param res Response receiving a refusal when unavailable or unauthorized.
 * @param methods Allowed HTTP methods for this route.
 * @param warning Optional diagnostic sink for a broken legacy fence.
 * @returns Whether the request may proceed.
 */
export function admitRoute(ctx: Ctx, req: IncomingMessage, res: ServerResponse, methods: string[], warning?: (text: string) => void): boolean {
  const rejection = legacyRejection(ctx, req, warning)
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
