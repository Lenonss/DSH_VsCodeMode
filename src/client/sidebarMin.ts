/**
 * dsh-vscode-mode client — 侧边栏最小宽度共享状态。
 * 设置来源：dsh-vscode-mode 命名空间的 sidebarMinWidth 字段（通用设置页可调）；
 * 客户端 settings 订阅经 sidebarMinApply 写入，编辑器/侧边栏容器经 getSidebarMinWidth 读取，
 * 变更时由 client/index.ts 派发 edrv:sidebar-min-width 窗口事件通知编辑器重夹。
 * 作者 ddj 2026年09月04号
 */

/** 默认最小宽度（设置缺失/非法时的兜底值）。 */
export const SIDEBAR_MIN_DEFAULT = 300
/** 最小宽度允许下界（与旧版拖拽下限一致）。 */
export const SIDEBAR_MIN_FLOOR = 180
/** 最小宽度允许上界（与侧边栏最大宽度 W_MAX 一致，避免区间倒挂）。 */
export const SIDEBAR_MIN_CEIL = 560

let currentMin = SIDEBAR_MIN_DEFAULT

/**
 * 归一化最小宽度：非法（NaN/非有限/负数）回退默认，越界夹取到 [180, 560]。
 * @author ddj 2026年09月04号
 * @param value 原始值（设置文档来的任意 JSON 值）
 * @returns 合法最小宽度
 */
export function normalizeSidebarMinWidth(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return SIDEBAR_MIN_DEFAULT
  return Math.max(SIDEBAR_MIN_FLOOR, Math.min(SIDEBAR_MIN_CEIL, Math.round(n)))
}

/**
 * 应用设置值（client/index.ts 设置订阅同步调用）。
 * @author ddj 2026年09月04号
 * @param value 设置文档中的 sidebarMinWidth
 * @returns 归一化后的生效值
 */
export function sidebarMinApply(value: unknown): number {
  currentMin = normalizeSidebarMinWidth(value)
  return currentMin
}

/**
 * 读取当前生效的最小宽度（编辑器初始/恢复/拖拽夹取共用）。
 * @author ddj 2026年09月04号
 * @returns 当前最小宽度
 */
export function getSidebarMinWidth(): number {
  return currentMin
}
