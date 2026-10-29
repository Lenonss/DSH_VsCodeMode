/** Scoped MCP lifecycle and file regressions. @author ddj 2026年09月28号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { filterResources, guardMcp, installIsolation } from '../src/mcpIsolation.js'
import { installMcpRuntime, runtimeOf } from '../src/mcpRuntime.js'
import { McpBridge } from '../src/mcpBridge.js'
import { listProjects, projectRefresh, projectRemove, projectSave, projectToggle, reconcileProject, mcpSnapshot } from '../src/mcpProject.js'
import { listMcp, MCP_PACKAGE, saveMcp, serverOf, toolsOf, validateConfig, removeMcp, toggleMcp, refreshMcp } from '../src/mcp.js'

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
      tools: { register: (definition: any) => { this.globalTools.set(definition.name, definition); return () => this.globalTools.delete(definition.name) }, view: (agent: any) => this.view(agent), guard: (guard: any) => { this.guards.push(guard); return () => this.guards.splice(this.guards.indexOf(guard), 1) } },
    }
    this.ctx = {
      get: (name: string) => this.services[name],
      on: (name: string, callback: any) => this.on(name, callback),
      emit: (name: string, payload: any) => { for (const callback of this.callbacks.get(name) ?? []) callback(payload) },
      effect: (factory: any) => { const dispose = factory(); this.effects.push(dispose); return dispose },
    }
    vi.spyOn(runtimeOf(this.ctx) as any, 'load').mockResolvedValue(this.official)
    const make = async (): Promise<McpBridge> => {
      const ctx: any = { isolate: () => ctx, provide: (name: string, provider: any) => { ctx[name] = provider },
        plugin: (official: any, config: any) => this.privateMount(ctx, official, config) }
      const fibers: any[] = []
      const plugin = ctx.plugin
      ctx.plugin = (official: any, config: any) => { const fiber = plugin(official, config); fibers.push(fiber); return fiber }
      return McpBridge.create(this.ctx, () => ({ ctx, dispose: async () => { await Promise.all(fibers.map((fiber) => fiber.dispose())) } }))
    }
    ;(runtimeOf(this.ctx).pool as any).make = make
    hosts.push(this)
  }

  /** @private @author ddj 2026年10月20号 @param ctx Private registration sink. @param official Module identity. @param config Effective config. @returns Cancellable fake fiber without publishing to any agent. */
  private privateMount(ctx: any, official: any, config: any): any {
    expect(official).toBe(this.official)
    const name = config.serverName
    this.events.push('mount:' + name)
    const removals: Array<() => void> = []
    if (config.command !== 'resource-only') removals.push(ctx.tools.register({ name: 'mcp__' + name + '__search', parameters: { type: 'object' }, execute: async () => ({ ok: true }) }))
    removals.push(ctx.mcpResources.register(name, { request: async () => ({ resources: [] }) }))
    removals.push(ctx.systemPrompt.section({ name: 'mcp:' + name, text: 'instructions:' + name }))
    let cancel!: () => void
    const canceled = new Promise<void>((resolve) => { cancel = resolve })
    const fiber: any = Object.assign(Promise.race([this.starts.get(name) ?? Promise.resolve(), canceled]).then(() => { fiber.state = 2 }), {
      state: 1, dispose: vi.fn(async () => { cancel(); for (const remove of removals.splice(0)) remove(); this.events.push('dispose:' + name) }),
    })
    this.mounts.push({ config, fiber })
    return fiber
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
    const agent: any = { session: { id: 'session-' + this.agents.length, header: { cwd } }, parent, tools: new Map(), prompts: new Map(), resources: new Map(), denies: new Map() }
    const tools = { view: (scope: any) => this.view(scope), restrict: (filter: any) => this.restrict(agent, filter), register: (definition: any) => {
      if (agent.tools.has(definition.name)) throw new Error('duplicate tool')
      agent.tools.set(definition.name, definition)
      this.ctx.emit('tools/change')
      return () => { agent.tools.delete(definition.name); this.ctx.emit('tools/change') }
    } }
    const resources = { register: (name: string, provider: any) => {
      if (agent.resources.has(name)) throw new Error('duplicate resources')
      agent.resources.set(name, provider)
      return () => agent.resources.delete(name)
    } }
    const prompt = { getSectionOrder: () => 3100, section: (section: any) => this.section(agent, section) }
    agent.ctx = { get: (name: string) => name === 'tools' ? tools : name === 'systemPrompt' ? prompt : name === 'mcpResources' ? resources : this.services[name],
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

/** @private @author ddj 2026年10月20号 @param host Memory host. @returns Explicit connections for legacy lifecycle assertions; creation itself no longer connects. */
async function installReady(host: TestHost): Promise<void> {
  await installMcpRuntime(host.ctx)
  const runtime = runtimeOf(host.ctx)
  await Promise.all(host.agents.flatMap((agent) => runtime.catalogue(agent).map((server) => runtime.connect(agent, server.serverName).catch(() => undefined))))
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.cleanup()
})

describe('independent session startup', () => {
  it('does not block other, empty, or same-project agents behind one slow startup', async () => {
    const host = new TestHost()
    host.source('/alpha', { slow: { command: 'ok' } })
    host.source('/beta', { fast: { command: 'ok' } })
    await installReady(host)
    let release!: () => void
    host.starts.set('slow', new Promise<void>((resolve) => { release = resolve }))
    const first = host.agent('/alpha')
    await host.serial('agent/created', { agent: first })
    const creating = runtimeOf(host.ctx).connect(first, 'slow')
    try {
      await vi.waitFor(() => expect(host.mounts).toHaveLength(1))
      host.starts.delete('slow') // Only A's already-created fiber keeps the gate.
      for (const cwd of ['/beta', '/outside', '/alpha']) {
        const second = host.agent(cwd)
        let ready = false
        const own = host.serial('agent/created', { agent: second }).then(() => { ready = true })
        await vi.waitFor(() => expect(ready).toBe(true))
        await own
      }
      const status = runtimeOf(host.ctx).sessionSnapshot()
      expect(status.sessions.find((entry) => entry.sessionId === first.session.id)?.phase).toBe('starting')
      expect(status.sessions.filter((entry) => entry.phase === 'idle')).toHaveLength(2)
      expect(status.sessions.filter((entry) => entry.phase === 'none')).toHaveLength(1)
    } finally { release(); await creating }
  })

  it('keeps the installation gate independent of existing-agent handshakes', async () => {
    const host = new TestHost()
    host.source('/alpha', { slow: { command: 'ok' } })
    let release!: () => void
    host.starts.set('slow', new Promise<void>((resolve) => { release = resolve }))
    host.source('/alpha', { slow: { command: 'ok', vscodeMode: { startup: 'background' } } })
    host.agent('/alpha')
    const installing = installMcpRuntime(host.ctx)
    try {
      await vi.waitFor(() => expect(host.mounts).toHaveLength(1))
      let ready = false
      const own = host.serial('agent/created', { agent: host.agent('/outside') }).then(() => { ready = true })
      await vi.waitFor(() => expect(ready).toBe(true))
      await own
    } finally { release(); await installing }
  })

  it('does not block a new same-project agent behind a refresh', async () => {
    const host = new TestHost()
    host.source('/alpha', { slow: { command: 'ok' } })
    host.agent('/alpha')
    await installReady(host)
    let release!: () => void
    host.starts.set('slow', new Promise<void>((resolve) => { release = resolve }))
    const refreshing = projectRefresh(host.ctx, '/alpha', 'slow')
    try {
      await vi.waitFor(() => expect(host.mounts).toHaveLength(2))
      host.starts.delete('slow')
      let ready = false
      const own = host.serial('agent/created', { agent: host.agent('/alpha') }).then(() => { ready = true })
      await vi.waitFor(() => expect(ready).toBe(true))
      await own
    } finally { release(); await refreshing }
  })

  it('keeps queue timing separate and resets startup timing on refresh', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    await installReady(host)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
    const agent = host.agent('/alpha')
    const creating = host.serial('agent/created', { agent })
    await creating
    await runtimeOf(host.ctx).connect(agent, 'alpha')
    expect(runtimeOf(host.ctx).sessionSnapshot().sessions[0]).toMatchObject({ startedAt: 100, finishedAt: 100 })
    clock.mockReturnValue(200)
    let release!: () => void
    host.starts.set('alpha', new Promise<void>((resolve) => { release = resolve }))
    const refreshing = projectRefresh(host.ctx, '/alpha', 'alpha')
    try {
      await vi.waitFor(() => expect(host.mounts).toHaveLength(2))
      clock.mockReturnValue(300)
      const waiting = runtimeOf(host.ctx).attach(agent)
      const status = runtimeOf(host.ctx).sessionSnapshot().sessions[0]
      expect(status).toMatchObject({ startedAt: 200, phase: 'starting' })
      expect(status.servers[0]).toMatchObject({ startedAt: 200, phaseAt: 200 })
      release()
      await Promise.all([refreshing, waiting])
      await runtimeOf(host.ctx).connect(agent, 'alpha')
      expect(host.mounts).toHaveLength(2)
      expect(runtimeOf(host.ctx).sessionSnapshot().sessions[0].finishedAt).toBe(300)
    } finally { release(); await refreshing; clock.mockRestore() }
  })

  it('detaches during module loading without waiting for or resurrecting that owner', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    await installReady(host)
    let release!: (module: unknown) => void
    vi.mocked((runtimeOf(host.ctx) as any).load).mockReturnValue(new Promise((resolve) => { release = resolve }))
    const agent = host.agent('/alpha')
    await host.serial('agent/created', { agent })
    const creating = runtimeOf(host.ctx).connect(agent, 'alpha').catch(() => undefined)
    try {
      await vi.waitFor(() => expect(runtimeOf(host.ctx).sessionSnapshot().sessions[0]?.phase).toBe('loading'))
      await runtimeOf(host.ctx).detach(agent)
      expect(runtimeOf(host.ctx).sessionSnapshot().sessions).toEqual([])
      expect(host.mounts).toEqual([])
    } finally { release(host.official); await creating }
    await runtimeOf(host.ctx).attach(agent)
    expect(host.mounts).toEqual([])
  })

  it('supersedes definitions during module loading and never mounts a stale command', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'old' } })
    await installReady(host)
    let release!: (module: unknown) => void
    vi.mocked((runtimeOf(host.ctx) as any).load).mockReturnValue(new Promise((resolve) => { release = resolve }))
    const agent = host.agent('/alpha')
    await host.serial('agent/created', { agent })
    const creating = runtimeOf(host.ctx).connect(agent, 'alpha').catch(() => undefined)
    let updating: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(runtimeOf(host.ctx).sessionSnapshot().sessions[0]?.phase).toBe('loading'))
      host.source('/alpha', { alpha: { command: 'new' } })
      updating = reconcileProject(host.ctx, '/alpha')
      await vi.waitFor(() => expect(runtimeOf(host.ctx).projects.get('/alpha')?.get('alpha')?.config.command).toBe('new'))
      release(host.official)
      await Promise.all([creating, updating])
      await runtimeOf(host.ctx).connect(agent, 'alpha')
      expect(host.mounts.map((mount) => mount.config.command)).toEqual(['new'])
    } finally { release(host.official); await Promise.all([creating, updating]) }
  })

  it('disposes a pending startup without releasing its synthetic handshake', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    await installReady(host)
    let release!: () => void
    host.starts.set('alpha', new Promise<void>((resolve) => { release = resolve }))
    const agent = host.agent('/alpha')
    await host.serial('agent/created', { agent })
    const creating = runtimeOf(host.ctx).connect(agent, 'alpha').catch(() => undefined)
    try {
      await vi.waitFor(() => expect(host.mounts).toHaveLength(1))
      let disposed = false
      const closing = runtimeOf(host.ctx).dispose().then(() => { disposed = true })
      await vi.waitFor(() => expect(disposed).toBe(true))
      await Promise.all([closing, creating])
      expect(host.mounts[0].fiber.dispose).toHaveBeenCalledOnce()
      expect(runtimeOf(host.ctx).sessionSnapshot().sessions).toEqual([])
    } finally { release(); await creating }
  })

  it('returns detached, IO-free and credential-free per-session errors', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok', env: { TOKEN: 'secret-value' } } })
    const agent = host.agent('/alpha')
    vi.mocked((runtimeOf(host.ctx) as any).load).mockRejectedValue(new Error('https://user:secret-value@host TOKEN=secret-value'))
    await installReady(host)
    const read = vi.spyOn(host.services.fs, 'readText')
    const snapshot = runtimeOf(host.ctx).sessionSnapshot()
    expect(snapshot.sessions[0]).toMatchObject({ sessionId: agent.session.id, phase: 'error' })
    expect(JSON.stringify(snapshot)).not.toContain('secret-value')
    snapshot.sessions[0].servers[0].phase = 'ready'
    expect(runtimeOf(host.ctx).sessionSnapshot().sessions[0].servers[0].phase).toBe('error')
    expect(read).not.toHaveBeenCalled()
    host.files.set('/alpha/.mcp.json', '{broken')
    const second = host.agent('/alpha')
    await host.serial('agent/created', { agent: second })
    expect(runtimeOf(host.ctx).sessionSnapshot().sessions.find((entry) => entry.sessionId === second.session.id)).toMatchObject({ phase: 'error', error: expect.stringContaining('配置读取或校验失败') })
  })
})

