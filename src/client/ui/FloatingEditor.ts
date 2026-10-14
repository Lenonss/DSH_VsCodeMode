/** In-page editor window; closing returns tabs, never closes documents. @author ddj 2026年10月14号 */
import React from 'react'
import type { FloatRect } from '../state/editorLayout.js'
import { FloatingWindow } from './FloatingWindow.js'

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

/** @public @author ddj 2026年10月14号 @param props Window geometry and group callbacks. @returns Shared window chrome preserving tab ownership. */
export function FloatingEditor(props: FloatingProps): React.ReactElement {
  /** @private @author ddj 2026年10月14号 @param rect Updated window bounds. */
  function bounds(rect: FloatRect): void { props.onBounds(props.group, rect) }
  /** @private @author ddj 2026年10月14号 Return all tabs to the main group. */
  function returnTabs(): void { props.onReturn(props.group) }
  /** @private @author ddj 2026年10月14号 Bring the group to the foreground. */
  function focus(): void { props.onFocus(props.group) }
  const actions = React.createElement(React.Fragment, null,
    React.createElement('button', { type: 'button', title: '将全部文件移回主编辑区', onClick: returnTabs }, '移回主编辑区'),
    React.createElement('button', { type: 'button', title: '关闭浮窗并将文件移回主编辑区', 'aria-label': '关闭浮窗并移回文件', onClick: returnTabs }, '×'))
  return React.createElement(FloatingWindow, {
    title: '浮动编辑组', owner: props.owner, group: props.group, rect: props.rect,
    closeOnEsc: false, onBounds: bounds, onFocus: focus, actions,
  }, props.children)
}
