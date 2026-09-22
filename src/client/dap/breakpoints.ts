/**
 * dsh-vscode-mode client — 调试断点集合（纯函数 + localStorage 持久）。
 * 存储：`edrv.dap.bp.<scope>` → Record<relPath, BpEntry[]>（行升序）。
 * scope 与编辑器状态作用域一致（workspaceScopeOf 产物），跨刷新保留。
 * 作者 ddj 2026年09月29号
 */

/** 单条断点。 */
export interface BpEntry {
  line: number
  enabled: boolean
  /** 命中条件表达式（Lua，如 count % 10 == 0；空=无条件）。 */
  condition?: string
  /** 命中次数条件（适配器 hitCondition，如 >=5）。 */
  hitCondition?: string
  /** 日志断点消息（适配器 logMessage；存在时命中不打断仅打日志）。 */
  logMessage?: string
}

/** 断点表：relPath → 条目列表。 */
export type BpMap = Record<string, BpEntry[]>

/** localStorage key 前缀。 */
const KEY_PREFIX = 'edrv.dap.bp.'

/**
 * 读断点表（缺失/损坏返回空表）。
 * @author ddj 2026年09月29号
 * @param scope 状态作用域
 */
export function loadBpMap(scope: string): BpMap {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + scope)
    if (!raw) return {}
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out: BpMap = {}
    for (const [path, list] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const entries: BpEntry[] = []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const line = (item as BpEntry).line
        if (typeof line !== 'number' || line < 1) continue
        const entry: BpEntry = { line, enabled: (item as BpEntry).enabled !== false }
        if (typeof (item as BpEntry).condition === 'string') entry.condition = (item as BpEntry).condition
        if (typeof (item as BpEntry).hitCondition === 'string') entry.hitCondition = (item as BpEntry).hitCondition
        if (typeof (item as BpEntry).logMessage === 'string') entry.logMessage = (item as BpEntry).logMessage
        entries.push(entry)
      }
      if (entries.length) out[path] = entries.sort((a, b) => a.line - b.line)
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 写断点表（空表时清 key；写失败静默）。
 * @author ddj 2026年09月29号
 * @param scope 状态作用域
 * @param map 断点表
 */
export function saveBpMap(scope: string, map: BpMap): void {
  try {
    const keys = Object.keys(map)
    if (!keys.length) localStorage.removeItem(KEY_PREFIX + scope)
    else localStorage.setItem(KEY_PREFIX + scope, JSON.stringify(map))
  } catch { /* 无 localStorage 环境：仅内存生效 */ }
}

/**
 * 切换某文件某行断点（纯函数，返回新表与是否新增）。
 * @author ddj 2026年09月29号
 * @param map 原表
 * @param path 文件相对路径
 * @param line 行号
 */
export function toggleBp(map: BpMap, path: string, line: number): { map: BpMap; added: boolean } {
  const list = map[path] ?? []
  const hit = list.find((item) => item.line === line)
  let nextList: BpEntry[]
  let added: boolean
  if (hit) {
    nextList = list.filter((item) => item.line !== line)
    added = false
  } else {
    nextList = [...list, { line, enabled: true }].sort((a, b) => a.line - b.line)
    added = true
  }
  const next: BpMap = { ...map }
  if (nextList.length) next[path] = nextList
  else delete next[path]
  return { map: next, added }
}

/**
 * 取某文件启用的断点行（升序）。
 * @author ddj 2026年09月29号
 * @param map 断点表
 * @param path 文件相对路径
 */
export function bpLinesOf(map: BpMap, path: string): number[] {
  return (map[path] ?? []).filter((item) => item.enabled).map((item) => item.line)
}

/**
 * 取某文件禁用的断点行（升序；灰点展示用）。
 * @author ddj 2026年09月29号
 * @param map 断点表
 * @param path 文件相对路径
 */
export function bpDisabledLinesOf(map: BpMap, path: string): number[] {
  return (map[path] ?? []).filter((item) => !item.enabled).map((item) => item.line)
}

