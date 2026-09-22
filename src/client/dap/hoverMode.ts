/**
 * dsh-vscode-mode client — hover 修饰键（Alt）状态。
 * 对齐 CodeBuddy/VS Code 调试浮窗语义：暂停态默认显示调试值，按住 Alt 切换为 LSP 信息。
 * 切换走**显示层行级显隐**（hoverTree.applyAltToHovers）：不重算 hover、不重跑 provider，
 * 因此不受 Monaco「同 anchor 直接早退」影响；状态同步不依赖单一键事件——任意带 altKey 的输入
 * 事件都会校正；且**调试浮层可见时消费裸 Alt**——否则 Chromium/宿主把 Alt 当菜单键会把焦点
 * 抢出页面（实测：每次 Alt 后约 4ms 页面失焦、要 4~5s 才回来），此后键事件到不了页面，
 * 切换只能等下一次鼠标移动自愈，观感就是「按下/松开都要等一会儿」。
 * 只读监听（capture 阶段）；安装幂等 + 可卸载，跨插件重载经 window 标记认领。
 * 作者 ddj 2026年09月21号
 */
import { applyAltToHovers, hasDebugHover } from './hoverTree.js'

// --region 常量与状态
/** 跨插件重载认领标记（存卸载函数）。 */
const MODE_GLOBAL = '__edrvHoverModeWatch__'
/** Alt 引发的抢焦点窗口（ms）：该窗口内的 blur 不回退状态（见 onBlur）。 */
const BLUR_GRACE_MS = 500
/** Alt 是否按住（供 hover provider 同步判定，无需异步等待）。 */
let altHeld = false
/** 最近一次「Alt 按住」键事件时间戳（blur 条件复位用）。 */
let lastAltAt = 0
/** Alt 状态变化订阅者。 */
const altListeners = new Set<(held: boolean) => void>()
// --endregion

/**
 * 更新 Alt 状态：仅在真正变化时同步显示层并通知订阅者。
 * @author ddj 2026年09月21号
 * @param next 新状态
 */
function setAlt(next: boolean): void {
  if (altHeld === next) return
  altHeld = next
  applyAltToHovers(next)
  for (const fn of Array.from(altListeners)) {
    try { fn(next) } catch { /* 单个订阅异常不影响其它订阅者 */ }
  }
}

/**
 * 订阅 Alt 状态变化。
 * @author ddj 2026年09月21号
 * @param fn 变化回调（参数为当前是否按住）
 * @returns 退订函数
 */
export function onAltChange(fn: (held: boolean) => void): () => void {
  altListeners.add(fn)
  return () => { altListeners.delete(fn) }
}

/**
 * Alt 是否按住。
 * @author ddj 2026年09月21号
 * @returns 是否按住
 */
export function isAltHeld(): boolean {
  return altHeld
}

/**
 * 设置 Alt 状态（测试注入用；运行期由监听器维护）。
 * @author ddj 2026年09月21号
 * @param on 是否按住
 */
export function setAltHeld(on: boolean): void {
  setAlt(Boolean(on))
}

/**
 * 是否应消费裸 Alt：仅 Alt 单键（无 Ctrl/Shift/Meta）且有调试浮层可见。
 * 消费 = preventDefault + stopPropagation，阻止浏览器/宿主把 Alt 当菜单键抢走焦点
 * （焦点一旦移出页面，后续键事件到不了页面，切换只能等下一次鼠标移动自愈）。
 * @author ddj 2026年09月21号
 * @param ev 键盘事件（仅取修饰键字段，便于单测）
 * @param debugHoverVisible 是否有可见的调试浮层
 * @returns 是否消费该事件
 */
export function consumesBareAlt(ev: { key: string; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean }, debugHoverVisible: boolean): boolean {
  return ev.key === 'Alt' && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey && debugHoverVisible
}

/**
 * Alt 键事件：消费（必要时）+ 记录时间（供 blur 条件复位判断）+ 同步状态。
 * @author ddj 2026年09月21号
 * @param ev 键盘事件
 */
function onAltKey(ev: KeyboardEvent): void {
  if (ev.key !== 'Alt') return
  if (consumesBareAlt(ev, hasDebugHover())) {
    ev.preventDefault()
    ev.stopPropagation()
  }
  lastAltAt = Date.now()
  setAlt(ev.type === 'keydown')
}

/**
 * 任意输入事件的 altKey 校正（键事件被吞时的兜底）。
 * @author ddj 2026年09月21号
 * @param ev 鼠标/键盘事件
 */
function onAnyInput(ev: Event): void {
  const held = Boolean((ev as MouseEvent).altKey)
  if (held) lastAltAt = Date.now()
  setAlt(held)
}

/**
 * 窗口失焦复位（条件）：刚看到 Alt 键事件则不复位
 * （既可能是宿主菜单抢焦点的 blur，也可能是紧邻 Alt 的页内元素级 blur）。
 * @author ddj 2026年09月21号
 */
function onBlur(): void {
  const since = lastAltAt ? Date.now() - lastAltAt : -1
  if (since >= 0 && since < BLUR_GRACE_MS) return
  setAlt(false)
}

/**
 * 安装 Alt 跟踪（幂等）。
 * keydown/keyup 记 Alt；任意带 altKey 的输入事件（含 mousemove/mousedown/wheel）校正——
 * 宿主吞掉 Alt 键事件时也能随下一次输入自愈；blur 仅在「不是刚按 Alt」时复位。
 * @author ddj 2026年09月21号
 */
export function installHoverMode(): void {
  if (typeof window === 'undefined') return
  const host = window as unknown as Record<string, unknown>
  if (typeof host[MODE_GLOBAL] === 'function') return // 上一代已安装（window 跨重载存活）
  const bound: Array<[string, EventListener]> = [
    ['keydown', onAltKey as EventListener],
    ['keyup', onAltKey as EventListener],
    ['keydown', onAnyInput as EventListener],
    ['mousemove', onAnyInput as EventListener],
    ['mousedown', onAnyInput as EventListener],
    ['wheel', onAnyInput as EventListener],
    ['blur', onBlur as EventListener],
  ]
  for (const [type, fn] of bound) window.addEventListener(type, fn, true)
  applyAltToHovers(altHeld) // 已存在的 hover 按当前状态对齐
  host[MODE_GLOBAL] = (): void => {
    for (const [type, fn] of bound) window.removeEventListener(type, fn, true)
    altHeld = false // 卸载路径直接复位，不再触发重算
  }
}

/**
 * 卸载 Alt 跟踪（插件重载/卸载时调用）。
 * @author ddj 2026年09月21号
 */
export function disposeHoverMode(): void {
  if (typeof window === 'undefined') return
  const host = window as unknown as Record<string, unknown>
  const off = host[MODE_GLOBAL]
  if (typeof off === 'function') off()
  delete host[MODE_GLOBAL]
  altHeld = false
  lastAltAt = 0
}
