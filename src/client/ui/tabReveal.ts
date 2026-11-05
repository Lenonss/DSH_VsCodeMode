/** Group-local active tab visibility. @author ddj 2026年11月05号 */

/**
 * Reveal the selected tab without moving the page or keyboard focus.
 * @public @author ddj 2026年11月05号
 * @param host Tab strip belonging to one editor group.
 * @sideEffects Updates only the strip's horizontal scroll position.
 */
export function revealTab(host: HTMLDivElement): void {
  const tab = host.querySelector<HTMLElement>('.edrv-tab-active')
  if (!tab || host.clientWidth <= 0) return

  // DOM rectangles share viewport coordinates even when offsetParent is outside the strip.
  const stripRect = host.getBoundingClientRect()
  const tabRect = tab.getBoundingClientRect()
  const left = stripRect.left + host.clientLeft
  const right = left + host.clientWidth
  let delta = 0
  if (tabRect.width > host.clientWidth || tabRect.left < left) delta = tabRect.left - left
  else if (tabRect.right > right) delta = tabRect.right - right
  if (Math.abs(delta) < 0.5) return

  const maximum = Math.max(0, host.scrollWidth - host.clientWidth)
  const next = Math.max(0, Math.min(maximum, host.scrollLeft + delta))
  if (next !== host.scrollLeft) host.scrollLeft = next
}

/**
 * Observe geometry changes, not scrolling, so manual tab browsing remains possible.
 * @public @author ddj 2026年11月05号
 * @param host Group tab strip after its DOM commit.
 * @returns Cleanup cancelling pending work and disconnecting geometry observation.
 */
export function watchTabReveal(host: HTMLDivElement): () => void {
  const view = host.ownerDocument.defaultView
  let frame: number | undefined
  let disposed = false
  /** @private @author ddj 2026年11月05号 Reveal the latest selected tab after layout. */
  function measure(): void {
    frame = undefined
    if (!disposed) revealTab(host)
  }
  /** @private @author ddj 2026年11月05号 Coalesce resize notifications into one layout read. */
  function schedule(): void {
    if (disposed || frame !== undefined || !view) return
    frame = view.requestAnimationFrame(measure)
  }

  revealTab(host)
  schedule()
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : undefined
  observer?.observe(host)
  const tab = host.querySelector<HTMLElement>('.edrv-tab-active')
  if (tab) observer?.observe(tab)

  /** @private @author ddj 2026年11月05号 Cancel work owned by the previous selection or pane. */
  function dispose(): void {
    disposed = true
    observer?.disconnect()
    if (frame !== undefined) view?.cancelAnimationFrame(frame)
    frame = undefined
  }
  return dispose
}
