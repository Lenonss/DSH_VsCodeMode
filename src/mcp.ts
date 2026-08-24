/**
 * dsh-vscode-mode host — MCP 运行时管理适配层。
 * 只操作已装配的 @deepseek-ai/dsh-mcp-client loader entry，不在浏览器侧连接 MCP。
 * 身份常量（包名/条目前缀/新旧格式判定）统一由 compat 层持有，本模块再导出保持既有 import 面。
 * 作者 ddj 2026年08月22号
 */
import {
  LEGACY_PROJECT_PREFIX,
  MCP_PACKAGE,
  PROJECT_ENTRY_PREFIX,
  isProjectEntryId,
} from './compat.js'
import type { MpcConfig, MpcServer, MpcTool } from './shared/mcp.js'
import type { Ctx } from './store.js'

export { LEGACY_PROJECT_PREFIX, MCP_PACKAGE, PROJECT_ENTRY_PREFIX, isProjectEntryId }

/** 列出当前 loader 中的 MCP entry。 */
function entriesOf(ctx: Ctx): any[] {
  const loader = ctx.get('loader')
  if (!loader || typeof loader.entries !== 'function') return []
  return [...loader.entries()].filter((entry) => entry?.options?.name === MCP_PACKAGE)
}
export { entriesOf }

/** 脱敏配置并保留可编辑字段的存在性。 */
export function publicConfig(config: Record<string, unknown>): MpcConfig {
  const out = { ...config } as Record<string, unknown>
  if (out.env && typeof out.env === 'object') out.env = Object.fromEntries(Object.keys(out.env as object).map((key) => [key, '••••••']))
  if (out.headers && typeof out.headers === 'object') out.headers = Object.fromEntries(Object.keys(out.headers as object).map((key) => [key, '••••••']))
  return out as unknown as MpcConfig
}

/** 从工具注册表读取服务器命名空间下的工具摘要。 */
export function toolsOf(ctx: Ctx, serverName: string): MpcTool[] {
  const tools = ctx.get('tools')
  const view = tools?.view?.(void 0)
  const visible = view?.visible
  if (!(visible instanceof Map)) return []
  const prefix = `mcp__${serverName}__`
  return [...visible.entries()].filter(([name]) => String(name).startsWith(prefix)).map(([name, definition]) => ({
    name: String(name).slice(prefix.length),
    description: typeof definition?.description === 'string' ? definition.description : undefined,
  }))
}

/** 将 loader entry 映射为设置页摘要。 */
export function serverOf(ctx: Ctx, entry: any): MpcServer {
  const config = (entry.options?.config ?? {}) as Record<string, unknown>
  const serverName = typeof config.serverName === 'string' ? config.serverName : entry.options?.id ?? 'unknown'
  const tools = toolsOf(ctx, serverName)
  const state = entry.fiber?.state
  return {
    id: String(entry.id ?? entry.options?.id ?? serverName),
    serverName,
    enabled: entry.disabled !== true,
    transport: config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    config: publicConfig(config),
    status: state === 2 ? 'connected' : state === 1 ? 'connecting' : 'error',
    toolCount: tools.length,
    tools,
    error: state === 3 ? 'MCP 插件未正常运行' : undefined,
  }
}

/** 校验 MCP 配置。 */
export function validateConfig(config: MpcConfig): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.serverName)) throw new Error('serverName 只能包含字母、数字、下划线和连字符（最多 32 位）')
  if (config.transport === 'stdio' && !config.command?.trim()) throw new Error('stdio MCP 必须填写 command')
  if (config.transport === 'streamable-http' && !/^https?:\/\//.test(config.url ?? '')) throw new Error('HTTP MCP 必须填写 http(s) URL')
}

/** 列出全局（profile）MCP 服务，过滤掉新旧格式的项目级条目。 */
export function listMcp(ctx: Ctx): { servers: MpcServer[] } {
  return { servers: entriesOf(ctx).filter((entry) => !isProjectEntryId(String(entry.id ?? entry.options?.id ?? ''))).map((entry) => serverOf(ctx, entry)) }
}

/** 保存 MCP 服务配置并触发 loader 热更新。 */
export async function saveMcp(ctx: Ctx, config: MpcConfig): Promise<MpcServer> {
  validateConfig(config)
  const loader = ctx.get('loader')
  if (!loader) throw new Error('缺少 loader 服务')
  const existing = entriesOf(ctx).find((entry) => !isProjectEntryId(String(entry.id ?? entry.options?.id ?? '')) && entry.options?.config?.serverName === config.serverName)
  if (existing) {
    await loader.update(existing.id, { config: { ...config } })
    return serverOf(ctx, loader.resolve(existing.id))
  }
  const id = await loader.create({ name: MCP_PACKAGE, config: { ...config } })
  return serverOf(ctx, loader.resolve(id))
}

/** 删除 MCP 服务。 */
export async function removeMcp(ctx: Ctx, id: string): Promise<void> {
  const loader = ctx.get('loader')
  if (!loader) throw new Error('缺少 loader 服务')
  const entry = entriesOf(ctx).find((candidate) => String(candidate.id) === id)
  if (!entry) throw new Error('MCP 服务不存在')
  await loader.remove(entry.id)
}

/** 切换 MCP 服务启用状态。 */
export async function toggleMcp(ctx: Ctx, id: string, enabled: boolean): Promise<MpcServer> {
  const loader = ctx.get('loader')
  if (!loader) throw new Error('缺少 loader 服务')
  const entry = entriesOf(ctx).find((candidate) => String(candidate.id) === id)
  if (!entry) throw new Error('MCP 服务不存在')
  await loader.update(entry.id, { disabled: !enabled })
  return serverOf(ctx, loader.resolve(entry.id))
}

/** 重新加载 MCP 服务。 */
export async function refreshMcp(ctx: Ctx, id: string): Promise<MpcServer> {
  const loader = ctx.get('loader')
  if (!loader) throw new Error('缺少 loader 服务')
  const entry = entriesOf(ctx).find((candidate) => String(candidate.id) === id)
  if (!entry) throw new Error('MCP 服务不存在')
  await loader.update(entry.id, { config: { ...(entry.options?.config ?? {}) } })
  return serverOf(ctx, loader.resolve(entry.id))
}

export type { MpcConfig, MpcServer }
export const mcpPackageName = MCP_PACKAGE
