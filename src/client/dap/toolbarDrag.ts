/**
 * dsh-vscode-mode client — 调试工具条拖拽位置纯逻辑。
 * 位置按工作区 scope 持久化；拖动结果始终 clamp 在编辑区边界内。
 * 作者 ddj 2026年09月29号
 */

export interface ToolbarPoint {
  left: number
  top: number
}

export interface ToolbarBounds {
  width: number
  height: number
  barWidth: number
  barHeight: number
  margin?: number
}

const KEY_PREFIX = 'edrv.dap.toolbar.'

/** 将工具条位置限制在编辑区内。 */
export function clampToolbarPosition(point: ToolbarPoint, bounds: ToolbarBounds): ToolbarPoint {
  const margin = bounds.margin ?? 6
  const maxLeft = Math.max(margin, bounds.width - bounds.barWidth - margin)
  const maxTop = Math.max(margin, bounds.height - bounds.barHeight - margin)
  return {
    left: Math.min(Math.max(margin, point.left), maxLeft),
    top: Math.min(Math.max(margin, point.top), maxTop),
  }
}

/** 读取当前工作区工具条位置；无记录返回 null（走 CSS 默认右上角）。 */
export function loadToolbarPosition(scope: string): ToolbarPoint | null {
  if (!scope) return null
  try {
    const raw = localStorage.getItem(KEY_PREFIX + scope)
    if (!raw) return null
    const value = JSON.parse(raw)
    if (!value || !Number.isFinite(value.left) || !Number.isFinite(value.top)) return null
    return { left: value.left, top: value.top }
  } catch {
    return null
  }
}

/** 保存工具条位置；存储失败仅影响下次恢复，不影响本次拖动。 */
export function saveToolbarPosition(scope: string, point: ToolbarPoint): void {
  if (!scope) return
  try { localStorage.setItem(KEY_PREFIX + scope, JSON.stringify(point)) } catch { /* 忽略 */ }
}
