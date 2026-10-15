/** Shared in-page window chrome, without a mask or focus trap. @author ddj 2026年10月14号 */
import React from 'react'
import { createPortal } from 'react-dom'
import { clampFloat } from '../state/editorLayout.js'
import type { FloatRect } from '../state/editorLayout.js'
import { dropFloat, floatLayer, floatVersion, initialFloat, moveFloat, raiseFloat, watchFloats } from '../state/floatingWindow.js'

export interface WindowProps {
  title: string
  dialogClass?: string
  width?: number
  height?: number
  rect?: FloatRect
  owner?: string
  group?: string
  closeOnEsc?: boolean
  onClose?: () => void
  onBounds?: (rect: FloatRect) => void
  onFocus?: () => void
  onKeyDown?: (event: React.KeyboardEvent) => void
  actions?: React.ReactNode
  children?: React.ReactNode
}

/** @private @author ddj 2026年10月14号 @param start Originating press. @param rect Initial bounds. @param sizing Resize mode. @param draw Paint live bounds without a render. @param apply Commit bounds once. @param done Gesture cleanup notification. @returns Gesture cancellation. */
function beginGesture(start: React.PointerEvent, rect: FloatRect, sizing: boolean, draw: (rect: FloatRect) => void, apply: (rect: FloatRect) => void, done: () => void): () => void {
  let frame: number | null = null
  let next = rect
  let moved = false
  /** @private @author ddj 2026年10月14号 Paint no more than once per frame. */
  function paint(): void { frame = null; draw(next) }
  /** @private @author ddj 2026年10月14号 @param event Pointer motion. Ignore unrelated pointers. */
  function move(event: PointerEvent): void {
    if (event.pointerId !== start.pointerId) return
    event.preventDefault()
    moved = true
    next = moveFloat(rect, event.clientX - start.clientX, event.clientY - start.clientY, sizing, window.innerWidth, window.innerHeight)
    if (frame === null) frame = requestAnimationFrame(paint)
  }
  /** @private @author ddj 2026年10月14号 Remove listeners, then commit the settled geometry exactly once. */
  function stop(): void {
    if (frame !== null) { cancelAnimationFrame(frame); frame = null }
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', end, true)
    window.removeEventListener('pointercancel', end, true)
    window.removeEventListener('blur', stop)
    if (moved) { draw(next); apply(next) }
    done()
  }
  /** @private @author ddj 2026年10月14号 @param event Pointer release. Only end originating gesture. */
  function end(event: PointerEvent): void { if (event.pointerId === start.pointerId) stop() }
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', end, true)
  window.addEventListener('pointercancel', end, true)
  window.addEventListener('blur', stop)
  return stop
}

const resizeSinks = new Set<() => void>()
let resizeFrame: number | null = null

/** @private @author ddj 2026年10月14号 Re-clamp every window at most once per frame. */
function onViewportResize(): void {
  if (resizeFrame !== null) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null
    for (const sink of [...resizeSinks]) sink()
  })
}

/** @private @author ddj 2026年10月14号 @param sink Per-window re-clamp callback. @returns Unsubscribe. */
function subscribeResize(sink: () => void): () => void {
  if (resizeSinks.size === 0) window.addEventListener('resize', onViewportResize)
  resizeSinks.add(sink)
  return () => {
    resizeSinks.delete(sink)
    if (resizeSinks.size === 0) {
      window.removeEventListener('resize', onViewportResize)
      if (resizeFrame !== null) { cancelAnimationFrame(resizeFrame); resizeFrame = null }
    }
  }
}

