// @ts-nocheck
/**
 * dsh-vscode-mode client — 复制选区为会话引用（`@相对路径 Lx-Ly`）。
 *
 * 规则（与 VS Code「复制行引用」对齐）：跨行选区一律算引用（首尾半行也算）；
 * 单行只有整行选中才算，否则按普通文本复制，避免误伤「复制一小段代码」。
 *
 * 只在编辑器根节点内拦截：终端、输入框、其他插件里的复制完全不受影响。
 *
 * @author ddj 2026年11月15号
 */
import { formatRef, selectionRange } from '../shared/refSyntax.js'

/**
 * 计算当前选区应写入剪贴板的引用文本。
 * @author ddj 2026年11月15号
 * @param editor Monaco 编辑器实例
 * @param path 当前文件工作区相对路径
 * @returns 引用文本；不满足引用条件时返回 null
 */
export function copyRefOf(editor, path) {
  if (!editor || !path) return null
  let selection = null
  let model = null
  try {
    selection = editor.getSelection?.() ?? null
    model = editor.getModel?.() ?? null
  } catch (error) {
    return null
  }
  if (!selection || !model || selection.isEmpty?.() === true) return null
  let lineLength = 0
  try {
    lineLength = model.getLineLength(selection.endLineNumber) ?? 0
  } catch (error) {
    return null
  }
  const range = selectionRange({
    startLine: selection.startLineNumber,
    endLine: selection.endLineNumber,
    startColumn: selection.startColumn,
    endColumn: selection.endColumn,
    lineLength,
  })
  if (!range) return null
  return formatRef(path, range) || null
}

/**
 * 拦截 copy 事件：满足引用条件时改写剪贴板为引用文本。
 * @author ddj 2026年11月15号
 * @param event 剪贴板事件
 * @param editor Monaco 编辑器实例
 * @param path 当前文件工作区相对路径
 * @returns 是否已接管（false = 交给原生复制）
 * @sideEffects 写系统剪贴板
 */
export function handleCopyAsRef(event, editor, path) {
  if (!event) return false
  const text = copyRefOf(editor, path)
  if (!text) return false
  try {
    event.clipboardData?.setData('text/plain', text)
  } catch (error) {
    return false
  }
  event.preventDefault()
  event.stopPropagation()
  return true
}