describe('agent-owned project runtime', () => {
  it('keeps idle projects configured-only and honors disabled definitions', async () => {
    const host = new TestHost()
    host.source('/alpha', { enabled: { command: 'ok' }, stopped: { command: 'ok', disabled: true } })
    await installReady(host)
    const servers = runtimeOf(host.ctx).views('/alpha')
    expect(servers.map((server) => [server.serverName, server.status, server.instanceCount])).toEqual([
      ['enabled', 'configured', 0], ['stopped', 'disabled', 0],
    ])
    expect(host.mounts).toHaveLength(0)
    expect(host.services.loader.create).not.toHaveBeenCalled()
  })

  it('uses public scoped definitions without consulting private view or step admission', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    const agent = host.agent('/alpha')
    await installReady(host)
    const registry = agent.ctx.get('tools')
    registry.definitions = vi.fn((scope) => [...host.view(scope).visible.values()])
    registry.view = vi.fn(() => { throw new Error('private') })
    registry.resolve = vi.fn()
    registry.executable = vi.fn()
    const result = await runtimeOf(host.ctx).connect(agent, 'alpha')
    expect(result.tools.map((tool) => tool.name)).toEqual(['mcp__alpha__search'])
    expect(registry.definitions).toHaveBeenCalledWith(agent)
    expect(registry.view).not.toHaveBeenCalled()
    expect(registry.resolve).not.toHaveBeenCalled()
    expect(registry.executable).not.toHaveBeenCalled()
    registry.definitions.mockReturnValue([])
    expect((await runtimeOf(host.ctx).connect(agent, 'alpha')).tools).toEqual([])
    registry.definitions.mockImplementation((scope) => [...host.view(scope).visible.values()])
    const other = host.agent('/alpha')
    await runtimeOf(host.ctx).attach(other)
    expect(host.view(other).visible.has('mcp__alpha__search')).toBe(false)
    expect(registry.definitions(other).some((tool) => tool.name === 'mcp__alpha__search')).toBe(false)
  })

  it('diagnoses a missing tool catalogue instead of exposing unfiltered tools', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    const agent = host.agent('/alpha')
    await installReady(host)
    agent.ctx.get('tools').view = undefined
    await expect(runtimeOf(host.ctx).connect(agent, 'alpha')).rejects.toThrow('工具目录不可用')
  })

  it('removes both legacy global formats before mounting each existing agent', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    host.entries = ['vsm-mcp.hash.alpha', 'vsm-mcp:hash:old'].map((id) => ({ id, options: { name: MCP_PACKAGE } }))
    const first = host.agent('/alpha')
    const second = host.agent('/alpha/src')
    host.agent('/beta')
    await installReady(host)
    expect(host.events.slice(0, 2)).toEqual(['remove:vsm-mcp.hash.alpha', 'remove:vsm-mcp:hash:old'])
    expect(host.mounts).toHaveLength(2)
    expect(first.tools.has('mcp__alpha__search') && second.tools.has('mcp__alpha__search')).toBe(true)
    expect(host.mounts[0].config.cwd).toBe('/alpha')
    expect(runtimeOf(host.ctx).views('/alpha')[0]).toMatchObject({ instanceCount: 2, status: 'unverified', toolCount: 1 })
    expect(listMcp(host.ctx).servers).toEqual([])
  })

  it('awaits serial agent creation startup and supports resource-only servers', async () => {
    const host = new TestHost()
    host.source('/alpha', { files: { command: 'resource-only' } })
    await installReady(host)
    let finish!: () => void
    host.starts.set('files', new Promise<void>((resolve) => { finish = resolve }))
    const agent = host.agent('/alpha')
    let ready = false
    await host.serial('agent/created', { agent })
    const creating = runtimeOf(host.ctx).connect(agent, 'files').then(() => { ready = true })
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
    await installReady(host)
    await reconcileProject(host.ctx, '/alpha')
    expect(host.mounts).toHaveLength(1)
    host.source('/alpha', { alpha: { command: 'changed' } })
    await reconcileProject(host.ctx, '/alpha')
    await runtimeOf(host.ctx).connect(agent, 'alpha')
    expect(host.mounts).toHaveLength(2)
    expect(host.events.indexOf('dispose:alpha')).toBeLessThan(host.events.lastIndexOf('mount:alpha'))
    await projectToggle(host.ctx, '/alpha', 'alpha', false)
    expect(runtimeOf(host.ctx).views('/alpha')[0]).toMatchObject({ status: 'disabled', instanceCount: 0 })
    await projectRefresh(host.ctx, '/alpha', 'alpha')
    expect(host.mounts).toHaveLength(2)
    await projectToggle(host.ctx, '/alpha', 'alpha', true)
    await runtimeOf(host.ctx).connect(agent, 'alpha')
    await projectRefresh(host.ctx, '/alpha', 'alpha')
    await runtimeOf(host.ctx).connect(agent, 'alpha')
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
    await installReady(host)
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

  it.each(['FS_NOT_FOUND', 'ENOENT'])('treats another project missing config (%s) as optional without blocking mounts', async (code) => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    host.failures.set('/beta/.mcp.json', Object.assign(new Error('cannot read beta: not found'), { code }))
    host.agent('/alpha')
    await installReady(host)
    const result = await listProjects(host.ctx)
    expect(result.projects[0].fileError).toBeUndefined()
    expect(result.projects[0].servers[0]).toMatchObject({ serverName: 'alpha', instanceCount: 1 })
    expect(result.projects[1]).toMatchObject({ servers: [], missingDir: false })
    expect(result.projects[1].fileError).toBeUndefined()
    expect(host.services.fs.writeText).not.toHaveBeenCalled()
  })

  it.each(['FS_NOT_FOUND', 'ENOENT'])('creates the first configuration after an absent read (%s)', async (code) => {
    const host = new TestHost()
    host.failures.set('/alpha/.mcp.json', Object.assign(new Error('missing config'), { code }))
    // A successful create makes subsequent reads observe the new document.
    host.services.fs.writeText.mockImplementation(async (path: string, text: string) => {
      host.files.set(path, text)
      host.failures.delete(path)
    })
    const result = await projectSave(host.ctx, '/alpha', 'alpha', { serverName: 'alpha', transport: 'stdio', command: 'ok' })
    expect(result.fileError).toBeUndefined()
    expect(JSON.parse(host.files.get('/alpha/.mcp.json')!)).toEqual({ mcpServers: { alpha: { command: 'ok' } } })
    expect(result.servers[0]).toMatchObject({ status: 'configured', instanceCount: 0 })
  })

  it.each(['FS_NOT_FOUND', 'ENOENT'])('marks a missing workspace directory (%s)', async (code) => {
    const host = new TestHost()
    host.services.fs.stat = vi.fn().mockRejectedValue(Object.assign(new Error('missing directory'), { code }))
    const result = await listProjects(host.ctx)
    expect(result.projects.every((project) => project.missingDir === true)).toBe(true)
    expect(host.mounts).toHaveLength(0)
    expect(host.services.fs.writeText).not.toHaveBeenCalled()
  })

  it.each(['FS_PERMISSION_DENIED', 'FS_IO_ERROR', 'FS_SANDBOX_DENIED', 'FS_NOT_TEXT'])('retains connections and refuses overwrites on %s', async (code) => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    host.agent('/alpha')
    await installReady(host)
    const source = host.files.get('/alpha/.mcp.json')
    host.failures.set('/alpha/.mcp.json', Object.assign(new Error('cannot read: not found in error context'), { code }))
    const result = await listProjects(host.ctx)
    expect(result.projects[0].fileError).toContain('读取失败')
    expect(result.projects[0].servers[0].instanceCount).toBe(1)
    await expect(projectSave(host.ctx, '/alpha', 'alpha', { serverName: 'alpha', transport: 'stdio', command: 'changed' })).rejects.toThrow('读取失败')
    expect(host.files.get('/alpha/.mcp.json')).toBe(source)
    expect(host.services.fs.writeText).not.toHaveBeenCalled()
    expect(host.mounts[0].fiber.dispose).not.toHaveBeenCalled()
  })

  it('refuses saving over invalid JSON while retaining the last valid connection', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    host.agent('/alpha')
    await installReady(host)
    host.files.set('/alpha/.mcp.json', '{broken')
    await expect(projectSave(host.ctx, '/alpha', 'alpha', { serverName: 'alpha', transport: 'stdio', command: 'changed' })).rejects.toThrow('解析失败')
    expect(host.files.get('/alpha/.mcp.json')).toBe('{broken')
    expect(host.services.fs.writeText).not.toHaveBeenCalled()
    expect(host.mounts[0].fiber.dispose).not.toHaveBeenCalled()
  })

  it('cancels pending startup and never resurrects a disposed agent', async () => {
    const host = new TestHost()
    host.source('/alpha', { first: { command: 'ok' }, later: { command: 'ok' } })
    await installReady(host)
    let finish!: () => void
    host.starts.set('first', new Promise<void>((resolve) => { finish = resolve }))
    const agent = host.agent('/alpha')
    await host.serial('agent/created', { agent })
    const creating = runtimeOf(host.ctx).connect(agent, 'first').catch(() => undefined)
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
    await installReady(host)
    host.source('/alpha', { alpha: { command: 'new' } })
    const agent = host.agent('/alpha')
    await host.serial('agent/created', { agent })
    expect(host.mounts).toHaveLength(0)
    await runtimeOf(host.ctx).connect(agent, 'alpha')
    expect(host.mounts[0].config.command).toBe('new')
  })

  it('rejects startup callers before non-cooperative cleanup quiesces', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok', vscodeMode: { startupTimeoutMs: 1000 } } })
    const agent = host.agent('/alpha')
    await installMcpRuntime(host.ctx)
    const runtime = runtimeOf(host.ctx)
    // Runtime intentionally owns a lazy resource provider before connecting; it is not a published binding.
    const resourcesBefore = [...agent.resources]
    let releaseWork!: () => void
    let releaseClose!: () => void
    const work = new Promise<void>((resolve) => { releaseWork = resolve })
    const closure = new Promise<void>((resolve) => { releaseClose = resolve })
    const plugin = vi.fn(() => work)
    const privateCtx = { isolate: () => privateCtx, provide: () => undefined, plugin }
    const dispose = vi.fn(() => closure)
    const make = vi.fn(() => McpBridge.create(host.ctx, () => ({ ctx: privateCtx, dispose })))
    ;(runtime.pool as any).make = make
    vi.useFakeTimers()
    const connecting = runtime.connect(agent, 'alpha')
    const failure = expect(connecting).rejects.toThrow('清理尚未确认')
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(plugin).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1000)
      await failure
      const entry = [...runtime.pool.entries.values()][0]
      expect(entry).toMatchObject({ phase: 'stopping', live: false })
      expect(entry.retryAt).toBeUndefined()
      expect(runtime.sessionSnapshot().sessions[0].servers[0]).toMatchObject({ phase: 'stopping', error: expect.stringContaining('清理尚未确认') })
      expect(agent.tools.size).toBe(0)
      expect([...agent.resources]).toEqual(resourcesBefore)
      await expect(runtime.connect(agent, 'alpha')).rejects.toThrow('清理尚未确认')
      expect(make).toHaveBeenCalledOnce()
      expect(dispose).toHaveBeenCalledOnce()
    } finally {
      releaseWork()
      releaseClose()
      await connecting.catch(() => undefined)
      await host.cleanup()
      vi.useRealTimers()
    }
  })

  it('surfaces plugin startup failure without reporting a connection', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    const agent = host.agent('/alpha')
    vi.mocked((runtimeOf(host.ctx) as any).load).mockRejectedValue(new Error('startup failed'))
    await installReady(host)
    expect(runtimeOf(host.ctx).views('/alpha')[0]).toMatchObject({ status: 'error', instanceCount: 0, error: expect.stringContaining('请查看 Host 日志') })
  })
})

