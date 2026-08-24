/**
 * dsh-vscode-mode host — 项目 MCP 的 agent 级隔离。
 * 项目 MCP 连接仍由 Host 维护，但每个 agent 只继承当前 workspace 的项目工具；
 * tools.restrict() 负责模型可见性，tools.guard() 负责执行层兜底拒绝。
 * 作者 ddj 2026年08月22号
 */
import { LEGACY_PROJECT_PREFIX, entryHash, isProjectEntryId } from './compat.js'
import { entriesOf } from './mcp.js'
import { hashWorkspace } from './mcpProject.js'
import type { Ctx } from './store.js'

const UNKNOWN_PROJECT = '__unknown_project__'

type ToolProjects = Map<string, string>
type AgentState = { dispose?: () => void; denyKey: string }

/** 统一 workspace 路径，供 cwd 父路径匹配。 */
export function normalizePath(path: string): string {
  const value = String(path ?? '').replace(/\\/g, '/').replace(/\/+/g, '/')
  return value.replace(/\/$/, '').toLowerCase()
}

/** 在已注册 workspace 中匹配 cwd，优先最长父路径。 */
export function matchWorkspace(cwd: string | undefined, paths: string[]): string | undefined {
  if (!cwd) return undefined
  const target = normalizePath(cwd)
  const matches = paths.filter((path) => {
    const root = normalizePath(path)
    return target === root || target.startsWith(root + '/')
  })
  matches.sort((a, b) => normalizePath(b).length - normalizePath(a).length)
  return matches[0]
}

/** 根据 entry id 判断是否为新旧格式项目 MCP（兼容层统一判定）。 */
export const isProjectEntry = isProjectEntryId

/** 兼容：旧版前缀常量名（mcpIsolation 历史导出，语义不变）。 */
export const LEGACY_PREFIX = LEGACY_PROJECT_PREFIX

/** 返回一个 agent 不应继承的项目工具名。 */
export function denyTools(toolProjects: ToolProjects, currentPath: string | undefined): string[] {
  return [...toolProjects.entries()].filter(([, owner]) => owner !== currentPath).map(([name]) => name).sort()
}

/** 从 loader entry 和工具注册表建立工具到项目路径的映射。 */
function projectTools(ctx: Ctx): ToolProjects {
  const result: ToolProjects = new Map()
  const registry = ctx.get('workspaceRegistry')
  const workspaces = registry?.list?.() ?? []
  const byHash: Map<string, string> = new Map(workspaces.map((ws: { path: string }) => [hashWorkspace(ws.path), ws.path] as [string, string]))
  const visible = ctx.get('tools')?.view?.(void 0)?.visible
  if (!(visible instanceof Map)) return result
  for (const entry of entriesOf(ctx)) {
    const id = String(entry.id ?? entry.options?.id ?? '')
    if (!isProjectEntry(id)) continue
    const hash = entryHash(id)
    const owner = hash ? byHash.get(hash) ?? UNKNOWN_PROJECT : UNKNOWN_PROJECT
    const serverName = entry.options?.config?.serverName
    if (typeof serverName !== 'string') continue
    const prefix = `mcp__${serverName}__`
    for (const name of visible.keys()) if (String(name).startsWith(prefix)) result.set(String(name), owner)
  }
  return result
}

/** 取得 agent 当前 cwd 所属 workspace。 */
function agentWorkspace(ctx: Ctx, agent: any): string | undefined {
  const cwd = agent?.session?.header?.cwd
  const paths = (ctx.get('workspaceRegistry')?.list?.() ?? []).map((ws: { path: string }) => ws.path)
  return matchWorkspace(cwd, paths)
}

/** 同步一个 agent 的项目工具 deny 列表。 */
function syncAgent(ctx: Ctx, state: AgentState, agent: any, tools: ToolProjects): void {
  const current = agentWorkspace(ctx, agent)
  const denied = denyTools(tools, current)
  const nextKey = denied.join('\n')
  if (state.denyKey === nextKey) return
  state.dispose?.()
  state.dispose = undefined
  if (denied.length > 0) {
    try {
      state.dispose = agent.ctx.tools.restrict({ deny: denied })
    } catch (error) {
      ctx.logger?.warn?.('[dsh-vscode-mode] MCP agent restriction failed: ' + String(error))
      return
    }
  }
  state.denyKey = nextKey
}

/** 为当前 Host 安装项目 MCP 的 agent restriction 与执行 guard。 */
export function installIsolation(ctx: Ctx): void {
  const tools = ctx.get('tools')
  const agents = ctx.get('agents')
  if (!tools || !agents) return
  const states = new Map<any, AgentState>()
  let toolProjects = projectTools(ctx)
  let scheduled = false
  let syncing = false

  const syncAll = () => {
    if (syncing) return
    syncing = true
    try {
      toolProjects = projectTools(ctx)
      for (const agent of agents.list?.() ?? []) {
        const state = states.get(agent) ?? { denyKey: '' }
        states.set(agent, state)
        syncAgent(ctx, state, agent, toolProjects)
      }
    } finally {
      syncing = false
    }
  }
  const scheduleSync = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      syncAll()
    })
  }
  const onCreated = ctx.on('agent/created', ({ agent }: { agent: any }) => {
    const state = { denyKey: '' }
    states.set(agent, state)
    syncAgent(ctx, state, agent, toolProjects)
  })
  const onDisposed = ctx.on('agent/disposed', ({ agent }: { agent: any }) => {
    const state = states.get(agent)
    state?.dispose?.()
    states.delete(agent)
  })
  const onToolsChange = ctx.on('tools/change', scheduleSync)
  const stopGuard = tools.guard((exec: any) => {
    const owner = toolProjects.get(String(exec?.name ?? ''))
    if (!owner) return undefined
    const current = agentWorkspace(ctx, exec.agent)
    if (owner === current) return undefined
    return current === undefined
      ? '项目 MCP 需要在已注册工作区的对话中使用'
      : '已拒绝：当前对话工作区不能使用其他项目的 MCP'
  })
  syncAll()
  ctx.effect(() => () => {
    onCreated?.()
    onDisposed?.()
    onToolsChange?.()
    stopGuard?.()
    for (const state of states.values()) state.dispose?.()
    states.clear()
  }, 'vscode-mode:mcp-isolation')
}