/**
 * 断点表规模（跨文件总数；版本指纹用）。
 * @author ddj 2026年09月29号
 * @param map 断点表
 */
export function bpTotalOf(map: BpMap): number {
  let total = 0
  for (const list of Object.values(map)) total += list.length
  return total
}

/**
 * 全量启停所有断点（不删条目，只改 enabled；纯函数）。
 * @author ddj 2026年09月21号
 * @param map 原表
 * @param enabled 目标启用态
 */
export function setAllEnabled(map: BpMap, enabled: boolean): BpMap {
  const next: BpMap = {}
  for (const [path, list] of Object.entries(map)) {
    if (!list.length) continue
    next[path] = list.map((item) => (item.enabled === enabled ? item : { ...item, enabled }))
  }
  return next
}

/**
 * 清空所有断点（纯函数；不修改原表）。
 * 同时返回曾有条目的文件清单（store 逐文件 syncPoints 空载荷用）。
 * @author ddj 2026年09月21号
 * @param map 原表
 */
export function removeAll(map: BpMap): { map: BpMap; files: string[] } {
  return { map: {}, files: Object.keys(map).filter((path) => (map[path] ?? []).length > 0) }
}

/**
 * 更新某行断点的编辑字段（条件/命中次数/日志；纯函数）。
 * 空串视为清除该字段。
 * @author ddj 2026年09月29号
 * @param map 原表
 * @param path 文件相对路径
 * @param line 行号
 * @param fields 要写入的字段（undefined = 不变）
 */
export function updateBpFields(
  map: BpMap,
  path: string,
  line: number,
  fields: { condition?: string; hitCondition?: string; logMessage?: string },
): BpMap {
  const clean = (value?: string): string | undefined => {
    const trimmed = typeof value === 'string' ? value.trim() : undefined
    return trimmed ? trimmed : undefined
  }
  const list = (map[path] ?? []).map((item) => {
    if (item.line !== line) return item
    const next: BpEntry = { ...item }
    if (fields.condition !== undefined) next.condition = clean(fields.condition)
    if (fields.hitCondition !== undefined) next.hitCondition = clean(fields.hitCondition)
    if (fields.logMessage !== undefined) next.logMessage = clean(fields.logMessage)
    return next
  })
  return { ...map, [path]: list }
}

/** 断点行跳转入参（调试面板行视图：文件路径 + 条目）。 */
export interface BpJumpRowLike {
  path?: string
  entry?: { line?: number }
}

/** 断点行跳转目标（1-based；列固定 1，与搜索面板命中跳转同口径）。 */
export interface BpJumpTarget {
  path: string
  line: number
  column: number
}

/**
 * 推导断点行的跳转目标（调试面板点击断点项 → 打开文件并定位到断点行）。
 * 路径缺失或行号非 ≥1 的有限数时返回 null（提前返回，不发起无效导航）。
 * @author ddj 2026年09月21号
 * @param row 面板行视图（文件路径 + 断点条目）
 * @returns 跳转目标；入参不合法时返回 null
 */
export function bpJumpTargetOf(row: BpJumpRowLike | null | undefined): BpJumpTarget | null {
  const path = typeof row?.path === 'string' ? row.path : ''
  const line = row?.entry?.line
  if (!path || typeof line !== 'number' || !Number.isFinite(line) || line < 1) return null
  return { path, line: Math.floor(line), column: 1 }
}

/**
 * 路径是否为可下断点的调试目标（当前调试器为 Lua；按扩展名后缀匹配，
 * 支持 '.lua' 与 '.lua.bytes' 这类带尾缀的 Unity 资产形态）。
 * @author ddj 2026年09月29号
 * @param path 文件路径（相对/绝对均可）
 * @param exts 允许的扩展名列表（默认 ['.lua']；大小写不敏感）
 */
export function isDebuggablePath(path: string, exts: readonly string[] = ['.lua']): boolean {
  const lower = String(path || '').toLowerCase()
  if (!lower) return false
  return exts.some((ext) => lower.endsWith(String(ext).toLowerCase()))
}
