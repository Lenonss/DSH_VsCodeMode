/** Project MCP configuration; .mcp.json is the source of truth. @author ddj 2026年09月28号 */
import { createHash } from 'node:crypto'
import { PROJECT_ENTRY_PREFIX, entriesOf, mergeSecrets, validateConfig } from './mcp.js'
import { isProjectEntryId } from './compat.js'
import { clearLegacy, runtimeOf } from './mcpRuntime.js'
import type { ProjectDef } from './mcpRuntime.js'
import type { MpcConfig, MpcProject, MpcServer } from './shared/mcp.js'
import type { Ctx } from './store.js'

const FILE_NAME = '.mcp.json'

/**
 * Require an exact registered workspace before any project file mutation.
 * @private @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param workspacePath Requested workspace.
 * @returns Registered workspace; throws for an unmanaged path.
 */
function requireWorkspace(ctx: Ctx, workspacePath: string): { path: string; title?: string } {
  const workspace = (ctx.get('workspaceRegistry')?.list?.() ?? []).find((item: { path: string }) => item.path === workspacePath)
  if (!workspace) throw new Error('项目未注册为 DSH workspace，不能管理项目 MCP')
  return workspace
}

/**
 * Resolve the explicit settings UI write policy for a fixed project configuration path.
 * @private @author ddj 2026年09月28号
 * @param ctx Host services.
 * @returns Resolved policy if the host supports it.
 */
function fullPolicy(ctx: Ctx): unknown {
  return ctx.get('sandboxPolicy')?.resolve?.({ mode: 'danger-full-access' })
}

/**
 * Hash a workspace path for stable project server identities.
 * @public @author ddj 2026年09月28号
 * @param path Registered workspace path.
 * @returns Ten hexadecimal characters.
 */
export function hashWorkspace(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 10)
}

/**
 * Preserve the historical project entry identity for RPC and UI consumers.
 * @public @author ddj 2026年09月28号
 * @param workspacePath Owning workspace.
 * @param serverName Configured name.
 * @returns Stable identity; this no longer denotes a global loader entry.
 */
export function projectEntryId(workspacePath: string, serverName: string): string {
  return PROJECT_ENTRY_PREFIX + hashWorkspace(workspacePath) + '.' + serverName
}

/**
 * Read the complete source document; only ENOENT denotes an absent configuration.
 * @private @author ddj 2026年09月28号
 * @param ctx Host filesystem.
 * @param workspacePath Registered workspace path.
 * @returns Parsed document; throws on unreadable or malformed input without changing runtime state.
 */
async function readProjectJson(ctx: Ctx, workspacePath: string): Promise<Record<string, unknown>> {
  const fs = ctx.get('fs')
  if (!fs) throw new Error('缺少 fs 服务')
  const target = await fs.resolve(FILE_NAME, { cwd: workspacePath })
  let text: string
  try {
    text = await fs.readText(target)
  } catch (error) {
    if ((error as { code?: string })?.code === 'ENOENT') return {}
    throw new Error('.mcp.json 读取失败：' + String(error))
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error('.mcp.json 解析失败：' + String(error))
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('.mcp.json 顶层必须是对象')
  return data as Record<string, unknown>
}

/**
 * Validate the server dictionary while retaining all definition fields.
 * @public @author ddj 2026年09月28号
 * @param data Source document.
 * @returns Server definitions; malformed definitions reject the entire snapshot.
 */
export function serversOf(data: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const raw = data.mcpServers
  if (raw === undefined) return Object.create(null)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('.mcp.json 的 mcpServers 必须是对象')
  const servers: Record<string, Record<string, unknown>> = Object.create(null)
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('.mcp.json 的 MCP 定义必须是对象：' + name)
    servers[name] = value as Record<string, unknown>
  }
  return servers
}

/**
 * Normalize a definition for the official plugin, retaining supported advanced options.
 * @public @author ddj 2026年09月28号
 * @param def Persisted server definition.
 * @param serverName Dictionary key.
 * @returns Plugin config, or null for a missing definition.
 */
export function configFromDef(def: Record<string, unknown> | undefined, serverName: string): MpcConfig | null {
  if (!def) return null
  const transport = typeof def.url === 'string' ? 'streamable-http' : 'stdio'
  const config: MpcConfig = { serverName, transport }
  if (transport === 'stdio') {
    config.command = typeof def.command === 'string' ? def.command : ''
    config.args = Array.isArray(def.args) ? def.args.map(String) : []
    if (typeof def.cwd === 'string') config.cwd = def.cwd
    if (def.env && typeof def.env === 'object') config.env = Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, String(v)]))
  } else {
    config.url = def.url as string
    if (def.headers && typeof def.headers === 'object') config.headers = Object.fromEntries(Object.entries(def.headers).map(([k, v]) => [k, String(v)]))
  }
  if (typeof def.toolCallTimeoutMs === 'number') config.toolCallTimeoutMs = def.toolCallTimeoutMs
  if (typeof def.maxInstructionBytes === 'number') config.maxInstructionBytes = def.maxInstructionBytes
  if (typeof def.failOnStartupError === 'boolean') config.failOnStartupError = def.failOnStartupError
  if (def.reconnect && typeof def.reconnect === 'object' && !Array.isArray(def.reconnect)) config.reconnect = { ...def.reconnect }
  return config
}

