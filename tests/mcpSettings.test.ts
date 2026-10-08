import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ scope: '', index: 0, states: new Map<string, any[]>(), effects: new Map<string, any[]>(), pending: [] as Array<() => void>, request: vi.fn() }))
vi.mock('../src/client/rpc.js', () => ({ rpc: harness.request }))
vi.mock('../src/client/ui/LspSettings.js', () => ({ LspSettings: () => null }))
vi.mock('../src/client/ui/PerfSettings.js', () => ({ PerfSettings: () => null }))
vi.mock('../src/client/ui/IntegrationSettings.js', () => ({ IntegrationSettings: () => null }))
vi.mock('../src/client/ui/AiSettings.js', () => ({ AiSettings: () => null }))
vi.mock('react', async (original) => {
  const real = await original<any>()
  const React = { ...real.default }
  /** @author ddj 2026年10月08号 @param initial Hook initial value. @returns State and setter. */
  React.useState = (initial: any) => {
    const index = harness.index++
    const values = harness.states.get(harness.scope) ?? []
    harness.states.set(harness.scope, values)
    if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial
    return [values[index], (next: any) => { values[index] = typeof next === 'function' ? next(values[index]) : next }]
  }
  /** @author ddj 2026年10月08号 @param initial Ref initial value. @returns Stable ref. */
  React.useRef = (initial: any) => React.useState({ current: initial })[0]
  /** @author ddj 2026年10月08号 @param effect Effect callback. @param deps Dependencies. */
  React.useEffect = (effect: any, deps: any[]) => {
    const index = harness.index++
    const effects = harness.effects.get(harness.scope) ?? []
    harness.effects.set(harness.scope, effects)
    const old = effects[index]
    if (old && deps.every((value, i) => value === old.deps[i])) return
    harness.pending.push(() => { old?.cleanup?.(); effects[index] = { deps, cleanup: effect() } })
  }
  /** @author ddj 2026年10月08号 @param callback Callback. @param deps Dependencies. @returns Stable callback. */
  React.useCallback = (callback: any, deps: any[]) => {
    const index = harness.index++
    const values = harness.states.get(harness.scope) ?? []
    harness.states.set(harness.scope, values)
    const old = values[index]
    if (!old || !deps.every((value, i) => value === old.deps[i])) values[index] = { deps, callback }
    return values[index].callback
  }
  return { ...real, default: React }
})
import { McpSettings } from '../src/client/ui/McpSettings.js'

