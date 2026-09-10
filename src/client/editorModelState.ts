/**
 * dsh-vscode-mode client — 编辑器模型可用性探测（模块级，不依赖 React）。
 * 命令可用性判定（快捷键过滤 / 命令栏隐藏 / 执行前置检查）需要「当前是否有活动编辑器」，
 * 而命令目录是模块级常量、拿不到 EditorView 实例，故统一读 DOM 标记：
 * `[data-edrv-view]` 只在 EditorView 挂载期存在于文档中（浮层 portal 走同一根节点）。
 * 作者 ddj 2026年09月10号
 */

/** 编辑器根节点选择器（EditorView 三种形态共用）。 */
export const EDITOR_ROOT_SELECTOR = '[data-edrv-view]'

/**
 * 当前文档是否挂载了编辑器视图（无 document 的运行环境返回 false）。
 * @author ddj 2026年09月10号
 * @returns 是否存在编辑器根节点
 */
export function hasEditorView(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(EDITOR_ROOT_SELECTOR) !== null
}

/**
 * 当前文档是否已有 Monaco 活动模型（编辑器打开着文件而非空态）。
 * @author ddj 2026年09月10号
 * @returns 是否存在活动模型
 */
export function hasEditorModel(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector('.monaco-editor textarea.inputarea') !== null
}
