/**
 * dsh-vscode-mode client — 对话输入条崩溃态探测与恢复。
 *
 * 背景：DSH 的槽渲染器在某个 slot 条目渲染抛错时，会把该槽替换成空的
 * `<div data-slot-error="…">`，并且不会自愈——所有会话的输入条都会一直是空的，
 * 用户只能手动刷新页面。已定位的触发源是第三方皮肤插件改写官方占位符节点的
 * textContent，导致 React 卸载时 removeChild 抛 NotFoundError。
 * @author ddj 2026年11月23号
 */

/** 官方对话输入条槽名（崩溃占位挂在同一个名字上）。 */
export const COMPOSER_BAR_SLOT = 'conversation.composer.bar'

/** 崩溃占位元素选择器。 */
const CRASH_SELECTOR = '[data-slot-error="' + COMPOSER_BAR_SLOT + '"]'

/** 恢复入口：复用插件已有的受保护页面刷新命令。 */
const RELOAD_EVENT = 'edrv.command.reloadWindow'

/**
 * 判断输入条是否已经进入崩溃占位态。
 * @public @author ddj 2026年11月23号
 * @param doc 目标文档，缺省取当前页面
 * @returns 崩溃占位存在时为 true
 */
export function composerCrashed(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  if (!doc) return false
  return doc.querySelector(CRASH_SELECTOR) !== null
}

/**
 * 监听输入条崩溃态变化（槽被替换、会话切换都会触发）。
 * @public @author ddj 2026年11月23号
 * @param doc 目标文档
 * @param onChange 状态变化回调；仅在布尔值真的翻转时调用
 * @returns 解绑函数；无 MutationObserver 时返回空操作
 */
export function watchComposer(doc: Document | undefined, onChange: (crashed: boolean) => void): () => void {
  if (!doc || typeof MutationObserver === 'undefined') return () => {}

  let last = composerCrashed(doc)
  const observer = new MutationObserver(() => {
    const next = composerCrashed(doc)
    if (next === last) return

    last = next
    onChange(next)
  })

  observer.observe(doc.body, { childList: true, subtree: true })
  onChange(last)
  return () => { observer.disconnect() }
}

/**
 * 触发一次受保护的页面刷新，把崩溃的输入条恢复到可用状态。
 * @public @author ddj 2026年11月23号
 * @returns 无
 * @sideEffects 派发插件既有的刷新命令（会先保存界面状态再 reload）
 */
export function recoverComposer(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(RELOAD_EVENT))
}