/** @author ddj 2026年10月08号 @param component Hook component. @param props Props. @returns Element tree with effects flushed. */
function render(component: any, props: any = {}) {
  harness.scope = component.name
  harness.index = 0
  const tree = component(props)
  harness.pending.splice(0).forEach((run) => run())
  return tree
}
/** @author ddj 2026年10月08号 @param tree Element subtree. @param test Element predicate. @returns First matching element. */
function find(tree: any, test: (node: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return undefined
  if (test(tree)) return tree
  const children = [tree.props?.children].flat(Infinity)
  for (const child of children) {
    const found = find(child, test)
    if (found) return found
  }
}
/** @author ddj 2026年10月08号 @returns MCP panel element after choosing the tab. */
function panel() {
  const tree = render(McpSettings)
  find(tree, (node) => node.type === 'button' && node.props.children === 'MCP 管理').props.onClick()
  return find(render(McpSettings), (node) => node.type?.name === 'McpManagePanel')
}
/** @author ddj 2026年10月08号 @returns Settled immediate promise reactions. */
async function settle() { await vi.advanceTimersByTimeAsync(0) }

const server = { id: 'global', serverName: 'agent', enabled: true, status: 'configured', toolCount: 0, tools: [], transport: 'stdio' }
const project = { workspacePath: 'D:/Workspace', title: 'Workspace', servers: [] }

describe('MCP settings integration', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    harness.states.clear(); harness.effects.clear(); harness.pending.length = 0
    harness.request.mockReset().mockImplementation(async (method) => method === 'mcp.list' ? { ok: true, servers: [server] } : method === 'mcp.projects' ? { ok: true, projects: [project] } : { ok: true, servers: [server], projects: [project] })
    const document = new EventTarget()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    vi.stubGlobal('document', document)
    vi.stubGlobal('window', { confirm: vi.fn(() => true) })
    render(McpSettings)
    await settle()
  })
  afterEach(() => {
    for (const effects of harness.effects.values()) for (const effect of effects) effect?.cleanup?.()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  it('does not poll on general tab, polls snapshot on MCP, and unsubscribes on unmount', async () => {
    await vi.advanceTimersByTimeAsync(10000)
    expect(harness.request).toHaveBeenCalledTimes(2)
    panel()
    await vi.advanceTimersByTimeAsync(3000)
    expect(harness.request.mock.calls.some((call) => call[0] === 'mcp.snapshot')).toBe(true)
    for (const effects of harness.effects.values()) for (const effect of effects) effect?.cleanup?.()
    const count = harness.request.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(harness.request).toHaveBeenCalledTimes(count)
  })
  it('stops polling on hidden document and non-MCP tab', async () => {
    panel()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    const count = harness.request.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(harness.request).toHaveBeenCalledTimes(count)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    const tree = render(McpSettings)
    find(tree, (node) => node.type === 'button' && node.props.children === '通用').props.onClick()
    render(McpSettings)
    await vi.advanceTimersByTimeAsync(10000)
    expect(harness.request).toHaveBeenCalledTimes(count)
  })
  it('removes global by id and locks another mutation before React rerender', async () => {
    const manage = panel()
    let finish!: (result: any) => void
    harness.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const first = manage.props.removeGlobal('global')
    await manage.props.refreshGlobal('global')
    expect(harness.request.mock.calls.at(-1)?.slice(0, 2)).toEqual(['mcp.remove', { id: 'global' }])
    finish({ ok: true })
    await first
    expect(panel().props.servers).toEqual([])
  })
  it('catches synchronous bad config and keeps the form and draft open', async () => {
    let manage = panel()
    let tree = render(manage.type, manage.props)
    find(tree, (node) => node.type === 'button' && node.props.children === '+ 添加全局 MCP').props.onClick()
    manage.props.edit('args', '[1]')
    manage = panel()
    tree = render(manage.type, manage.props)
    const form = find(tree, (node) => node.type?.name === 'McpForm')
    await form.props.save()
    manage = panel()
    tree = render(manage.type, manage.props)
    expect(find(tree, (node) => node.type?.name === 'McpForm')).toBeTruthy()
    expect(manage.props.draft.args).toBe('[1]')
    expect(manage.props.busy).toBe('')
    expect(harness.request.mock.calls.some((call) => call[0] === 'mcp.save')).toBe(false)
    expect(find(render(McpSettings), (node) => node.props.className === 'vsm-mcp-error vsm-mcp-banner')).toBeTruthy()
  })
  it('preserves failed save form and closes only after success', async () => {
    let manage = panel()
    const opened = render(manage.type, manage.props)
    find(opened, (node) => node.type === 'button' && node.props.children === '+ 添加全局 MCP').props.onClick()
    manage.props.edit('serverName', 'new')
    manage = panel()
    let form = find(render(manage.type, manage.props), (node) => node.type?.name === 'McpForm')
    harness.request.mockResolvedValueOnce({ ok: false, error: 'disk denied' })
    await form.props.save()
    manage = panel()
    form = find(render(manage.type, manage.props), (node) => node.type?.name === 'McpForm')
    expect(form).toBeTruthy()
    expect(manage.props.draft.serverName).toBe('new')
    harness.request.mockResolvedValueOnce({ ok: true, server: { ...server, id: 'new' } })
    await form.props.save()
    manage = panel()
    expect(find(render(manage.type, manage.props), (node) => node.type?.name === 'McpForm')).toBeUndefined()
    expect(manage.props.draft.serverName).toBe('')
    expect(manage.props.servers).toHaveLength(2)
  })
  it('keeps project form open on synchronous malformed headers, then saves losslessly', async () => {
    let manage = panel()
    const tree = render(manage.type, manage.props)
    find(tree, (node) => node.type === 'button' && node.props.children === '项目 MCP').props.onClick()
    const projectTree = render(manage.type, manage.props)
    const group = find(projectTree, (node) => node.type?.name === 'ProjectGroup')
    group.props.onAdd(project)
    manage.props.edit('serverName', 'http')
    manage.props.edit('transport', 'streamable-http')
    manage.props.edit('url', ' https://example.test/mcp ')
    manage.props.edit('headers', 'broken')
    manage = panel()
    let form = find(render(manage.type, manage.props), (node) => node.type?.name === 'McpForm')
    await form.props.save()
    manage = panel()
    form = find(render(manage.type, manage.props), (node) => node.type?.name === 'McpForm')
    expect(form).toBeTruthy()
    expect(manage.props.draft.headers).toBe('broken')
    expect(manage.props.busy).toBe('')
    expect(harness.request.mock.calls.some((call) => call[0] === 'mcp.projectSave')).toBe(false)
    manage.props.edit('headers', 'Token=a=b')
    manage = panel()
    form = find(render(manage.type, manage.props), (node) => node.type?.name === 'McpForm')
    harness.request.mockResolvedValueOnce({ ok: true, project: { ...project, servers: [{ ...server, id: 'http' }] } })
    await form.props.save()
    expect(harness.request.mock.calls.at(-1)?.slice(0, 2)).toEqual(['mcp.projectSave', {
      workspacePath: project.workspacePath, serverName: 'http', config: { serverName: 'http', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Token: 'a=b' } },
    }])
    manage = panel()
    expect(manage.props.projects[0].servers).toHaveLength(1)
    expect(find(render(manage.type, manage.props), (node) => node.type?.name === 'McpForm')).toBeUndefined()
  })
  it('serializes project refresh/toggle/remove with global operations', async () => {
    const manage = panel()
    let finish!: (result: any) => void
    harness.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const first = manage.props.toggleProject(project, server)
    expect(await manage.props.refreshGlobal(server.id)).toBe(false)
    expect(await manage.props.refreshProject(project, server)).toBe(false)
    expect(manage.props.removeProject(project, server)).toBe(false)
    expect(harness.request.mock.calls.at(-1)?.slice(0, 2)).toEqual(['mcp.projectToggle', { workspacePath: project.workspacePath, serverName: server.serverName, enabled: false }])
    finish({ ok: true, project: { ...project, servers: [{ ...server, enabled: false }] } })
    await first
    expect(panel().props.projects[0].servers[0].enabled).toBe(false)
  })
  it('labels enabled as configuration and disables every action while busy', () => {
    const manage = panel()
    const tree = render(manage.type, { ...manage.props, busy: 'save' })
    const card = find(tree, (node) => node.type?.name === 'ServerCard')
    const cardTree = render(card.type, card.props)
    const toggle = find(cardTree, (node) => node.props.className?.startsWith('vsm-switch'))
    expect(toggle.props['aria-label']).toBe('禁用配置（不代表在线）')
    expect(toggle.props.disabled).toBe(true)
    const remove = find(cardTree, (node) => node.props.title === '删除 MCP')
    expect(remove.props.disabled).toBe(true)
  })
})
