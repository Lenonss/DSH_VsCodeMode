/**
 * Lua 5.3 保留字，供编辑器补全与调试悬停共同使用。
 * 作者 ddj 2026年09月24号
 */
export const LUA_RESERVED_WORDS = [
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
] as const

export const LUA_RESERVED_WORD_SET: ReadonlySet<string> = new Set(LUA_RESERVED_WORDS)
