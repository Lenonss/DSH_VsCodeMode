/** Optional installed-host integration: real Cordis, MCP client and HTTP protocol. @author ddj 2026年09月28号 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { installIsolation } from '../src/mcpIsolation.js'
import { installMcpRuntime, runtimeOf } from '../src/mcpRuntime.js'
import { projectToggle, projectRefresh, mcpSnapshot, projectSave } from '../src/mcpProject.js'

const hostRoot = process.env.DSH_MCP_HOST_ROOT

/**
 * Import the exact installed host module without using the plugin's old dev dependency tree.
 * @private @author ddj 2026年09月28号
 * @param name Official package suffix.
 * @returns Module namespace from the optional test host installation.
 */
async function hostModule(name: string): Promise<any> {
  const require = createRequire(join(hostRoot!, 'package.json'))
  return import(/* @vite-ignore */ pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
}

/** Minimal JSON HTTP MCP peer recording resource and handshake requests. */
class HttpPeer {
  calls: Array<{ server: string; method: string }> = []
  failing = new Set<string>()
  rawNames = new Map<string, string>()

  /**
   * Serve an MCP JSON-RPC request without files, processes, or remote network access.
   * @public @author ddj 2026年09月28号
   * @param request Loopback HTTP request.
   * @param response HTTP response.
   * @returns Completion of the JSON response.
   */
  async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const message = JSON.parse(Buffer.concat(chunks).toString())
    const server = request.url!.slice(1)
    this.calls.push({ server, method: message.method })
    if (this.failing.has(server)) { response.writeHead(503).end(); return }
    if (message.id === undefined) { response.writeHead(202).end(); return }
    const result = this.result(server, message)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  }

  /**
   * Return valid MCP results, including legal resource-only beta capabilities.
   * @private @author ddj 2026年09月28号
   * @param server URL-selected server identity.
   * @param message JSON-RPC request.
   * @returns Method-specific protocol payload.
   */
  private result(server: string, message: any): any {
    switch (message.method) {
      case 'initialize': return { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: server, version: '1' }, instructions: 'private-' + server + ' {{literal}}' }
      case 'tools/list': return { tools: ['beta', 'preset'].includes(server) ? [] : [{ name: this.rawNames.get(server) ?? 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } }] }
      case 'resources/list': return { resources: [{ uri: 'test://' + server, name: server }] }
      case 'resources/templates/list': return { resourceTemplates: [] }
      case 'resources/read': return { contents: [{ uri: message.params.uri, text: server }] }
      case 'tools/call': return { content: [{ type: 'text', text: server }] }
      default: return {}
    }
  }
}

/**
 * Install the official services and supply a minimal registered-workspace filesystem.
 * @private @author ddj 2026年09月28号
 * @param ctx Real Cordis root context.
 * @param files Memory configuration sources.
 * @param agents Mutable registry snapshot.
 * @returns Completion after official tool/resource services become active.
 */
async function setupHost(ctx: any, files: Map<string, string>, agents: any[]): Promise<void> {
  const prompt = await hostModule('dsh-system-prompt')
  const tools = await hostModule('dsh-tools')
  const resources = await hostModule('dsh-mcp-resources')
  await ctx.plugin(prompt.default, {})
  await ctx.plugin(tools.default, {})
  await ctx.plugin(resources.default)
  ctx.provide('workspaceRegistry', { list: () => [{ path: '/alpha' }, { path: '/beta' }] })
  ctx.provide('agents', { list: () => agents })
  ctx.provide('loader', { entries: () => [] })
  ctx.provide('fs', {
    resolve: async (path: string, opts?: any) => opts?.cwd ? opts.cwd + '/' + path : path,
    stat: async () => ({ type: 'directory' }),
    readText: async (path: string) => files.get(path) ?? '{}',
    writeText: async (path: string, text: string) => { files.set(path, text) },
  })
}

/**
 * Call through the actual official tools execution pipeline, including registered guards.
 * @private @author ddj 2026年09月28号
 * @param ctx Host context.
 * @param agent Calling scope.
 * @param server Resource server argument.
 * @returns Materialized official tool result.
 */
function listResources(ctx: any, agent: any, server: string): Promise<any> {
  return ctx.get('tools').execute({ name: 'list_mcp_resources', arguments: { server }, agent, callId: crypto.randomUUID(), signal: new AbortController().signal })
}

