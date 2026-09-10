/**
 * dsh-vscode-mode client — 编辑器模型可用性探测（模块级，不依赖 React）。
 * 命令可用性判定（快捷键过滤 / 命令栏隐藏 / 执行前置检查）需要「当前是否有活动编辑器」，
 * 而命令目录是模块级常量、拿不到 EditorView 实例，故统一读 DOM 标记。
 *
 * ⚠️ 判据必须与 Monaco 的**输入实现无关**：
 * 旧实现探测 `.monaco-editor textarea.inputarea`，而 Monaco 在有 EditContext API 的浏览器
 * （Chrome/Edge）中默认用它取代 textarea（源码 `editContext: se(44,"editContext",!0)`），
 * 只创建 `div.native-edit-context` —— 于是「编辑器明明开着文件」却判定为无模型，
 * 导致 13 条 needsModel 命令（含 Ctrl+U 加引用、Ctrl+Alt+↑↓ 编辑行、命令栏里的保存/定义/引用等）
 * 全部被静默隐藏且按键被放行（不吞键）→ 表现为「快捷键完全没效果」。
 * 现判据用插件编辑器专属类名（不随 Monaco 输入实现演进、也不会误命中官方预览的 Monaco）。
 * 作者 ddj 2026年09月10号
 */

/** 编辑器行根节点选择器（EditorView 三种形态共用；浮层 portal 不含该类名）。 */
export const EDITOR_ROOT_SELECTOR = '.edrv-editor-row'

/** Monaco 编辑器实例选择器（限定在插件编辑器行内，排除官方预览等其它 Monaco）。 */
export const EDITOR_MODEL_SELECTOR = EDITOR_ROOT_SELECTOR + ' .monaco-editor'

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
 * 当前文档是否已有 Monaco 活动编辑器（编辑器打开着文件而非空态）。
 * 判据为插件编辑器行内存在 Monaco 实例：与输入实现（textarea / EditContext）无关，
 * 空态（无文件页签）时 Monaco 未创建 → 返回 false，与旧语义一致。
 * @author ddj 2026年09月10号
 * @returns 是否存在活动编辑器
 */
export function hasEditorModel(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(EDITOR_MODEL_SELECTOR) !== null
}
