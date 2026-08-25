/**
 * dsh-vscode-mode client — 编辑区与原生 composer 的几何边界计算。
 * @author ddj 2026年08月26号
 */

/**
 * 计算编辑根节点在当前会话滚动区内、composer 上方可使用的高度。
 * @author ddj 2026年08月26号
 * @param rootTop 编辑根节点顶边
 * @param scrollBottom 会话滚动区可视底边
 * @param composerTop composer 顶边；缺失时回退滚动区底边
 * @returns 非负可用高度
 */
export function editorHeight(rootTop: number, scrollBottom: number, composerTop?: number): number {
  const root = Number.isFinite(rootTop) ? rootTop : 0
  const scroll = Number.isFinite(scrollBottom) ? scrollBottom : root
  const composer = Number.isFinite(composerTop) ? composerTop as number : scroll
  return Math.max(0, Math.min(scroll, composer) - root)
}