describe.skipIf(!hostRoot)('installed official scoped MCP integration', () => {
  it('confirms official public-name collisions across separate legal scopes', async () => {
    const peer = new HttpPeer()
    peer.rawNames.set('short', 'nested__search')
    const handler = (request: IncomingMessage, response: ServerResponse) => { void peer.serve(request, response) }
    const server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    const { Context } = await hostModule('cordis')
    const { createScope } = await hostModule('dsh-scope')
    const official = await hostModule('dsh-mcp-client')
    const ctx = new Context()
    const scopes: any[] = []
    try {
      await setupHost(ctx, new Map(), [])
      for (const [serverName, endpoint] of [['alpha', 'short'], ['alpha__nested', 'long']]) {
        const agent: any = { session: { header: { cwd: '/alpha' } } }
        const scope = createScope(ctx, agent)
        scopes.push(scope)
        agent.ctx = scope.ctx
        await agent.ctx.plugin(official, { serverName, transport: 'streamable-http', url: base + '/' + endpoint, reconnect: { enabled: false } })
        expect(ctx.get('tools').view(agent).visible.has('mcp__alpha__nested__search')).toBe(true)
      }
    } finally {
      for (const scope of scopes.reverse()) await scope.dispose()
      await ctx.fiber.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }, 20000)

  it('retains a real startup error and recovers after explicit refresh', async () => {
    const peer = new HttpPeer()
    peer.failing.add('alpha')
    const handler = (request: IncomingMessage, response: ServerResponse) => { void peer.serve(request, response) }
    const server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    const { Context } = await hostModule('cordis')
    const { createScope } = await hostModule('dsh-scope')
    const official = await hostModule('dsh-mcp-client')
    const ctx = new Context()
    const files = new Map([['/alpha/.mcp.json', JSON.stringify({ mcpServers: { alpha: { url: base + '/alpha', failOnStartupError: true, reconnect: { enabled: false } } } })]])
    const agent: any = { session: { header: { cwd: '/alpha' } } }
    let scope: any
    try {
      await setupHost(ctx, files, [agent])
      scope = createScope(ctx, agent)
      agent.ctx = scope.ctx
      vi.spyOn(runtimeOf(ctx) as any, 'load').mockResolvedValue(official)
      await installMcpRuntime(ctx)
      expect(runtimeOf(ctx).views('/alpha')[0]).toMatchObject({ status: 'error', toolCount: 0, instanceCount: 0 })
      expect(runtimeOf(ctx).views('/alpha')[0].error).toContain('initial connection or tool synchronization failed')
      const before = peer.calls.length
      mcpSnapshot(ctx)
      expect(peer.calls).toHaveLength(before)
      peer.failing.clear()
      await projectRefresh(ctx, '/alpha', 'alpha')
      expect(runtimeOf(ctx).views('/alpha')[0]).toMatchObject({ status: 'unverified', toolCount: 1, instanceCount: 1, error: undefined })
    } finally {
      await runtimeOf(ctx).dispose()
      if (scope) await scope.dispose()
      await ctx.fiber.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }, 20000)

  it('isolates real connections, inherited tools, resources and instructions', async () => {
    const peer = new HttpPeer()
    const handler = (request: IncomingMessage, response: ServerResponse) => { void peer.serve(request, response) }
    const server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const base = 'http://127.0.0.1:' + address.port
    const { Context } = await hostModule('cordis')
    const { createScope, scopeParentOf } = await hostModule('dsh-scope')
    const official = await hostModule('dsh-mcp-client')
    const ctx = new Context()
    const agents: any[] = []
    const scopes: any[] = []
    const files = new Map<string, string>([
      ['/alpha/.mcp.json', JSON.stringify({ mcpServers: { alpha: { url: base + '/alpha', reconnect: { enabled: false } } } })],
      ['/beta/.mcp.json', JSON.stringify({ mcpServers: { beta: { url: base + '/beta', reconnect: { enabled: false } } } })],
    ])
    try {
      await setupHost(ctx, files, agents)
      const globalConfig = { serverName: 'global', transport: 'streamable-http', url: base + '/global', reconnect: { enabled: false } }
      const globalFiber = ctx.plugin(official, globalConfig)
      await globalFiber
      ctx.get('loader').entries = () => [{ id: 'global', fiber: globalFiber, options: { name: '@deepseek-ai/dsh-mcp-client', config: globalConfig } }]
      const parent: any = { session: { header: { cwd: '/alpha' } } }
      const child: any = { session: { header: { cwd: '/beta' } } }
      const sibling: any = { session: { header: { cwd: '/alpha/src' } } }
      for (const agent of [parent, child, sibling]) {
        const scope = createScope(ctx, agent, agent === child ? { parent } : undefined)
        scopes.push(scope)
        agent.ctx = scope.ctx
        agents.push(agent)
      }
      vi.spyOn(runtimeOf(ctx) as any, 'load').mockResolvedValue(official)
      installIsolation(ctx)
      await installMcpRuntime(ctx)
      expect(peer.calls.filter((call) => call.server === 'alpha' && call.method === 'initialize')).toHaveLength(2)
      expect(peer.calls.filter((call) => call.server === 'beta' && call.method === 'initialize')).toHaveLength(1)
      expect(runtimeOf(ctx).views('/beta')[0]).toMatchObject({ instanceCount: 1, toolCount: 0, status: 'unverified' })
      expect(ctx.get('tools').view(undefined).visible.has('mcp__alpha__search')).toBe(false)
      expect(ctx.get('tools').view(child).visible.has('mcp__alpha__search')).toBe(false)
      expect(ctx.get('tools').view(parent).visible.has('mcp__alpha__search')).toBe(true)
      expect(scopeParentOf(child)).toBe(parent)
      await child.ctx.plugin(official, { serverName: 'preset', transport: 'streamable-http', url: base + '/preset', reconnect: { enabled: false } })
      const prompt = await ctx.get('systemPrompt').assemble({ scope: child })
      const text = JSON.stringify(prompt.sections)
      expect(text).not.toContain('private-alpha')
      expect(text).toContain('private-beta {{literal}}')
      expect(prompt.sections.find((section: any) => section.name === 'mcp-resource-servers').text).toContain('["beta","global","preset"]')
      expect(JSON.stringify(await listResources(ctx, child, 'global'))).toContain('test://global')
      const before = peer.calls.length
      const denied = await listResources(ctx, child, 'alpha')
      expect(JSON.stringify(denied)).toContain('不能使用其他项目')
      expect(peer.calls).toHaveLength(before)
      const allowed = await listResources(ctx, child, 'beta')
      expect(JSON.stringify(allowed)).toContain('test://beta')
      peer.failing.add('beta')
      const outage = await listResources(ctx, child, 'beta')
      expect(JSON.stringify(outage)).not.toContain('test://beta')
      expect(JSON.stringify(outage)).toMatch(/503|error|failed/i)
      expect(runtimeOf(ctx).views('/beta')[0].status).toBe('unverified')
      peer.failing.delete('beta')
      expect(JSON.stringify(await listResources(ctx, child, 'beta'))).toContain('test://beta')
      const handshakes = peer.calls.filter((call) => call.method === 'initialize').length
      expect(mcpSnapshot(ctx).projects.find((project) => project.workspacePath === '/beta')?.servers[0].toolCount).toBe(0)
      expect(peer.calls.filter((call) => call.method === 'initialize')).toHaveLength(handshakes)
      await projectRefresh(ctx, '/alpha', 'alpha')
      expect(peer.calls.filter((call) => call.server === 'alpha' && call.method === 'initialize')).toHaveLength(4)
      expect(peer.calls.filter((call) => call.server === 'beta' && call.method === 'initialize')).toHaveLength(1)
      const config = { serverName: 'alpha__nested', transport: 'streamable-http' as const, url: base + '/alpha' }
      await expect(projectSave(ctx, '/beta', config.serverName, config)).rejects.toThrow('命名空间冲突')
      await projectToggle(ctx, '/alpha', 'alpha', false)
      expect(runtimeOf(ctx).views('/alpha')[0].instanceCount).toBe(0)
      expect(ctx.get('tools').view(parent).visible.has('mcp__alpha__search')).toBe(false)
      const removed = await listResources(ctx, parent, 'alpha')
      expect(JSON.stringify(removed)).toContain('unavailable')
    } finally {
      await runtimeOf(ctx).dispose()
      for (const scope of scopes.reverse()) await scope.dispose()
      await ctx.fiber.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }, 20000)
})
