/**
 * dsh-vscode-mode client — React 元素类型判定（纯函数，无 React/primitives 依赖）。
 *
 * 用途：编辑区 Markdown 预览要判断官方 `MarkdownText` 原语是否可用（旧版 DSH 可能缺该导出）。
 *
 * ⚠️ 为什么不能只判 `typeof value === 'function'`：
 * 官方 `MarkdownText` 是 `React.memo(...)` 的产物（`MemoExoticComponent`），
 * 其 `typeof` 是 **'object'** 而非 'function'。函数判据恒为 false，会让「兼容降级」分支在
 * **所有新版 DSH 上永久生效** —— 表现是预览只显示纯文本降级提示。
 * 该缺陷由 GUI 端到端验证捕获：纯函数单测不覆盖该守卫，手写垫片又把它声明得很宽松，
 * 故 tsc 与既有测试都无法发现。抽出本模块正是为了让它有单测守约。
 *
 * 判定口径与 React 自身一致：函数（函数组件 / 类组件），或带 `$$typeof` 标记的非 null
 * 对象（memo / forwardRef / lazy 等「外部对象类型」）。
 * 作者 ddj 2026年09月18号
 */

/**
 * 判断值是否可作为 React 元素类型传给 `React.createElement`。
 * @author ddj 2026年09月18号
 * @param value 候选组件（undefined/null 表示该导出不存在）
 * @returns 是否可作为元素类型使用
 */
export function isComponentType(value: unknown): boolean {
  if (typeof value === 'function') return true
  if (typeof value !== 'object' || value === null) return false
  return (value as { $$typeof?: unknown }).$$typeof !== undefined
}
