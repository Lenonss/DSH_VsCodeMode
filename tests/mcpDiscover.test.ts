/** Discovery authorization and next-request schema contract. @author ddj 2026年10月20号 */
import { describe, expect, it, vi } from 'vitest'
import { installDiscover, discoverPrompt } from '../src/mcpDiscover.js'

/** @private @author ddj 2026年10月20号 @returns Minimal scoped registry and discovery runtime. */
function fixture() {
  const definitions = new Map<string, any>()
  const sections = new Map<string, any>()
  const tools = { register: (definition: any) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) } }
  const prompt = { section: (section: any) => { sections.set(section.name, section); return () => sections.delete(section.name) } }
  const agent = { ctx: { get: (name: string) => name === 'tools' ? tools : prompt } }
  const runtime = { agents: new Map([[agent, {}]]), catalogue: vi.fn(() => [{ serverName: 'code', phase: 'idle' }]), connect: vi.fn(async () => ({ tools: [{ name: 'mcp__code__search', parameters: { type: 'object' } }], nextRequest: 'next request' })) }
  const offTool = installDiscover(runtime as any, agent.ctx)
  const offPrompt = discoverPrompt(runtime as any, agent)
  const remove = () => { offTool(); offPrompt() }
  return { agent, runtime, definitions, sections, remove, tool: definitions.get('discover_project_mcp') }
}

describe('scoped project discovery', () => {
  it('lists only configured capability names without connecting and installs explicit PTC guidance', async () => {
    const host = fixture()
    expect(await host.tool.execute({ action: 'list' }, { agent: host.agent })).toEqual([{ serverName: 'code', phase: 'idle' }])
    expect(host.runtime.connect).not.toHaveBeenCalled()
    const text = host.sections.get('vscode-mode:project-mcp').text()
    expect(text).toContain('PTC must finish the current program')
    expect(text).not.toContain('command')
    host.remove()
    expect(host.definitions.size + host.sections.size).toBe(0)
  })

  it('takes identity and cancellation from execution and returns real schemas', async () => {
    const host = fixture()
    const signal = new AbortController().signal
    const result = await host.tool.execute({ action: 'connect', serverName: 'code' }, { agent: host.agent, signal })
    expect(host.runtime.connect).toHaveBeenCalledWith(host.agent, 'code', signal)
    expect(result.tools[0]).toEqual({ name: 'mcp__code__search', parameters: { type: 'object' } })
    await expect(host.tool.execute({ action: 'connect', serverName: 'code' }, { agent: {} })).rejects.toThrow('未激活')
    await expect(host.tool.execute({ action: 'run', serverName: 'code' }, { agent: host.agent })).rejects.toThrow('action')
    expect(host.tool.parameters.additionalProperties).toBe(false)
    expect(host.tool.parameters.properties).not.toHaveProperty('sessionId')
  })
})
