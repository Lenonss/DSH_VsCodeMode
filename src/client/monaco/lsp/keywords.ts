/**
 * 为 Lua 的 LSP 补全补充服务器缺失的保留字与注解基础类型候选。
 * 作者 ddj 2026年09月24号
 */
import { LUA_RESERVED_WORDS } from '../../luaReservedWords.js'

const LUA_BASE_TYPES = [
  'any', 'boolean', 'integer', 'nil', 'number', 'string', 'table', 'thread', 'userdata',
] as const
const TYPE_START = /^\s*---@(?:(?:type|return)\s+|param\s+\S+\s+|field\s+(?:(?:public|private|protected|package)\s+)?\S+\s+)(.*)$/

interface KeywordRange {
  startLineNumber: number
  endLineNumber: number
  startColumn: number
  endColumn: number
}

interface KeywordItem {
  label: string
  kind: number
  insertText: string
  range: KeywordRange
  detail: string
}

/**
 * 构造轻量本地候选，保留服务器同名项的优先权交给 mergeKeywords。
 * @author ddj 2026年09月24号
 * @param words 候选文本
 * @param kind Monaco 候选类型
 * @param range 当前单词范围
 * @param detail 候选说明
 * @returns 可直接交给 Monaco 的候选
 */
function keywordItems(words: readonly string[], kind: number, range: KeywordRange, detail: string): KeywordItem[] {
  return words.map((label) => ({ label, kind, insertText: label, range, detail }))
}

/**
 * 判断光标是否在 EmmyLua 注解的类型槽；普通注释和描述文字均不匹配。
 * @author ddj 2026年09月24号
 * @param model 当前文档
 * @param position 光标所在行
 * @param range 当前词范围
 * @returns 是否应提示基础类型
 */
export function isLuaTypeSlot(
  model: { getLineContent(lineNumber: number): string },
  position: { lineNumber: number },
  range: Pick<KeywordRange, 'startColumn'>,
): boolean {
  const beforeWord = model.getLineContent(position.lineNumber).slice(0, range.startColumn - 1)
  const match = TYPE_START.exec(beforeWord)
  if (!match) return false
  const context = match[1] ?? ''
  const typePrefix = context.trimEnd()
  if (/[.:]$/.test(typePrefix)) return false
  return !(/\s$/.test(context) && typePrefix && !/[|&,<]$/.test(typePrefix))
}

/**
 * 在普通代码位置生成关键字；成员名和类型注解位置只交给对应候选。
 * @author ddj 2026年09月24号
 * @param monaco Monaco 语言枚举
 * @param model 当前文档
 * @param position 光标所在行
 * @param range 当前单词的替换范围
 * @returns 当前上下文可用的 Lua 关键字候选
 */
export function luaKeywordsAt(
  monaco: { languages: { CompletionItemKind: { Keyword: number } } },
  model: { getLineContent(lineNumber: number): string },
  position: { lineNumber: number },
  range: KeywordRange,
): KeywordItem[] {
  const line = model.getLineContent(position.lineNumber)
  const beforeWord = line.charAt(range.startColumn - 2)
  if (beforeWord === '.' || beforeWord === ':' || /^\s*---@/.test(line)) return []
  return keywordItems(LUA_RESERVED_WORDS, monaco.languages.CompletionItemKind.Keyword, range, 'Lua 关键字')
}

/**
 * 仅在注解类型槽补最基本类型，项目类型和服务器自带类型仍由 LSP 提供。
 * @author ddj 2026年09月24号
 * @param monaco Monaco 语言枚举
 * @param model 当前文档
 * @param position 光标所在行
 * @param range 当前单词的替换范围
 * @returns 类型候选；非注解返回空数组
 */
export function luaTypesAt(
  monaco: { languages: { CompletionItemKind: { Keyword: number } } },
  model: { getLineContent(lineNumber: number): string },
  position: { lineNumber: number },
  range: KeywordRange,
): KeywordItem[] {
  if (!isLuaTypeSlot(model, position, range)) return []
  return keywordItems(LUA_BASE_TYPES, monaco.languages.CompletionItemKind.Keyword, range, 'Lua 基础类型')
}

/**
 * 合并 LSP 与本地关键字，服务器同名项优先并保持原顺序。
 * @author ddj 2026年09月24号
 * @param server 服务器候选
 * @param keywords 本地关键字候选
 * @returns 去重后的补全列表
 */
export function mergeKeywords<T extends { label: string }, U extends { label: string }>(
  server: T[],
  keywords: U[],
): Array<T | U> {
  if (keywords.length === 0) return server
  const labels = new Set(server.map((item) => item.label))
  const merged: Array<T | U> = [...server]
  for (const keyword of keywords) {
    if (labels.has(keyword.label)) continue
    merged.push(keyword)
  }
  return merged
}
