/**
 * dsh-vscode-mode client — 调试面板四段分栏高度（纯函数 + localStorage 持久）。
 * 对齐 VS Code/CodeBuddy splitview 语义：段间 sash 拖动时相邻两段高度重分配
 * （拖下 = 上段增高、下段减矮；任一段触到夹取界时拖动量被"吸收"，分隔条停在可行位置）。
 * 存储：`edrv.dap.split.<scope>` → { variables, watch, stack, breakpoints }。
 * 作者 ddj 2026年09月21号
 */

/** 分栏段 key（与 DebugPanel section key 一致）。 */
export const SPLIT_KEYS = ['variables', 'watch', 'stack', 'breakpoints'] as const
/** 分栏段 key 类型。 */
export type SplitKey = (typeof SPLIT_KEYS)[number]

/** 默认高度（沿用重构前各段 max-height 值，改前改后视觉一致）。 */
export const DEFAULT_HEIGHTS: Record<SplitKey, number> = { variables: 360, watch: 220, stack: 180, breakpoints: 260 }
/** 单段最小高度（低于此不可再压缩）。 */
export const MIN_H = 64
/** 单段最大高度（防无限拖爆面板）。 */
export const MAX_H = 1200

/** localStorage key 前缀。 */
const KEY_PREFIX = 'edrv.dap.split.'

/**
 * 夹取单段高度到 [MIN_H, MAX_H]（非有限数回退最小值）。
 * @author ddj 2026年09月21号
 * @param px 目标高度
 */
export function clampSectionHeight(px: number): number {
  if (!Number.isFinite(px)) return MIN_H
  return Math.min(MAX_H, Math.max(MIN_H, Math.round(px)))
}

/**
 * 归一化高度表：非对象/缺 key 回退默认，非法值丢弃（损坏安全）。
 * @author ddj 2026年09月21号
 * @param input localStorage 解析结果
 */
export function sanitizeHeights(input: unknown): Record<SplitKey, number> {
  const out: Record<SplitKey, number> = { ...DEFAULT_HEIGHTS }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  const data = input as Record<string, unknown>
  for (const key of SPLIT_KEYS) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = clampSectionHeight(value)
  }
  return out
}

/**
 * 相邻两段高度重分配：above += dy、below −= dy，各自夹取；
 * 一段被夹取吸收的量补给另一段（分隔条停在可行位置，拖动量尽量生效）。
 * @author ddj 2026年09月21号
 * @param heights 拖动起点高度表（不修改入参）
 * @param above 上邻段 key
 * @param below 下邻段 key
 * @param dy 拖动位移（>0 向下拖 = 上段增高）
 * @returns 新高度表
 */
export function redistribute(
  heights: Record<SplitKey, number>,
  above: SplitKey,
  below: SplitKey,
  dy: number,
): Record<SplitKey, number> {
  const clean = Math.round(Number.isFinite(dy) ? dy : 0)
  const next: Record<SplitKey, number> = { ...heights }
  const startAbove = heights[above] ?? MIN_H
  const startBelow = heights[below] ?? MIN_H
  const targetAbove = clampSectionHeight(startAbove + clean)
  const targetBelow = clampSectionHeight(startBelow - clean)
  next[above] = targetAbove
  next[below] = targetBelow
  // 夹取吸收量：>0 表示该段未能吃满 dy，按原方向补给另一段
  const lostAbove = startAbove + clean - targetAbove
  const lostBelow = startBelow - clean - targetBelow
  if (lostAbove > 0) next[below] = clampSectionHeight(targetBelow + lostAbove)
  else if (lostBelow > 0) next[above] = clampSectionHeight(targetAbove + lostBelow)
  return next
}

/**
 * 读高度表（缺失/损坏回退默认值）。
 * @author ddj 2026年09月21号
 * @param scope 状态作用域
 */
export function loadSectionHeights(scope: string): Record<SplitKey, number> {
  if (!scope) return { ...DEFAULT_HEIGHTS }
  try {
    const raw = localStorage.getItem(KEY_PREFIX + scope)
    return sanitizeHeights(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_HEIGHTS }
  }
}

/**
 * 写高度表（写失败静默；写入前归一化）。
 * @author ddj 2026年09月21号
 * @param scope 状态作用域
 * @param heights 高度表
 */
export function saveSectionHeights(scope: string, heights: Record<SplitKey, number>): void {
  try { localStorage.setItem(KEY_PREFIX + scope, JSON.stringify(sanitizeHeights(heights))) } catch { /* 忽略 */ }
}
