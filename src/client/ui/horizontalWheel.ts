/**
 * dsh-vscode-mode client — 溢出容器的滚轮横向滚动（页签栏用）。
 *
 * 需求 3：页签栏出现水平滚动条时，用鼠标滚轮（垂直滚动轮）也能横向滚动。
 * 浏览器对 `overflow-x: auto` 的容器**不会**把垂直滚轮折算成横向滚动（只有原生横向
 * 滚轮/触控板横滑或 Shift+滚轮才横滚），故需要显式接管。
 *
 * 设计取舍：
 * - **不溢出就不接管**：内容放得下时滚轮必须保持页面垂直滚动语义，绝不能 preventDefault。
 * - **Shift+滚轮不接管**：Chrome/Edge 对横向溢出容器原生支持 Shift+滚轮横滚，
 *   我们再次处理会导致位移翻倍。
 * - 触控板的横向手势（deltaX）与纵向手势（deltaY）都按主分量取用。
 *
 * `wheelScrollStep` 为纯函数（node 可测）；`attachHorizontalWheel` 只做 DOM 装配。
 * 作者 ddj 2026年09月18号
 */

/** 行模式（deltaMode === 1）下一「行」折算的像素数（主流浏览器约 16px 行高）。 */
const LINE_HEIGHT_PX = 16

/** 滚轮输入（DOM WheelEvent 的相关字段子集，便于单测构造）。 */
export interface WheelInput {
  deltaX: number
  deltaY: number
  /** 0 = 像素 / 1 = 行 / 2 = 页。 */
  deltaMode: number
  shiftKey: boolean
}

/** 容器几何（只需可滚宽度与可视宽度）。 */
export interface WheelGeometry {
  scrollWidth: number
  clientWidth: number
}

/**
 * 计算一次滚轮事件应产生的横向位移。
 * @author ddj 2026年09月18号
 * @param input 滚轮事件字段
 * @param geometry 容器几何（未溢出时返回 0，即不接管）
 * @returns 横向位移（px，带符号）；0 表示本事件不处理（调用方不得 preventDefault）
 */
export function wheelScrollStep(input: WheelInput, geometry: WheelGeometry): number {
  const scrollable = Number(geometry?.scrollWidth) - Number(geometry?.clientWidth)
  if (!Number.isFinite(scrollable) || scrollable <= 0) return 0
  // Shift+滚轮交给浏览器原生横滚（处理两次会翻倍）
  if (input?.shiftKey === true) return 0
  const dx = Number(input?.deltaX) || 0
  const dy = Number(input?.deltaY) || 0
  const raw = Math.abs(dx) >= Math.abs(dy) ? dx : dy
  if (!raw) return 0
  const mode = input?.deltaMode | 0
  if (mode === 1) return Math.round(raw * LINE_HEIGHT_PX)
  if (mode === 2) return Math.round(raw * Number(geometry.clientWidth || 0))
  return Math.round(raw)
}

/** 可挂载滚轮的节点最小形状（浏览器元素或测试替身）。 */
export interface WheelTarget {
  addEventListener: (type: string, listener: (event: unknown) => void, options?: unknown) => void
  removeEventListener: (type: string, listener: (event: unknown) => void, options?: unknown) => void
}

/**
 * 给横向溢出容器挂上「垂直滚轮驱动横向滚动」。
 * 监听器为 `passive: false`（需要 preventDefault 阻止页面滚动），仅在需要位移时阻止默认行为。
 * @author ddj 2026年09月18号
 * @param node 目标元素（空则返回空注销器，不做任何事）
 * @returns 注销函数（幂等调用安全）
 */
export function attachHorizontalWheel(node: WheelTarget | null | undefined): () => void {
  if (!node || typeof node.addEventListener !== 'function') return () => {}
  const onWheel = (event: unknown): void => {
    const e = event as WheelInput & { preventDefault?: () => void }
    const step = wheelScrollStep(
      { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, shiftKey: e.shiftKey },
      { scrollWidth: (node as unknown as { scrollWidth: number }).scrollWidth, clientWidth: (node as unknown as { clientWidth: number }).clientWidth },
    )
    if (!step) return
    e.preventDefault?.()
    ;(node as unknown as { scrollLeft: number }).scrollLeft += step
  }
  node.addEventListener('wheel', onWheel, { passive: false })
  return () => node.removeEventListener('wheel', onWheel, { passive: false })
}
