/** Project MCP visibility, instruction shadows, and execution guards. @author ddj 2026年09月28号 */
import { posix, win32 } from 'node:path'
import { LEGACY_PROJECT_PREFIX, entryHash, isProjectEntryId } from './compat.js'
import { entriesOf, mcpNames } from './mcp.js'
import { hashWorkspace } from './mcpProject.js'
import { runtimeOf } from './mcpRuntime.js'
import type { Ctx } from './store.js'

const UNKNOWN_PROJECT = '__unknown_project__'
const RESOURCE_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
type ToolProjects = Map<string, string>
type AgentState = { dispose?: () => void; denyKey: string; shadows: Map<string, () => void> }

/**
 * Normalize path separators and Windows case while retaining POSIX case sensitivity.
 * @public @author ddj 2026年09月28号
 * @param path Workspace or agent cwd.
 * @returns Comparable path with a stable root representation.
 */
export function normalizePath(path: string): string {
  const raw = String(path ?? '').replace(/\\/g, '/')
  const windows = /^[a-z]:/i.test(raw) || raw.startsWith('//')
  const normalized = (windows ? win32.normalize(raw) : posix.normalize(raw)).replace(/\\/g, '/')
  const value = normalized.replace(/\/+$/, '') || '/'
  return windows ? value.toLowerCase() : value
}

/**
 * Match the most specific registered parent workspace.
 * @public @author ddj 2026年09月28号
 * @param cwd Agent working directory.
 * @param paths Registered workspace paths.
 * @returns Matching original path, or undefined.
 */
export function matchWorkspace(cwd: string | undefined, paths: string[]): string | undefined {
  if (!cwd) return undefined
  const target = normalizePath(cwd)
  const matches = paths.filter((path) => {
    const root = normalizePath(path)
    return target === root || target.startsWith(root === '/' ? root : root + '/')
  })
  matches.sort((a, b) => normalizePath(b).length - normalizePath(a).length)
  return matches[0]
}

export const isProjectEntry = isProjectEntryId
export const LEGACY_PREFIX = LEGACY_PROJECT_PREFIX

/**
 * Select foreign project tool names.
 * @public @author ddj 2026年09月28号
 * @param toolProjects Tool ownership map.
 * @param currentPath Matching workspace.
 * @returns Sorted deny list.
 */
export function denyTools(toolProjects: ToolProjects, currentPath: string | undefined): string[] {
  return [...toolProjects].filter(([, owner]) => owner !== currentPath).map(([name]) => name).sort()
}

/**
 * Include historical global entries in ownership until migration has disposed them.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @returns Server-to-workspace ownership map.
 */
export function serverOwners(ctx: Ctx): Map<string, string> {
  const result = runtimeOf(ctx).owners()
  const workspaces = ctx.get('workspaceRegistry')?.list?.() ?? []
  const hashes = new Map(workspaces.map((ws: { path: string }) => [hashWorkspace(ws.path), ws.path]))
  for (const entry of entriesOf(ctx)) {
    const id = String(entry.id ?? entry.options?.id ?? '')
    const name = entry.options?.config?.serverName
    if (!isProjectEntry(id) || typeof name !== 'string') continue
    result.set(name, String(hashes.get(entryHash(id)) ?? UNKNOWN_PROJECT))
  }
  return result
}

/**
 * Resolve managed server attribution for namespaced tools and shared resource calls.
 * @public @author ddj 2026年09月28号
 * @param exec Tool execution with arguments.server for shared resource tools.
 * @returns Attributed server name, or undefined for unrelated tools.
 */
export function callServer(exec: any): string | undefined {
  const name = String(exec?.name ?? '')
  if (RESOURCE_TOOLS.has(name)) return typeof exec?.arguments?.server === 'string' ? exec.arguments.server : undefined
  return /^mcp__(.+?)__/.exec(name)?.[1]
}

/**
 * Check workspace ownership before any tool or resource network operation.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param exec Caller and tool arguments.
 * @returns A denial message, or undefined for an allowed/global call.
 */
export function guardMcp(ctx: Ctx, exec: any): string | undefined {
  const name = String(exec?.name ?? '')
  if (!RESOURCE_TOOLS.has(name) && !name.startsWith('mcp__')) return undefined
  const server = callServer(exec)
  const owners = serverOwners(ctx)
  const current = runtimeOf(ctx).workspace(exec.agent)
  if (!RESOURCE_TOOLS.has(name) && [...mcpNames(ctx)].filter((key) => name.startsWith('mcp__' + key + '__')).length > 1) return '已拒绝：MCP 命名空间冲突，无法确认工具归属'
  const owned = RESOURCE_TOOLS.has(name) ? [...owners].filter(([key]) => key === server)
    : [...owners].filter(([key]) => name.startsWith('mcp__' + key + '__'))
  if (!owned.some(([, owner]) => owner !== current)) return undefined
  return current === undefined ? '项目 MCP 需要在已注册工作区的对话中使用' : '已拒绝：当前对话工作区不能使用其他项目的 MCP'
}

/**
 * Restrict inherited names using the public restrictableNames set, even after already hidden.
 * @private @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param agent Target scope.
 * @param state Owned restriction disposers.
 * @param owners Server ownership.
 * @sideEffects Replaces only this plugin's scoped restriction.
 */
