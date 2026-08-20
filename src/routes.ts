/**
 * dsh-vscode-mode host — webServer 路由注册（/edrv/rpc、/edrv/assets/*、/edrv/vendor/*）。
 * 迁移自原 src/index.ts 的路由部分，路径/行为一字不改。
 * 作者 ddj 2026-08-20
 */
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RPC_PATH } from './shared/rpc.js'
import type { RpcMethod, RpcRequestMap } from './shared/rpc.js'
import type { Ctx } from './store.js'

const IMG_ROUTES = [
  { url: '/edrv/assets/compare-idle.png', file: 'compare_idle.png' },
  { url: '/edrv/assets/compare-select.png', file: 'compare_select.png' },
]

/** Monaco AMD 构建静态资源（随包发布，离线可用；前缀路由 /edrv/vendor/*）。 */
const VENDOR_PREFIX = '/edrv/vendor'
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

/** 图标目录：默认插件包内 assets/（随包发布）；config.imageDir 可覆盖（用于自定义换图）。 */
function imageDirOf(config: unknown): string {
  const cfg = config as { imageDir?: unknown } | undefined
  if (cfg && typeof cfg.imageDir === 'string' && cfg.imageDir) return cfg.imageDir.replace(/\\/g, '/')
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
}

/** Monaco AMD 静态目录（随包发布）。 */
const vendorDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'vendor')

/**
 * 注册全部 webServer 路由。
 * @author ddj 2026年08月20号
 * @param ctx DSH 上下文
 * @param config 插件配置（可选 imageDir 等）
 * @param handleRpc RPC 分发入口（method,args → RpcResult）
 */
export function registerRoutes(
  ctx: Ctx,
  config: unknown,
  handleRpc: <M extends RpcMethod>(method: M, args: RpcRequestMap[M]) => Promise<unknown>,
): void {
  const imgDir = imageDirOf(config)
  const web = ctx.get('webServer')
  if (!web) return

  ctx.effect(() => web.register({
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
  }), 'edrv: /edrv/rpc route')

  for (const r of IMG_ROUTES) {
    ctx.effect(() => web.register({
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
    }), 'edrv: static ' + r.file)
  }

  // Monaco Editor AMD 构建：/edrv/vendor/* → assets/vendor/*（路径穿越防护 + 按扩展名 MIME）
  ctx.effect(() => web.register({
    kind: 'prefix',
    path: VENDOR_PREFIX,
    handler: async (req: { method?: string; url?: string }, res: { statusCode?: number; setHeader: (k: string, v: string) => void; end: (b?: string | Uint8Array) => void }) => {
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
        const body = await readFile(target)
        res.statusCode = 200
        res.setHeader('content-type', VENDOR_MIME[extname(target)] ?? 'application/octet-stream')
        res.setHeader('cache-control', 'public, max-age=3600')
        res.end(body)
      } catch (error) {
        res.statusCode = 404
        res.end()
      }
    },
  }), 'edrv: /edrv/vendor prefix')
}