/** @public @author ddj 2026年10月14号 @param props Window contents and lifecycle callbacks. @returns Movable, resizable nonmodal portal. */
export function FloatingWindow(props: WindowProps): React.ReactPortal {
  const id = React.useId()
  const root = React.useRef<HTMLDivElement>(null)
  const latest = React.useRef(props)
  latest.current = props
  const [bounds, setBounds] = React.useState(() => initialFloat(props.width ?? 760, props.height ?? 600, window.innerWidth, window.innerHeight))
  const current = React.useRef(props.rect ?? bounds)
  current.current = props.rect ?? bounds
  const cleanup = React.useRef<(() => void) | null>(null)
  const gesture = React.useRef<FloatRect | null>(null)
  React.useSyncExternalStore(watchFloats, floatVersion, floatVersion)
  /** @private @author ddj 2026年10月14号 @param rect Next geometry. Notify controlled owner or retain local geometry. */
  function apply(rect: FloatRect): void {
    if (latest.current.rect) latest.current.onBounds?.(rect)
    else setBounds(rect)
  }
  /** @private @author ddj 2026年10月14号 @param rect Live gesture geometry. Write the DOM and hold it until the commit render lands. */
  function draw(rect: FloatRect): void {
    gesture.current = rect
    const node = root.current
    if (!node) return
    node.style.left = rect.left + 'px'
    node.style.top = rect.top + 'px'
    node.style.width = rect.width + 'px'
    node.style.height = rect.height + 'px'
  }
  /** @private @author ddj 2026年10月14号 End any active gesture. */
  function cancel(): void { cleanup.current?.(); cleanup.current = null }
  /** @private @author ddj 2026年10月14号 Re-clamp after viewport resize, preferring the gesture that just settled. */
  function resize(): void { cancel(); apply(clampFloat(gesture.current ?? current.current, window.innerWidth, window.innerHeight)) }
  React.useEffect(() => {
    raiseFloat(id)
    const off = subscribeResize(resize)
    resize()
    return () => { off(); cancel(); dropFloat(id) }
  }, [id])
  /** @private @author ddj 2026年10月14号 Activate without stealing text input focus. */
  function focus(): void { raiseFloat(id); latest.current.onFocus?.() }
  /** @private @author ddj 2026年10月14号 @param event Window press. Give noninteractive content a keyboard owner. */
  function activate(event: React.PointerEvent): void {
    focus()
    if (!(event.target as Element).closest('button, input, select, textarea, a, [contenteditable], .monaco-editor')) root.current?.focus({ preventScroll: true })
  }
  /** @private @author ddj 2026年10月14号 @param event Handle press. @param sizing Resize instead of move. */
  function start(event: React.PointerEvent, sizing: boolean): void {
    if (event.button !== 0 || !event.isPrimary) return
    cancel()
    event.preventDefault()
    cleanup.current = beginGesture(event, gesture.current ?? current.current, sizing, draw, apply, clear)
  }
  // 手势几何的持有范围只到「提交渲染落地」为止：apply() 走的是 pointerup 等离散事件，
  // React 18 会在事件末尾同步 flush，下一次渲染 base 已是新几何，故此处可同步释放。
  // 勘误 2026-10-14（测试约定）：原先额外挂一帧再释放，会在手势结束后残留一个待执行帧
  // （tests/floatingWindow.test.ts 断言 frames.size === 0），且无必要。
  /** @private @author ddj 2026年10月14号 Release the settled geometry once React has committed it. */
  function clear(): void {
    cleanup.current = null
    gesture.current = null
  }
  /** @private @author ddj 2026年10月14号 @param event Title press. Preserve title action buttons. */
  function moveStart(event: React.PointerEvent): void { if (!(event.target as Element).closest('button')) start(event, false) }
  /** @private @author ddj 2026年10月14号 @param event Resize press. */
  function sizeStart(event: React.PointerEvent): void { start(event, true) }
  /** @private @author ddj 2026年10月14号 @param event Local key. Exclude React-bubbling child portals. */
  function keyDown(event: React.KeyboardEvent): void {
    if ((event.target as Element).closest('[data-edrv-window]') !== root.current || event.defaultPrevented) return
    if (event.key === 'Escape' && props.closeOnEsc !== false && props.onClose) {
      event.preventDefault(); event.stopPropagation(); props.onClose(); return
    }
    props.onKeyDown?.(event)
  }
  const base = clampFloat(props.rect ?? bounds, window.innerWidth, window.innerHeight)
  const rect = gesture.current ?? base
  return createPortal(React.createElement('div', {
    ref: root, tabIndex: -1, role: 'dialog', 'aria-label': props.title, 'aria-modal': false,
    className: 'edrv-floating', 'data-edrv-view': '1', 'data-edrv-window': id,
    'data-edrv-float': props.group, 'data-edrv-owner': props.owner,
    style: { ...rect, zIndex: floatLayer(id) }, onPointerDownCapture: activate, onFocusCapture: focus, onKeyDown: keyDown,
  },
  React.createElement('div', { className: 'edrv-floating-title', onPointerDown: moveStart },
    React.createElement('span', null, props.title), props.actions),
  React.createElement('div', { className: 'edrv-floating-content' + (props.dialogClass ? ' ' + props.dialogClass : '') }, props.children),
  React.createElement('div', { className: 'edrv-floating-grip', title: '拖动调整窗口大小', onPointerDown: sizeStart })), document.body)
}
