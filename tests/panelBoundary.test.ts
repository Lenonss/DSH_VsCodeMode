/** Panel callbacks plus the real React server render path. @author ddj 2026年10月22号 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { inspectPanel, PanelBoundary, PanelContent } from '../src/client/sidebar/PanelBoundary.js'
import { SidebarView } from '../src/client/sidebar/SidebarView.js'
import type { SidebarCtx, SidebarPanelDef } from '../src/client/sidebar/types.js'
const ctx = { scope: 'ws:a', sessionId: 's1' } as SidebarCtx
/** @private @author ddj 2026年10月22号 @param overrides Callback overrides. @returns Test extension. */
function panel(overrides: Partial<SidebarPanelDef> = {}): SidebarPanelDef {
  return { id: 'acme.panel', title: 'Example', icon: '', render: () => React.createElement('span', null, 'healthy'), ...overrides }
}

describe('panel isolation', () => {
  it('isolates both visible and badge failures while retaining a retryable entry', () => {
    for (const callback of ['visible', 'badge']) {
      const extension = panel({ [callback]: () => { throw new Error(callback) } })
      expect(inspectPanel(extension, ctx)?.error?.message).toBe(callback)
      expect(() => PanelContent({ panel: extension, ctx })).toThrow(callback)
    }
    expect(inspectPanel(panel({ visible: () => false }), ctx)).toBeNull()
  })
  it('invokes render beneath rather than above the React error boundary', () => {
    const extension = panel({ render: () => { throw new Error('render failed') } })
    expect(() => PanelContent({ panel: extension, ctx })).toThrow('render failed')
    const boundary = new PanelBoundary({ panel: extension, scope: ctx.scope })
    boundary.state = { ...boundary.state, ...PanelBoundary.getDerivedStateFromError(new Error('render failed')) }
    const markup = renderToStaticMarkup(boundary.render() as React.ReactElement)
    expect(markup).toContain('role="alert"'); expect(markup).toContain('render failed'); expect(markup).toContain('重试')
    boundary.setState = ((patch: object) => { boundary.state = { ...boundary.state, ...patch } }) as any
    ;(boundary.render() as React.ReactElement<any>).props.children[1].props.onClick()
    expect(boundary.state.error).toBeNull()
  })
  it('resets only for new scope, session or registered instance', () => {
    const extension = panel(), boundary = new PanelBoundary({ panel: extension, scope: 'ws:a', sessionId: 's1' })
    boundary.state.error = new Error('old')
    expect(PanelBoundary.getDerivedStateFromProps(boundary.props, boundary.state)).toBeNull()
    for (const props of [{ ...boundary.props, scope: 'ws:b' }, { ...boundary.props, sessionId: 's2' }, { ...boundary.props, panel: panel() }]) {
      expect(PanelBoundary.getDerivedStateFromProps(props, boundary.state)?.error).toBeNull()
    }
  })
  it('changes the keyed healthy subtree on registered owner or scope replacement', () => {
    const extension = panel(), boundary = new PanelBoundary({ panel: extension, scope: 'a' })
    const original = (boundary.render() as React.ReactElement).key
    boundary.props = { panel: extension, scope: 'b' }
    expect((boundary.render() as React.ReactElement).key).not.toBe(original)
    const scoped = (boundary.render() as React.ReactElement).key
    boundary.props = { panel: panel(), scope: 'b' }
    expect((boundary.render() as React.ReactElement).key).not.toBe(scoped)
  })
  it('uses a compact non-interactive icon fallback without nested buttons', () => {
    const boundary = new PanelBoundary({ panel: panel(), compact: true })
    boundary.state.error = new Error('icon failed')
    const markup = renderToStaticMarkup(boundary.render() as React.ReactElement)
    expect(markup).toContain('图标加载失败'); expect(markup).not.toContain('<button')
  })
  it('renders healthy panel and rail despite another extension guard throwing', () => {
    const bad = panel({ id: 'bad', visible: () => { throw new Error('bad guard') } }), good = panel({ id: 'good' })
    const markup = renderToStaticMarkup(React.createElement(SidebarView, {
      registry: { list: () => [bad, good] }, ctx, activePanel: 'good', visible: true, width: 350,
    }))
    expect(markup).toContain('healthy'); expect(markup).toContain('edrv-rail-btn')
  })
})
