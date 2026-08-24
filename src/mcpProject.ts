/**
 * dsh-vscode-mode host — 项目级 MCP 管理。
 * 配置以项目根目录 .mcp.json（mcpServers 格式，对齐 Claude Code/Cursor）存储；
 * 工具经 loader 动态激活（entry id 带 PROJECT_ENTRY_PREFIX，全局生效）。
 * 重启后由本项目从各 .mcp.json 恢复激活；.mcp.json 为持久真相，reconcile 以文件为准。
 * 作者 ddj 2026年08月22号
 */
import { createHash } from 'node:crypto'
import { PROJECT_ENTRY_PREFIX, entriesOf, serverOf, validateConfig } from './mcp.js'
import type { MpcConfig, MpcProject, MpcServer } from './shared/mcp.js'
import type { Ctx } from './store.js'

const FILE_NAME = '.mcp.json'

/** 校验项目路径属于 DSH 已注册 workspace，避免 RPC 写入任意目录。 */
function requireWorkspace(ctx: Ctx, workspacePath: string): { path: string; title?: string } {
  const workspace = (ctx.get('workspaceRegistry')?.list?.() ?? []).find((item: { path: string }) => item.path === workspacePath)
  if (!workspace) throw new Error('项目未注册为 DSH workspace，不能管理项目 MCP')
  return workspace
}

/** 用户显式 GUI 管理操作的写策略：danger-full-access（写入路径固定为 workspacePath/.mcp.json）。 */
function fullPolicy(ctx: Ctx): unknown {
  const svc = ctx.get('sandboxPolicy')
  if (!svc || typeof svc.resolve !== 'function') return undefined
  return svc.resolve({ mode: 'danger-full-access' })
}

/** workspace 路径 → 确定性短哈希（entry id 归属段，重启后稳定可解码）。 */
export function hashWorkspace(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 10)
}

/** 项目 MCP 的 loader entry id：vsm-mcp.<pathHash>.<serverName>（loader id 不能用冒号）。 */
export function projectEntryId(workspacePath: string, serverName: string): string {
  return PROJECT_ENTRY_PREFIX + hashWorkspace(workspacePath) + '.' + serverName
}

