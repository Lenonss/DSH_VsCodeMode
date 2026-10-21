/** Private registration proof using the installed Host, not mock scope semantics. @author ddj 2026年10月20号 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpBinding, McpBridge } from '../src/mcpBridge.js'

const hostRoot = process.env.DSH_MCP_HOST_ROOT

/** @private @author ddj 2026年10月20号 @param suffix Official package. @returns Installed module namespace. */
async function hostModule(suffix: string): Promise<any> {
  const require = createRequire(join(hostRoot!, 'package.json'))
  return import(/* @vite-ignore */ pathToFileURL(require.resolve('@deepseek-ai/' + suffix)).href)
}

/** @private @author ddj 2026年10月20号 @param message MCP request. @returns Small valid protocol payload. */
function peerResult(message: any): any {
  switch (message.method) {
    case 'initialize': return { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'private', version: '1' }, instructions: 'private instructions {{literal}}' }
    case 'tools/list': return { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }] }
    case 'tools/call': return { content: [{ type: 'text', text: 'private result' }] }
    case 'resources/list': return { resources: [{ name: 'private', uri: 'test://private' }] }
    default: return {}
  }
}

describe('revocable MCP bindings', () => {
  it('updates tool definitions, preserves official metadata and rejects stale or foreign executions', async () => {
    const published = new Map<string, any>()
    const sections = new Map<string, any>()
    const sinks = new Map<string, any>()
    const privateCtx: any = { isolate: () => privateCtx, provide: (name: string, provider: any) => sinks.set(name, provider) }
    const bridge = await McpBridge.create({} as any, () => ({ ctx: privateCtx, dispose: async () => undefined }))
    const tools = { register: (definition: any) => { published.set(definition.name, definition); return () => published.delete(definition.name) } }
    const prompt = { section: (section: any) => { sections.set(section.name, section); return () => sections.delete(section.name) } }
    const agent = { ctx: { get: (name: string) => name === 'tools' ? tools : prompt } }
    const entry: any = { bridge, live: true }
    const pool: any = { run: async (_entry: any, action: any) => action() }
    let valid = true
    const binding = new McpBinding(agent, pool, entry, () => valid)
    const output = { schema: {}, render: () => [] }
    const definition = { name: 'mcp__test__one', output, projectContent: () => undefined, presentCall: () => ({ kind: 'card' }), execute: async (_args: any, execution: any) => execution.callId }
    const removeFirst = sinks.get('tools').register(definition)
    binding.sync()
    const first = published.get(definition.name)
    expect(first.output).toBe(output)
    expect(first.projectContent).toBe(definition.projectContent)
    expect(first.presentCall).toBe(definition.presentCall)
    expect(await first.execute({}, { agent, callId: 'original' })).toBe('original')
    await expect(first.execute({}, { agent: {}, callId: 'foreign' })).rejects.toThrow('作用域')
    removeFirst()
    expect(published.has(definition.name)).toBe(false)
    sinks.get('tools').register({ ...definition, name: 'mcp__test__two' })
    expect(published.has('mcp__test__two')).toBe(true)
    await expect(first.execute({}, { agent })).rejects.toThrow('定义已更新')
    valid = false
    const second = published.get('mcp__test__two')
    await expect(second.execute({}, { agent })).rejects.toThrow('作用域')
    binding.dispose()
    expect(published.size + sections.size).toBe(0)
    await bridge.dispose()
  })
})

describe.skipIf(!hostRoot)('installed private MCP bridge', () => {
  it('captures official tools/resources/instructions privately and preserves scoped execution and revocation', async () => {
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const message = JSON.parse(Buffer.concat(chunks).toString())
      if (message.id === undefined) { response.writeHead(202).end(); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: peerResult(message) }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { Context } = await hostModule('cordis')
    const { createScope } = await hostModule('dsh-scope')
    const ctx = new Context()
    let bridge: McpBridge | undefined
    let owner: any
    try {
      await ctx.plugin((await hostModule('dsh-system-prompt')).default, {})
      await ctx.plugin((await hostModule('dsh-tools')).default, {})
      await ctx.plugin((await hostModule('dsh-mcp-resources')).default)
      bridge = await McpBridge.create(ctx, createScope)
      const official = await hostModule('dsh-mcp-client')
      const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/mcp'
      await bridge.scope.ctx.plugin(official, { serverName: 'private', transport: 'streamable-http', url, failOnStartupError: true, reconnect: { enabled: false } })
      const tools = ctx.get('tools')
      expect(tools.schemas()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'mcp__private__echo' })]))
      expect(JSON.stringify(await ctx.get('systemPrompt').assemble({}))).not.toContain('private instructions')
      expect(bridge.tools.has('mcp__private__echo')).toBe(true)
      expect(bridge.resources.has('private')).toBe(true)
      expect(bridge.sections.has('mcp:private')).toBe(true)

      const agent: any = { session: { id: 'owner' } }
      owner = createScope(ctx, agent)
      agent.ctx = owner.ctx
      const definition = bridge.tools.get('mcp__private__echo')
      const remove = agent.ctx.get('tools').register(definition)
      agent.ctx.get('mcpResources').register('private', bridge.resources.get('private'))
      agent.ctx.get('systemPrompt').section(bridge.sections.get('mcp:private'))
      const execution = { agent, callId: 'proof', signal: new AbortController().signal }
      expect(JSON.stringify(await tools.execute({ ...execution, name: 'mcp__private__echo', arguments: {} }))).toContain('private result')
      expect(JSON.stringify(await tools.execute({ ...execution, name: 'list_mcp_resources', arguments: { server: 'private' } }))).toContain('test://private')
      expect(JSON.stringify(await ctx.get('systemPrompt').assemble({ scope: agent }))).toContain('private instructions {{literal}}')
      expect(tools.get('mcp__private__echo', {})).toBeUndefined()
      remove()
      expect(tools.get('mcp__private__echo', agent)).toBeUndefined()
      await bridge.dispose()
      expect(bridge.tools.size + bridge.resources.size + bridge.sections.size).toBe(0)
    } finally {
      await owner?.dispose()
      await bridge?.dispose()
      await ctx.fiber.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }, 20000)
})