/**
 * Write a validated source document without dropping unrelated keys.
 * @private @author ddj 2026年09月28号
 * @param ctx Host filesystem.
 * @param workspacePath Registered workspace path.
 * @param data Complete next document.
 * @returns Completion of the authorized settings write.
 */
async function writeProjectJson(ctx: Ctx, workspacePath: string, data: Record<string, unknown>): Promise<void> {
  const fs = ctx.get('fs')
  if (!fs) throw new Error('缺少 fs 服务')
  const target = await fs.resolve(FILE_NAME, { cwd: workspacePath })
  await fs.writeText(target, JSON.stringify(data, null, 2) + '\n', void 0, void 0, fullPolicy(ctx))
}

/**
 * Reserve names across global entries and configured project files, including idle projects.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param serverName Proposed name.
 * @param workspacePath Owning project, omitted for a global save.
 * @returns Completion; throws on collision or an unreadable competing source document.
 */
export async function checkMcpName(ctx: Ctx, serverName: string, workspacePath?: string): Promise<void> {
  const conflict = 'serverName "' + serverName + '" 已被另一个 MCP 使用（全局或其他项目），请换一个名称'
  for (const entry of entriesOf(ctx)) {
    const project = isProjectEntryId(String(entry.id ?? entry.options?.id ?? ''))
    if (project || workspacePath === undefined) continue
    if (entry.options?.config?.serverName === serverName) throw new Error(conflict)
  }
  for (const ws of ctx.get('workspaceRegistry')?.list?.() ?? []) {
    if (ws.path === workspacePath) continue
    const servers = serversOf(await readProjectJson(ctx, ws.path))
    if (Object.hasOwn(servers, serverName)) throw new Error(conflict)
  }
}

/**
 * Reconcile one complete, validated snapshot; invalid reads preserve all active connections.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param workspacePath Registered workspace.
 * @param refresh Optional unchanged server to reconnect.
 * @returns Completion after scoped fibers match the file, including disabled flags.
 */
export async function reconcileProject(ctx: Ctx, workspacePath: string, refresh?: string): Promise<void> {
  const data = await readProjectJson(ctx, workspacePath)
  const defs = new Map<string, ProjectDef>()
  for (const [name, def] of Object.entries(serversOf(data))) {
    const config = configFromDef(def, name)!
    validateConfig(config)
    await checkMcpName(ctx, name, workspacePath)
    defs.set(name, { config, enabled: def.disabled !== true })
  }
  await clearLegacy(ctx)
  await runtimeOf(ctx).replace(workspacePath, defs, refresh)
}

/**
 * Preserve the historical activation entrypoint while using the source file and agent scopes.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param workspacePath Registered workspace.
 * @param config Requested configuration to persist.
 * @returns Masked runtime summary after saving and attaching matching agents.
 */
export async function activateProjectMcp(ctx: Ctx, workspacePath: string, config: MpcConfig): Promise<MpcServer> {
  const project = await projectSave(ctx, workspacePath, config.serverName, config)
  return project.servers.find((server) => server.serverName === config.serverName)!
}

/**
 * Disable a project definition by its stable id, retaining its persisted configuration.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param entryId Stable project identity.
 * @returns Completion of disabled persistence and connection teardown.
 */
export async function deactivateMcp(ctx: Ctx, entryId: string): Promise<void> {
  for (const [path, defs] of runtimeOf(ctx).projects) {
    for (const name of defs.keys()) {
      if (projectEntryId(path, name) !== entryId) continue
      await projectToggle(ctx, path, name, false)
      return
    }
  }
}

/**
 * List one project, retaining the last good runtime view on file errors.
 * @private @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param workspacePath Registered path.
 * @param title Workspace title.
 * @returns Configuration and honest runtime status with any read error attached.
 */
async function projectOf(ctx: Ctx, workspacePath: string, title: string): Promise<MpcProject> {
  let fileError: string | undefined
  let missingDir: boolean | undefined
  try {
    const fs = ctx.get('fs')
    if (!fs) throw new Error('缺少 fs 服务')
    const info = await fs.stat(await fs.resolve(workspacePath))
    missingDir = !info || info.type !== 'directory'
    if (!missingDir) await reconcileProject(ctx, workspacePath)
  } catch (error) {
    missingDir = (error as { code?: string })?.code === 'ENOENT' || undefined
    fileError = String(error)
  }
  return { workspacePath, title, servers: runtimeOf(ctx).views(workspacePath), source: 'project', missingDir, fileError }
}

