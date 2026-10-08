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
import { checkMcpName } from './mcpProject.js'
import { runtimeOf } from './mcpRuntime.js'

/**
 * Compare the official tool-name namespaces without guessing the longest prefix.
 * @public @author ddj 2026年10月08号
 * @param left First server name.
 * @param right Second server name.
 * @returns Whether distinct names generate overlapping public tool names.
 */
export function nameOverlap(left: string, right: string): boolean {
  return left !== right && (left.startsWith(right + '__') || right.startsWith(left + '__'))
}

/**
 * Collect known global and project namespaces without opening connections.
 * @public @author ddj 2026年10月08号
 * @param ctx Host context.
 * @returns Distinct server names used for fail-closed attribution.
 */
export function mcpNames(ctx: Ctx): Set<string> {
  const names = new Set(runtimeOf(ctx).owners().keys())
  for (const entry of entriesOf(ctx)) {
    const name = entry.options?.config?.serverName
    if (typeof name === 'string') names.add(name)
  }
  return names
}

const edits = new WeakMap<object, Promise<unknown>>()

/**
 * Serialize profile/project edits together to preserve files and cross-scope name reservations.
 * @public @author ddj 2026年10月08号
 * @param ctx Host owner.
 * @param action Validated configuration operation.
 * @returns Operation result; a rejection never poisons the next edit.
 */
export function mcpEdit<T>(ctx: Ctx, action: () => Promise<T>): Promise<T> {
  const owner = ctx.root ?? ctx
  const next = (edits.get(owner) ?? Promise.resolve()).then(action, action)
  edits.set(owner, next)
  return next
}

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

/**
 * Read tool summaries from the caller's exact visible scope.
 * @public @author ddj 2026年09月28号
 * @param ctx Host tools service.
 * @param serverName Server namespace.
 * @param agent Optional agent scope; omitted for global entries.
 * @returns Scoped tool summaries, allowing resource-only servers to have zero tools.
 */
export function toolsOf(ctx: Ctx, serverName: string, agent?: any): MpcTool[] {
  const tools = ctx.get('tools')
  const view = tools?.view?.(agent)
  const visible = view?.visible
  if (!(visible instanceof Map)) return []
  const prefix = `mcp__${serverName}__`
  const namespaces = mcpNames(ctx)
  namespaces.add(serverName)
  const belongs = (name: string) => name.startsWith(prefix)
    && [...namespaces].filter((server) => name.startsWith('mcp__' + server + '__')).length === 1
  return [...visible.entries()].filter(([name]) => belongs(String(name))).map(([name, definition]) => ({
    name: String(name).slice(prefix.length),
    description: typeof definition?.description === 'string' ? definition.description : undefined,
  }))
}

/**
 * Restore unchanged masked values without inventing credentials for new keys.
 * @public @author ddj 2026年09月28号
 * @param next Submitted configuration, including editable unknown fields.
 * @param previous Last persisted configuration.
 * @returns Detached configuration with unchanged secrets restored; throws for an orphan mask.
 */
export function mergeSecrets(next: Record<string, unknown>, previous: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...next }
  for (const field of ['env', 'headers']) {
    const values = next[field]
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue
    const old = previous[field] as Record<string, unknown> | undefined
    const restored: Record<string, unknown> = Object.create(null)
    for (const [key, value] of Object.entries(values)) {
      if (value !== '••••••') { restored[key] = value; continue }
      if (!old || !Object.hasOwn(old, key)) throw new Error('脱敏凭据没有原值，请重新填写：' + key)
      restored[key] = old[key]
    }
    merged[field] = restored
  }
  return merged
}

/**
 * Merge editable transport fields while retaining advanced settings and secret values.
 * @public @author ddj 2026年10月08号
 * @param previous Last saved configuration.
 * @param config Submitted transport configuration.
 * @returns Detached configuration without fields belonging to the old transport.
 */
export function mergeMcp(previous: Record<string, unknown>, config: MpcConfig): Record<string, unknown> {
  const next = mergeSecrets({ ...previous, ...config }, previous)
  const stale = config.transport === 'stdio' ? ['url', 'headers'] : ['command', 'args', 'cwd', 'env']
  for (const key of stale) delete next[key]
  return next
}

/**
 * Summarize a global entry without treating plugin activation as a successful handshake.
 * @public @author ddj 2026年09月28号
 * @param ctx Host services.
 * @param entry Global loader entry.
 * @returns Masked status and globally visible tools.
 */
export function serverOf(ctx: Ctx, entry: any): MpcServer {
  const config = (entry.options?.config ?? {}) as Record<string, unknown>
  const serverName = typeof config.serverName === 'string' ? config.serverName : entry.options?.id ?? 'unknown'
  const tools = toolsOf(ctx, serverName)
  const state = entry.fiber?.state
  return {
    id: String(entry.id ?? entry.options?.id ?? serverName),
    serverName,
    enabled: entry.disabled !== true && entry.options?.disabled !== true,
    transport: config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
    config: publicConfig(config),
    status: entry.disabled === true || entry.options?.disabled === true ? 'disabled'
      : state === 2 ? 'unverified' : state === 1 || state === 0 ? 'connecting' : state === 3 ? 'error' : 'configured',
    instanceCount: entry.fiber ? 1 : 0,
    toolCount: tools.length,
    tools,
    error: state === 3 ? 'MCP 插件未正常运行' : undefined,
  }
}

/**
 * Validate transport fields before any loader or source mutation.
 * @public @author ddj 2026年10月08号
 * @param config Submitted configuration.
 * @throws Error for unsupported transport or malformed endpoint/arguments/maps.
 */