describe('source preservation and name reservations', () => {
  it('persists separate project strategies without forwarding them or changing unknown configuration fields', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok', custom: { keep: true }, env: { TOKEN: 'real' } } })
    const policy = { startup: 'on-demand' as const, sharing: 'workspace' as const, startupTimeoutMs: 1000 }
    const config = { serverName: 'alpha', transport: 'stdio' as const, command: 'ok', env: { TOKEN: '••••••' } }
    const view = await projectSave(host.ctx, '/alpha', 'alpha', config, policy)
    const persisted = JSON.parse(host.files.get('/alpha/.mcp.json')!).mcpServers.alpha
    expect(persisted).toMatchObject({ custom: { keep: true }, env: { TOKEN: 'real' }, vscodeMode: policy })
    expect(view.servers[0].policy).toEqual(policy)
    const agent = host.agent('/alpha')
    await runtimeOf(host.ctx).attach(agent)
    expect(host.mounts).toHaveLength(0)
    await runtimeOf(host.ctx).connect(agent, 'alpha')
    expect(host.mounts[0].config).not.toHaveProperty('vscodeMode')
    await expect(projectSave(host.ctx, '/alpha', 'alpha', config, { ...policy, startupTimeoutMs: 0 })).rejects.toThrow('startupTimeoutMs')
    await expect(saveMcp(host.ctx, { ...config, vscodeMode: policy } as any)).rejects.toThrow('仅适用于项目')
  })

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

describe('MCP audit regressions', () => {
  it('clears stale global transport fields without losing advanced options or enable intent', async () => {
    const host = new TestHost()
    const name = 'global'
    await saveMcp(host.ctx, { serverName: name, transport: 'stdio', command: 'ok', args: ['one'], env: { TOKEN: 'real' } })
    host.entries[0].options.config.toolCallTimeoutMs = 300000
    host.entries[0].disabled = true
    await saveMcp(host.ctx, { serverName: name, transport: 'streamable-http', url: 'http://localhost/mcp', headers: { Token: 'real' } })
    expect(host.entries[0].options.config).not.toHaveProperty('command')
    expect(host.entries[0].options.config).not.toHaveProperty('env')
    expect(host.entries[0].options.config.toolCallTimeoutMs).toBe(300000)
    expect(host.entries[0].disabled).toBe(true)
    await saveMcp(host.ctx, { serverName: name, transport: 'stdio', command: 'new' })
    expect(host.entries[0].options.config).not.toHaveProperty('url')
    expect(host.entries[0].options.config).not.toHaveProperty('headers')
  })

  it('serializes concurrent project saves so neither definition is lost', async () => {
    const host = new TestHost()
    host.source('/alpha', {})
    await Promise.all(['first', 'second'].map((serverName) => projectSave(host.ctx, '/alpha', serverName, { serverName, transport: 'stdio', command: 'ok' })))
    expect(Object.keys(JSON.parse(host.files.get('/alpha/.mcp.json')!).mcpServers).sort()).toEqual(['first', 'second'])
  })

  it('serializes concurrent global and project namespace reservations', async () => {
    const host = new TestHost()
    const config = { serverName: 'shared', transport: 'stdio' as const, command: 'ok' }
    const results = await Promise.allSettled([saveMcp(host.ctx, config), projectSave(host.ctx, '/alpha', 'shared', config)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('retries a transient official module load failure on explicit refresh', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    host.agent('/alpha')
    const load = vi.mocked((runtimeOf(host.ctx) as any).load)
    load.mockRejectedValueOnce(new Error('transient module load failure')).mockResolvedValue(host.official)
    await installReady(host)
    expect(runtimeOf(host.ctx).views('/alpha')[0].status).toBe('error')
    await projectRefresh(host.ctx, '/alpha', 'alpha')
    expect(load).toHaveBeenCalledTimes(2)
    expect(host.mounts).toHaveLength(1)
    expect(runtimeOf(host.ctx).views('/alpha')[0].status).toBe('unverified')
  })

  it('remounts identical definitions when an agent moves to another workspace', async () => {
    const host = new TestHost()
    const agent = host.agent('/alpha')
    const runtime = runtimeOf(host.ctx)
    const defs = new Map([['alpha', { config: { serverName: 'alpha', transport: 'stdio' as const, command: 'ok' }, enabled: true }]])
    await runtime.replace('/alpha', defs)
    await runtime.replace('/beta', defs)
    await runtime.attach(agent)
    await runtime.connect(agent, 'alpha')
    expect(host.mounts[0].config.cwd).toBe('/alpha')
    agent.session.header.cwd = '/beta'
    await runtime.attach(agent)
    await runtime.connect(agent, 'alpha')
    expect(host.mounts).toHaveLength(2)
    expect(host.mounts[0].fiber.dispose).toHaveBeenCalledOnce()
    expect(host.mounts[1].config.cwd).toBe('/beta')
  })

  it('refreshes only the requested workspace for historical same-name ledgers', async () => {
    const host = new TestHost()
    const first = host.agent('/alpha')
    const second = host.agent('/beta')
    const runtime = runtimeOf(host.ctx)
    const defs = new Map([['alpha', { config: { serverName: 'alpha', transport: 'stdio' as const, command: 'ok' }, enabled: true }]])
    await runtime.replace('/alpha', defs)
    await runtime.replace('/beta', defs)
    await runtime.attach(first)
    await runtime.attach(second)
    await Promise.all([runtime.connect(first, 'alpha'), runtime.connect(second, 'alpha')])
    await runtime.replace('/alpha', defs, 'alpha')
    await runtime.connect(first, 'alpha')
    expect(host.mounts).toHaveLength(3)
    expect(host.mounts[0].fiber.dispose).toHaveBeenCalledOnce()
    expect(host.mounts[1].fiber.dispose).not.toHaveBeenCalled()
  })

  it('polls detached live snapshots without filesystem reads, writes, or reconcile', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    const agent = host.agent('/alpha')
    await installReady(host)
    host.source('/alpha', { alpha: { command: 'external-change' } })
    const read = vi.spyOn(host.services.fs, 'readText')
    const before = host.mounts.length
    const snapshot = mcpSnapshot(host.ctx)
    expect(snapshot.projects[0].servers[0].config.command).toBe('ok')
    expect(snapshot.projects[0].servers[0].toolCount).toBe(1)
    agent.tools.set('mcp__alpha__new', {})
    expect(mcpSnapshot(host.ctx).projects[0].servers[0].toolCount).toBe(2)
    expect(snapshot.projects[0].servers[0].toolCount).toBe(1)
    expect(read).not.toHaveBeenCalled()
    expect(host.services.fs.writeText).not.toHaveBeenCalled()
    expect(host.mounts).toHaveLength(before)
  })

  it('reports handwritten namespace overlap without mounting and denies ambiguous calls', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' }, alpha__nested: { command: 'ok' } })
    const agent = host.agent('/alpha')
    const result = await listProjects(host.ctx)
    expect(result.projects[0].fileError).toContain('命名空间冲突')
    expect(host.mounts).toHaveLength(0)
    host.entries = ['alpha', 'alpha__nested'].map((serverName) => ({ id: serverName, options: { name: MCP_PACKAGE, config: { serverName } } }))
    expect(guardMcp(host.ctx, { name: 'mcp__alpha__nested__search', agent })).toContain('命名空间冲突')
  })

  it.each(['alpha__nested', 'alpha'])('rejects overlapping namespaces before project writes: %s', async (name) => {
    const host = new TestHost()
    host.source('/beta', { [name === 'alpha' ? 'alpha__nested' : 'alpha']: { command: 'ok' } })
    await expect(projectSave(host.ctx, '/alpha', name, { serverName: name, transport: 'stdio', command: 'ok' })).rejects.toThrow('命名空间')
    expect(host.services.fs.writeText).not.toHaveBeenCalled()
    await expect(saveMcp(host.ctx, { serverName: name, transport: 'stdio', command: 'ok' })).rejects.toThrow('命名空间')
  })

  it('rejects overlapping names within one project and between globals', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok' } })
    await expect(projectSave(host.ctx, '/alpha', 'alpha__nested', { serverName: 'alpha__nested', transport: 'stdio', command: 'ok' })).rejects.toThrow('命名空间')
    host.entries = [{ id: 'global', options: { name: MCP_PACKAGE, config: { serverName: 'global', transport: 'stdio', command: 'ok' } } }]
    await expect(saveMcp(host.ctx, { serverName: 'global__nested', transport: 'stdio', command: 'ok' })).rejects.toThrow('命名空间')
  })

  it('does not count an ambiguously attributed historical tool', () => {
    const host = new TestHost()
    host.entries = ['alpha', 'alpha__nested'].map((serverName) => ({ id: serverName, options: { name: MCP_PACKAGE, config: { serverName } } }))
    host.globalTools.set('mcp__alpha__nested__search', {})
    expect(toolsOf(host.ctx, 'alpha')).toEqual([])
    expect(toolsOf(host.ctx, 'alpha__nested')).toEqual([])
  })

  it.each([removeMcp, refreshMcp])('rejects project entries in a global action', async (action) => {
    const host = new TestHost()
    host.entries = [{ id: 'vsm-mcp.a164c0c98d.alpha', options: { name: MCP_PACKAGE, config: { serverName: 'alpha' } } }]
    await expect(action(host.ctx, host.entries[0].id)).rejects.toThrow('项目')
    expect(host.services.loader.remove).not.toHaveBeenCalled()
    expect(host.services.loader.update).not.toHaveBeenCalled()
  })

  it.each([
    { serverName: 'bad', transport: 'invalid' },
    { serverName: 'bad', transport: 'stdio', command: 'ok', args: 'not-array' },
    { serverName: 'bad', transport: 'stdio', command: 'ok', args: [1] },
    { serverName: 'bad', transport: 'streamable-http', url: 'http://' },
    { serverName: 'bad', transport: 'streamable-http', url: 'http://user:secret@localhost/mcp' },
    { serverName: 'bad', transport: 'stdio', command: 'ok', env: [] },
  ])('rejects malformed runtime configurations before loader calls', async (config) => {
    const host = new TestHost()
    await expect(saveMcp(host.ctx, config as any)).rejects.toThrow()
    expect(host.services.loader.create).not.toHaveBeenCalled()
  })

  it('rejects invalid persisted definitions instead of coercing argument values', async () => {
    const host = new TestHost()
    host.source('/alpha', { alpha: { command: 'ok', args: [null] } })
    const result = await listProjects(host.ctx)
    expect(result.projects[0].fileError).toBeTruthy()
    expect(host.mounts).toHaveLength(0)
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
    await installReady(host)
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
    await installReady(host)
    expect(host.view(child).visible.has('mcp__alpha__nested__search')).toBe(false)
    expect(guardMcp(host.ctx, { name: 'mcp__alpha__nested__search', agent: child })).toContain('不能使用其他项目')
  })
})
