// @ts-nocheck
/**
 * dsh-vscode-mode client — 交互类特性的开关缓存（引用接入 / 搜索替换）。
 *
 * 为什么单独成模块：这两个开关都在「输入框/面板的 DOM 事件」里即时读取，走 React 状态会
 * 让每次粘贴都要等一次渲染；而它们的唯一写入方是设置桥同步（client/index.ts 每拍推送）。
 * 故用「模块级缓存 + 窗口事件」的最小方案，默认值在此单点维护，host schema 默认值同源。
 *
 * @author ddj 2026年11月15号
 */

/** 设置值变化广播事件名（值不变不派发）。 */
export const FEATURE_PREFS_EVENT = 'edrv:feature-prefs'

/** 特性开关默认值（与 host 设置 schema 默认值一致）。 */
export const FEATURE_PREFS_DEFAULT = Object.freeze({ refIntake: true, searchReplace: true })

/** 当前开关状态（热路径读取，避免每帧解析设置快照）。 */
let prefs = { ...FEATURE_PREFS_DEFAULT }

/**
 * 读当前开关状态（返回副本，调用方改不坏缓存）。
 * @author ddj 2026年11月15号
 * @returns 开关快照
 */
export function featurePrefs() {
  return { ...prefs }
}

/**
 * 推入设置值（设置桥每拍调用；旧版无字段 → 保持默认，不因 undefined 关掉特性）。
 * @author ddj 2026年11月15号
 * @param value 设置快照里的字段（可能缺省）
 * @returns 是否有变化
 */
export function setFeaturePrefs(value) {
  const next = {
    refIntake: typeof value?.refIntake === 'boolean' ? value.refIntake : FEATURE_PREFS_DEFAULT.refIntake,
    searchReplace: typeof value?.searchReplace === 'boolean' ? value.searchReplace : FEATURE_PREFS_DEFAULT.searchReplace,
  }
  if (next.refIntake === prefs.refIntake && next.searchReplace === prefs.searchReplace) return false
  prefs = next
  try {
    window.dispatchEvent(new CustomEvent(FEATURE_PREFS_EVENT, { detail: { ...next } }))
  } catch (error) { /* 无 window（测试）：仅内存更新 */ }
  return true
}

/**
 * 订阅开关变化（立即回调一次当前值）。
 * @author ddj 2026年11月15号
 * @param listener 回调
 * @returns 取消订阅
 */
export function watchFeaturePrefs(listener) {
  if (typeof listener !== 'function') return () => {}
  const onEvent = (event) => listener({ ...FEATURE_PREFS_DEFAULT, ...(event?.detail ?? {}) })
  try { window.addEventListener(FEATURE_PREFS_EVENT, onEvent) } catch (error) { /* 无 window */ }
  listener(featurePrefs())
  return () => {
    try { window.removeEventListener(FEATURE_PREFS_EVENT, onEvent) } catch (error) { /* 无 window */ }
  }
}
