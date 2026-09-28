/** Authenticated plugin HTTP routes and offline editor assets. @author ddj 2026年09月28号 */
import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { ROUTE_PREFIX, noteOwnRoute, resetOwnRoutes, routeConflict } from './compat.js'
import { RPC_PATH } from './shared/rpc.js'
import type { RpcMethod, RpcRequestMap } from './shared/rpc.js'
import type { Ctx } from './store.js'
import { VENDOR_PREFIX, imageDirOf, vendorDirOf } from './paths.js'
import { admitRoute, readRpc, replyJson } from './httpGuard.js'

const IMG_ROUTES = [
  { url: '/edrv/assets/compare-idle.png', file: 'compare_idle.png' },
  { url: '/edrv/assets/compare-select.png', file: 'compare_select.png' },
]
const VENDOR_MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.ts': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.html': 'text/html; charset=utf-8', '.md': 'text/markdown',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
}

type RpcHandler = <M extends RpcMethod>(method: M, args: RpcRequestMap[M]) => Promise<unknown>
type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
interface PluginRoute { kind: 'exact' | 'prefix'; path: string; methods: string[]; handler: HttpHandler }

// #region RPC
/**
 * Serialize RPC results, retaining the binary preview transport.
 * @author ddj 2026年09月28号
 * @param res HTTP response.
 * @param result RPC business result or binary envelope.
 */
function sendRpc(res: ServerResponse, result: unknown): void {
  const envelope = result as { ok?: boolean; binary?: { bytes?: Uint8Array; mime?: string; size?: number; version?: string } } | null
  const binary = envelope?.binary
  if (envelope?.ok !== true || !(binary?.bytes instanceof Uint8Array)) {
    replyJson(res, 200, result)
    return
  }
  res.statusCode = 200
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/octet-stream')
  res.setHeader('x-edrv-mime', String(binary.mime ?? ''))
  res.setHeader('x-edrv-version', String(binary.version ?? ''))
  res.setHeader('x-edrv-size', String(binary.size ?? binary.bytes.byteLength))
  res.end(Buffer.from(binary.bytes))
}

/**
 * Build a bounded RPC handler; authorization is applied by mountRoute.
 * @author ddj 2026年09月28号
 * @param dispatch Business dispatcher.
 * @returns HTTP handler rejecting malformed bodies before dispatch.
 */
function rpcHandler(dispatch: RpcHandler): HttpHandler {
  /** @author ddj 2026年09月28号 @param req Admitted request. @param res HTTP response. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const decoded = await readRpc(req)
    if ('status' in decoded) {
      replyJson(res, decoded.status, { ok: false, error: decoded.error })
      return
    }
    const { method, args } = decoded.input
    sendRpc(res, await dispatch(method as RpcMethod, args as never))
  }
  return handle
}
// #endregion

// #region Static files
/**
 * Check a resolved asset remains under its canonical asset root.
 * @author ddj 2026年09月28号
 * @param root Canonical asset directory.
 * @param target Candidate canonical file path.
 * @returns Whether the target lies strictly below the root.
 */
function assetInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

/**
 * Serve a file with conditional caching, honoring HEAD without loading its body.
 * @author ddj 2026年09月28号
 * @param req Admitted GET or HEAD request.
 * @param res HTTP response.
 * @param target Canonical asset file.
 * @param mime Content type.
 */
async function sendAsset(req: IncomingMessage, res: ServerResponse, target: string, mime: string): Promise<void> {
  const info = await stat(target)
  if (!info.isFile()) { res.statusCode = 404; res.end(); return }
  const etag = 'W/"' + info.mtimeMs.toString(16) + '-' + info.size.toString(16) + '"'
  res.setHeader('etag', etag)
  res.setHeader('cache-control', 'private, max-age=3600')
  if (req.headers['if-none-match'] === etag) { res.statusCode = 304; res.end(); return }
  res.statusCode = 200
  res.setHeader('content-type', mime)
  res.setHeader('content-length', info.size)
  res.end(req.method === 'HEAD' ? undefined : await readFile(target))
}

/**
 * Build an asset handler that refuses traversal and symlinks outside its root.
 * @author ddj 2026年09月28号
 * @param directory Static assets directory.
 * @param prefix URL prefix, absent for a fixed asset filename.
 * @param filename Optional fixed asset name.
 * @returns Authenticated route body handler.
 */
function assetHandler(directory: string, prefix?: string, filename?: string): HttpHandler {
  /** @author ddj 2026年09月28号 @param req Admitted request. @param res HTTP response. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const name = filename ?? decodeURIComponent(pathname.slice(prefix!.length)).replace(/^\/+/, '')
      if (!name) { res.statusCode = 404; res.end(); return }
      const root = await realpath(directory)
      const target = await realpath(resolve(root, name))
      if (!assetInside(root, target)) { res.statusCode = 403; res.end(); return }
      await sendAsset(req, res, target, VENDOR_MIME[extname(target)] ?? 'application/octet-stream')
    } catch {
      if (!res.headersSent) res.statusCode = 404
      res.end()
    }
  }
  return handle
}
// #endregion

/**
 * Register one owned route, enforcing authentication before any asset or RPC access.
 * @author ddj 2026年09月28号
 * @param ctx Host context.
 * @param route Plugin route descriptor.
 * @param warning Optional registration diagnostic sink.
 */
function mountRoute(ctx: Ctx, route: PluginRoute, warning?: (text: string) => void): void {
  /** @author ddj 2026年09月28号 @param req Original HTTP request. @param res HTTP response. */
  async function guarded(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!admitRoute(ctx, req, res, route.methods)) return
    try { await route.handler(req, res) } catch {
      if (!res.headersSent) replyJson(res, 500, { ok: false, error: 'Plugin request failed' })
      else res.end()
    }
  }
  /** @author ddj 2026年09月28号 @returns Route disposer, or undefined on a registration conflict. */
  function install(): (() => void) | undefined {
    try {
      const dispose = ctx.get('webServer').register({ kind: route.kind, path: route.path, handler: guarded })
      noteOwnRoute(route.kind, route.path)
      return dispose
    } catch (error) {
      warning?.('兼容性：' + route.path + ' 注册失败（' + String(error) + '）')
      return undefined
    }
  }
  ctx.effect(install, 'edrv: ' + route.path)
}

/**
 * Register plugin RPC and offline asset routes with the official connection fence.
 * @author ddj 2026年09月28号
 * @param ctx Host context.
 * @param config Plugin configuration.
 * @param handleRpc Business RPC dispatcher.
 * @param onWarning Optional compatibility diagnostic sink.
 */
export function registerRoutes(ctx: Ctx, config: unknown, handleRpc: RpcHandler, onWarning?: (text: string) => void): void {
  const web = ctx.get('webServer')
  if (!web) return
  resetOwnRoutes()
  const conflict = routeConflict(web, ROUTE_PREFIX)
  if (conflict) onWarning?.('兼容性：' + conflict)
  mountRoute(ctx, { kind: 'exact', path: RPC_PATH, methods: ['POST'], handler: rpcHandler(handleRpc) }, onWarning)
  const images = imageDirOf(config, import.meta.url)
  for (const image of IMG_ROUTES) {
    mountRoute(ctx, { kind: 'exact', path: image.url, methods: ['GET', 'HEAD'], handler: assetHandler(images, undefined, image.file) }, onWarning)
  }
  mountRoute(ctx, { kind: 'prefix', path: VENDOR_PREFIX, methods: ['GET', 'HEAD'], handler: assetHandler(vendorDirOf(import.meta.url), VENDOR_PREFIX) }, onWarning)
}
