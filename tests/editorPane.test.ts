import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { EditorPane, bindPaneView } from '../src/client/ui/EditorPane.js'
import { buildTabMenu } from '../src/client/tabMenu.js'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createDocStore } from '../src/client/state/documentStore.js'
import { createLayout, moveTab, syncTabs, ownerOf } from '../src/client/state/editorLayout.js'
import { applyClose, closeAll, closeOthers, closeRight, closeSaved } from '../src/client/tabActions.js'

/** @private @author ddj 2026年10月14号 @param node React element. @returns Flattened element descendants for callback-level tests. */
function descendants(node: any): any[] {
  if (!node || typeof node !== 'object') return []
  return [node, ...React.Children.toArray(node.props?.children).flatMap(descendants)]
}

/** @private @author ddj 2026年10月14号 @returns Testable pane with real tab component callbacks. */
function pane() {
  const callbacks = { onSelect: vi.fn(), onClose: vi.fn(), onDrag: vi.fn(), onMenu: vi.fn(), consumeClick: vi.fn(() => false) }
  const tree = EditorPane({ group: { id: 'main', active: 'a.ts', tabs: [{ path: 'a.ts' }, { path: 'pin.ts', pinned: true }] }, focused: true, dirty: { 'a.ts': true }, ...callbacks })
  return { tree, callbacks, nodes: descendants(tree) }
}

const css = readFileSync(new URL('../src/client/styles/editor.css', import.meta.url), 'utf8')
/** @private @author ddj 2026年10月14号 @param selector Exact stylesheet selector. @returns Declaration block for style regression evidence. */
function cssRule(selector: string): string {
  const start = css.indexOf(selector + ' {')
  if (start < 0) throw new Error('Missing style: ' + selector)
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
}

