/**
 * dsh-vscode-mode client — 资源管理栏目录条目缓存（SWR：旧数据即时渲染 + 后台刷新）。
 * 与 explorerCache（展开状态持久化）互补：本文件只缓存目录条目数据，键按会话隔离。
 * 纯函数（序列化/解析/裁剪）导出可单测；内存镜像 Map 同步读避免每次渲染 parse
 * localStorage，落盘 300ms 防抖；配额满/隐私模式 try/catch 降级纯内存。
 * 作者 ddj 2026-08-31
 */
import type { TreeEntry } from '../../shared/rpc.js'
import { CACHE_KEY } from '../paths.js'

// --region 常量
const KEY_PREFIX = CACHE_KEY.entries
/** 缓存目录上限（超出按 ts 逐出最旧，保活热门目录）。 */
export const CACHE_MAX_DIRS = 300
/** 单目录条目缓存上限（即时渲染用，刷新补齐全量）。 */
export const CACHE_DIR_ENTRIES = 500
/** 新鲜度窗口：预取去重用（展示不受限，永远可用缓存渲染）。 */
export const CACHE_FRESH_MS = 30_000
/** 落盘防抖。 */
export const CACHE_SAVE_DEBOUNCE_MS = 300
// --endregion

/** 单目录缓存条目。 */
export interface CachedDir {
  ts: number
  entries: TreeEntry[]
}

/** 缓存数据（v2：与 v1 展开状态缓存分离）。 */
export interface EntriesCacheData {
  v: 2
  root: string | null
  dirs: Record<string, CachedDir>
}

/** 裁剪到上限（目录按 ts 逐出最旧；单目录条目截断）。 */
export function entriesTrim(data: EntriesCacheData, maxDirs = CACHE_MAX_DIRS, maxEntries = CACHE_DIR_ENTRIES): EntriesCacheData {
  const dirs: Record<string, CachedDir> = {}
  const sorted = Object.entries(data.dirs).sort((a, b) => b[1].ts - a[1].ts)
  for (const [rel, dir] of sorted) {
    if (Object.keys(dirs).length >= maxDirs) break
    dirs[rel] = { ts: dir.ts, entries: dir.entries.length > maxEntries ? dir.entries.slice(0, maxEntries) : dir.entries }
  }
  return { v: 2, root: data.root, dirs }
}

/** 序列化缓存数据。 */
export function entriesSerialize(data: EntriesCacheData): string {
  return JSON.stringify(data)
}

/** 解析缓存文本；损坏/格式不符 → null。 */
export function entriesParse(text: string | null): EntriesCacheData | null {
  if (!text) return null
  try {
    const raw = JSON.parse(text) as { v?: unknown; root?: unknown; dirs?: unknown }
    if (!raw || raw.v !== 2 || !raw.dirs || typeof raw.dirs !== 'object') return null
    const dirs: Record<string, CachedDir> = {}
    for (const [rel, d] of Object.entries(raw.dirs)) {
      if (!d || typeof d !== 'object') continue
      const dir = d as { ts?: unknown; entries?: unknown }
      if (!Array.isArray(dir.entries)) continue
      const entries: TreeEntry[] = []
      for (const e of dir.entries) {
        if (!e || typeof e !== 'object') continue
        const item = e as { name?: unknown; path?: unknown; type?: unknown }
        if (typeof item.name !== 'string' || typeof item.path !== 'string') continue
        const type = item.type === 'directory' ? 'directory' : item.type === 'file' ? 'file' : 'other'
        entries.push({ name: item.name, path: item.path, type })
      }
      if (!entries.length) continue
      dirs[rel] = { ts: typeof dir.ts === 'number' ? dir.ts : 0, entries }
    }
    return { v: 2, root: typeof raw.root === 'string' ? raw.root : null, dirs }
  } catch (error) {
    return null
  }
}

// --region 内存镜像 + 防抖落盘
/** sessionId → 缓存镜像（同步读，避免每次渲染 parse）。 */
const mirrors = new Map<string, EntriesCacheData>()
/** sessionId → 落盘防抖计时器。 */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 单调时钟：连续 put 的 ts 严格递增（同毫秒不并列，逐出顺序可预期）。 */
let clock = 0

/** 取下一时间戳（不小于真实时间且严格递增）。 */
function nextTs(): number {
  clock = Math.max(Date.now(), clock + 1)
  return clock
}

/** localStorage 读取（不可用 → null）。 */
function readRaw(sessionId: string): string | null {
  try {
    return window.localStorage.getItem(KEY_PREFIX + sessionId)
  } catch (error) {
    return null
  }
}

/** localStorage 写入（配额/隐私模式失败静默）。 */
function writeRaw(sessionId: string, text: string): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + sessionId, text)
  } catch (error) { /* 配额满/隐私模式忽略 */ }
}

/** 取（或建）会话缓存镜像。 */
function mirrorOf(sessionId: string): EntriesCacheData {
  const existing = mirrors.get(sessionId)
  if (existing) return existing
  const data = entriesParse(readRaw(sessionId)) ?? { v: 2, root: null, dirs: {} }
  mirrors.set(sessionId, data)
  return data
}

/** 调度防抖落盘（重置已有计时器）。 */
function scheduleSave(sessionId: string): void {
  const prev = saveTimers.get(sessionId)
  if (prev) clearTimeout(prev)
  saveTimers.set(sessionId, setTimeout(() => {
    saveTimers.delete(sessionId)
    const data = mirrors.get(sessionId)
    if (data) writeRaw(sessionId, entriesSerialize(entriesTrim(data)))
  }, CACHE_SAVE_DEBOUNCE_MS))
}
// --endregion

/**
 * 读某目录缓存条目（无 → null；展示不受新鲜度限制）。
 * @author ddj 2026年08月31号
 * @param sessionId 会话 id
 * @param rel 目录相对路径（'' = 根）
 * @returns 缓存条目或 null
 */
export function entriesCacheGet(sessionId: string | undefined, rel: string): TreeEntry[] | null {
  if (!sessionId) return null
  const dir = mirrorOf(sessionId).dirs[rel]
  if (!dir || !dir.entries.length) return null
  return dir.entries
}

/**
 * 某目录缓存是否新鲜（预取去重用）。
 * @author ddj 2026年08月31号
 * @param sessionId 会话 id
 * @param rel 目录相对路径
 * @returns 新鲜返回 true
 */
export function entriesCacheIsFresh(sessionId: string | undefined, rel: string): boolean {
  if (!sessionId) return false
  const dir = mirrorOf(sessionId).dirs[rel]
  return Boolean(dir && Date.now() - dir.ts < CACHE_FRESH_MS)
}

/**
 * 写入某目录缓存条目（内存镜像 + 防抖落盘；单目录条目截断）。
 * @author ddj 2026年08月31号
 * @param sessionId 会话 id
 * @param rel 目录相对路径
 * @param entries 目录条目
 */
export function entriesCachePut(sessionId: string | undefined, rel: string, entries: TreeEntry[]): void {
  if (!sessionId) return
  const data = mirrorOf(sessionId)
  data.dirs[rel] = { ts: nextTs(), entries: entries.slice(0, CACHE_DIR_ENTRIES) }
  const trimmed = entriesTrim(data)
  data.dirs = trimmed.dirs
  scheduleSave(sessionId)
}
