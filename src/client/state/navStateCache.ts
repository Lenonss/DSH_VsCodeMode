/**
 * dsh-vscode-mode client — 编辑器导航历史存档（localStorage，按工作区作用域）。
 * 语义：刷新/重启后「后退/前进」双栈与当前位置仍在（对齐 VSCode navigation history 的体感，
 * 只是延长到跨会话/跨 origin）。条目不含 viewState——它体积大且已由 viewStateCache 按路径存档。
 * 键 = CACHE_KEY.navHistory + scope；序列化/解析为纯函数，IO 收在 load/save 两端。
 * 作者 ddj 2026-09-28
 */
import { CACHE_KEY } from '../paths.js'
import { cleanNavEntries, NAV_PERSIST_CAP, type NavState } from '../navHistory.js'

/** 存档格式版本（结构不兼容时递增，旧档自动作废）。 */
export const NAV_STATE_VERSION = 1

/**
 * 序列化双栈（空栈 → 空串，调用方据此删键）。
 * @author ddj 2026年09月28号
 * @param state 双栈快照（null/undefined → 空串）
 * @returns 存档文本
 */
export function serializeNavState(state: NavState | null | undefined): string {
  if (!state) return ''
  const past = cleanNavEntries(state.past, NAV_PERSIST_CAP)
  const future = cleanNavEntries(state.future, NAV_PERSIST_CAP)
  if (!past.length && !future.length) return ''
  return JSON.stringify({ v: NAV_STATE_VERSION, past, future })
}

/**
 * 解析存档文本（空/损坏/版本不符/无可恢复条目 → null）。
 * @author ddj 2026年09月28号
 * @param text localStorage 原文
 * @returns 双栈快照
 */
export function parseNavState(text: string | null): NavState | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as { v?: unknown; past?: unknown; future?: unknown }
    if (!value || typeof value !== 'object' || value.v !== NAV_STATE_VERSION) return null
    const past = cleanNavEntries(value.past, NAV_PERSIST_CAP)
    const future = cleanNavEntries(value.future, NAV_PERSIST_CAP)
    if (!past.length && !future.length) return null
    return { past, future }
  } catch (error) {
    return null
  }
}

/** scope → 最近写入的原文（去重写：光标移动触发的快照大多与上次相同）。 */
const lastWritten = new Map<string, string>()

/**
 * 读某作用域的导航历史存档。
 * @author ddj 2026年09月28号
 * @param scope 作用域键（scopeStore.workspaceScopeOf 产物）
 * @returns 双栈快照（无存档/存储不可用 → null）
 */
export function navStateLoad(scope: string): NavState | null {
  try {
    return parseNavState(localStorage.getItem(CACHE_KEY.navHistory + scope))
  } catch (error) {
    return null
  }
}

/**
 * 写某作用域的导航历史存档（空存档删键；原文未变跳过写入）。
 * @author ddj 2026年09月28号
 * @param scope 作用域键
 * @param state 双栈快照（null → 删除存档）
 */
export function navStateSave(scope: string, state: NavState | null | undefined): void {
  try {
    const text = serializeNavState(state)
    if (lastWritten.get(scope) === text) return
    lastWritten.set(scope, text)
    const key = CACHE_KEY.navHistory + scope
    if (!text) {
      localStorage.removeItem(key)
      return
    }
    localStorage.setItem(key, text)
  } catch (error) { /* 存储不可用：导航历史仅存活本次会话 */ }
}
