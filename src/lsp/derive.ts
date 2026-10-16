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

/** 文本读取回调（服务器提供：已打开文档走内存，其余读盘）。 */
export interface CrossFileLookup {
  readText: (uri: string) => Promise<string | null>
  maxFiles?: number
}

/** 提取文本开头的标识符链（`EventId.ISTaskSystem = {` → ['EventId','ISTaskSystem']）。 */
function chainOf(text: string): string[] {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)/.exec(text)
  if (!match) return []
  return match[1].replace(/\s+/g, '').split('.')
}

/**
 * 判定切片文本是否为查询链的声明形候选：链后紧跟单个 '='（name = ... 赋值，排除 '==' 比较），
 * 且候选链是查询链的段级前缀（外层表声明 `EventId.ISTaskSystem = {`）或末段一致（叶字段声明
 * `TaskStateChange = 50000,`）。
 */
function isDeclarationMatch(word: string, queryChain: string[]): boolean {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*(=)(?!=)/.exec(word)
  if (!match) return false
  const chain = match[1].replace(/\s+/g, '').split('.')
  if (!chain.length || chain.length > queryChain.length) return false
  // 候选是查询链的外层声明（EventId.ISTaskSystem = {）
  const prefix = queryChain.slice(0, chain.length)
  if (chain.every((seg, i) => seg === prefix[i])) return true
  // 候选末段与查询链末段一致（TaskStateChange = 50000 是链叶字段声明）
  if (chain[chain.length - 1] === queryChain[queryChain.length - 1]) return true
  return false
}

/**
 * 跨文件声明推导（definition/declaration 均空、同文件推导只给出"点击处自身"时的兜底）。
 * 背景：EmmyLua 0.9.41 对成员链字段（EventId.ISTaskSystem.TaskStateChange）的 definition 恒返回空，
 * 但 references(includeDeclaration) 在词中/尾位置包含字段声明位置（声明文件内的 `XXX = {...}` /
 * `KEY = value,` 赋值行）。同文件推导把跨文件声明过滤掉 → 这里放宽到跨文件，
 * 用"段级相等/前缀/后缀 + 赋值形（单个 '='）"识别声明，并读取目标文件文本做词级校验。
 * 文件读取有上限（maxFiles），防止大工作区把跳转拖慢。
 * @author ddj 2026年10月15号
 * @param queryPos 查询位置（调用方已 nudge 到词尾）
 * @param locations references(includeDeclaration) 结果
 * @param docText 当前文档全文（取点击链）
 * @param docAbsPath 当前文档绝对路径（file:// URI）
 * @param lookup 文件文本读取器与读取上限
 * @returns 跨文件声明位置；未识别到返回 null
 */
export async function deriveCrossFileDeclaration(
  queryPos: LspPosition,
  locations: LspLocation[],
  docText: string,
  docAbsPath: string,
  lookup: CrossFileLookup,
): Promise<LspLocation | null> {
  if (!locations.length) return null
  const docAbs = normAbs(docAbsPath)

  // 点击位置落在的条目（多个时取最小包裹），取其词文本的标识符链作为查询链
  const containing = locations
    .filter((loc) => posInLspRange(queryPos, loc.range))
    .sort((a, b) => rangeSize(a.range) - rangeSize(b.range))[0]
  if (!containing) return null
  const queryChain = chainOf(sliceRange(docText, containing.range))
  if (!queryChain.length) return null

  // 声明候选集中在低列（EventId = {} 在 col0、表字段 `TaskStateChange = 50000,` 在 col4），
  // 使用点通常在 col10+。按列升序优先读取"声明形"文件，避免 3884 条引用按原序只读到使用文件
  // 就耗尽 maxFiles。每个文件只读一次，但文件内每个位置都要判定。
  const maxFiles = lookup.maxFiles ?? 8
  const textByKey = new Map<string, string | null>()
  let best: LspLocation | null = null
  let bestChainLen = Number.POSITIVE_INFINITY
  const ordered = [...locations].sort((a, b) => {
    const ca = a.range.start.character - b.range.start.character
    return ca !== 0 ? ca : a.range.start.line - b.range.start.line
  })
  for (const loc of ordered) {
    const key = normAbs(loc.uri)
    if (key === docAbs) continue
    let text = textByKey.get(key)
    if (text === undefined) {
      if (textByKey.size >= maxFiles) break
      text = await lookup.readText(loc.uri)
      textByKey.set(key, text ?? null)
    }
    if (!text) continue
    // 声明检测需看到标识符后的 `= value`，而引用条目 range 常只覆盖标识符本身
    // （如 EventId = {} 的 range 是 0:0-0:7，'=' 在 8）。取从 range.start 到行末的文本。
    const word = sliceToLineEnd(text, loc.range)
    const chain = chainOf(word)
    if (chain.length && chain.length <= bestChainLen && isDeclarationMatch(word, queryChain)) {
      best = loc
      bestChainLen = chain.length
      if (bestChainLen === 1) break
    }
  }
  return best
}

