/** Scoped MCP lifecycle and file regressions. @author ddj 2026年09月28号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { filterResources, guardMcp, installIsolation } from '../src/mcpIsolation.js'
import { installMcpRuntime, runtimeOf } from '../src/mcpRuntime.js'
import { listProjects, projectRefresh, projectRemove, projectSave, projectToggle, reconcileProject } from '../src/mcpProject.js'
import { listMcp, MCP_PACKAGE, saveMcp, serverOf } from '../src/mcp.js'

const hosts: TestHost[] = []

/** Scope-aware fixture models the audited official registry inheritance contracts. */
class TestHost {
  files = new Map<string, string>()
  failures = new Map<string, Error>()
  entries: any[] = []
  agents: any[] = []
  callbacks = new Map<string, Set<(...args: any[]) => any>>()
  effects: Array<() => any> = []
  globalTools = new Map<string, any>()
  starts = new Map<string, Promise<void>>()
  events: string[] = []
  mounts: any[] = []
  guards: Array<(exec: any) => unknown> = []
  official = { name: 'official-mcp-test' }
  services: Record<string, any>
  ctx: any

  /** @public @author ddj 2026年09月28号 Initializes isolated host services without disk or network IO. */
  constructor() {
    this.services = {
      workspaceRegistry: { list: () => [{ path: '/alpha' }, { path: '/beta' }] },
      agents: { list: () => this.agents },
      fs: this.makeFs(), loader: this.makeLoader(),
      tools: { view: (agent: any) => this.view(agent), guard: (guard: any) => { this.guards.push(guard); return () => this.guards.splice(this.guards.indexOf(guard), 1) } },
    }
    this.ctx = {
      get: (name: string) => this.services[name],
      on: (name: string, callback: any) => this.on(name, callback),
      emit: (name: string, payload: any) => { for (const callback of this.callbacks.get(name) ?? []) callback(payload) },
      effect: (factory: any) => { const dispose = factory(); this.effects.push(dispose); return dispose },
    }
    vi.spyOn(runtimeOf(this.ctx) as any, 'load').mockResolvedValue(this.official)
    hosts.push(this)
  }

