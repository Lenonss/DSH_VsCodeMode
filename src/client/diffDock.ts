/**
 * dsh-vscode-mode client — 对话差异 dock 纯函数。
 * 只负责差异文件轮转和文案，状态查询仍由组件复用现有 edrv.list/summarize。
 * 作者 ddj 2026-08-26
 */

/**
 * 从稳定差异文件列表中取下一个路径，并返回下一次索引。
 * @author ddj 2026年08月26号
 * @param paths 待处理差异文件路径
 * @param index 当前轮转索引
 * @returns 下一个路径与归一化后的下一索引
 */
export function nextDiffPath(paths: string[], index: number): { path: string | null; index: number } {
  if (!paths.length) return { path: null, index: 0 }
  const current = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0
  const at = current % paths.length
  return { path: paths[at] ?? null, index: (at + 1) % paths.length }
}

/**
 * 生成对话差异 dock 的单按钮文案。
 * @author ddj 2026年08月26号
 * @param count 待处理差异文件数量
 * @returns 展示文案
 */
export function diffDockText(count: number): string {
  return '差异 ' + Math.max(0, Math.floor(count)) + ' 个文件 · 查看下一个'
}

/**
 * 根据活动文件决定编辑页 dock 形态，加载期间保持 editor 结构稳定。
 * @author ddj 2026年08月26号
 * @param activePath 当前活动文件路径
 * @returns 编辑态或无文件空态
 */
export function editorDockMode(activePath: string | null | undefined): 'editor' | 'editor-empty' {
  return activePath ? 'editor' : 'editor-empty'
}

/**
 * 获取切换文件期间稳定展示的文件内差异数量。
 * @author ddj 2026年08月26号
 * @param ready 当前文件内容是否已加载完成
 * @param actualTotal 内容就绪后的精确差异数
 * @param fallbackTotal 内容加载期间的文件摘要差异数
 * @returns 非负整数差异数
 */
export function displayDiffTotal(ready: boolean, actualTotal: number, fallbackTotal: number): number {
  const value = ready ? actualTotal : fallbackTotal
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}
