/**
 * dsh-vscode-mode shared — 外部深链 URL 契约（Windows launcher / Unity 包 / client 共用）。
 * 形态：?<FLAG>=1&<PATHS_KEY>=<enc1>[,<enc2>…] [&<LINE_KEY>=N] [&<COLUMN_KEY>=M]
 * 每个路径独立 percent-encode（encodeURIComponent / Uri.EscapeDataString）后以 `,` 连接：
 * 编码结果不含裸逗号（Windows 路径本身不允许逗号，编码兜底其余字符），URLSearchParams
 * 取值做一次标准解码即得 `enc1,enc2`，按 `,` split 即路径，无需二次 decode。
 * Purity rule: no node/react imports（URLSearchParams 为标准全局）。
 * 作者 ddj 2026-09-07
 */

/** 深链开关参数名（值恒为 '1'）。 */
export const EDRV_OPEN_FLAG = 'edrvOpen'
/** 路径列表参数名（逗号分隔的已编码路径）。 */
export const EDRV_PATHS_KEY = 'edrvPaths'
/** 目标行参数名（1-based，可选，作用于首个路径）。 */
export const EDRV_LINE_KEY = 'edrvLine'
/** 目标列参数名（1-based，可选，作用于首个路径）。 */
export const EDRV_COLUMN_KEY = 'edrvColumn'
/** 深链参数键全集（URL 清理用）。 */
export const EDRV_PARAM_KEYS = [EDRV_OPEN_FLAG, EDRV_PATHS_KEY, EDRV_LINE_KEY, EDRV_COLUMN_KEY]
/** 路径分隔符（编码后路径不含裸逗号，分隔安全）。 */
export const PATHS_SEPARATOR = ','

export const OPEN_TTL_MS = 60_000
export const OPEN_MAX_BYTES = 65_536
export const OPEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface InboxOpen extends OpenParams {
  version: 1
  requestId: string
  profile: string
  createdAt: number
}

export interface InboxAck {
  version: 1
  requestId: string
  profile: string
  createdAt: number
  success: boolean
  error?: string
}

/**
 * Detect the host platform without importing node builtins.
 * @author ddj 2026年09月28号
 * @returns Platform name, or an empty string outside Node.
 */
function platformName(): string {
  return typeof process === 'object' && process !== null ? String(process.platform) : ''
}

/**
 * Compare profile directories by physical identity, not by spelling.
 * Windows accepts either separator and folds case; other platforms stay exact.
 * @author ddj 2026年09月28号
 * @param left Declared profile directory.
 * @param right Expected profile directory.
 * @param platform Platform name for separator and case rules.
 * @returns Whether both name the same profile.
 */
export function sameProfile(left: string, right: string, platform = platformName()): boolean {
  if (platform === 'win32') {
    const fold = (value: string) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    return fold(left) === fold(right)
  }
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
}

/** @public @author ddj 2026年09月28号
 * Validate the open-only envelope before accepting filesystem input.
 * @param value Parsed untrusted JSON.
 * @param profile Exact expected profile directory.
 * @param now Current epoch milliseconds.
 * @param platform Platform name used for profile identity.
 * @returns A typed request or null.
 */
export function parseInboxOpen(value: unknown, profile: string, now = Date.now(), platform = platformName()): InboxOpen | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const keys = ['version', 'requestId', 'profile', 'paths', 'line', 'column', 'createdAt']
  if (Object.keys(row).some((key) => !keys.includes(key))) return null
  if (row.version !== 1 || typeof row.profile !== 'string' || !sameProfile(row.profile, profile, platform)
    || typeof row.requestId !== 'string' || !OPEN_ID.test(row.requestId)) return null
  if (typeof row.createdAt !== 'number' || !Number.isSafeInteger(row.createdAt)) return null
  if (now - row.createdAt >= OPEN_TTL_MS || row.createdAt > now + 5000) return null
  if (!Array.isArray(row.paths) || !row.paths.length || row.paths.length > 20) return null
  if (!row.paths.every((path) => typeof path === 'string' && path.length <= 8192 && !/[\u0000-\u001f]/.test(path) && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path))) return null
  for (const key of ['line', 'column']) {
    if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || Number(row[key]) < 1)) return null
  }
  return row as unknown as InboxOpen
}

/** 一次外部深链请求（解析结果）。 */
export interface OpenParams {
  /** 待打开路径（已解码，首个路径可携带行列）。 */
  paths: string[]
  /** 目标行（1-based，可空）。 */
  line?: number
  /** 目标列（1-based，可空）。 */
  column?: number
}

/**
 * 解析深链查询串：非深链/路径为空 → null；行列仅接受正整数，非法忽略。
 * @author ddj 2026年09月07号
 * @param search location.search（含或不含前导 ? 均可）
 * @returns 深链参数或 null
 */
export function parseOpenParams(search: string): OpenParams | null {
  const params = new URLSearchParams(search ?? '')
  if (params.get(EDRV_OPEN_FLAG) !== '1') return null
  const paths = (params.get(EDRV_PATHS_KEY) ?? '')
    .split(PATHS_SEPARATOR)
    .map((item) => item.trim())
    .filter(Boolean)
  if (!paths.length) return null
  const line = positiveIntOf(params.get(EDRV_LINE_KEY))
  const column = positiveIntOf(params.get(EDRV_COLUMN_KEY))
  return { paths, line, column }
}

/**
 * 正整数解析（非法/非正 → undefined）。
 * @author ddj 2026年09月07号
 * @param raw 参数原文（可空）
 * @returns 正整数或 undefined
 */
function positiveIntOf(raw: string | null): number | undefined {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}
