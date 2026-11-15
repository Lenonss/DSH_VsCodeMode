/**
 * dsh-vscode-mode host — 全局替换的纯逻辑：模式编译、空匹配拒绝、逐行替换与计数。
 *
 * 为什么按「行」而不是整段正则：
 * 1. 编辑器里的搜索是行感知的（`^`/`$` 在行首行尾生效、`.` 不跨行），替换必须同语义；
 * 2. CRLF 文件按行拆分后能原样拼回，不会把 `\r\n` 洗成 `\n`；
 * 3. 命中跨行结构的需求可以用正则里的 `\n` 表达，但只能是用户显式写出。
 *
 * 纯函数，不碰 fs / ctx，便于单测与事后复查破坏性行为。
 * @author ddj 2026年11月15号
 */

/** 替换请求（与 RPC 入参同形）。 */
export interface ReplaceQuery {
  query: string
  replacement: string
  regex?: boolean
  matchCase?: boolean
  wholeWord?: boolean
}

/** 编译后的替换模式。 */
export interface CompiledReplace {
  pattern: RegExp
  regex: boolean
  replacement: string
}

/** 正则源码长度上限：防止把超长串当正则编译（ReDoS 面与内存面都收窄）。 */
export const MAX_PATTERN_LENGTH = 4000

/**
 * 转义正则元字符（字面量模式用）。
 * @author ddj 2026年11月15号
 * @param text 原始文本
 * @returns 可安全嵌入正则的文本
 */
export function escapeRegExp(text: string): string {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 判断模式能否匹配空字符串（`a*`、`(?:)`、`x?` 等）。
 *
 * 这类模式在替换时会在每个字符间隙插入替换文本，破坏文件；发现即拒绝。
 * @author ddj 2026年11月15号
 * @param pattern 已编译模式（可带任意 flags）
 * @returns 是否可能匹配空串
 */
export function hasEmptyMatch(pattern: RegExp): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  const probe = new RegExp(pattern.source, flags)
  for (const sample of ['', 'a', 'ab', ' ', '\n']) {
    probe.lastIndex = 0
    const match = probe.exec(sample)
    if (match !== null && match[0] === '') return true
  }
  return false
}

/**
 * 编译替换模式（字面量模式转义；正则模式支持分组 `$1`）。
 * @author ddj 2026年11月15号
 * @param input 替换请求
 * @returns 编译结果
 * @throws 查询为空 / 正则无效 / 可匹配空串
 */
export function compileReplace(input: ReplaceQuery): CompiledReplace {
  const query = String(input.query ?? '')
  if (query === '') throw new Error('请先输入要查找的内容')
  if (query.length > MAX_PATTERN_LENGTH) throw new Error('查找内容过长（超过 ' + MAX_PATTERN_LENGTH + ' 字符）')
  const regex = input.regex === true
  const body = regex ? query : escapeRegExp(query)
  const wrapped = input.wholeWord === true ? '\\b(?:' + body + ')\\b' : (regex ? '(?:' + body + ')' : body)
  let pattern: RegExp
  try {
    pattern = new RegExp(wrapped, input.matchCase === true ? 'g' : 'gi')
  } catch (error) {
    throw new Error('正则表达式无效：' + (error instanceof Error ? error.message : String(error)))
  }
  if (hasEmptyMatch(pattern)) throw new Error('该查询可以匹配空字符串（例如 a*），替换会破坏文件，已拒绝')
  return { pattern, regex, replacement: String(input.replacement ?? '') }
}

/**
 * 统计一行内的命中数（用独立副本，避免污染调用方 lastIndex）。
 * @author ddj 2026年11月15号
 * @param line 单行文本
 * @param pattern 已编译模式
 * @returns 命中次数
 */
export function countInLine(line: string, pattern: RegExp): number {
  if (line === '') return 0
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  const probe = new RegExp(pattern.source, flags)
  let total = 0
  for (const matched of line.matchAll(probe)) {
    if (matched[0] !== '') total += 1
  }
  return total
}

/**
 * 逐行替换（保留行尾与 BOM；只改写确实变化的行）。
 * @author ddj 2026年11月15号
 * @param text 文件全文
 * @param compiled 编译后的模式
 * @returns 新文本与替换次数
 */
export function replaceInText(text: string, compiled: CompiledReplace): { text: string; count: number } {
  if (text === '') return { text, count: 0 }
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const body = bom ? text.slice(1) : text
  // 保留分隔符的拆分：奇数下标是行尾，偶数下标是行内容
  const parts = body.split(/(\r\n|\r|\n)/)
  const replacement = compiled.replacement
  let count = 0
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]
    const hits = countInLine(line, compiled.pattern)
    if (hits === 0) continue
    // 字面量模式用函数替换，保证用户输入的 `$` 不被解释成分组引用
    parts[index] = compiled.regex ? line.replace(compiled.pattern, replacement) : line.replace(compiled.pattern, () => replacement)
    count += hits
  }
  if (count === 0) return { text, count: 0 }
  return { text: bom + parts.join(''), count }
}

/**
 * 统计全文命中数（dryRun 预览用；与 replaceInText 同语义）。
 * @author ddj 2026年11月15号
 * @param text 文件全文
 * @param compiled 编译后的模式
 * @returns 命中次数
 */
export function countInText(text: string, compiled: CompiledReplace): number {
  if (text === '') return 0
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text
  const parts = body.split(/(\r\n|\r|\n)/)
  let total = 0
  for (let index = 0; index < parts.length; index += 2) total += countInLine(parts[index], compiled.pattern)
  return total
}
