/** In-page window chrome; closing returns tabs, never closes documents. @author ddj 2026年10月14号 */
import React from 'react'
import { createPortal } from 'react-dom'
import { clampFloat, type FloatRect } from '../state/editorLayout.js'

export interface FloatingProps {
  group: string
  owner: string
  rect: FloatRect
  focused: boolean
  layer: number
  onBounds(group: string, rect: FloatRect): void
  onFocus(group: string): void
  onReturn(group: string): void
  children?: React.ReactNode
}

/** @public @author ddj 2026年10月14号 @param props Window geometry and group callbacks. @returns Theme-aware portal with move/resize handles. */
export function FloatingEditor(props: FloatingProps): React.ReactPortal {
  const latest = React.useRef(props)
  latest.current = props
  const cleanup = React.useRef<(() => void) | null>(null)
  /** @private @author ddj 2026年10月14号 Cancel a gesture on unmount without altering tabs. */
  function cancel(): void { cleanup.current?.(); cleanup.current = null }
  React.useEffect(() => cancel, [])
  React.useEffect(() => {
    /** @private @author ddj 2026年10月14号 Keep title/chrome visible after viewport changes. */
    function resize(): void {
      const current = latest.current
      current.onBounds(current.group, clampFloat(current.rect, window.innerWidth, window.innerHeight))
    }
    window.addEventListener('resize', resize)
    resize()
    return () => window.removeEventListener('resize', resize)
  }, [])

  /** @private @author ddj 2026年10月14号 @param event Handle press. @param sizing Resize rather than move. */
  function start(event: React.PointerEvent, sizing: boolean): void {
    if (event.button !== 0 || !event.isPrimary) return
    cancel()
    event.preventDefault()
    const initial = latest.current.rect
    const x = event.clientX, y = event.clientY, pointer = event.pointerId
    let frame: number | null = null
    let next = initial
    latest.current.onFocus(props.group)
    /** @private @author ddj 2026年10月14号 Apply at most one geometry change per animation frame. */
    function paint(): void { frame = null; latest.current.onBounds(props.group, next) }
    /** @private @author ddj 2026年10月14号 @param moveEvent Pointer movement for the originating pointer. */
    function move(moveEvent: PointerEvent): void {
      if (moveEvent.pointerId !== pointer) return
      moveEvent.preventDefault()
      const dx = moveEvent.clientX - x, dy = moveEvent.clientY - y
      next = clampFloat(sizing ? { ...initial, width: initial.width + dx, height: initial.height + dy } : { ...initial, left: initial.left + dx, top: initial.top + dy }, window.innerWidth, window.innerHeight)
      if (frame === null) frame = requestAnimationFrame(paint)
    }
    /** @private @author ddj 2026年10月14号 Remove gesture listeners and pending frames. */
    function stop(): void {
      if (frame !== null) { cancelAnimationFrame(frame); paint() }
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', stop, true)
      window.removeEventListener('pointercancel', stop, true)
      window.removeEventListener('blur', stop)
      cleanup.current = null
    }
    cleanup.current = stop
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', stop, true)
    window.addEventListener('pointercancel', stop, true)
    window.addEventListener('blur', stop)
  }
  /** @private @author ddj 2026年10月14号 @param event Title press. Move window without stealing button presses. */
  function moveStart(event: React.PointerEvent): void { if (!(event.target as Element).closest('button')) start(event, false) }
  /** @private @author ddj 2026年10月14号 @param event Resize grip press. */
  function sizeStart(event: React.PointerEvent): void { start(event, true) }
  /** @private @author ddj 2026年10月14号 Return all tabs to the main group. */
  function returnTabs(): void { latest.current.onReturn(props.group) }
  /** @private @author ddj 2026年10月14号 Bring the group to the foreground. */
  function focus(): void { latest.current.onFocus(props.group) }
  const rect = clampFloat(props.rect, window.innerWidth, window.innerHeight)
  return createPortal(React.createElement('div', { className: 'edrv-floating' + (props.focused ? ' edrv-floating-focused' : ''), 'data-edrv-view': '1', 'data-edrv-float': props.group, 'data-edrv-owner': props.owner, style: { ...rect, zIndex: (props.focused ? 80 : 60) + props.layer }, onPointerDownCapture: focus },
    React.createElement('div', { className: 'edrv-floating-title', onPointerDown: moveStart },
      React.createElement('span', null, '浮动编辑组'), React.createElement('button', { type: 'button', title: '将全部文件移回主编辑区', onClick: returnTabs }, '移回主编辑区'),
      React.createElement('button', { type: 'button', title: '关闭浮窗并将文件移回主编辑区', 'aria-label': '关闭浮窗并移回文件', onClick: returnTabs }, '×')),
    props.children,
    React.createElement('div', { className: 'edrv-floating-grip', title: '拖动调整窗口大小', onPointerDown: sizeStart })), document.body)
}
