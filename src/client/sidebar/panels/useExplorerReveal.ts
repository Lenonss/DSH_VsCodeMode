import React from 'react'
import { isTreeRevealable } from '../../tabActions.js'

/** @private @author ddj 2026年10月14号 @param path Editor path. @returns Safe normalized tree path, or null. */
export function treeRevealPath(path: string | null): string | null {
  if (!path || !isTreeRevealable(path)) return null
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** @private @author ddj 2026年10月14号 @param host Tree scroll container. @param path Exact row path. @returns Whether a visible row was located. Only scrolls the tree. */
export function revealTreeRow(host: HTMLElement | null, path: string): boolean {
  if (!host || host.clientHeight <= 0) return false
  const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const row = host.querySelector<HTMLElement>('[data-edrv-path="' + escaped + '"]')
  if (!row) return false
  const viewport = host.getBoundingClientRect()
  const bounds = row.getBoundingClientRect()
  const top = viewport.top + host.clientTop
  if (bounds.top < top || bounds.bottom > top + host.clientHeight) {
    host.scrollTop += bounds.top - top - (host.clientHeight - bounds.height) / 2
  }
  return true
}

interface RevealOptions {
  scope: string
  activePath: string | null
  treeRef: React.RefObject<HTMLElement>
  prepare: (path: string) => void
  /** Optional virtual-list locator; success does not depend on mounted row DOM. */
  locate?: (path: string) => boolean
}
interface RevealTarget {
  scope: string
  path: string
  active: string | null
}

/** @private @author ddj 2026年10月14号 @param options Current workspace, active editor and tree preparation. @returns Highlight and manual request callback. Waits for committed rows without polling; unmount cancels highlight cleanup. */
export function useExplorerReveal(options: RevealOptions) {
  const { scope, activePath, treeRef } = options
  const [target, setTarget] = React.useState<RevealTarget | null>(null)
  const [revealPath, setRevealPath] = React.useState<string | null>(null)
  const pending = React.useRef<RevealTarget | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = React.useRef(options)
  latest.current = options

  /** @private @author ddj 2026年10月14号 Clears only this hook's highlight timer. */
  function clearHighlight(): void {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  /** @private @author ddj 2026年10月14号 @param path Requested tree path. Expands ancestors and replaces any previous pending target. */
  function requestReveal(path: string | null): void {
    clearHighlight()
    setRevealPath(null)
    const normalized = treeRevealPath(path)
    const current = latest.current
    const next = normalized ? { scope: current.scope, path: normalized, active: current.activePath } : null
    pending.current = next
    setTarget(next)
    if (next) current.prepare(next.path)
  }
  /** @private @author ddj 2026年10月22号 Attempts virtual data-index location or the original mounted-row fallback after commit/resize; consumes only a successful current request. */
  function tryReveal(): void {
    const next = pending.current
    const current = latest.current
    if (!next || next.scope !== current.scope || next.active !== current.activePath) return
    const located = current.locate ? current.locate(next.path) : revealTreeRow(current.treeRef.current, next.path)
    if (!located) return
    pending.current = null
    setRevealPath(next.path)
    clearHighlight()
    timer.current = setTimeout(endHighlight, 2000)
  }
  /** @private @author ddj 2026年10月14号 Ends transient reveal styling without changing the active editor row. */
  function endHighlight(): void {
    timer.current = null
    setRevealPath(null)
  }

  /** @private @author ddj 2026年10月14号 Establishes the latest editor target after workspace tree restoration. */
  function followActive(): void { requestReveal(activePath) }
  React.useEffect(followActive, [scope, activePath])
  React.useLayoutEffect(tryReveal)

  /** @private @author ddj 2026年10月14号 @returns Cleanup for manual events, resize observation and highlight timer. */
  function listenReveal(): () => void {
    /** @private @author ddj 2026年10月14号 @param event Existing explicit reveal request. */
    function onReveal(event: Event): void {
      const detail = (event as CustomEvent<{ path?: string; scope?: string }>).detail
      if (detail?.scope && detail.scope !== latest.current.scope) return
      if (typeof detail?.path === 'string') requestReveal(detail.path)
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(tryReveal) : null
    if (treeRef.current) observer?.observe(treeRef.current)
    window.addEventListener('edrv:reveal-path', onReveal)
    /** @private @author ddj 2026年10月14号 Cancels callbacks owned by this mounted tree. */
    function cleanup(): void {
      observer?.disconnect()
      window.removeEventListener('edrv:reveal-path', onReveal)
      pending.current = null
      clearHighlight()
    }
    return cleanup
  }
  React.useEffect(listenReveal, [treeRef])
  // Keep the request state as a render trigger when an already-open tree is revealed manually.
  void target
  return { revealPath, requestReveal }
}
