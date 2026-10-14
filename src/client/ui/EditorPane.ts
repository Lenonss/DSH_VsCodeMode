/** Independent group views; workbench owns documents, saves and commands. @author ddj 2026年10月14号 */
import React from 'react'
import { createViewKeeper, type ViewEditor } from '../state/editorViewState.js'
import type { Group } from '../state/editorLayout.js'
import type { TabLike } from '../tabActions.js'

export interface PaneProps {
  group: Group
  focused: boolean
  dirty: Record<string, boolean>
  onSelect(group: string, path?: string): void
  onClose(path: string): void
  onMenu(path: string, event: React.MouseEvent): void
  onDrag(path: string, event: React.PointerEvent): void
  consumeClick(): boolean
  children?: React.ReactNode
  extras?: React.ReactNode
}

/** @public @author ddj 2026年10月14号 @param props Group callbacks and file view. @returns Accessible tab strip and drop target. */
export function EditorPane(props: PaneProps): React.ReactElement {
  const { group } = props
  /** @private @author ddj 2026年10月14号 @param tab File record. @returns Draggable tab with isolated close control. */
  function renderTab(tab: TabLike): React.ReactElement {
    /** @private @author ddj 2026年10月14号 @param event Primary press. Start trusted file drag. */
    function press(event: React.PointerEvent): void { props.onDrag(tab.path, event) }
    /** @private @author ddj 2026年10月14号 Select unless release completed a drag. */
    function select(): void { if (!props.consumeClick()) props.onSelect(group.id, tab.path) }
    /** @private @author ddj 2026年10月14号 @param event Context event. Open file actions. */
    function menu(event: React.MouseEvent): void { event.preventDefault(); event.stopPropagation(); props.onMenu(tab.path, event) }
    /** @private @author ddj 2026年10月14号 @param event Close activation. Never select tab. */
    function close(event: React.MouseEvent): void { event.stopPropagation(); props.onClose(tab.path) }
    /** @private @author ddj 2026年10月14号 @param event Close press. Never start a drag. */
    function stop(event: React.PointerEvent): void { event.stopPropagation() }
    /** @private @author ddj 2026年10月14号 @param event Keyboard activation. */
    function key(event: React.KeyboardEvent): void { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onSelect(group.id, tab.path) } }
    return React.createElement('div', {
      key: tab.path, 'data-edrv-tab-path': tab.path, role: 'tab', tabIndex: 0, 'aria-selected': tab.path === group.active,
      className: 'edrv-tab' + (tab.path === group.active ? ' edrv-tab-active' : '') + (tab.pinned ? ' edrv-tab-pinned' : ''),
      title: tab.path + (tab.pinned ? '（已固定）' : ''), onPointerDown: press, onClick: select, onContextMenu: menu, onKeyDown: key,
    }, tab.pinned ? React.createElement('span', { className: 'edrv-tab-pin' }, '📌') : null,
    React.createElement('span', { className: 'edrv-group-tab-name' }, tab.path.split(/[\\/]/).pop()),
    props.dirty[tab.path] ? React.createElement('span', { className: 'edrv-tab-star', title: '未保存修改' }, '*') : null,
    tab.pinned ? null : React.createElement('button', { className: 'edrv-tab-x', type: 'button', 'aria-label': '关闭 ' + tab.path, title: '关闭', onPointerDown: stop, onClick: close }, '×'))
  }
  /** @private @author ddj 2026年10月14号 @param event Group background press. Allow an empty main group to receive new files. */
  function focusEmpty(event: React.PointerEvent): void {
    if (!group.active && !props.focused && event.button === 0) props.onSelect(group.id)
  }
  return React.createElement('section', { className: 'edrv-group' + (props.focused ? ' edrv-group-focused' : ''), 'data-edrv-group': group.id, onPointerDown: focusEmpty },
    React.createElement('div', { className: 'edrv-tabs', role: 'tablist', 'data-edrv-group-tabs': group.id }, group.tabs.map(renderTab), props.extras),
    React.createElement('div', { className: 'edrv-group-body', role: 'tabpanel' }, props.children))
}

/** @public @author ddj 2026年10月14号 @param editor View instance. @param scope Workspace. @param path Canonical path. @param model Shared content. @returns Keeper whose disposal never disposes the model. */
export function bindPaneView(editor: ViewEditor, scope: string, path: string, model: unknown) {
  const keeper = createViewKeeper(editor)
  keeper.bind(scope, path, model)
  return keeper
}

export interface PassiveProps {
  path: string | null
  mount(host: HTMLDivElement, path: string): (() => void) | undefined
}

/** @public @author ddj 2026年10月14号 @param props Workbench-owned mounting contract. @returns Independent visible file view without global command listeners. */
export function PassiveEditor(props: PassiveProps): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    if (host.current && props.path) return props.mount(host.current, props.path)
  }, [props.path, props.mount])
  return React.createElement('div', { ref: host, className: 'edrv-passive-view' })
}

export interface SplitProps {
  axis: 'horizontal' | 'vertical'
  ratio: number
  onRatio(ratio: number): void
  first: React.ReactNode
  second: React.ReactNode
}

/** @public @author ddj 2026年10月14号 @param props Split geometry. @returns Resizable split with keyboard equivalents. */
export function EditorSplit(props: SplitProps): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null)
  const clean = React.useRef<(() => void) | null>(null)
  const latest = React.useRef(props)
  latest.current = props
  React.useEffect(() => () => clean.current?.(), [])
  /** @private @author ddj 2026年10月14号 @param event Separator press. Resize only this branch. */
  function start(event: React.PointerEvent): void {
    if (event.button !== 0 || !host.current) return
    clean.current?.()
    event.preventDefault()
    const rect = host.current.getBoundingClientRect(), pointer = event.pointerId
    /** @private @author ddj 2026年10月14号 @param value Pointer movement. Keep both leaves usable. */
    function move(value: PointerEvent): void {
      if (value.pointerId !== pointer) return
      const horizontal = latest.current.axis === 'horizontal'
      const size = horizontal ? rect.width : rect.height
      const min = Math.min(0.45, (horizontal ? 240 : 160) / size)
      const at = horizontal ? value.clientX - rect.left : value.clientY - rect.top
      latest.current.onRatio(Math.max(min, Math.min(1 - min, at / size)))
    }
    /** @private @author ddj 2026年10月14号 Remove resize listeners. */
    function stop(): void {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
      clean.current = null
    }
    clean.current = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
  }
  /** @private @author ddj 2026年10月14号 @param event Keyboard resizing. Arrow keys change ratio. */
  function key(event: React.KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    props.onRatio(Math.max(0.1, Math.min(0.9, props.ratio + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -0.05 : 0.05))))
  }
  return React.createElement('div', { ref: host, className: 'edrv-split edrv-split-' + props.axis },
    React.createElement('div', { className: 'edrv-split-child', style: { flex: props.ratio } }, props.first),
    React.createElement('div', { className: 'edrv-split-handle', role: 'separator', tabIndex: 0, 'aria-orientation': props.axis === 'horizontal' ? 'vertical' : 'horizontal', 'aria-valuenow': Math.round(props.ratio * 100), 'aria-valuemin': 10, 'aria-valuemax': 90, onPointerDown: start, onKeyDown: key }),
    React.createElement('div', { className: 'edrv-split-child', style: { flex: 1 - props.ratio } }, props.second))
}
