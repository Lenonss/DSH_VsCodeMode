import type { MpcConfig } from '../shared/mcp.js'

export interface McpDraft {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command: string
  args: string
  cwd: string
  url: string
  headers: string
}

/**
 * @public
 * @author ddj 2026年10月08号
 * @description Parse lossless JSON string[] or one literal argument per nonempty line; no shell splitting.
 * @param text Argument field.
 * @returns Literal argument vector.
 * @throws Invalid JSON or a non-string array element.
 */
export function parseArgs(text: string): string[] {
  if (text.trimStart().startsWith('[')) {
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new Error('参数 JSON 无效，请输入 string[] 或每行一个参数') }
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      throw new Error('参数 JSON 必须是 string[]')
    }
    return value
  }
  return text.split(/\r?\n/).filter((line) => line.length > 0)
}

/**
 * @public
 * @author ddj 2026年10月08号
 * @description Validate HTTP headers; duplicates are case-insensitive and values retain embedded equals.
 * @param text One key=value header per line.
 * @returns Validated header dictionary.
 * @throws Missing separator, invalid/empty key, duplicate key, or illegal control characters.
 */
export function parsePairs(text: string): Record<string, string> {
  const pairs: Array<[string, string]> = []
  const keys = new Set<string>()
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    const separator = raw.indexOf('=')
    const key = raw.slice(0, separator).trim()
    const value = raw.slice(separator + 1).trim()
    if (separator < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw new Error('请求头第 ' + (index + 1) + ' 行格式错误，应为有效 key=value')
    }
    const normalized = key.toLowerCase()
    if (keys.has(normalized)) throw new Error('请求头重复：' + key)
    keys.add(normalized)
    pairs.push([key, value])
  }
  return Object.fromEntries(pairs)
}

/**
 * @public
 * @author ddj 2026年10月08号
 * @description Convert a form draft without losing argument boundaries or silently accepting malformed headers.
 * @param draft Current editable fields.
 * @returns Host MCP configuration.
 * @throws Argument/header validation errors; callers must keep the form open.
 */
export function configOf(draft: McpDraft): MpcConfig {
  const config: MpcConfig = { serverName: draft.serverName.trim(), transport: draft.transport }
  if (draft.transport === 'stdio') {
    config.command = draft.command.trim()
    config.args = parseArgs(draft.args)
    if (draft.cwd.trim()) config.cwd = draft.cwd.trim()
  } else {
    config.url = draft.url.trim()
    config.headers = parsePairs(draft.headers)
  }
  return config
}
