/**
 * dsh-vscode-mode host — 定义查找降级链的纯推导函数。
 * 背景：EmmyLua 对局部变量/参数/表字段的 textDocument/definition 常返回空，
 * 但 references(includeDeclaration) 能给出包含声明的条目。
 * 本函数从引用列表推导"声明位置"：同文件、词文本与点击处一致，且点击位置落在某条目内时，
 * 取列表首个（EmmyLua 对局部/参数把声明排在引用首位；点击处即首个时按"点击了声明"处理）。
 * 词文本必须与点击词一致，否则拒绝（宁可空，不误跳）。
 * 作者 ddj 2026-09-02
 */
import type { LspLocation, LspPosition, LspRange } from '../shared/lsp.js'

/** file:// URI（或裸路径）→ 归一化绝对路径（小写、/ 分隔）。 */
function normAbs(uri: string): string {
  const path = String(uri ?? '').replace(/^file:\/\/\/?/, '')
  return decodeURIComponent(path).replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1').toLowerCase()
}

/** 取文档 text 在 LSP range（0-based）内的切片。 */
function sliceRange(text: string, range: LspRange): string {
  const lines = text.split(/\r\n|\r|\n/)
  const start = range.start
  const end = range.end
  const startLine = Math.max(0, start.line)
  const endLine = Math.max(startLine, end.line)
  if (startLine >= lines.length || endLine >= lines.length) return ''
  const startChar = Math.max(0, start.character)
  if (startLine === endLine) {
    return lines[startLine].slice(startChar, Math.max(startChar, end.character))
  }
  const first = lines[startLine].slice(startChar)
  const middle = lines.slice(startLine + 1, endLine)
  const last = lines[endLine].slice(0, Math.max(0, end.character))
  return [first, ...middle, last].join('\n')
}

/** LSP position 是否落在 range 内（start 包含、end 排除；零宽按点匹配）。 */
function posInLspRange(pos: LspPosition, range: LspRange): boolean {
  const start = range.start
  const end = range.end ?? start
  if (start.line === end.line && start.character === end.character) {
    return pos.line === start.line && pos.character === start.character
  }
  if (pos.line < start.line || pos.line > end.line) return false
  if (pos.line === start.line && pos.character < start.character) return false
  if (pos.line === end.line && pos.character >= end.character) return false
  return true
}

/** 两个 range 是否完全一致。 */
function sameRange(a: LspRange, b: LspRange): boolean {
  return a.start.line === b.start.line && a.start.character === b.start.character &&
    a.end.line === b.end.line && a.end.character === b.end.character
}

/** range 长度（行/列均按 0-based 差估算，仅用于取"最小包裹"排序）。 */
function rangeSize(r: LspRange): number {
  return (r.end.line - r.start.line) * 1_000_000 + (r.end.line === r.start.line ? r.end.character - r.start.character : r.end.character)
}

/**
 * 从引用列表推导定义位置。
 * @author ddj 2026年09月02号
 * @param queryPos 查询位置（LSP 0-based）
 * @param locations references(includeDeclaration) 结果
 * @param docText 当前文档全文（词文本一致校验）
 * @param docAbsPath 当前文档绝对路径（root+相对路径，与 loc.uri 归一化后比较）
 * @returns 推导出的定义位置；无法确定返回 null
 */
export function deriveDefinitionFromLocations(
  queryPos: LspPosition,
  locations: LspLocation[],
  docText: string,
  docAbsPath: string,
): LspLocation | null {
  if (!locations.length) return null
  const docAbs = normAbs(docAbsPath)

  // 点击位置落在的条目（多个时取最小包裹 = 最贴近词的 range）
  const containing = locations
    .filter((loc) => posInLspRange(queryPos, loc.range))
    .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0]
  if (!containing) return null
  const queryWord = sliceRange(docText, containing.range)
  if (!queryWord) return null

  // 同文件 + 词文本一致的候选（按服务器返回顺序）
  const candidates = locations.filter((loc) => {
    return normAbs(loc.uri) === docAbs && sliceRange(docText, loc.range) === queryWord
  })
  if (!candidates.length) return null

  // 点击处即候选首个（且与查询词重合）→ 点击的就是声明，返回自身
  // 否则取首个（EmmyLua 对局部/参数把声明排在引用首位）
  const first = candidates[0]
  return sameRange(first.range, containing.range) ? containing : first
}
