/**
 * dsh-vscode-mode client — Markdown 文件判定（编辑区预览用）。
 * 纯函数、无 DOM/React 依赖，便于单测。
 * @author ddj 2026年09月18号
 */

/** 可进入预览的 Markdown 扩展名（小写、无点）。 */
const MARKDOWN_EXT_SET: Set<string> = new Set(['md', 'markdown'])

/**
 * 判断路径是否为可预览的 Markdown 文件（取 basename 扩展名，大小写不敏感）。
 *
 * 为什么不含 `mdx`：官方 MarkdownText 只走 GFM+KaTeX 语法，不解析 JSX；
 * 对 .mdx 做「预览」会把 JSX 当字面文本渲染出来，比文本编辑更容易误导，故排除。
 * @author ddj 2026年09月18号
 * @param path 文件路径（`/` 或 `\` 分隔均可）
 * @returns 是否 Markdown 文件
 */
export function isMarkdownPath(path: string): boolean {
  const base = String(path || '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return MARKDOWN_EXT_SET.has(base.slice(dot + 1).toLowerCase())
}
