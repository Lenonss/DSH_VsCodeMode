/**
 * dsh-vscode-mode — 会话引用语法（`@相对路径 Lx-Ly`）的解析与格式化。
 *
 * 双面共享（client 复制/粘贴/拖拽拦截 + host 无关），故放在 shared 且不引入 node/react。
 *
 * 语义（与 VS Code「复制行引用/添加选区到对话」对齐）：
 * - 路径统一 `/` 分隔、相对工作区；
 * - 行区间后缀 `L12`（单行）或 `L12-L20`（多行），只有存在真实行范围时才带；
 * - 复制拦截规则：跨行选区一律算引用；单行只有**整行选中**才算（否则普通复制）。
 *
 * @author ddj 2026年11月15号
 */

/** 引用行范围（1-based，闭区间）。 */
export interface RefRange {
  startLine: number
  endLine: number
}

/** 解析结果。 */
export interface ParsedRef {
  path: string
  range?: RefRange
}

/** 引用文本正则：`@path` 或 `@path L3-L5`；路径可加引号以容纳空格。 */
const REF_PATTERN = /^\s*@?(?:"([^"]+)"|(\S+?))(?:\s+L(\d+)(?:-L?(\d+))?)?\s*$/

/**
 * 路径归一：反斜杠转 `/`、去掉前导 `./` 与 `@`。
 * @author ddj 2026年11月15号
 * @param path 原始路径
 * @returns 归一后的相对路径
 */
export function normalizeRefPath(path: string): string {
  let text = String(path ?? '').trim().split('\\').join('/')
  if (text.startsWith('@')) text = text.slice(1)
  while (text.startsWith('./')) text = text.slice(2)
  return text
}

/**
 * 格式化引用文本。
 * @author ddj 2026年11月15号
 * @param path 工作区相对路径
 * @param range 行范围（可空）
 * @returns `@path` / `@path L3` / `@path L3-L5`
 */
export function formatRef(path: string, range?: RefRange | null): string {
  const relative = normalizeRefPath(path)
  if (!relative) return ''
  if (!range || !Number.isFinite(range.startLine)) return '@' + relative
  const start = Math.max(1, Math.trunc(range.startLine))
  const end = Math.max(start, Math.trunc(range.endLine ?? start))
  return start === end ? '@' + relative + ' L' + start : '@' + relative + ' L' + start + '-L' + end
}

/**
 * 解析剪贴板/拖拽里的引用文本（整段必须是一条引用，否则返回 null）。
 * @author ddj 2026年11月15号
 * @param text 原始文本
 * @returns 解析结果；不是引用语法时返回 null
 */
export function parseRef(text: string): ParsedRef | null {
  const raw = String(text ?? '').trim()
  if (!raw || raw.length > 4096) return null
  const matched = REF_PATTERN.exec(raw)
  if (!matched) return null
  const path = normalizeRefPath(matched[1] ?? matched[2] ?? '')
  if (!path) return null
  const start = matched[3] === undefined ? undefined : Number(matched[3])
  const end = matched[4] === undefined ? start : Number(matched[4])
  if (start === undefined || !Number.isFinite(start) || start < 1) return { path }
  return { path, range: { startLine: start, endLine: Math.max(start, end ?? start) } }
}

/**
 * 选区是否应转成「行引用」：跨行一律是；单行只有整行选中才是。
 * @author ddj 2026年11月15号
 * @param input 选区信息（行列均 1-based；endColumn 为选区右边界后一位）
 * @returns 行范围；不满足条件返回 null
 */
export function selectionRange(input: {
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  lineLength: number
}): RefRange | null {
  const startLine = Math.max(1, Math.trunc(Number(input.startLine) || 0))
  const endLine = Math.max(startLine, Math.trunc(Number(input.endLine) || startLine))
  const lineLength = Math.max(0, Math.trunc(Number(input.lineLength) || 0))
  if (endLine > startLine) return { startLine, endLine }
  const wholeLine = Math.trunc(Number(input.startColumn)) === 1 && Math.trunc(Number(input.endColumn)) === lineLength + 1
  return wholeLine && lineLength > 0 ? { startLine, endLine: startLine } : null
}

/**
 * 取路径末段文件名（引用解析/同名匹配用）。
 * @author ddj 2026年11月15号
 * @param path 路径文本
 * @returns 文件名
 */
export function refBasename(path: string): string {
  return normalizeRefPath(path).split('/').filter(Boolean).pop() ?? ''
}
