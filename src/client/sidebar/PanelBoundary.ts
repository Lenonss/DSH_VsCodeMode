/** Panel-local callback and React subtree isolation, not a security sandbox. @author ddj 2026年10月22号 */
import React from 'react'
import type { SidebarCtx, SidebarPanelDef } from './types.js'

export interface PanelCheck { panel: SidebarPanelDef; badge: number | null; error?: Error }
interface BoundaryProps { panel: SidebarPanelDef; scope?: string; sessionId?: string; compact?: boolean; children?: React.ReactNode }
interface BoundaryState { panel: SidebarPanelDef; scope?: string; sessionId?: string; error: Error | null }
const panelIds = new WeakMap<SidebarPanelDef, number>()
let nextPanelId = 0
/** @private @author ddj 2026年10月22号 @param props Subtree ownership. @returns Stable identity that changes on registration, scope or session replacement. */
function ownerKey(props: BoundaryProps): string {
  if (!panelIds.has(props.panel)) panelIds.set(props.panel, ++nextPanelId)
  return JSON.stringify([panelIds.get(props.panel), props.scope, props.sessionId])
}

/** @public @author ddj 2026年10月22号 @param panel Registered definition. @param ctx Current scope. @returns Hidden marker or isolated visible/badge result; failed guards stay reachable for retry. */
export function inspectPanel(panel: SidebarPanelDef, ctx: SidebarCtx): PanelCheck | null {
  try {
    if (panel.visible && panel.visible(ctx) !== true) return null
    return { panel, badge: panel.badge?.(ctx) ?? null }
  } catch (error) {
    return { panel, badge: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/** @public @author ddj 2026年10月22号 @description Reset a failed subtree when registration or scope ownership changes. */
export class PanelBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { panel: this.props.panel, scope: this.props.scope, sessionId: this.props.sessionId, error: null }

  /** @public @author ddj 2026年10月22号 @param props Current ownership. @param state Previous ownership/error. @returns Reset only when the owner changes. */
  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (state.panel === props.panel && state.scope === props.scope && state.sessionId === props.sessionId) return null
    return { panel: props.panel, scope: props.scope, sessionId: props.sessionId, error: null }
  }

  /** @public @author ddj 2026年10月22号 @param error React render/lifecycle error. @returns Local fallback state. */
  static getDerivedStateFromError(error: Error): Partial<BoundaryState> { return { error } }

  /** @private @author ddj 2026年10月22号 @description Remount only this failed subtree and reevaluate its callbacks. */
  private retry = (): void => { this.setState({ error: null }) }

  /** @public @author ddj 2026年10月22号 @returns Original subtree or panel-local retry UI. */
  render(): React.ReactNode {
    if (!this.state.error) return React.createElement(React.Fragment, { key: ownerKey(this.props) }, this.props.children)
    if (this.props.compact) return React.createElement('span', { role: 'img', title: '图标加载失败', 'aria-label': '图标加载失败' }, '!')
    return React.createElement('div', { className: 'edrv-empty', role: 'alert' },
      this.props.panel.title + '：' + String(this.state.error.message),
      React.createElement('button', { onClick: this.retry }, '重试'))
  }
}

/** @public @author ddj 2026年10月22号 @param props Isolated panel invocation below the boundary. @returns Panel subtree. @throws Extension callback error for the nearest boundary. */
export function PanelContent(props: { panel: SidebarPanelDef; ctx: SidebarCtx }): React.ReactNode {
  const checked = inspectPanel(props.panel, props.ctx)
  if (checked?.error) throw checked.error
  return checked ? props.panel.render(props.ctx) as React.ReactNode : null
}
