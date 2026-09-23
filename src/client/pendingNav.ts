/**
 * dsh-vscode-mode client — 跨挂载/跨热重载的待跳转交接（pending nav handoff）。
 *
 * 为什么必须落 window（第三次事故根因，2026-09-23 实测取证）：
 * 并行改码触发插件 client HMR 热重载（保留 console 中装配日志重复 6-7 轮为证）时，
 * EditorView 被重挂载、模块级变量随 bundle 重求值复位——挂载级 `pendingFocusRef`
 * 一并销毁，首开跳转只打开文件、不落目标行，热重载平息后的第二次点击才正常。
 * window 属性跨热重载存活（先例：`__edrvLspProvidersRegistered__`、`__DSH_DEBUG_LOG__`）。
 *
 * 语义约定：
 * - `putPendingNav` 写槽（openFileAt 与挂载级 ref 同步写，ref 是快路径、槽是交接路径）；
 * - `readPendingNav` **只读不消费**——过期/形状非法才清；新鲜槽可反复读；
 * - 落点成功后由调用方 `clearPendingNav`（与 ref 同一清除点，防止残留二次跳）；
 * - TTL 到点自动失效，避免"稍后莫名跳一下"（用户已离开目标意图窗口）。
 * 作者 ddj 2026-09-23
 */

// --region 类型与常量

/** 待跳转形状（行列均 1-based；at = 写入时刻，TTL 判据）。 */
export interface PendingNav {
  path: string
  line?: number | null
  column?: number | null
  endLine?: number | null
  endColumn?: number | null
  at: number
}

/** 写入接口（at 由 putPendingNav 盖时间戳）。 */
export type PendingNavInput = Omit<PendingNav, 'at'>

/** window 槽键名（跨热重载存活的全局挂点）。 */
export const PENDING_NAV_KEY = '__edrvPendingNav__'

/** 交接有效期：超过即失效清槽（点击意图的有效窗口，防陈旧跳转）。 */
export const PENDING_NAV_TTL = 30000

// --endregion

// --region 纯函数（可单测）

/**
 * 形状守卫：非法入参返回 null，合法则归一化为 PendingNav。
 * 行列非有限数字一律归 null（缺省语义 = 不定位行），path 必须为非空字符串。
 * @author ddj 2026年09月23号
 * @param raw 任意来源的原始值
 * @returns 归一化后的 PendingNav 或 null
 */
export function sanitizeNav(raw: unknown): PendingNav | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  if (typeof src.path !== 'string' || !src.path) return null
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const at = num(src.at)
  if (at === null) return null // at 是 TTL 判据：缺失/非法直接整体无效，不兜 0 免依赖巧合
  return {
    path: src.path,
    line: num(src.line),
    column: num(src.column),
    endLine: num(src.endLine),
    endColumn: num(src.endColumn),
    at,
  }
}

/**
 * 新鲜度判定：形状合法且未超过 TTL 才算有效；过期返回 null。
 * @author ddj 2026年09月23号
 * @param nav 已归一化的待跳转（可空）
 * @param now 当前时刻（毫秒）
 * @param ttl 有效期（毫秒）
 * @returns 有效导航或 null
 */
export function freshNav(nav: PendingNav | null, now: number, ttl: number): PendingNav | null {
  if (!nav) return null
  return now - nav.at <= ttl ? nav : null
}

// --endregion

// --region window 槽适配

/** window 上的槽宿主（node 环境无 window，读写降级为 no-op）。 */
type NavSlotHost = Record<string, unknown>

/**
 * 取槽宿主：仅浏览器环境返回 window，否则 undefined（测试/SSR 降级）。
 * @author ddj 2026年09月23号
 */
function slotHost(): NavSlotHost | undefined {
  if (typeof window === 'undefined') return undefined
  return window as unknown as NavSlotHost
}

/**
 * 写入待跳转（盖写整槽；at 由调用方给定或取当前时间）。
 * 非法 path 直接丢弃，不写槽。
 * @author ddj 2026年09月23号
 * @param nav 待跳转内容（不含 at）
 * @param now 写入时刻（测试注入用）
 * @returns 是否写入成功
 */
export function putPendingNav(nav: PendingNavInput, now: number = Date.now()): boolean {
  const host = slotHost()
  if (!host) return false
  if (typeof nav?.path !== 'string' || !nav.path) return false
  host[PENDING_NAV_KEY] = { ...nav, at: now }
  return true
}

/**
 * 读取新鲜的待跳转（**不消费**；过期或形状非法才清槽）。
 * @author ddj 2026年09月23号
 * @param now 当前时刻（测试注入用）
 * @param ttl 有效期（毫秒）
 * @returns 有效导航或 null
 */
export function readPendingNav(now: number = Date.now(), ttl: number = PENDING_NAV_TTL): PendingNav | null {
  const host = slotHost()
  if (!host) return null
  const nav = freshNav(sanitizeNav(host[PENDING_NAV_KEY]), now, ttl)
  if (!nav) {
    // 失效即清：过期/垃圾数据不留在 window 上
    if (host[PENDING_NAV_KEY] !== undefined) delete host[PENDING_NAV_KEY]
    return null
  }
  return nav
}

/**
 * 清除待跳转槽（落点成功或显式放弃时调用）。
 * @author ddj 2026年09月23号
 */
export function clearPendingNav(): void {
  const host = slotHost()
  if (!host) return
  delete host[PENDING_NAV_KEY]
}

// --endregion
