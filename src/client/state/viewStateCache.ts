/**
 * dsh-vscode-mode client — 编辑器视图状态持久化（纯函数，可单测）。
 * 对齐 VSCode workbench.editor.restoreViewState：恢复每个文件的光标/滚动/折叠位置。
 * 视图状态 = Monaco editor.saveViewState() 返回值（JSON 可序列化），按 path 存储。
 * 键前缀统一走 paths.ts PathConst（CACHE_KEY.viewstate）。
 * 作者 ddj 2026-08-28
 */
import { CACHE_KEY } from '../paths.js'

/** localStorage 键前缀（按会话隔离）。 */
const KEY_PREFIX = CACHE_KEY.viewstate

/** 视图状态条目容量上限。 */
export const VIEWSTATE_CAP = 50

/** 视图状态序列化体积上限（单条目，防止超大选区/折叠数据撑爆配额）。 */
export const VIEWSTATE_BYTES_CAP = 64 * 1024

/**
 * 判断对象是否为合法的 Monaco view state（保守形状校验，非深校验）。
 * @author ddj 2026年08月28号
 * @param value 待校验对象
 * @returns 是否可接受
 */
export function isViewStateLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  // 至少含光标状态与视口滚动信息之一；无内容时拒绝（空对象无恢复价值）
  return Array.isArray(v.cursorState) || typeof v.viewState === 'object'
    || Array.isArray(v.contributionsState)
}

/**
 * 序列化视图状态映射（path → viewState）。
 * @author ddj 2026年08月28号
 * @param states path → viewState 映射
 * @returns JSON 字符串
 */
export function serializeViewStates(states: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, states })
}

/**
 * 解析视图状态文本；损坏/格式不符 → null。
 * @author ddj 2026年08月28号
 * @param text localStorage 原文
 * @returns path → viewState 映射，非法返回 null
 */
export function parseViewStates(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object') return null
    const states = (data as Record<string, unknown>).states
    if (!states || typeof states !== 'object' || Array.isArray(states)) return null
    const out: Record<string, unknown> = {}
    for (const [path, state] of Object.entries(states)) {
      if (typeof path !== 'string' || !path) continue
      if (!isViewStateLike(state)) continue
      out[path] = state
    }
    return out
  } catch (error) {
    return null
  }
}

/**
 * 把新视图状态并入既有映射：同 path 覆盖、按写入顺序裁剪到容量上限。
 * @author ddj 2026年08月28号
 * @param states 既有映射
 * @param path 文件路径
 * @param state 视图状态
 * @returns 新映射（容量裁剪后）
 */
export function upsertViewState(
  states: Record<string, unknown>,
  path: string,
  state: unknown,
): Record<string, unknown> {
  if (!path || !isViewStateLike(state)) return states
  try {
    if (JSON.stringify(state).length > VIEWSTATE_BYTES_CAP) return states
  } catch (error) {
    return states
  }
  const next = Object.assign({}, states)
  delete next[path] // 先删后加，保证该 path 排到最末（近似 LRU：最新写入）
  next[path] = state
  const keys = Object.keys(next)
  if (keys.length > VIEWSTATE_CAP) {
    for (const k of keys.slice(0, keys.length - VIEWSTATE_CAP)) delete next[k]
  }
  return next
}

/**
 * 读取某会话的视图状态缓存（localStorage 不可用 → 空映射）。
 * @author ddj 2026年08月28号
 * @param sessionId 会话 id
 * @returns path → viewState 映射
 */
export function viewStatesLoad(sessionId: string): Record<string, unknown> {
  try {
    return parseViewStates(window.localStorage.getItem(KEY_PREFIX + String(sessionId))) ?? {}
  } catch (error) {
    return {}
  }
}

/**
 * 写入某会话的视图状态缓存（损坏/配额满 → 忽略）。
 * @author ddj 2026年08月28号
 * @param sessionId 会话 id
 * @param states path → viewState 映射
 */
export function viewStatesSave(sessionId: string, states: Record<string, unknown>): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + String(sessionId), serializeViewStates(states))
  } catch (error) { /* 配额满/隐私模式忽略 */ }
}