/** 从 range.start 到所在行末的切片（声明形判定需覆盖标识符后的 `= value`）。 */
function sliceToLineEnd(text: string, range: LspRange): string {
  const lines = text.split(/\r\n|\r|\n/)
  const line = lines[Math.max(0, range.start.line)] ?? ''
  return line.slice(Math.max(0, range.start.character))
}

/**
 * 判定"直接 definition 结果是否为同文件误解析（把使用点当定义）"。
 * 背景：EmmyLua 0.9.41 对跨文件全局（EventId = {} 定义在别的文件）的 textDocument/definition
 * 常错误返回当前文件最后一个使用点（如 SubHandler:94 的 `{ EventId.NewActivity...`），而非声明文件。
 * 特征：直接结果全部位于查询文档同文件，且首个结果的切片文本不是点击链的声明形
 * （local/function 声明或 `链 = ...` 赋值）。命中即应降级走跨文件声明推导。
 * @author ddj 2026年10月15号
 * @param docAbsPath 当前文档绝对路径（file:// URI 或绝对路径）
 * @param locations 直接 definition 结果
 * @param docText 当前文档全文（取点击链）
 * @param position 查询位置（调用方已 nudge 到词尾）
 */
export function isMisresolvedSameFileUsage(
  docAbsPath: string,
  locations: LspLocation[],
  docText: string,
  position: LspPosition,
): boolean {
  if (!locations.length) return false
  const docAbs = normAbs(docAbsPath)
  // 直接结果含跨文件条目 → 正常定义，不疑误
  if (locations.some((loc) => normAbs(loc.uri) !== docAbs)) return false
  const chainRange = chainRangeAt(docText, position)
  if (!chainRange) return false
  const queryChain = chainOf(sliceRange(docText, chainRange))
  if (!queryChain.length) return false
  // 取行末切片，覆盖 local/function 前缀与 `= value`（range 常只覆盖标识符本身）
  return !isDeclarationForm(sliceToLineEnd(docText, locations[0].range), queryChain)
}

/** 取 position 处的标识符/成员链 range（0-based，取所在行内的链）。 */
function chainRangeAt(text: string, pos: LspPosition): LspRange | null {
  const line = text.split(/\r\n|\r|\n/)[pos.line] ?? ''
  const re = /[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    const start = m.index
    const end = start + m[0].length
    if (pos.character >= start && pos.character < end) {
      return { start: { line: pos.line, character: start }, end: { line: pos.line, character: end } }
    }
  }
  return null
}

/** 切片文本是否为查询链的"声明形"（local/function 声明或 `链 = ...` 赋值）。 */
function isDeclarationForm(word: string, queryChain: string[]): boolean {
  const t = word.replace(/^\s+/, '')
  if (/^(local\b|function\b)/.test(t)) return true
  return isDeclarationMatch(word, queryChain)
}
