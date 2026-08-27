/**
 * dsh-vscode-mode host — webServer 路由注册（/edrv/rpc、/edrv/assets/*、/edrv/vendor/*）。
 * 迁移自原 src/index.ts 的路由部分，路径/行为一字不改。
 * 作者 ddj 2026-08-20
 */
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { ROUTE_PREFIX, noteOwnRoute, resetOwnRoutes, routeConflict } from './compat.js'
import { RPC_PATH } from './shared/rpc.js'
import type { RpcMethod, RpcRequestMap } from './shared/rpc.js'
import type { Ctx } from './store.js'
import { VENDOR_PREFIX, imageDirOf, vendorDirOf } from './paths.js'

const IMG_ROUTES = [
  { url: '/edrv/assets/compare-idle.png', file: 'compare_idle.png' },
  { url: '/edrv/assets/compare-select.png', file: 'compare_select.png' },
]

/** Monaco AMD 构建静态资源（随包发布，离线可用；前缀路由 /edrv/vendor/*）。 */
const VENDOR_MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ts': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown',
}

/** 图标目录（paths.ts 统一解析：config.imageDir 覆盖优先，否则插件包 assets/）。 */
const imgDirOf = (config: unknown): string => imageDirOf(config, import.meta.url)

/** Monaco AMD 静态目录（随包发布，paths.ts 统一解析）。 */
const vendorDir = vendorDirOf(import.meta.url)

/**
 * 注册全部 webServer 路由（带兼容护栏：前缀冲突预警 + 注册失败降级跳过）。
 * @author ddj 2026年08月20号
 * @param ctx DSH 上下文
 * @param config 插件配置（可选 imageDir 等）
 * @param handleRpc RPC 分发入口（method,args → RpcResult）
 * @param onWarning 兼容性警告收集（可选）
 */
export function registerRoutes(
  ctx: Ctx,
  config: unknown,
  handleRpc: <M extends RpcMethod>(method: M, args: RpcRequestMap[M]) => Promise<unknown>,
  onWarning?: (warning: string) => void,
): void {
  const imgDir = imgDirOf(config)
  const web = ctx.get('webServer')
  if (!web) return

  resetOwnRoutes()
  const conflict = routeConflict(web, ROUTE_PREFIX)
  if (conflict) onWarning?.('兼容性：' + conflict)

  /** 护栏注册：重复路由抛错时降级为警告并跳过，不让单条路由拖垮装配。 */
  const guarded = (route: { kind: 'exact' | 'prefix'; path: string; handler?: unknown }, label: string): (() => void) | undefined => {
    try {
      const dispose = web.register(route)
      noteOwnRoute(route.kind, route.path)
      return dispose
    } catch (error) {
      onWarning?.('兼容性：' + label + ' 注册失败（' + String(error) + '）')
      return undefined
    }
  }

  ctx.effect(() => guarded({
    kind: 'exact',
    path: RPC_PATH,
    handler: async (req: unknown, res: { statusCode?: number; setHeader: (k: string, v: string) => void; end: (b?: string) => void }) => {
      try {
        const chunks: Uint8Array[] = []
        for await (const chunk of req as AsyncIterable<Uint8Array>) chunks.push(chunk)
        let input: { method?: string; args?: unknown } = {}
        try {
          input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch (error) {
          input = {}
        }
        const method = (typeof input.method === 'string' ? input.method : '') as RpcMethod
        const result = await handleRpc(method, (input.args ?? {}) as never)
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(result))
      } catch (error) {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, error: String(error) }))
      }
    },
  }, '/edrv/rpc 精确路由'), 'edrv: routes')

  for (const r of IMG_ROUTES) {
    ctx.effect(() => guarded({
      kind: 'exact',
      path: r.url,
      handler: async (req: unknown, res: { statusCode?: number; setHeader: (k: string, v: string) => void; end: (b?: string | Uint8Array) => void }) => {
        try {
          const body = await readFile(imgDir + '/' + r.file)
          res.statusCode = 200
          res.setHeader('content-type', 'image/png')
          res.setHeader('cache-control', 'no-cache')
          res.end(body)
        } catch (error) {
          res.statusCode = 404
          res.end()
        }
      },
    }, '静态资源 ' + r.file), 'edrv: routes')
  }

  // Monaco Editor AMD 构建：/edrv/vendor/* → assets/vendor/*（路径穿越防护 + 按扩展名 MIME）
  // ETag 协商缓存：弱 etag（mtime+size），配合 max-age 让浏览器 304 复用，插件升级内容变化自动失效。
  ctx.effect(() => guarded({
    kind: 'prefix',
    path: VENDOR_PREFIX,
    handler: async (req: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> }, res: { statusCode?: number; setHeader: (k: string, v: string) => void; end: (b?: string | Uint8Array) => void }) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.end()
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        const rel = decodeURIComponent(pathname.slice(VENDOR_PREFIX.length)).replace(/^\/+/, '')
        if (!rel) { res.statusCode = 404; res.end(); return }
        const target = resolve(normalize(join(vendorDir, rel)))
        if (target !== vendorDir && !target.startsWith(vendorDir + sep)) {
          res.statusCode = 403
          res.end()
          return
        }
        const info = await stat(target).catch(() => null)
        if (!info || !info.isFile()) { res.statusCode = 404; res.end(); return }
        const etag = 'W/"' + info.mtimeMs.toString(16) + '-' + info.size.toString(16) + '"'
        const reqEtag = (() => {
          const raw = req.headers?.['if-none-match']
          if (Array.isArray(raw)) return raw[0]
          return raw
        })()
        if (reqEtag === etag) {
          res.statusCode = 304
          res.setHeader('etag', etag)
          res.end()
          return
        }
        const body = await readFile(target)
        res.statusCode = 200
        res.setHeader('content-type', VENDOR_MIME[extname(target)] ?? 'application/octet-stream')
        res.setHeader('cache-control', 'public, max-age=3600')
        res.setHeader('etag', etag)
        res.end(body)
      } catch (error) {
        res.statusCode = 404
        res.end()
      }
    },
  }, '/edrv/vendor 前缀路由'), 'edrv: routes')
}
