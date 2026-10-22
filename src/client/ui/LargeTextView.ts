import React from 'react'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { createTextPager } from '../textPages.js'
import type { TextPageLoader, TextPagerState } from '../textPages.js'

export interface LargeTextViewProps {
  sessionId: string
  path: string
  loadPage: TextPageLoader
}
const Button = (Primitives as unknown as { Button: React.ComponentType<{
  children?: React.ReactNode; disabled?: boolean; onClick?: () => void
}> }).Button

/**
 * Read-only paged text surface: never creates a Monaco model or exposes a save action.
 * @public @author ddj 2026年10月22号
 * @param props Exact session/file identity and authorized page loader.
 * @returns Bounded selectable text with explicit continuation and status.
 */
export function LargeTextView(props: LargeTextViewProps): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<TextPagerState | null>(null)
  const [identity, setIdentity] = React.useState('')
  const pagerRef = React.useRef<ReturnType<typeof createTextPager> | null>(null)
  const loaderRef = React.useRef(props.loadPage)
  const mountedRef = React.useRef(false)
  const firstPending = React.useRef(false)
  loaderRef.current = props.loadPage
  const currentIdentity = JSON.stringify([props.sessionId, props.path])

  /** @private @author ddj 2026年10月22号 @param args Request identity. @returns Current injected loader response. */
  function loadPage(args: Parameters<TextPageLoader>[0]): ReturnType<TextPageLoader> {
    return loaderRef.current(args)
  }
  /** @private @author ddj 2026年10月22号 @param state Latest pager snapshot. @returns Publish only while mounted. */
  function onSnapshot(state: TextPagerState): void {
    if (!mountedRef.current) return
    setSnapshot(state)
    if (!state.loading && firstPending.current) queueMicrotask(loadFirst)
  }

  /** @private @author ddj 2026年10月22号 @description Start only the new identity's deferred first page, never automatic continuation. */
  function loadFirst(): void {
    const pager = pagerRef.current
    if (!mountedRef.current || !firstPending.current || !pager || pager.getState().loading
      || (typeof document !== 'undefined' && document.hidden)) return
    firstPending.current = false
    void pager.loadNext()
  }

  /** @private @author ddj 2026年10月22号 @returns Bind identity without replacing the single transport lock. */
  function mountPager(): () => void {
    mountedRef.current = true
    if (!pagerRef.current) pagerRef.current = createTextPager(loadPage, onSnapshot)
    const pager = pagerRef.current
    setIdentity(currentIdentity)
    firstPending.current = true
    pager.reset({ sessionId: props.sessionId, path: props.path })
    loadFirst()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', loadFirst)
    /** @private @author ddj 2026年10月22号 @returns Release retained text and ignore pending responses. */
    function unmountPager(): void {
      mountedRef.current = false
      firstPending.current = false
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', loadFirst)
      pager.invalidate()
    }
    return unmountPager
  }
  React.useEffect(mountPager, [props.sessionId, props.path])

  /** @private @author ddj 2026年10月22号 @returns Load exactly one additional page on user intent. */
  function loadNext(): void {
    if (typeof document !== 'undefined' && document.hidden) return
    if (firstPending.current) { loadFirst(); return }
    void pagerRef.current?.loadNext()
  }

  const state = identity === currentIdentity ? snapshot : null
  let status = '正在加载只读文本…'
  if (state?.error) status = state.error
  else if (state?.capped) status = '已达预览上限（8 MiB / 50,000 行），请使用外部编辑器查看完整文件'
  else if (state?.eof) status = '文件末尾 · 只读'
  else if (state) status = `已读取 ${state.offset.toLocaleString()} / ${state.size.toLocaleString()} 字节 · 只读`
  if (state?.partialLine) status += ' · 末行尚未完整'

  return React.createElement('section', { className: 'edrv-large-text', 'aria-label': '大文件只读预览' },
    React.createElement('div', { className: 'edrv-large-text-toolbar' },
      React.createElement('span', { role: 'status' }, status),
      React.createElement(Button, { onClick: loadNext,
        disabled: !state || state.loading || state.eof || state.capped },
      state?.loading ? '加载中…' : (state?.error ? '重试本段' : '加载下一段'))),
    React.createElement('pre', { className: 'edrv-large-text-content', tabIndex: 0 }, state?.text ?? ''))
}