/**
 * List registered projects and reconcile readable source documents.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @returns Project list; individual malformed files are reported on their project.
 */
export async function listProjects(ctx: Ctx): Promise<{ projects: MpcProject[] }> {
  const projects: MpcProject[] = []
  for (const ws of ctx.get('workspaceRegistry')?.list?.() ?? []) projects.push(await projectOf(ctx, ws.path, ws.title ?? ''))
  return { projects }
}

/**
 * Merge editable fields while retaining advanced fields and unchanged masked credentials.
 * @private @author ddj 2026年09月28号
 * @param previous Persisted server definition.
 * @param config Submitted form config.
 * @returns Enabled source definition without runtime-only keys or stale transport fields.
 */
function mergeDefinition(previous: Record<string, unknown>, config: MpcConfig): Record<string, unknown> {
  const next = mergeSecrets({ ...previous, ...config }, previous)
  delete next.serverName
  delete next.transport
  delete next.disabled
  const stale = config.transport === 'stdio' ? ['url', 'headers'] : ['command', 'args', 'cwd', 'env']
  for (const key of stale) delete next[key]
  return next
}

/**
 * Save one definition, preserving unrelated fields and masked secrets, then reconcile.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param workspacePath Registered workspace.
 * @param serverName Dictionary key.
 * @param config Submitted configuration.
 * @returns Updated project view; invalid sources or conflicts reject before writing.
 */
export async function projectSave(ctx: Ctx, workspacePath: string, serverName: string, config: MpcConfig): Promise<MpcProject> {
  const workspace = requireWorkspace(ctx, workspacePath)
  validateConfig({ ...config, serverName })
  await checkMcpName(ctx, serverName, workspacePath)
  const data = await readProjectJson(ctx, workspacePath)
  const servers = serversOf(data)
  servers[serverName] = mergeDefinition(servers[serverName] ?? {}, { ...config, serverName })
  await writeProjectJson(ctx, workspacePath, { ...data, mcpServers: servers })
  await reconcileProject(ctx, workspacePath)
  return projectOf(ctx, workspacePath, workspace.title ?? '')
}

/**
 * Persist removal before shutting down its scoped fibers.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param workspacePath Registered workspace.
 * @param serverName Target definition.
 * @returns Updated project view; write failures leave active configuration intact.
 */
export async function projectRemove(ctx: Ctx, workspacePath: string, serverName: string): Promise<MpcProject> {
  const workspace = requireWorkspace(ctx, workspacePath)
  const data = await readProjectJson(ctx, workspacePath)
  const servers = serversOf(data)
  delete servers[serverName]
  await writeProjectJson(ctx, workspacePath, { ...data, mcpServers: servers })
  await reconcileProject(ctx, workspacePath)
  return projectOf(ctx, workspacePath, workspace.title ?? '')
}

/**
 * Persist enabled state and reconcile all matching agents immediately.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param workspacePath Registered workspace.
 * @param serverName Target definition.
 * @param enabled Desired enabled state.
 * @returns Updated project view, including retained disabled definitions.
 */
export async function projectToggle(ctx: Ctx, workspacePath: string, serverName: string, enabled: boolean): Promise<MpcProject> {
  const workspace = requireWorkspace(ctx, workspacePath)
  const data = await readProjectJson(ctx, workspacePath)
  const servers = serversOf(data)
  const def = servers[serverName]
  if (!def) throw new Error('项目中不存在该 MCP')
  if (enabled) delete def.disabled
  else def.disabled = true
  await writeProjectJson(ctx, workspacePath, { ...data, mcpServers: servers })
  await reconcileProject(ctx, workspacePath)
  return projectOf(ctx, workspacePath, workspace.title ?? '')
}

/**
 * Reconnect one enabled source definition across its active agents.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param workspacePath Registered workspace.
 * @param serverName Target definition.
 * @returns Updated project view; disabled or idle definitions stay connection-free.
 */
export async function projectRefresh(ctx: Ctx, workspacePath: string, serverName: string): Promise<MpcProject> {
  const workspace = requireWorkspace(ctx, workspacePath)
  const data = await readProjectJson(ctx, workspacePath)
  if (!Object.hasOwn(serversOf(data), serverName)) throw new Error('项目中不存在该 MCP')
  await reconcileProject(ctx, workspacePath, serverName)
  return projectOf(ctx, workspacePath, workspace.title ?? '')
}