  /** @private @author ddj 2026年09月28号 @returns Memory filesystem with distinct missing, denied and parse-error cases. */
  private makeFs(): any {
    return {
      resolve: async (path: string, opts?: any) => opts?.cwd ? opts.cwd + '/' + path : path,
      stat: async () => ({ type: 'directory' }),
      readText: async (path: string) => {
        if (this.failures.has(path)) throw this.failures.get(path)
        if (!this.files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return this.files.get(path)
      },
      writeText: vi.fn(async (path: string, text: string) => { this.files.set(path, text) }),
    }
  }

  /** @private @author ddj 2026年09月28号 @returns Loader preserving global create/update/remove behavior. */
  private makeLoader(): any {
    return {
      entries: () => this.entries,
      resolve: (id: string) => this.entries.find((entry) => entry.id === id),
      create: vi.fn(async (options: any) => { const id = options.id ?? 'global'; this.entries.push({ id, options, fiber: { state: 2 } }); return id }),
      update: vi.fn(async (id: string, patch: any) => {
        const entry = this.entries.find((item) => item.id === id)
        entry.options = { ...entry.options, ...patch }
        if ('disabled' in patch) entry.disabled = patch.disabled
      }),
      remove: vi.fn(async (id: string) => { this.events.push('remove:' + id); this.entries = this.entries.filter((entry) => entry.id !== id) }),
    }
  }

  /** @public @author ddj 2026年09月28号 @param name Event name. @param callback Listener. @returns Listener removal. */
  on(name: string, callback: any): () => void {
    const callbacks = this.callbacks.get(name) ?? new Set()
    this.callbacks.set(name, callbacks)
    callbacks.add(callback)
    return () => { callbacks.delete(callback) }
  }

  /** @public @author ddj 2026年09月28号 @param name Event name. @param payload Event payload. @returns Serial listener completion. */
  async serial(name: string, payload: any): Promise<void> {
    for (const callback of this.callbacks.get(name) ?? []) await callback(payload)
  }

  /** @public @author ddj 2026年09月28号 @param agent Viewing scope. @returns Merged tools and inherited restrictable names. */
  view(agent?: any): any {
    const inherited = agent?.parent ? this.view(agent.parent).visible : this.globalTools
    const visible = new Map<string, any>(inherited)
    const restrictableNames = new Set<string>(inherited.keys())
    for (const deny of agent?.denies.values() ?? []) for (const name of deny) visible.delete(name)
    for (const [name, tool] of agent?.tools ?? []) visible.set(name, tool)
    return { visible, restrictableNames, knownNames: new Set([...restrictableNames, ...agent?.tools.keys() ?? []]) }
  }

  /** @public @author ddj 2026年09月28号 @param path Source workspace. @param servers Source definitions. @param extra Extra document fields. @sideEffects Sets the memory file. */
  source(path: string, servers: any, extra: any = {}): void {
    this.files.set(path + '/.mcp.json', JSON.stringify({ ...extra, mcpServers: servers }))
  }

  /** @public @author ddj 2026年09月28号 @param cwd Agent directory. @param parent Inherited scope. @returns Registered fake agent with scoped plugin API. */
  agent(cwd: string, parent?: any): any {
    const agent: any = { session: { header: { cwd } }, parent, tools: new Map(), prompts: new Map(), resources: new Map(), denies: new Map() }
    const tools = { view: (scope: any) => this.view(scope), restrict: (filter: any) => this.restrict(agent, filter) }
    const prompt = { getSectionOrder: () => 3100, section: (section: any) => this.section(agent, section) }
    agent.ctx = { get: (name: string) => name === 'tools' ? tools : name === 'systemPrompt' ? prompt : this.services[name],
      plugin: vi.fn((official: any, config: any) => this.mount(agent, official, config)) }
    this.agents.push(agent)
    return agent
  }

  /** @private @author ddj 2026年09月28号 @param agent Scoped target. @param filter Denied inherited tools. @returns Restriction disposer. */
  private restrict(agent: any, filter: any): () => void {
    const names = this.view(agent).restrictableNames
    for (const name of filter.deny) if (!names.has(name)) throw new Error('unknown inherited tool: ' + name)
    const key = {}
    agent.denies.set(key, filter.deny)
    this.ctx.emit('tools/change')
    return () => { agent.denies.delete(key); this.ctx.emit('tools/change') }
  }

  /** @private @author ddj 2026年09月28号 @param agent Scoped target. @param section Prompt definition. @returns Exact-section removal. */
  private section(agent: any, section: any): () => void {
    if (agent.prompts.has(section.name)) throw new Error('duplicate section: ' + section.name)
    agent.prompts.set(section.name, section)
    return () => { if (agent.prompts.get(section.name) === section) agent.prompts.delete(section.name) }
  }

  /** @private @author ddj 2026年09月28号 @param agent Scoped target. @param official Loaded module. @param config Plugin config. @returns Awaitable disposable fiber. */
  private mount(agent: any, official: any, config: any): any {
    expect(official).toBe(this.official)
    const name = config.serverName
    this.events.push('mount:' + name)
    const tool = 'mcp__' + name + '__search'
    if (config.command !== 'resource-only') agent.tools.set(tool, { name: tool })
    agent.resources.set(name, vi.fn())
    const clearPrompt = this.section(agent, { name: 'mcp:' + name, text: 'instructions:' + name })
    const fiber: any = Object.assign((this.starts.get(name) ?? Promise.resolve()).then(() => { fiber.state = 2 }), {
      state: 1,
      dispose: vi.fn(async () => {
        this.events.push('dispose:' + name)
        agent.tools.delete(tool)
        agent.resources.delete(name)
        clearPrompt()
        this.ctx.emit('tools/change')
      }),
    })
    this.mounts.push({ agent, config, fiber })
    this.ctx.emit('tools/change')
    return fiber
  }

  /** @public @author ddj 2026年09月28号 @param agent Viewing scope. @returns Effective scoped prompt texts. */
  prompt(agent: any): Map<string, string> {
    const sections = agent.parent ? this.prompt(agent.parent) : new Map<string, string>()
    for (const [name, section] of agent.prompts) sections.set(name, typeof section.text === 'function' ? section.text() : section.text)
    const names = new Set<string>(this.entries.map((entry) => entry.options?.config?.serverName).filter(Boolean))
    for (let scope = agent; scope; scope = scope.parent) for (const name of scope.resources.keys()) names.add(name)
    const text = 'Use resource tools with server argument: ' + JSON.stringify([...names].sort()) + '.'
    sections.set('mcp-resource-servers', filterResources(this.ctx, agent, text))
    return sections
  }

  /** @public @author ddj 2026年09月28号 @returns Completion of all owned lifecycle cleanups. */
  async cleanup(): Promise<void> {
    await runtimeOf(this.ctx).dispose()
    for (const dispose of this.effects.reverse()) await dispose?.()
  }
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.cleanup()
})

