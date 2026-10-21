/** Scoped capability discovery; never accepts commands, paths or caller identity. @author ddj 2026年10月20号 */
import type { McpRuntime } from './mcpRuntime.js'

/** @public @author ddj 2026年10月20号 @param runtime Authorized runtime. @param ctx Host registration context. @returns Global discovery cleanup; normal capability filters remain authoritative. */
export function installDiscover(runtime: McpRuntime, ctx: any): () => void {
  const tools = ctx.get('tools')
  /** @author ddj 2026年10月20号 @param args Validated operation. @param execution Registry-owned caller identity. @returns Safe capability catalogue or real connected schemas. */
  const execute = async (args: any, execution: any): Promise<unknown> => {
    const agent = execution.agent
    if (!agent || !runtime.agents.has(agent)) throw new Error('会话未激活，不能使用项目 MCP 发现入口')
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !['action', 'serverName'].includes(key))) throw new Error('发现入口仅接受 action 和 serverName')
    if (!['list', 'connect'].includes(args.action)) throw new Error('action 必须为 list 或 connect')
    if (args.action === 'list') return runtime.catalogue(agent)
    if (typeof args.serverName !== 'string') throw new Error('请指定已配置的 serverName')
    return runtime.connect(agent, args.serverName, execution.signal)
  }
  /** @author ddj 2026年10月20号 @param _args Unused. @param result Safe canonical JSON. @returns Native content without bypassing output validation. */
  const render = (_args: unknown, result: unknown): any[] => [{ type: 'text', text: JSON.stringify(result) }]
  const removeTool = tools.register({
    name: 'discover_project_mcp', description: 'List this workspace’s configured project MCP services without starting them, or connect one to discover its real tools. After connecting, call discovered tools in the NEXT request/program; never guess schemas. Global/preset MCPs are not included.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'connect'] }, serverName: { type: 'string' } }, required: ['action'], additionalProperties: false },
    output: { schema: {}, render }, execute,
  })
  return removeTool
}

/** @public @author ddj 2026年10月20号 @param runtime Active owners. @param agent Scoped catalogue owner. @returns Scoped instruction cleanup; does not register a tool override. */
export function discoverPrompt(runtime: McpRuntime, agent: any): () => void {
  const prompt = agent.ctx.get('systemPrompt')
  /** @author ddj 2026年10月20号 @returns Current enabled names only; no credential-bearing configuration. */
  const text = (): string => {
    const names = runtime.catalogue(agent).map((server) => server.serverName)
    if (!names.length) return ''
    return 'Project MCP capabilities (may not be started): ' + JSON.stringify(names) + '. Use discover_project_mcp action=list, then action=connect with serverName when needed. Only use returned real tool schemas. Native tools appear on the next model request; PTC must finish the current program and start a new program to refresh its SDK. Do not eval or bypass tool approval.'
  }
  const removePrompt = prompt.section({ name: 'vscode-mode:project-mcp', order: 3090, text, interpolate: false })
  return removePrompt
}
