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