describe('agent-owned project runtime', () => {
  it('keeps idle projects configured-only and honors disabled definitions', async () => {
    const host = new TestHost()
    host.source('/alpha', { enabled: { command: 'ok' }, stopped: { command: 'ok', disabled: true } })
    await installMcpRuntime(host.ctx)
    const servers = runtimeOf(host.ctx).views('/alpha')
    expect(servers.map((server) => [server.serverName, server.status, server.instanceCount])).toEqual([
      ['enabled', 'configured', 0], ['stopped', 'disabled', 0],
    ])
    expect(host.mounts).toHaveLength(0)
    expect(host.services.loader.create).not.toHaveBeenCalled()
  })

  it('removes both legacy global formats before mounting each existing agent', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    host.entries = ['vsm-mcp.hash.alpha', 'vsm-mcp:hash:old'].map((id) => ({ id, options: { name: MCP_PACKAGE } }))
    const first = host.agent('/alpha')
    const second = host.agent('/alpha/src')
    host.agent('/beta')
    await installMcpRuntime(host.ctx)
    expect(host.events.slice(0, 2)).toEqual(['remove:vsm-mcp.hash.alpha', 'remove:vsm-mcp:hash:old'])
    expect(host.mounts.map((mount) => mount.agent)).toEqual([first, second])
    expect(host.mounts[0].config.cwd).toBe('/alpha')
    expect(runtimeOf(host.ctx).views('/alpha')[0]).toMatchObject({ instanceCount: 2, status: 'unverified', toolCount: 1 })
    expect(listMcp(host.ctx).servers).toEqual([])
  })

  it('awaits serial agent creation startup and supports resource-only servers', async () => {
    const host = new TestHost()
    host.source('/alpha', { files: { command: 'resource-only' } })
    await installMcpRuntime(host.ctx)
    let finish!: () => void
    host.starts.set('files', new Promise<void>((resolve) => { finish = resolve }))
    const agent = host.agent('/alpha')
    let ready = false
    const creating = host.serial('agent/created', { agent }).then(() => { ready = true })
    await vi.waitFor(() => expect(host.mounts).toHaveLength(1))
    expect(ready).toBe(false)
    expect(runtimeOf(host.ctx).views('/alpha')[0].status).toBe('connecting')
    finish()
    await creating
    expect(runtimeOf(host.ctx).views('/alpha')[0]).toMatchObject({ status: 'unverified', toolCount: 0, instanceCount: 1 })
  })

  it('reconfigures idempotently and closes fibers on disable, refresh, delete, and disposal', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    const agent = host.agent('/alpha')
    await installMcpRuntime(host.ctx)
    await reconcileProject(host.ctx, '/alpha')
    expect(host.mounts).toHaveLength(1)
    host.source('/alpha', { alpha: { command: 'changed' } })
    await reconcileProject(host.ctx, '/alpha')
    expect(host.mounts).toHaveLength(2)
    expect(host.events.indexOf('dispose:alpha')).toBeLessThan(host.events.lastIndexOf('mount:alpha'))
    await projectToggle(host.ctx, '/alpha', 'alpha', false)
    expect(runtimeOf(host.ctx).views('/alpha')[0]).toMatchObject({ status: 'disabled', instanceCount: 0 })
    await projectRefresh(host.ctx, '/alpha', 'alpha')
    expect(host.mounts).toHaveLength(2)
    await projectToggle(host.ctx, '/alpha', 'alpha', true)
    await projectRefresh(host.ctx, '/alpha', 'alpha')
    expect(host.mounts).toHaveLength(4)
    await projectRemove(host.ctx, '/alpha', 'alpha')
    expect(runtimeOf(host.ctx).views('/alpha')).toEqual([])
    expect(agent.resources.size).toBe(0)
    await runtimeOf(host.ctx).detach(agent)
    expect(runtimeOf(host.ctx).agents.size).toBe(0)
    expect(host.mounts.every((mount) => mount.fiber.dispose.mock.calls.length === 1)).toBe(true)
  })

  it('preserves connections and source content on denied reads and invalid JSON', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    host.agent('/alpha')
    await installMcpRuntime(host.ctx)
    host.failures.set('/alpha/.mcp.json', Object.assign(new Error('denied'), { code: 'EACCES' }))
    let result = await listProjects(host.ctx)
    expect(result.projects[0].fileError).toContain('读取失败')
    expect(result.projects[0].servers[0].instanceCount).toBe(1)
    await expect(projectRemove(host.ctx, '/alpha', 'alpha')).rejects.toThrow('读取失败')
    host.failures.clear()
    host.files.set('/alpha/.mcp.json', '{broken')
    result = await listProjects(host.ctx)
    expect(result.projects[0].fileError).toContain('解析失败')
    expect(host.files.get('/alpha/.mcp.json')).toBe('{broken')
    expect(host.mounts[0].fiber.dispose).not.toHaveBeenCalled()
    host.files.delete('/alpha/.mcp.json')
    await reconcileProject(host.ctx, '/alpha')
    expect(host.mounts[0].fiber.dispose).toHaveBeenCalledOnce()
  })

  it('cancels pending startup and never resurrects a disposed agent', async () => {
    const host = new TestHost()
    host.source('/alpha', { first: { command: 'ok' }, later: { command: 'ok' } })
    await installMcpRuntime(host.ctx)
    let finish!: () => void
    host.starts.set('first', new Promise<void>((resolve) => { finish = resolve }))
    const agent = host.agent('/alpha')
    const creating = host.serial('agent/created', { agent })
    await vi.waitFor(() => expect(host.mounts).toHaveLength(1))
    await runtimeOf(host.ctx).detach(agent)
    finish()
    await creating
    await runtimeOf(host.ctx).attach(agent)
    expect(host.mounts).toHaveLength(1)
    expect(host.mounts[0].fiber.dispose).toHaveBeenCalledOnce()
    expect(runtimeOf(host.ctx).agents.has(agent)).toBe(false)
    expect(agent.resources.size).toBe(0)
  })

  it('reads externally edited configuration before a new agent becomes ready', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'old' } })
    await installMcpRuntime(host.ctx)
    host.source('/alpha', { alpha: { command: 'new' } })
    const agent = host.agent('/alpha')
    await host.serial('agent/created', { agent })
    expect(host.mounts[0].config.command).toBe('new')
  })

  it('surfaces plugin startup failure without reporting a connection', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    const agent = host.agent('/alpha')
    agent.ctx.plugin.mockImplementation(() => { throw new Error('startup failed') })
    await installMcpRuntime(host.ctx)
    expect(runtimeOf(host.ctx).views('/alpha')[0]).toMatchObject({ status: 'error', instanceCount: 0, error: 'Error: startup failed' })
  })
})

