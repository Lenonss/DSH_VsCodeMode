/** 快捷菜单几何测量：合并通知，动态维护锚点，并保留位置变化兜底。 */
export interface QuickMeasure {
  /** 请求下一帧测量。 */
  request(): void
  /** 取消所有待执行任务及监听。 */
  dispose(): void
}

/**
 * @public
 * @author ddj 2026年11月06号
 * @description 合并尺寸测量；兜底覆盖仅位置变化及宿主替换锚点，不监听整页高频 DOM 变更。
 * @param measure 实际读取几何的回调
 * @returns 调度器；卸载必须 dispose
 */
export function watchQuickSize(measure: () => void): QuickMeasure {
  let frame: number | null = null
  let disposed = false
  const observed = new Set<Element>()
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(request)

  /** @private @author ddj 2026年11月06号 @description 更新当前尺寸观察目标，释放已移除的节点。 */
  function trackAnchors(): void {
    const anchors = new Set<Element>(Array.from(document.querySelectorAll('[data-shell-overlay], [data-composer-seat]')))
    if (document.body) anchors.add(document.body)
    for (const target of observed) {
      if (anchors.has(target)) continue
      observer?.unobserve(target)
      observed.delete(target)
    }
    for (const target of anchors) {
      if (observed.has(target)) continue
      observer?.observe(target)
      observed.add(target)
    }
  }

  /** @private @author ddj 2026年11月06号 @description 在帧内统一读取几何，先清空句柄以支持后续通知。 */
  function flush(): void {
    frame = null
    if (disposed) return
    trackAnchors()
    measure()
  }

  /** @private @author ddj 2026年11月06号 @description 同一帧的多个通知只触发一次测量。 */
  function request(): void {
    if (disposed || frame !== null) return
    frame = window.requestAnimationFrame(flush)
  }

  /** @private @author ddj 2026年11月06号 @description 释放监听、计时器和节点引用，防止卸载后更新状态。 */
  function dispose(): void {
    disposed = true
    window.removeEventListener('resize', request)
    observer?.disconnect()
    observed.clear()
    window.clearInterval(poll)
    for (const timer of timers) window.clearTimeout(timer)
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
  }

  window.addEventListener('resize', request)
  // RO 不报告仅位置变化；保留 5 秒兜底，不再每 1.2 秒同步强制布局。
  const poll = window.setInterval(request, 5000)
  const timers = [80, 320, 900, 2000].map(delay => window.setTimeout(request, delay))
  request()
  return { request, dispose }
}
