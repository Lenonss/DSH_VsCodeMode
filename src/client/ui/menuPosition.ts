/**
 * dsh-vscode-mode client — 右键菜单 viewport 定位纯函数。
 * 将目标行锚点与视口边界计算从 React 渲染层拆出，便于复用和单测。
 * 作者 ddj 2026-08-28
 */

export interface MenuPosition {
  left: number
  top: number
}

export interface MenuAnchorRect {
  top: number
  right: number
  width: number
  height: number
}

/**
 * 将菜单坐标限制在 viewport 内。
 * @author ddj 2026年08月28号
 * @param x 期望的 viewport x 坐标
 * @param y 期望的 viewport y 坐标
 * @param viewportWidth viewport 宽度
 * @param viewportHeight viewport 高度
 * @param menuWidth 菜单估算宽度
 * @param menuHeight 菜单估算高度
 * @returns 限制后的菜单位置
 */
export function clampMenuPosition(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth: number,
  menuHeight: number,
): MenuPosition {
  const maxLeft = Math.max(4, viewportWidth - menuWidth)
  const maxTop = Math.max(4, viewportHeight - menuHeight)
  return {
    left: Math.max(4, Math.min(x, maxLeft)),
    top: Math.max(4, Math.min(y, maxTop)),
  }
}

/**
 * 将文件树行右键菜单锚定到目标行右侧；无法测量时回退到鼠标坐标。
 * @author ddj 2026年08月28号
 * @param rect 目标行的布局矩形
 * @param fallbackX 鼠标 viewport x 坐标
 * @param fallbackY 鼠标 viewport y 坐标
 * @returns 菜单初始位置
 */
export function rowMenuPosition(
  rect: MenuAnchorRect | null | undefined,
  fallbackX: number,
  fallbackY: number,
): MenuPosition {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { left: fallbackX, top: fallbackY }
  }
  return { left: rect.right + 4, top: rect.top }
}