describe('source preservation and name reservations', () => {
  it('preserves unknown fields, advanced options and unchanged masked secrets', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok', env: { TOKEN: 'real' }, custom: { keep: 1 }, reconnect: { enabled: false }, maxInstructionBytes: 1000 } }, { schemaVersion: 2 })
    await projectSave(host.ctx, '/alpha', 'alpha', { serverName: 'alpha', transport: 'stdio', command: 'new', env: { TOKEN: '••••••' } })
    const document = JSON.parse(host.files.get('/alpha/.mcp.json')!)
    expect(document.schemaVersion).toBe(2)
    expect(document.mcpServers.alpha).toMatchObject({ command: 'new', env: { TOKEN: 'real' }, custom: { keep: 1 }, reconnect: { enabled: false } })
    expect(runtimeOf(host.ctx).views('/alpha')[0].config).toMatchObject({ env: { TOKEN: '••••••' }, maxInstructionBytes: 1000, reconnect: { enabled: false } })
    await expect(projectSave(host.ctx, '/alpha', 'beta', { serverName: 'beta', transport: 'stdio', command: 'ok', env: { NEW: '••••••' } })).rejects.toThrow('没有原值')
  })

  it('preserves server and secret names that equal object prototype keys', async () => {
    const host = new TestHost()
    const env = JSON.parse('{"__proto__":"secret"}')
    await projectSave(host.ctx, '/alpha', '__proto__', { serverName: '__proto__', transport: 'stdio', command: 'ok', env })
    const document = JSON.parse(host.files.get('/alpha/.mcp.json')!)
    expect(Object.hasOwn(document.mcpServers, '__proto__')).toBe(true)
    expect(Object.hasOwn(document.mcpServers.__proto__.env, '__proto__')).toBe(true)
    expect(document.mcpServers.__proto__.env.__proto__).toBe('secret')
    expect(runtimeOf(host.ctx).views('/alpha')[0].serverName).toBe('__proto__')
  })

  it('rejects configured-only project names for global saves and other projects', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok', disabled: true } })
    const config = { serverName: 'alpha', transport: 'stdio' as const, command: 'ok' }
    await expect(saveMcp(host.ctx, config)).rejects.toThrow('已被另一个 MCP 使用')
    await expect(projectSave(host.ctx, '/beta', 'alpha', config)).rejects.toThrow('已被另一个 MCP 使用')
    expect(host.services.loader.create).not.toHaveBeenCalled()
    expect(host.services.fs.writeText).not.toHaveBeenCalled()
  })

  it('keeps global CRUD on the loader and does not claim ACTIVE is connected', async () => {
    const host = new TestHost()
    const config = { serverName: 'global', transport: 'stdio' as const, command: 'ok', env: { TOKEN: 'real' } }
    await saveMcp(host.ctx, config)
    const result = await saveMcp(host.ctx, { ...config, env: { TOKEN: '••••••' } })
    expect(host.entries[0].options.config.env.TOKEN).toBe('real')
    expect(result).toMatchObject({ status: 'unverified', instanceCount: 1 })
    expect(serverOf(host.ctx, { ...host.entries[0], disabled: true }).status).toBe('disabled')
    expect(listMcp(host.ctx).servers).toHaveLength(1)
  })
})