/** 读取项目 .mcp.json 顶层对象（缺失 → 空；非法 → 抛错带文案）。 */
async function readProjectJson(ctx: Ctx, workspacePath: string): Promise<Record<string, unknown>> {
  const fs = ctx.get('fs')
  if (!fs) throw new Error('缺少 fs 服务')
  const target = await fs.resolve(FILE_NAME, { cwd: workspacePath })
  let text: string
  try {
    text = await fs.readText(target)
  } catch (error) {
    return {}
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

/** 读取并校验 .mcp.json 的 mcpServers 映射（纯函数，可单测）。 */
export function serversOf(data: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const raw = data.mcpServers
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('.mcp.json 的 mcpServers 必须是对象')
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    out[name] = value as Record<string, unknown>
  }
  return out
}

/** 把 .mcp.json 单条 server 定义归一化为 MpcConfig（缺传输必填 → null，纯函数可单测）。 */
export function configFromDef(def: Record<string, unknown> | undefined, serverName: string): MpcConfig | null {
  if (!def) return null
  const transport = typeof def.url === 'string' ? 'streamable-http' : 'stdio'
  const config: MpcConfig = { serverName, transport }
  if (transport === 'stdio') {
    config.command = typeof def.command === 'string' ? def.command : ''
    config.args = Array.isArray(def.args) ? def.args.map(String) : []
    if (typeof def.cwd === 'string') config.cwd = def.cwd
    if (def.env && typeof def.env === 'object') config.env = Object.fromEntries(Object.entries(def.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
  } else {
    config.url = def.url as string
    if (def.headers && typeof def.headers === 'object') config.headers = Object.fromEntries(Object.entries(def.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
  }
  if (typeof def.toolCallTimeoutMs === 'number') config.toolCallTimeoutMs = def.toolCallTimeoutMs
  return config
}

/** 写回 .mcp.json（保留顶层未知字段与其余 mcpServers，仅改目标 serverName）。 */
async function writeProjectJson(ctx: Ctx, workspacePath: string, data: Record<string, unknown>, mcpServers: Record<string, Record<string, unknown>>): Promise<void> {
  const fs = ctx.get('fs')
  if (!fs) throw new Error('缺少 fs 服务')
  const target = await fs.resolve(FILE_NAME, { cwd: workspacePath })
  const next = { ...data, mcpServers }
  await fs.writeText(target, JSON.stringify(next, null, 2) + '\n', void 0, void 0, fullPolicy(ctx))
}

/** 查重：目标 serverName 是否已被其他 loader entry（全局或他项目）占用。 */
function findConflict(ctx: Ctx, workspacePath: string, serverName: string): string | null {
  const ownId = projectEntryId(workspacePath, serverName)
  for (const entry of entriesOf(ctx)) {
    if (String(entry.id ?? entry.options?.id ?? '') === ownId) continue
    if (entry.options?.config?.serverName === serverName) {
      return 'serverName "' + serverName + '" 已被另一个 MCP 使用（全局或其他项目），请换一个名称'
    }
  }
  return null
}

/** 激活一个项目 MCP：校验 + 查重 + loader.create。 */
export async function activateProjectMcp(ctx: Ctx, workspacePath: string, config: MpcConfig): Promise<MpcServer> {
  validateConfig(config)
  const conflict = findConflict(ctx, workspacePath, config.serverName)
  if (conflict) throw new Error(conflict)
  const loader = ctx.get('loader')
  if (!loader) throw new Error('缺少 loader 服务')
  const id = projectEntryId(workspacePath, config.serverName)
  const existing = entriesOf(ctx).find((entry) => String(entry.id ?? entry.options?.id ?? '') === id)
  if (existing) {
    await loader.update(existing.id, { config: { ...config } })
    return serverOf(ctx, loader.resolve(existing.id))
  }
  const created = await loader.create({ id, name: '@deepseek-ai/dsh-mcp-client', config: { ...config } })
  const entry = entriesOf(ctx).find((candidate) => String(candidate.id ?? candidate.options?.id ?? '') === id)
  if (!entry) throw new Error('MCP 已创建但未能找到 entry（id=' + id + '）')
  return serverOf(ctx, entry)
}

/** 停用一个项目 MCP（按 entry id）。 */
export async function deactivateMcp(ctx: Ctx, entryId: string): Promise<void> {
  const loader = ctx.get('loader')
  if (!loader) throw new Error('缺少 loader 服务')
  const entry = entriesOf(ctx).find((candidate) => String(candidate.id ?? candidate.options?.id ?? '') === entryId)
  if (!entry) return
  await loader.remove(entry.id)
}

/** 以 .mcp.json 为真相 reconcile 该项目的激活状态（幂等）。 */
export async function reconcileProject(ctx: Ctx, workspacePath: string): Promise<void> {
  const data = await readProjectJson(ctx, workspacePath)
  const fileServers = new Set(Object.keys(serversOf(data)))
  const prefix = PROJECT_ENTRY_PREFIX + hashWorkspace(workspacePath) + '.'
  for (const entry of entriesOf(ctx)) {
    const id = String(entry.id ?? entry.options?.id ?? '')
    if (!id.startsWith(prefix)) continue
    const serverName = id.slice(prefix.length)
    if (fileServers.has(serverName)) continue
    await deactivateMcp(ctx, id)
  }
  for (const serverName of fileServers) {
    const config = await configOfServer(ctx, workspacePath, serverName)
    if (config === null) continue
    const id = projectEntryId(workspacePath, serverName)
    if (entriesOf(ctx).some((entry) => String(entry.id ?? entry.options?.id ?? '') === id)) continue
    await activateProjectMcp(ctx, workspacePath, { ...config, serverName })
  }
}

/** 把 .mcp.json 单条 server 定义归一化为 MpcConfig（缺传输必填 → null）。 */
async function configOfServer(ctx: Ctx, workspacePath: string, serverName: string): Promise<MpcConfig | null> {
  const data = await readProjectJson(ctx, workspacePath)
  return configFromDef(serversOf(data)[serverName], serverName)
}

/** 单个项目的完整视图（fileData + 激活状态合并）。 */
async function projectOf(ctx: Ctx, workspacePath: string, title: string): Promise<MpcProject> {
  const fs = ctx.get('fs')
  if (!fs) return { workspacePath, title, servers: [], source: 'project' }
  try {
    const target = await fs.resolve(workspacePath)
    const info = await fs.stat(target)
    if (!info || info.type !== 'directory') return { workspacePath, title, servers: [], source: 'project', missingDir: true }
  } catch (error) {
    return { workspacePath, title, servers: [], source: 'project', missingDir: true }
  }
  await reconcileProject(ctx, workspacePath)
  let servers: MpcServer[] = []
  let fileError: string | undefined
  try {
    const data = await readProjectJson(ctx, workspacePath)
    const prefix = PROJECT_ENTRY_PREFIX + hashWorkspace(workspacePath) + '.'
    servers = entriesOf(ctx).filter((entry) => String(entry.id ?? entry.options?.id ?? '').startsWith(prefix)).map((entry) => serverOf(ctx, entry))
    servers.sort((a, b) => (a.serverName < b.serverName ? -1 : 1))
  } catch (error) {
    fileError = String(error)
  }
  return { workspacePath, title, servers, source: 'project', fileError }
}

/** 列出全部项目及其项目级 MCP。 */
export async function listProjects(ctx: Ctx): Promise<{ projects: MpcProject[] }> {
  const registry = ctx.get('workspaceRegistry')
  const workspaces = registry?.list?.() ?? []
  const projects: MpcProject[] = []
  for (const ws of workspaces) projects.push(await projectOf(ctx, ws.path, ws.title ?? ''))
  return { projects }
}

/** 保存（新增/更新）一个项目 MCP：写 .mcp.json → 激活。 */
export async function projectSave(ctx: Ctx, workspacePath: string, serverName: string, config: MpcConfig): Promise<MpcProject> {
  const workspace = requireWorkspace(ctx, workspacePath)
  validateConfig({ ...config, serverName })
  const conflict = findConflict(ctx, workspacePath, serverName)
  if (conflict) throw new Error(conflict)
  const data = await readProjectJson(ctx, workspacePath)
  const servers = serversOf(data)
  const next = { ...config } as unknown as Record<string, unknown>
  delete next.serverName
  delete next.transport
  delete next.disabled // disabled 由 projectToggle 管理，保存恒为启用
  servers[serverName] = next
  await writeProjectJson(ctx, workspacePath, data, servers)
  await activateProjectMcp(ctx, workspacePath, { ...config, serverName })
  return projectOf(ctx, workspacePath, workspace.title ?? '')
}

/** 删除一个项目 MCP：停用 → 从 .mcp.json 移除。 */
export async function projectRemove(ctx: Ctx, workspacePath: string, serverName: string): Promise<MpcProject> {
  const workspace = requireWorkspace(ctx, workspacePath)
  await deactivateMcp(ctx, projectEntryId(workspacePath, serverName))
  const data = await readProjectJson(ctx, workspacePath)
  const servers = serversOf(data)
  delete servers[serverName]
  await writeProjectJson(ctx, workspacePath, data, servers)
  return projectOf(ctx, workspacePath, workspace.title ?? '')
}

/** 切换项目 MCP 启用状态（持久化到 .mcp.json + loader.update）。 */
export async function projectToggle(ctx: Ctx, workspacePath: string, serverName: string, enabled: boolean): Promise<MpcProject> {
  const workspace = requireWorkspace(ctx, workspacePath)
  const data = await readProjectJson(ctx, workspacePath)
  const servers = serversOf(data)
  const def = servers[serverName]
  if (!def) throw new Error('项目中不存在该 MCP')
  if (enabled) delete def.disabled
  else def.disabled = true
  await writeProjectJson(ctx, workspacePath, data, servers)
  const loader = ctx.get('loader')
  if (loader) {
    const entry = entriesOf(ctx).find((candidate) => String(candidate.id ?? candidate.options?.id ?? '') === projectEntryId(workspacePath, serverName))
    if (entry) await loader.update(entry.id, { disabled: !enabled })
  }
  return projectOf(ctx, workspacePath, workspace.title ?? '')
}

/** 刷新（重连）项目 MCP。 */
export async function projectRefresh(ctx: Ctx, workspacePath: string, serverName: string): Promise<MpcProject> {
  const workspace = requireWorkspace(ctx, workspacePath)
  const loader = ctx.get('loader')
  if (!loader) throw new Error('缺少 loader 服务')
  const id = projectEntryId(workspacePath, serverName)
  const entry = entriesOf(ctx).find((candidate) => String(candidate.id ?? candidate.options?.id ?? '') === id)
  if (!entry) throw new Error('该项目 MCP 未激活')
  await loader.update(entry.id, { config: { ...(entry.options?.config ?? {}) } })
  return projectOf(ctx, workspacePath, workspace.title ?? '')
}
