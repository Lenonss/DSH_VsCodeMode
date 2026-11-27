/**
 * dsh-vscode-mode client — 最近打开记录（跨挂载防「界面状态恢复」覆盖刚点开的文件）。
 *
 * 缺陷现场（2026-11-26 实测）：点对话里的文件链接后编辑区先正确打开目标文件，紧接着
 * 同一次挂载链里又跑了一遍界面状态恢复——恢复先清空页签、再整份塞回滞后存档，把刚
 * 打开的文件顶掉，用户看到的是上一份文件（插件日志：BootText.cs 打开后立刻变回
 * GameInitState.cs；落盘存档里根本没有 BootText.cs）。
 *
 * 恢复本身没错，错在没把「刚发生的打开」算进去：存档是滞后的，打开事件是新的。
 * 因此集中记一份最近打开：打开事件写入，恢复流程读出并合并进恢复结果。
 * 只认 TTL 内的记录——时间一过就交回存档语义，避免在另一个客户端改过存档后被内存记录顶掉。
 * 记录挂在 window 上跨 HMR/重挂载存活；无 window 时退化为模块级表（单测用）。
 *
 * @author ddj 2026年11月26号
 */
import { insertTab, type TabLike } from '../tabActions.js'

/** 记录有效期（毫秒）：超过后不再干预恢复，交回存档语义。 */
export const RECENT_OPEN_TTL_MS = 12_000

/** 跨重挂载存活的全局挂点。 */
const GLOBAL_KEY = '__edrvRecentOpen__'

/** 一条最近打开记录。 */
export interface RecentOpenRecord {
  /** 页签规范路径（工作区相对路径，工作区外为绝对路径）。 */
  path: string
  /** 写入时刻（毫秒时间戳）。 */
  at: number
}

/** 无 window 环境（node 单测）的兜底表。 */
const fallbackTable = new Map<string, RecentOpenRecord>()

/**
 * 取记录表：优先复用 window 上挂着的那一份，缺失则新建并挂上。
 * @author ddj 2026年11月26号
 * @returns 作用域键 → 最近打开记录
 */
function tableOf(): Map<string, RecentOpenRecord> {
  if (typeof window === 'undefined') return fallbackTable
  const host = window as unknown as Record<string, unknown>
  const existing = host[GLOBAL_KEY]
  if (existing instanceof Map) return existing as Map<string, RecentOpenRecord>
  const created = new Map<string, RecentOpenRecord>()
  host[GLOBAL_KEY] = created
  return created
}

/**
 * 记一条最近打开（同一作用域只留最新一条）。
 * @author ddj 2026年11月26号
 * @param scope 编辑区作用域键（workspaceScopeOf 产物）
 * @param path 页签规范路径
 * @param now 当前时刻（单测注入）
 */
export function markRecentOpen(scope: string, path: string, now = Date.now()): void {
  if (!scope || !path) return
  tableOf().set(scope, { path, at: now })
}

/**
 * 读某作用域的最近打开路径（无记录或已过期 → null）。
 * @author ddj 2026年11月26号
 * @param scope 编辑区作用域键
 * @param now 当前时刻（单测注入）
 * @returns 仍在有效期内的路径
 */
export function recentOpenOf(scope: string, now = Date.now()): string | null {
  if (!scope) return null
  const record = tableOf().get(scope)
  if (!record) return null
  // 系统时间回拨时 now - at 为负，同样视为新鲜，不因时钟抖动丢掉刚发生的打开
  if (now - record.at > RECENT_OPEN_TTL_MS) return null
  return record.path
}

/**
 * 清记录（不传作用域清全部）。
 * @author ddj 2026年11月26号
 * @param scope 编辑区作用域键
 */
export function clearRecentOpen(scope?: string): void {
  if (scope) {
    tableOf().delete(scope)
    return
  }
  tableOf().clear()
}

/**
 * 把最近打开合并进恢复出的页签表：已存在只切活动页，不存在则插入并设为活动。
 * @author ddj 2026年11月26号
 * @param tabs 恢复出的页签
 * @param active 恢复出的活动页
 * @param pending 最近打开路径（null = 不干预）
 * @returns 合并后的页签与活动页
 */
export function applyRecentOpen(
  tabs: TabLike[],
  active: string | null,
  pending: string | null,
): { tabs: TabLike[]; active: string | null } {
  if (!pending) return { tabs, active }
  if (tabs.some((tab) => tab.path === pending)) return { tabs, active: pending }
  return { tabs: insertTab(tabs, pending), active: pending }
}
