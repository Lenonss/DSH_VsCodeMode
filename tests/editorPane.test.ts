import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { EditorPane, GroupPathbar, bindPaneView, type PaneProps } from '../src/client/ui/EditorPane.js'
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

/** @private @author ddj 2026年10月14号 @param overrides Pane props replacing defaults. @returns Testable pane with real tab component callbacks. */
function pane(overrides: Partial<PaneProps> = {}) {
  const callbacks = { onSelect: vi.fn(), onClose: vi.fn(), onDrag: vi.fn(), onMenu: vi.fn(), consumeClick: vi.fn(() => false) }
  const tree = EditorPane({ group: { id: 'main', active: 'a.ts', tabs: [{ path: 'a.ts' }, { path: 'pin.ts', pinned: true }] }, focused: true, dirty: { 'a.ts': true }, ...callbacks, ...overrides })
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
    const acceptLayout = adapter('acceptLayout', { saveViewState, setWorkbench, setPlanActive: vi.fn(), setDiskActive, activeRef: { current: 'b' }, resetContentForSwitch: () => {} })
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
  it('suppresses disk tab selection and keeps one tab row while a plan preview is active', () => {
    let layout = createLayout([{ path: 'a' }, { path: 'b' }], 'a')
    layout = moveTab(layout, 'b', { kind: 'split', group: 'main', edge: 'right' })
    const renderWith = (planActive: string | null) => adapter('renderGroup', {
      workbench: layout, dirtyMap: {}, planActive, sessionId: 'test-session', React, EditorPane, GroupPathbar: () => null, PassiveEditor: () => null,
      mountFull: () => {}, passiveMount: () => {}, scope: 'w', selectGroup: vi.fn(), closeTab: vi.fn(), paneMenu: vi.fn(), dragTab: vi.fn(), consumeDrag: () => false,
      // 页签行归属在组件体里算好（浮窗聚焦时回落到主组），renderGroup 只按 id 认领这一行。
      rowOwner: layout.focused, tabsHostRef: { current: null }, planTabExtras: [{}], rowTools: {},
    })
    const preview = layout.groups.map((group) => renderWith('dsh-resource://plan/s/c')(group.id))
    for (const [index, group] of layout.groups.entries()) {
      // 计划预览接管焦点组正文：只有它收起磁盘选中态（其余分组仍保留自己的选中页签）
      expect(preview[index].props.suppressActive).toBe(group.id === layout.focused)
      // 同一时刻只有焦点分组承载页签行：计划页签与行尾工具列只出现在这一组，其余分组不再有第二行
      expect(preview[index].props.extras !== undefined).toBe(group.id === layout.focused)
      expect(preview[index].props.tools !== undefined).toBe(group.id === layout.focused)
    }
    const idle = layout.groups.map((group) => renderWith(null)(group.id))
    expect(idle.every((paneNode) => paneNode.props.suppressActive === false)).toBe(true)
    // 浮窗里的组不承载页面页签行（浮窗自带标题栏），但仍收起磁盘选中态
    const floatingPane = renderWith('dsh-resource://plan/s/c')(layout.focused, true)
    expect(floatingPane.props.extras).toBeUndefined()
    expect(floatingPane.props.tools).toBeUndefined()
    expect(floatingPane.props.suppressActive).toBe(true)
  })
  it('returns to the pre-plan file when the active preview closes', () => {
    const address = 'dsh-resource://plan/s/c'
    const closeWith = (planActive: string, planReturn: string | null) => {
      const scope = { setPlanTabs: vi.fn(), planActiveRef: { current: planActive }, planReturnRef: { current: planReturn }, setActive: vi.fn(), tabsRef: { current: [{ path: 'a.ts' }, { path: 'b.ts' }] } }
      adapter('closePlan', scope)(address, undefined)
      return scope
    }
    expect(closeWith(address, 'b.ts').setActive).toHaveBeenCalledWith('b.ts')
    expect(closeWith(address, 'gone.ts').setActive).toHaveBeenCalledWith('a.ts')
    expect(closeWith(address, null).setActive).toHaveBeenCalledWith('a.ts')
    expect(closeWith('dsh-resource://plan/s/other', 'b.ts').setActive).not.toHaveBeenCalled()
  })
})