describe('page and tab visual contracts', () => {
  it('disables text selection on tabs without disabling editor content selection', () => {
    const rule = cssRule('[data-edrv-view] .edrv-tab')
    expect(rule).toContain('user-select: none')
    expect(rule).toContain('-webkit-user-select: none')
    expect(cssRule('[data-edrv-view]')).not.toContain('user-select: none')
  })
  it('has no permanent focused page or floating blue frame', () => {
    expect(cssRule('[data-edrv-view] .edrv-group')).toContain('border: 0')
    expect(css).not.toMatch(/\.edrv-(?:group|floating)-focused\s*\{/)
  })
  it('uses a borderless translucent rectangle without blocking pointer hit testing', () => {
    const rule = cssRule('.edrv-drag-overlay')
    expect(rule).toContain('border: 0')
    expect(rule).toContain('var(--dsw-alias-state-info-primary, #4d6bfe) 25%, transparent')
    expect(rule).toContain('pointer-events: none')
  })
  it('keeps the small close glyph without native button chrome', () => {
    const rule = cssRule('[data-edrv-view] .edrv-tab .edrv-tab-x')
    for (const style of ['appearance: none', 'border: 0', 'padding: 0', 'background: transparent', 'box-shadow: none', 'width: 16px', 'height: 16px']) expect(rule).toContain(style)
    const { nodes } = pane()
    const close = nodes.find((node) => node.props['aria-label'] === '关闭 a.ts')
    expect(close.type).toBe('button')
    expect(close.props.children).toBe('×')
  })
})

const source = ts.createSourceFile('EditorView.ts', readFileSync(new URL('../src/client/ui/EditorView.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const adapters = new Map<string, string>()
/** @private @author ddj 2026年10月14号 @param node Production syntax node. Retain real workbench adapters for behavioral execution. */
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name) adapters.set(node.name.text, node.getText(source))
  ts.forEachChild(node, collect)
}
collect(source)
/** @private @author ddj 2026年10月14号 @param name Actual adapter name. @param scope Explicit IO/view dependencies. @returns Executable production function. */
function adapter(name: string, scope: Record<string, unknown>): (...args: any[]) => any {
  const text = adapters.get(name)
  if (!text) throw new Error('Missing workbench adapter: ' + name)
  return new Function(...Object.keys(scope), text + '; return ' + name)(...Object.values(scope))
}

describe('actual workbench adapters', () => {
  it('closes right tabs in visible group order without touching other groups', () => {
    let layout = createLayout(['a', 'b', 'c', 'd'].map((path) => ({ path })), 'a')
    layout = moveTab(layout, 'd', { kind: 'split', group: 'main', edge: 'right' })
    layout = moveTab(layout, 'a', { kind: 'group', group: 'main', index: 3 })
    const closeTabs = vi.fn()
    const close = adapter('closeInGroup', { benchRef: { current: layout }, ownerOf, closeOthers, closeRight, closeSaved, closeAll, dirtyRef: { current: {} }, tabsRef: { current: ['a', 'b', 'c', 'd'].map((path) => ({ path })) }, activeRef: { current: 'd' }, applyClose, closeTabs })
    close('c', 'right')
    expect(closeTabs.mock.calls[0][0].tabs.map((tab: any) => tab.path)).toEqual(['b', 'c', 'd'])
    expect(closeTabs.mock.calls[0][0].active).toBe('d')
  })
  it('moves a dirty file without closing or forcing a save', () => {
    const layout = createLayout([{ path: 'a' }, { path: 'b' }], 'a')
    const setWorkbench = vi.fn(), setDiskActive = vi.fn(), saveViewState = vi.fn()
    const acceptLayout = adapter('acceptLayout', { saveViewState, setWorkbench, setPlanActive: vi.fn(), setDiskActive })
    const reference = vi.fn()
    const drop = adapter('dropTab', { ownerOf: (current: any, path: string) => current.groups.find((group: any) => group.tabs.some((tab: any) => tab.path === path)), benchRef: { current: layout }, addRefToChat: reference, acceptLayout, moveTab })
    drop('a', { kind: 'split', group: 'main', edge: 'right' })
    const next = setWorkbench.mock.calls[0][0]
    expect(next.groups.find((group: any) => group.id === 'group-1')?.tabs).toEqual([{ path: 'a' }])
    expect(setDiskActive).toHaveBeenCalledWith('a')
    expect(saveViewState).toHaveBeenCalledOnce()
    expect(reference).not.toHaveBeenCalled()
  })
  it('references only trusted open tabs and leaves ownership untouched', () => {
    const layout = createLayout([{ path: 'a' }], 'a'), addRefToChat = vi.fn(), acceptLayout = vi.fn()
    const drop = adapter('dropTab', { ownerOf: (current: any, path: string) => current.groups.find((group: any) => group.tabs.some((tab: any) => tab.path === path)), benchRef: { current: layout }, addRefToChat, acceptLayout, moveTab })
    drop('external-text', { kind: 'reference' })
    drop('a', { kind: 'reference' })
    expect(addRefToChat).toHaveBeenCalledExactlyOnceWith('a')
    expect(acceptLayout).not.toHaveBeenCalled()
    expect(layout.groups[0].tabs).toEqual([{ path: 'a' }])
  })
  it('saves the requested cached model rather than the focused editor text', async () => {
    const save = vi.fn(async () => ({ ok: true, rev: 'new' })), model = { getValue: () => 'dirty B' }
    const store = createDocStore({ save })
    const saveDocument = adapter('saveDocument', { modelsRef: { current: new Map([['b', model]]) }, documents: () => store, revRef: { current: { b: 'old' } }, dirtyRef: { current: { b: true } }, readSync: () => null, scope: 'workspace' })
    await saveDocument('b', false)
    expect(save).toHaveBeenCalledExactlyOnceWith({ path: 'b', content: 'dirty B', rev: 'old' })
    expect(store.state('b').dirty).toBe(false)
    store.dispose()
  })
  it('reparents the full view without recreating the editor or repeating attachments', () => {
    const fullHost: any = { parentElement: null }, layout = vi.fn()
    const mount = adapter('mountFull', { fullHost, editorRef: { current: { layout } } })
    const host = { appendChild: vi.fn((node: any) => { node.parentElement = host }) }
    mount(host); mount(host); mount(null)
    expect(host.appendChild).toHaveBeenCalledOnce()
    expect(layout).toHaveBeenCalledOnce()
  })
  it('retains one PDF panel container when moving across groups', () => {
    const createElement = vi.fn(() => ({ className: '' }))
    const pdfNode = adapter('pdfNode', { pdfNodes: { current: new Map() }, document: { createElement } })
    expect(pdfNode('a.pdf')).toBe(pdfNode('a.pdf'))
    expect(createElement).toHaveBeenCalledOnce()
  })
})

describe('actual editor pane interaction', () => {
  it('renders group geometry, accessible tabs and dirty markers', () => {
    const { tree, nodes } = pane()
    expect(tree.props['data-edrv-group']).toBe('main')
    expect(nodes.filter((node) => node.props.role === 'tab')).toHaveLength(2)
    expect(nodes.some((node) => node.props.title === '未保存修改')).toBe(true)
    expect(nodes.filter((node) => node.props['aria-label']?.startsWith('关闭 '))).toHaveLength(1)
  })
  it('starts trusted internal drag and consumes the post-drag click', () => {
    const { nodes, callbacks } = pane()
    const tab = nodes.find((node) => node.props['data-edrv-tab-path'] === 'a.ts')
    const press = { pointerId: 7 }
    tab.props.onPointerDown(press)
    expect(callbacks.onDrag).toHaveBeenCalledWith('a.ts', press)
    callbacks.consumeClick.mockReturnValueOnce(true)
    tab.props.onClick()
    expect(callbacks.onSelect).not.toHaveBeenCalled()
    tab.props.onClick()
    expect(callbacks.onSelect).toHaveBeenCalledWith('main', 'a.ts')
  })
  it('isolates close press from dragging and supports keyboard selection', () => {
    const { nodes, callbacks } = pane()
    const close = nodes.find((node) => node.props['aria-label'] === '关闭 a.ts')
    const event = { stopPropagation: vi.fn() }
    close.props.onPointerDown(event)
    close.props.onClick(event)
    expect(event.stopPropagation).toHaveBeenCalledTimes(2)
    expect(callbacks.onDrag).not.toHaveBeenCalled()
    expect(callbacks.onClose).toHaveBeenCalledWith('a.ts')
    const tab = nodes.find((node) => node.props['data-edrv-tab-path'] === 'pin.ts')
    tab.props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() })
    expect(callbacks.onSelect).toHaveBeenCalledWith('main', 'pin.ts')
  })
  it('has real split/float menu alternatives with capability guards', () => {
    const entries = buildTabMenu({ path: 'a', tabs: [{ path: 'a' }], active: 'a', dirty: {}, hasSession: true, canAddToConversation: true, canSplit: false, canFloat: true, canReturn: false })
    expect(entries.find((item) => item.id === 'split-right')?.disabled).toBe(true)
    expect(entries.find((item) => item.id === 'move-new-window')?.disabled).toBe(false)
    expect(entries.find((item) => item.id === 'return-main')?.disabled).toBe(true)
  })
  it('keeps layout ownership after legacy tab reconciliation', () => {
    const state = moveTab(createLayout([{ path: 'a' }, { path: 'b' }], 'a'), 'a', { kind: 'split', group: 'main', edge: 'right' })
    const next = syncTabs(state, [{ path: 'a' }, { path: 'b' }], 'a')
    expect(next.focused).toBe('group-1')
    expect(next.groups.find((group) => group.id === 'group-1')?.active).toBe('a')
  })
})
