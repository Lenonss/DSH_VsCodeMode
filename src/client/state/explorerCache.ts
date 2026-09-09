/**
 * dsh-vscode-mode client — 资源管理栏展开状态持久化（纯函数，可单测）。
 * 对齐 VSCode：只持久化展开路径集合，不缓存目录条目数据（条目实时 listDir）。
 * 键前缀统一走 paths.ts PathConst（CACHE_KEY.expanded）。
 * 作者 ddj 2026-08-28
 */
import { CACHE_KEY } from '../paths.js'

/** localStorage 键前缀（按工作区作用域隔离，无 cwd 会话回退会话键）。 */
const KEY_PREFIX = CACHE_KEY.expanded

/** 展开路径容量上限：超出丢弃最旧（按写入顺序近似 LRU）。 */
export const EXPANDED_CAP = 500

/** 展开状态缓存内容。 */
export interface ExplorerCacheData {
  root: string | null
  expanded: string[]
}

/**
 * 归一化展开路径：去空白、反斜杠→斜杠、去首尾斜杠，`..` 段拒绝。
 * @author ddj 2026年08月28号
 * @param rel 目录相对路径（'' = 根）
 * @returns 归一化路径，非法返回 null
 */
export function normalizeExpanded(rel: string | undefined | null): string | null {
  const s = String(rel ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!s) return ''
  const segs = s.split('/').filter((seg) => seg !== '.')
  if (!segs.length) return ''
  for (const seg of segs) {
    if (seg === '..') return null
  }
  return segs.join('/')
}

/**
 * 裁剪展开路径集：去重、丢弃非法路径、超容量丢弃尾部（保持传入顺序）。
 * @author ddj 2026年08月28号
 * @param expanded 原始展开路径集合
 * @returns 规范化后的路径数组
 */
export function sanitizeExpanded(expanded: unknown): string[] {
  if (!Array.isArray(expanded)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of expanded) {
    const rel = normalizeExpanded(typeof item === 'string' ? item : null)
    if (rel === null || seen.has(rel)) continue
    seen.add(rel)
    out.push(rel)
    if (out.length >= EXPANDED_CAP) break
  }
  return out
}

/**
 * 序列化缓存数据（JSON；root 为 null 时省略，减小体积）。
 * @author ddj 2026年08月28号
 * @param data 缓存数据
 * @returns JSON 字符串
 */
export function serializeExplorer(data: ExplorerCacheData): string {
  const payload = data.root === null || data.root === undefined
    ? { v: 1, expanded: data.expanded }
    : { v: 1, root: data.root, expanded: data.expanded }
  return JSON.stringify(payload)
}

/**
 * 解析缓存文本；损坏/格式不符 → null。
 * @author ddj 2026年08月28号
 * @param text localStorage 原文
 * @returns 解析后的缓存数据，非法返回 null
 */
export function parseExplorer(text: string | null): ExplorerCacheData | null {
  if (!text) return null
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object') return null
    const root = typeof data.root === 'string' && data.root ? data.root : null
    const expanded = sanitizeExpanded(data.expanded)
    return { root, expanded }
  } catch (error) {
    return null
  }
}

/**
 * 读取某作用域的展开状态缓存（localStorage 不可用 → null）。
 * @author ddj 2026年08月28号
 * @param scope 作用域键（scopeStore.workspaceScopeOf 产物）
 * @returns 缓存数据或 null
 */
export function explorerLoad(scope: string): ExplorerCacheData | null {
  try {
    return parseExplorer(window.localStorage.getItem(KEY_PREFIX + String(scope)))
  } catch (error) {
    return null
  }
}

/**
 * 写入某作用域的展开状态缓存（损坏/配额满 → 忽略）。
 * @author ddj 2026年08月28号
 * @param scope 作用域键（scopeStore.workspaceScopeOf 产物）
 * @param data 缓存数据
 */
export function explorerSave(scope: string, data: ExplorerCacheData): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + String(scope), serializeExplorer(data))
  } catch (error) { /* 配额满/隐私模式忽略 */ }
}