describe('actual editor pane interaction', () => {
  it('renders a static pathbar per group with a stable height and focus click (ddj 2026年10月16号)', () => {
    const onFocus = vi.fn()
    const withFile = GroupPathbar({ path: 'Assets/GameData/Scheme/ItemScheme.lua', onFocus })
    const nodes = descendants(withFile)
    expect(withFile.props.className).toBe('edrv-pathbar')
    expect(withFile.props['data-edrv-pb-static']).toBe('1')
    expect(nodes.find((node) => node.props.className === 'edrv-pb-name')?.props.children).toBe('ItemScheme.lua')
    expect(nodes.find((node) => node.props.className === 'edrv-pb-full')?.props.children).toBe('Assets/GameData/Scheme/ItemScheme.lua')
    withFile.props.onClick()
    expect(onFocus).toHaveBeenCalledOnce()
    // 空分组占位：恒定高度、无空文件名
    const empty = GroupPathbar({ path: null })
    expect(descendants(empty).find((node) => node.props.className === 'edrv-pb-name')?.props.children).toBe('未打开文件')
    expect(empty.props.title).toBe('此分页未打开文件')
  })
  it('renders group geometry, accessible tabs and dirty markers', () => {
    const { tree, nodes } = pane()
    expect(tree.props['data-edrv-group']).toBe('main')
    expect(nodes.filter((node) => node.props.role === 'tab')).toHaveLength(2)
    expect(nodes.some((node) => node.props.title === '未保存修改')).toBe(true)
    expect(nodes.filter((node) => node.props['aria-label']?.startsWith('关闭 '))).toHaveLength(1)
  })
  it('paints exactly one selected tab and none while a plan preview owns the pane', () => {
    const tabsOf = (nodes: any[]) => nodes.filter((node) => node.props.role === 'tab')
    const selectedOf = (nodes: any[]) => tabsOf(nodes).filter((node) => String(node.props.className).includes('edrv-tab-active'))
    expect(selectedOf(pane().nodes)).toHaveLength(1)
    expect(tabsOf(pane().nodes).filter((node) => node.props['aria-selected'] === true)).toHaveLength(1)
    // 双下划线根因：计划预览接管正文后，磁盘页签既不能画 active 也不能宣告 aria-selected。
    const suppressed = pane({ suppressActive: true }).nodes
    expect(selectedOf(suppressed)).toHaveLength(0)
    expect(tabsOf(suppressed).every((node) => node.props['aria-selected'] === false)).toBe(true)
    expect(pane({ suppressActive: false }).nodes.some((node) => String(node.props.className).includes('edrv-tab-active'))).toBe(true)
  })
  it('keeps the plan preview tabs and row tools on the single tab row of the focused pane', () => {
    const planTab = React.createElement('div', { className: 'edrv-tab edrv-tab-plan', key: 'plan' }, '计划预览')
    const tools = React.createElement('div', { className: 'edrv-tabs-tools', key: 'tools' }, '←')
    const { tree } = pane({ extras: planTab, tools })
    const row = tree.props.children[0]
    expect(row.props.className).toBe('edrv-tabs-row')
    const [strip, rowTools] = React.Children.toArray(row.props.children) as any[]
    expect(strip.props.className).toBe('edrv-tabs')
    expect(strip.props.role).toBe('tablist')
    // 计划预览页签与磁盘页签同处一条滚动区（extras 是页签区的尾部内容），工具列在滚动区之外
    const stripChildren = React.Children.toArray(strip.props.children) as any[]
    expect(stripChildren.some((node) => node.props.className === 'edrv-tab edrv-tab-plan')).toBe(true)
    expect(rowTools.props.className).toBe('edrv-tabs-tools')
    expect(cssRule('[data-edrv-view] .edrv-tabs-row')).toContain('display: flex')
    // 页签区吃掉行走宽（特异性要压过分组内 .edrv-tabs 的 flex: 0 0 auto），工具列固定行尾
    expect(cssRule('[data-edrv-view] .edrv-group .edrv-tabs-row > .edrv-tabs')).toContain('flex: 1 1 auto')
    expect(cssRule('[data-edrv-view] .edrv-tabs-tools')).toContain('flex: 0 0 auto')
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
