/**
 * dsh-vscode-mode client — 候选列表键盘导航纯函数。
 * 从搜索浮窗（QuickOpen）的按键处理中拆出，便于单测；不依赖 React 与 DOM。
 * 导航语义：步进越界**循环**（末位 ↓ 回首位、首位 ↑ 到末位），与命令栏
 * （CommandPalette 的 (min+step) % len）保持一致。
 * 作者 ddj 2026年09月11号
 */

/**
 * 计算候选列表的下一选中下标（循环；任何非法输入都收敛到合法下标）。
 * 入参与返回值恒在 `[0, length - 1]`（`length <= 0` 时返回 0）。
 * 作者 ddj 2026年09月11号
 * @param current 当前选中下标（越界/非有限值按首位处理）
 * @param delta 步进（+1 下一项 / -1 上一项）
 * @param length 候选总数
 * @returns 步进后的选中下标；无候选时返回 0
 */
export function stepIndex(current: number, delta: number, length: number): number {
  if (!Number.isFinite(length) || length <= 0) return 0
  const size = Math.floor(length)
  const from = Math.min(Math.max(Number.isFinite(current) ? Math.floor(current) : 0, 0), size - 1)
  const move = Number.isFinite(delta) ? Math.trunc(delta) : 0
  return ((from + move) % size + size) % size
}
