/**
 * dsh-vscode-mode client — 「性能优化」页工作区栏目展开状态持久化（纯函数，可单测）。
 * 只持久化「已展开」的工作区键集合（默认全部折叠），对齐 explorerCache 的做法：
 * 不缓存会话条目本身，条目由 edrv.perf.inventory 实时返回。
 * 键前缀统一走 paths.ts PathConst（CACHE_KEY.workspaceFold）。
 * 作者 ddj 2026-09-02
 */
import { CACHE_KEY } from '../paths.js'

/** localStorage 键（全局，不按会话隔离）。 */
const STORE_KEY = CACHE_KEY.workspaceFold

/** 展开键容量上限：超出丢弃尾部，防止无限增长撑爆配额。 */
export const FOLD_CAP = 300

/**
 * 归一化工作区键：仅去首尾空白（工作区键非文件系统路径，不做斜杠转换）。
 * @author ddj 2026年09月02号
 * @param key 工作区标识
 * @returns 归一化键，空值返回 ''
 */
export function normalizeFoldKey(key: string | undefined | null): string {
  return String(key ?? '').trim()
}

/**
 * 裁剪展开键集：去重、丢弃空值、超容量丢弃尾部（保持传入顺序）。
 * @author ddj 2026年09月02号
 * @param expanded 原始展开键集合
 * @returns 规范化后的键数组
 */
export function sanitizeFolded(expanded: unknown): string[] {
  if (!Array.isArray(expanded)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of expanded) {
    const key = normalizeFoldKey(typeof item === 'string' ? item : '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= FOLD_CAP) break
  }
  return out
}

/**
 * 序列化展开状态（JSON，带 schema 版本号）。
 * @author ddj 2026年09月02号
 * @param expanded 已展开的项目键集合
 * @returns JSON 字符串
 */
export function serializeFold(expanded: string[]): string {
  return JSON.stringify({ v: 1, expanded: sanitizeFolded(expanded) })
}

/**
 * 解析缓存文本；损坏/格式不符 → 空集合。
 * @author ddj 2026年09月02号
 * @param text localStorage 原文
 * @returns 已展开键集合
 */
export function parseFold(text: string | null): string[] {
  if (!text) return []
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object') return []
    return sanitizeFolded(data.expanded)
  } catch (error) {
    return []
  }
}

/**
 * 读取展开状态（localStorage 不可用 → 空集合）。
 * @author ddj 2026年09月02号
 * @returns 已展开键集合
 */
export function foldLoad(): string[] {
  try {
    return parseFold(window.localStorage.getItem(STORE_KEY))
  } catch (error) {
    return []
  }
}

/**
 * 写入展开状态（配额满/隐私模式失败静默）。
 * @author ddj 2026年09月02号
 * @param expanded 已展开键集合
 */
export function foldSave(expanded: string[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, serializeFold(expanded))
  } catch (error) { /* 配额满/隐私模式忽略 */ }
}