describe('inherited workspace isolation', () => {
  it('hides foreign inherited tools, instructions and resource names while keeping globals', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    host.source('/beta', { beta: { command: 'resource-only' } })
    host.entries = [{ id: 'global', options: { name: MCP_PACKAGE, config: { serverName: 'global' } } }]
    host.globalTools.set('mcp__global__search', { name: 'mcp__global__search' })
    const parent = host.agent('/alpha')
    const child = host.agent('/beta', parent)
    const outside = host.agent('/outside', parent)
    installIsolation(host.ctx)
    await installMcpRuntime(host.ctx)
    expect(host.view(parent).visible.has('mcp__alpha__search')).toBe(true)
    expect(host.view(child).visible.has('mcp__alpha__search')).toBe(false)
    expect(host.view(child).visible.has('mcp__global__search')).toBe(true)
    expect(host.prompt(child).get('mcp:alpha')).toBe('')
    expect(host.prompt(child).get('mcp:beta')).toBe('instructions:beta')
    expect(host.prompt(child).get('mcp-resource-servers')).toContain('["beta","global"]')
    expect(host.prompt(outside).get('mcp-resource-servers')).toContain('["global"]')
    expect(child.parent).toBe(parent)
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      expect(guardMcp(host.ctx, { name, arguments: { server: 'alpha' }, agent: child })).toContain('不能使用其他项目')
      expect(guardMcp(host.ctx, { name, arguments: { server: 'beta' }, agent: child })).toBeUndefined()
      expect(guardMcp(host.ctx, { name, arguments: { server: 'global' }, agent: child })).toBeUndefined()
    }
    expect(guardMcp(host.ctx, { name: 'mcp__alpha__search', agent: outside })).toContain('已注册工作区')
    host.ctx.emit('tools/change')
    expect(child.denies.size).toBe(1)
  })

  it('guards legal server names containing double underscores', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha__nested: { command: 'ok' } })
    const parent = host.agent('/alpha')
    const child = host.agent('/beta', parent)
    installIsolation(host.ctx)
    await installMcpRuntime(host.ctx)
    expect(host.view(child).visible.has('mcp__alpha__nested__search')).toBe(false)
    expect(guardMcp(host.ctx, { name: 'mcp__alpha__nested__search', agent: child })).toContain('不能使用其他项目')
  })
})