export function validateConfig(config: MpcConfig): void {
  if (!config || typeof config !== 'object') throw new Error('MCP 配置必须是对象')
  if (typeof config.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(config.serverName)) throw new Error('serverName 只能包含字母、数字、下划线和连字符（最多 32 位）')
  if (!['stdio', 'streamable-http'].includes(config.transport)) throw new Error('不支持的 MCP transport')
  if (config.transport === 'stdio') {
    if (typeof config.command !== 'string' || !config.command.trim()) throw new Error('stdio MCP 必须填写 command')
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))) throw new Error('MCP args 必须是字符串数组')
    if (config.cwd !== undefined && typeof config.cwd !== 'string') throw new Error('MCP cwd 必须是字符串')
    validatePairs(config.env, 'env')
  } else {
    let url: URL
    try { url = new URL(config.url ?? '') } catch { throw new Error('HTTP MCP 必须填写有效 http(s) URL') }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('HTTP MCP 必须填写有效 http(s) URL，凭据请使用请求头')
    validatePairs(config.headers, 'headers')
  }
}

/**
 * Validate an optional string-valued map without coercing malformed input.
 * @private @author ddj 2026年10月08号
 * @param values Submitted map.
 * @param field Field used in the diagnostic.
 * @throws Error for non-object or non-string values.
 */
function validatePairs(values: unknown, field: string): void {
  if (values === undefined) return
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || Object.entries(values).some(([key, value]) => !key || typeof value !== 'string')) throw new Error('MCP ' + field + ' 必须是字符串字典')
}

/** 列出全局（profile）MCP 服务，过滤掉新旧格式的项目级条目。 */
export function listMcp(ctx: Ctx): { servers: MpcServer[] } {
  return { servers: entriesOf(ctx).filter((entry) => !isProjectEntryId(String(entry.id ?? entry.options?.id ?? ''))).map((entry) => serverOf(ctx, entry)) }
}

/**
 * Save a global loader entry while preserving advanced options and unchanged secrets.
 * @public @author ddj 2026年09月28号
 * @param ctx Host loader context.
 * @param config Submitted global configuration.
 * @returns Masked server status; project name collisions reject before writing.
 */
export async function saveMcp(ctx: Ctx, config: MpcConfig): Promise<MpcServer> {
  return mcpEdit(ctx, () => saveGlobal(ctx, config))
}

/** @private @author ddj 2026年10月08号 @param ctx Host services. @param config Configuration. @returns Saved status; validation failures do not write. */
async function saveGlobal(ctx: Ctx, config: MpcConfig): Promise<MpcServer> {
  validateConfig(config)
  await checkMcpName(ctx, config.serverName)
  const loader = ctx.get('loader')
  if (!loader) throw new Error('缺少 loader 服务')
  const existing = entriesOf(ctx).find((entry) => !isProjectEntryId(String(entry.id ?? entry.options?.id ?? '')) && entry.options?.config?.serverName === config.serverName)
  const previous = existing?.options?.config ?? {}
  const next = mergeMcp(previous, config)
  if (existing) {
    await loader.update(existing.id, { config: next })
    return serverOf(ctx, loader.resolve(existing.id))
  }
  const id = await loader.create({ name: MCP_PACKAGE, config: next })
  return serverOf(ctx, loader.resolve(id))
}

/** @private @author ddj 2026年10月08号 @param ctx Host services. @param id Global identity. @returns Loader and verified global entry. @throws Missing service, entry or wrong scope. */
function globalEntry(ctx: Ctx, id: string): { loader: any; entry: any } {
  const loader = ctx.get('loader')
  if (!loader) throw new Error('缺少 loader 服务')
  const entry = entriesOf(ctx).find((candidate) => String(candidate.id) === id)
  if (!entry) throw new Error('MCP 服务不存在')
  if (isProjectEntryId(String(entry.id ?? entry.options?.id ?? ''))) throw new Error('项目 MCP 必须通过项目入口操作')
  return { loader, entry }
}

/** @public @author ddj 2026年10月08号 @param ctx Host services. @param id Global identity. @returns Persisted removal, serialized with all settings writes. */
export async function removeMcp(ctx: Ctx, id: string): Promise<void> {
  /** @private @author ddj 2026年10月08号 @returns Loader removal after scope validation. */
  const remove = async () => {
    const { loader, entry } = globalEntry(ctx, id)
    await loader.remove(entry.id)
  }
  return mcpEdit(ctx, remove)
}

/** @public @author ddj 2026年10月08号 @param ctx Host services. @param id Global identity. @param enabled Desired state. @returns Persisted status after serialized toggle. */
export async function toggleMcp(ctx: Ctx, id: string, enabled: boolean): Promise<MpcServer> {
  /** @private @author ddj 2026年10月08号 @returns Loader status after toggle. */
  const toggle = async () => {
    const { loader, entry } = globalEntry(ctx, id)
    await loader.update(entry.id, { disabled: !enabled })
    return serverOf(ctx, loader.resolve(entry.id))
  }
  return mcpEdit(ctx, toggle)
}

/** @public @author ddj 2026年10月08号 @param ctx Host services. @param id Global identity. @returns Loader status after serialized refresh. */
export async function refreshMcp(ctx: Ctx, id: string): Promise<MpcServer> {
  /** @private @author ddj 2026年10月08号 @returns Loader status after refresh. */
  const refresh = async () => {
    const { loader, entry } = globalEntry(ctx, id)
    await loader.update(entry.id, { config: { ...(entry.options?.config ?? {}) } })
    return serverOf(ctx, loader.resolve(entry.id))
  }
  return mcpEdit(ctx, refresh)
}

export type { MpcConfig, MpcServer }
export const mcpPackageName = MCP_PACKAGE
