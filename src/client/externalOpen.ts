/**
 * dsh-vscode-mode client — 外部深链落地（Windows 右键菜单 / Unity 外部编辑器）。
 * 启动时解析 location.search 的 edrvOpen 深链：跨源 referrer 守卫防外部网页诱导；
 * 处理完剥离 URL 参数防刷新重开；执行委托 openFlow 打开规则引擎（工作区/对话智能路由）。
 * 另挂 3s 移交轮询（兼活跃心跳）：launcher 投递的打开请求由已打开页面就地执行，避免重复开新页。
 * 作者 ddj 2026-09-07 / 2026-09-08
 */
import { EDRV_PARAM_KEYS, parseOpenParams } from '../shared/externalOpen.js'
import { openDeepLink } from './openFlow.js'
import { disposeOpenWait } from './openReceipt.js'
import { rpc } from './rpc.js'
import { log } from './log.js'

/** toast 自隐时长。 */
const TOAST_MS = 5000
/** 深链移交轮询周期（兼活跃心跳）。 */
const HANDOFF_POLL_MS = 3000

/** 深链装配选项（全部可注入便于测试；缺省读浏览器全局）。 */
export interface ExtOpenOptions {
  /** 查询串（缺省 location.search）。 */
  search?: string
  /** referrer（缺省 document.referrer）。 */
  referrer?: string
  /** 当前源（缺省 location.origin）。 */
  origin?: string
}

/**
 * 装配外部深链：深链参数缺失时仅保持移交轮询（零额外开销）。
 * @author ddj 2026年09月07号
 * @param ctx 客户端根上下文（sessions/workspaces 服务）
 * @param options 可注入选项
 */
export function setupExtOpen(ctx: unknown, options: ExtOpenOptions = {}): () => void {
  const dispose = startPresencePoll(ctx)
  const search = options.search ?? (typeof location !== 'undefined' ? location.search : '')
  const params = parseOpenParams(search)
  if (!params) return dispose
  const referrer = options.referrer ?? (typeof document !== 'undefined' ? document.referrer : '')
  const origin = options.origin ?? (typeof location !== 'undefined' ? location.origin : '')
  if (!referrerAllowed(referrer, origin)) {
    log.warn('已忽略跨源深链请求（referrer=' + referrer + '）')
    return dispose
  }
  stripCurrentUrl()
  void openDeepLink(ctx, params).catch((error) => {
    log.warn('深链打开失败：' + String(error))
    toastDom('深链打开失败：' + String((error as Error)?.message ?? error))
  })
  return dispose
}

/**
 * 深链移交轮询：每 3s 向 host 领取待打开请求（兼活跃心跳，launcher 据此决定是否开新页）。
 * 页面级单例（window 标记防 HMR 重复）；领取到即执行打开规则。
 * @author ddj 2026年09月08号
 * @param ctx 客户端根上下文
 */
function startPresencePoll(ctx: unknown): () => void {
  if (typeof window === 'undefined') return () => {}
  const marker = window as unknown as { __edrvExtPoll?: () => void }
  if (typeof marker.__edrvExtPoll === 'function') marker.__edrvExtPoll()
  const clientId = crypto.randomUUID()
  let disposed = false
  let polling = false
  let executing = false
  /** @private @author ddj 2026年09月28号 Open all requested paths before acknowledging this exact lease. */
  async function execute(open: { paths: string[]; line?: number; column?: number; token: string; leaseId: string }): Promise<void> {
    executing = true
    try {
      const success = await openDeepLink(ctx, open)
      if (!disposed) await rpc('edrv.external.ack', { token: open.token, leaseId: open.leaseId, clientId, success, error: success ? undefined : '编辑器打开失败或取消' })
    } finally { executing = false }
  }
  /** @private @author ddj 2026年09月28号 Poll while opening to renew the lease without accepting a second request. */
  async function tick(): Promise<void> {
    if (disposed || polling) return
    polling = true
    try {
      const result = await rpc('edrv.external.pending', { clientId, busy: executing })
      if (!disposed && result.ok && result.open && !executing) void execute(result.open).catch(() => {})
    } finally { polling = false }
  }
  const timer = window.setInterval(() => { void tick().catch(() => {}) }, HANDOFF_POLL_MS)
  /** @private @author ddj 2026年09月28号 Stop heartbeats and fail outstanding editor waits on plugin disposal. */
  function dispose(): void {
    disposed = true
    window.clearInterval(timer)
    disposeOpenWait()
    if (marker.__edrvExtPoll === dispose) delete marker.__edrvExtPoll
  }
  marker.__edrvExtPoll = dispose
  void tick().catch(() => {})
  return dispose
}

/**
 * 跨源守卫：referrer 为空（launcher/Unity 直开）或同源 → 允许。
 * @author ddj 2026年09月07号
 * @param referrer 文档 referrer
 * @param origin 当前页面源
 * @returns 是否允许处理深链
 */
export function referrerAllowed(referrer: string, origin: string): boolean {
  if (!referrer) return true
  try {
    return new URL(referrer).origin === origin
  } catch {
    return false
  }
}

/**
 * 剥离 URL 中的深链参数（保留其余参数与 hash，防刷新重开）。
 * @author ddj 2026年09月07号
 * @param href 完整 URL
 * @returns 清理后的 URL（pathname+search+hash）
 */
export function stripOpenHref(href: string): string {
  const url = new URL(href)
  for (const key of EDRV_PARAM_KEYS) url.searchParams.delete(key)
  return url.pathname + url.search + url.hash
}

/** 清理当前页面 URL（best-effort，失败不阻塞打开）。 */
function stripCurrentUrl(): void {
  try {
    if (typeof location === 'undefined' || typeof history === 'undefined') return
    const next = stripOpenHref(location.href)
    if (next !== location.pathname + location.search + location.hash) history.replaceState(null, '', next)
  } catch { /* 清理失败忽略 */ }
}

/**
 * 轻量 toast（编辑器未挂载也能提示；5s 自隐；openFlow 通知与错误呈现共用）。
 * @author ddj 2026年09月07号
 * @param text 提示文本
 */
export function toastDom(text: string): void {
  if (typeof document === 'undefined') return
  const toast = document.createElement('div')
  toast.textContent = text
  toast.setAttribute('style', [
    'position:fixed', 'left:50%', 'bottom:28px', 'transform:translateX(-50%)',
    'z-index:99999', 'padding:8px 14px', 'border-radius:8px', 'max-width:80vw',
    'background:#2a2a2a', 'color:#ddd', 'border:1px solid #444', 'font-size:12px',
    'box-shadow:0 4px 16px rgba(0,0,0,.35)',
  ].join(';'))
  document.body?.appendChild(toast)
  setTimeout(() => toast.remove(), TOAST_MS)
}