function syncTools(ctx: Ctx, agent: any, state: AgentState, owners: Map<string, string>): void {
  const tools = agent.ctx.get('tools')
  const view = tools?.view?.(agent)
  const names: Iterable<string> = view?.restrictableNames ?? view?.knownNames ?? view?.visible?.keys?.() ?? []
  const current = runtimeOf(ctx).workspace(agent)
  const denied = [...names].filter((name) => {
    return [...owners].some(([server, owner]) => name.startsWith('mcp__' + server + '__') && owner !== current)
  }).sort()
  const key = denied.join('\n')
  if (key === state.denyKey) return
  state.denyKey = key
  let dispose: (() => void) | undefined
  try { dispose = denied.length > 0 ? tools.restrict({ deny: denied }) : undefined }
  catch (error) { state.denyKey = ''; throw error }
  state.dispose?.()
  state.dispose = dispose
}

/**
 * Filter the official assembled server list, retaining unmanaged and resource-only providers.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param agent Actual assembly scope, including a descendant of the listening scope.
 * @param text Official mcp-resource-servers section text.
 * @returns Scope-visible resource help; unfamiliar list formats fail closed for foreign projects.
 */
export function filterResources(ctx: Ctx, agent: any, text: string): string {
  const current = runtimeOf(ctx).workspace(agent)
  const owners = serverOwners(ctx)
  const foreign = new Set([...owners].filter(([, owner]) => owner !== current).map(([name]) => name))
  if (!foreign.size || !text) return text
  const match = /(\[[^\n]*\])\.\s*$/.exec(text)
  if (!match) return ''
  let names: unknown
  try { names = JSON.parse(match[1]) } catch { return '' }
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) return ''
  const visible = names.filter((name) => !foreign.has(name))
  return visible.length ? text.slice(0, match.index) + JSON.stringify(visible) + '.' : ''
}

/**
 * Apply scope-specific resource visibility to the public assembled prompt snapshot.
 * @private @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param assembly Downstream assembly result.
 * @param agent Actual viewing scope.
 * @returns Detached section list; all unrelated sections retain their original identity.
 */
function filterAssembly(ctx: Ctx, assembly: any, agent: any): any {
  const sections = assembly.sections.map((section: any) => section.name === 'mcp-resource-servers'
    ? { ...section, text: filterResources(ctx, agent, section.text) } : section)
  return { ...assembly, sections }
}

/**
 * Shadow inherited foreign instructions without changing the scope's parent chain.
 * @private @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param agent Target scope.
 * @param state Owned prompt registrations.
 * @param owners Current project server ownership.
 * @sideEffects Registers blank foreign instruction sections in the exact agent scope.
 */
function syncPrompts(ctx: Ctx, agent: any, state: AgentState, owners: Map<string, string>): void {
  const prompt = agent.ctx.get('systemPrompt')
  if (!prompt) return
  const current = runtimeOf(ctx).workspace(agent)
  const foreign = new Set([...owners].filter(([, path]) => path !== current).map(([name]) => name))
  for (const [name, dispose] of state.shadows) {
    if (foreign.has(name)) continue
    dispose()
    state.shadows.delete(name)
  }
  const order = prompt.getSectionOrder('MCP_SERVERS')
  for (const name of foreign) {
    if (state.shadows.has(name)) continue
    state.shadows.set(name, prompt.section({ name: 'mcp:' + name, order, interpolate: false, text: '' }))
  }
}

/**
 * Dispose only isolation effects owned for one agent.
 * @private @author ddj 2026年09月28号
 * @param state Stored effect handles.
 * @sideEffects Removes restrictions, blank instruction shadows, and resource help override.
 */
function clearState(state: AgentState): void {
  state.dispose?.()
  for (const dispose of state.shadows.values()) dispose()
  state.shadows.clear()
}

/**
 * Install synchronous creation isolation and guards before installing the MCP runtime.
 * @public @author ddj 2026年09月28号
 * @param ctx Host lifecycle context.
 * @sideEffects Owns per-agent restrictions and prompt shadows plus a global execution guard.
 */
export function installIsolation(ctx: Ctx): void {
  const tools = ctx.get('tools')
  const agents = ctx.get('agents')
  if (!tools || !agents) return
  const states = new Map<any, AgentState>()
  let syncing = false
  const syncAgent = (agent: any) => {
    const state = states.get(agent) ?? { denyKey: '', shadows: new Map() }
    states.set(agent, state)
    const owners = serverOwners(ctx)
    syncTools(ctx, agent, state, owners)
    syncPrompts(ctx, agent, state, owners)
  }
  const syncAll = () => {
    if (syncing) return
    syncing = true
    try { for (const agent of agents.list?.() ?? []) syncAgent(agent) }
    finally { syncing = false }
  }
  const onCreated = ({ agent }: { agent: any }) => { syncAgent(agent) }
  const onDisposed = ({ agent }: { agent: any }) => {
    const state = states.get(agent)
    if (state) clearState(state)
    states.delete(agent)
  }
  const guard = (exec: any) => guardMcp(ctx, exec)
  /**
   * Filter the completed assembly using its actual viewing scope.
   * @private @author ddj 2026年09月28号
   * @param assembly Initial prompt snapshot.
   * @param context Assembly scope.
   * @param next Downstream assembly continuation.
   * @returns Completed prompt with foreign project resource names removed.
   */
  const filterPrompt = async (assembly: any, context: any, next: () => Promise<any>) => {
    return filterAssembly(ctx, await next(), context.scope)
  }
  const disposers = [ctx.on('agent/created', onCreated), ctx.on('agent/disposed', onDisposed),
    ctx.on('tools/change', syncAll), ctx.on('vscode-mode/mcp-change', syncAll),
    ctx.on('system-prompt/assemble', filterPrompt), tools.guard(guard)]
  const cleanup = () => {
    for (const dispose of disposers) dispose?.()
    for (const state of states.values()) clearState(state)
    states.clear()
  }
  ctx.effect(() => cleanup, 'vscode-mode:mcp-isolation')
  syncAll()
}
