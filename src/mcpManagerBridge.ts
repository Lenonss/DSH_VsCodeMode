/**
 * dsh-vscode-mode host — 官方 MCP 框架（ctx.mcpManager, DSH 0.2.3+）适配桥。
 * 职责：能力探测、插件配置 → 官方条目映射、官方视图 → 插件视图映射、凭据键派生、
 *       以及授权/重启/探测等控制命令的安全委派。
 * 约束：不 import @deepseek-ai/*（形状用最小 interface 描述）；服务缺失时全部安全空转，
 *       由调用方回落到旧的 loader 条目路径。
 * 作者 ddj 2026年11月23号
 */
import { createHash } from 'node:crypto'
import type { MpcConfig, MpcTransport } from './shared/mcp.js'

/** 按需加载策略（官方条目字段）。 */
export type ToolLoading = 'eager' | 'on-demand'

/** 传给 ctx.mcpManager.register 的条目；transport 相关字段只留一侧。 */
export interface ManagerEntry {
  transport: MpcTransport
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url: string
  headers: Record<string, string>
  oauth?: { credentialKey: string }
  toolLoading: ToolLoading
  startupTimeoutMs: number
}

/** 管理界面读取的视图。 */
export interface ManagerView {
  name: string
  configured: boolean
  state: string
  error?: string
  phase?: string
  /** 官方报告的真连上时刻（epoch 毫秒，仅 connected 状态有）。 */
  connectedAt?: number
}

/** 官方 manager 的最小能力面；服务缺失即 available() === false。 */
export interface ManagerPort {
  available: () => boolean
  register: (name: string, entry: ManagerEntry) => () => void
  list: () => ManagerView[]
  /** 订阅官方状态流；服务端不支持或宿主停用时静默结束。 */
  watch: (signal: AbortSignal) => AsyncIterable<ManagerView[]>
  restart: (name: string) => Promise<void>
  probe: (name: string) => Promise<unknown>
  authorize: (name: string) => Promise<unknown>
  cancelAuthorize: (name: string, id: string) => Promise<void>
  signOut: (name: string) => Promise<void>
}

/** 宿主上下文的最小面（避免与 store 的 Ctx 循环）。 */
interface HostLike { get: (name: string) => unknown }

/** 官方视图里本模块读到的字段。 */
interface RawView {
  name?: unknown
  configured?: unknown
  status?: { state?: unknown; reason?: unknown; lastError?: unknown; connectedAt?: unknown; result?: { message?: unknown } }
  authorization?: { phase?: unknown }
}

const UNAVAILABLE = 'mcpManager 不可用'

/**
 * 从服务器名稳定派生 OAuth 凭据键：同名服务器每次得到同一地址，凭据本身不落插件。
 * 官方格式是 `<scope>/<id>`，且 scope 必须是 mcp-client，否则 register 当场抛错。
 * @public @author ddj 2026年11月23号
 * @param serverName 服务器名
 * @returns `mcp-client/` 加 `vsm-` 与 8 位哈希
 */
export function credentialKeyOf(serverName: string): string {
  const digest = createHash('sha1').update(String(serverName)).digest('hex').slice(0, 8)
  return 'mcp-client/vsm-' + digest
}

/**
 * 把插件配置映射成官方条目：stdio 清空 HTTP 字段，HTTP 清空进程字段。
 * @public @author ddj 2026年11月23号
 * @param config 插件保存的服务器配置
 * @param serverName 服务器名（用于派生凭据键）
 * @param toolLoading 按需加载策略
 * @returns 可直接交给 ctx.mcpManager.register 的条目
 */
export function toManagerEntry(config: MpcConfig, serverName: string, toolLoading: ToolLoading = 'eager'): ManagerEntry {
  const transport: MpcTransport = config.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const entry: ManagerEntry = {
    transport,
    command: '',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    toolLoading,
    startupTimeoutMs: startupTimeoutOf(config),
  }
  if (transport === 'stdio') {
    entry.command = typeof config.command === 'string' ? config.command : ''
    entry.args = Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : []
    entry.env = pairsOf(config.env)
    entry.cwd = typeof config.cwd === 'string' ? config.cwd : ''
  } else {
    entry.url = typeof config.url === 'string' ? config.url : ''
    entry.headers = pairsOf(config.headers)
  }
  const oauth = oauthOf(config)
  // 官方只允许 streamable-http 配 OAuth：stdio 上带 oauth 会被 register 拒绝，这里直接不登记。
  if (oauth && transport === 'streamable-http') entry.oauth = { credentialKey: credentialKeyOf(serverName) }
  return entry
}

/**
 * 取条目的启动预算：显式策略优先，缺省官方默认 30000。
 * @private @author ddj 2026年11月23号
 * @param config 插件保存的服务器配置
 * @returns 启动超时毫秒
 */
function startupTimeoutOf(config: MpcConfig): number {
  const policy = (config as { vscodeMode?: { startupTimeoutMs?: unknown } }).vscodeMode
  const value = policy?.startupTimeoutMs
  return typeof value === 'number' && Number.isInteger(value) && value >= 1000 ? value : 30000
}

/**
 * 是否需要 OAuth：配置里显式声明了 oauth 才登记凭据键。
 * @private @author ddj 2026年11月23号
 * @param config 插件保存的服务器配置
 * @returns 是否登记 OAuth
 */
function oauthOf(config: MpcConfig): boolean {
  const oauth = (config as { oauth?: unknown }).oauth
  return Boolean(oauth) && typeof oauth === 'object'
}

/**
 * 只保留字符串值对，丢弃非法输入。
 * @private @author ddj 2026年11月23号
 * @param values 原始字典
 * @returns 干净的字符串字典
 */
function pairsOf(values: unknown): Record<string, string> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * 官方视图映射成插件视图；未知形状不抛错。
 * @public @author ddj 2026年11月23号
 * @param raw ctx.mcpManager.list() 的一项
 * @returns 插件视图
 */
export function toView(raw: unknown): ManagerView {
  const view = (raw && typeof raw === 'object' ? raw : {}) as RawView
  const name = typeof view.name === 'string' ? view.name : ''
  const status = view.status ?? {}
  const reason = typeof status.reason === 'string' ? status.reason : ''
  const message = typeof status.lastError === 'string' ? status.lastError : closureMessageOf(status.result)
  const state = typeof status.state === 'string' && status.state ? status.state : reason === 'load' ? 'failed' : 'unknown'
  const phase = typeof view.authorization?.phase === 'string' ? view.authorization.phase : undefined
  const result: ManagerView = { name, configured: view.configured === true, state }
  if (message) result.error = message
  if (phase) result.phase = phase
  // 只有真连上才带这个时刻，会话卡片据此算本服务器的真实初始化耗时。
  if (typeof status.connectedAt === 'number') result.connectedAt = status.connectedAt
  return result
}

/**
 * 清理失败时官方只给结构化结果，取其中第一条可读信息。
 * @private @author ddj 2026年11月23号
 * @param result 官方清理结果
 * @returns 可读文案或空串
 */
function closureMessageOf(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const message = (result as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

/**
 * 探测并包装 ctx.mcpManager；旧版没有该服务时所有方法安全空转。
 * @public @author ddj 2026年11月23号
 * @param ctx 宿主上下文
 * @returns manager 端口
 */
export function managerPort(ctx: HostLike): ManagerPort {
  const service = serviceOf(ctx)
  if (!service) return unavailablePort()
  const manager = service as Record<string, unknown>
  return {
    available: () => true,
    register: (name, entry) => {
      const dispose = manager.register as (key: string, value: ManagerEntry) => () => void
      return dispose.call(manager, name, entry)
    },
    list: () => (Array.isArray((manager.list as () => unknown[])?.call(manager))
      ? ((manager.list as () => unknown[]).call(manager)).map(toView)
      : []),
    watch: (signal) => watchOf(manager, signal),
    restart: (name) => call(manager, 'restart', name) as Promise<void>,
    probe: (name) => call(manager, 'probe', name),
    authorize: (name) => call(manager, 'startAuthorization', name),
    cancelAuthorize: (name, id) => call(manager, 'cancelAuthorization', name, id) as Promise<void>,
    signOut: (name) => call(manager, 'signOut', name) as Promise<void>,
  }
}

/**
 * 把官方状态流逐帧映射成插件视图；官方没有 watch 时给出空流。
 * @private @author ddj 2026年11月23号
 * @param manager 官方 manager 服务
 * @param signal 订阅生命周期
 * @returns 映射后的视图流
 */
async function* watchOf(manager: Record<string, unknown>, signal: AbortSignal): AsyncIterable<ManagerView[]> {
  const watch = manager.watch
  if (typeof watch !== 'function') return
  const stream = (watch as (this: unknown, token: AbortSignal) => AsyncIterable<unknown[]>).call(manager, signal)
  for await (const views of stream) yield Array.isArray(views) ? views.map(toView) : []
}

/**
 * 无 manager 时的空状态流：立刻结束，调用方按“没有更新”处理。
 * @private @author ddj 2026年11月23号
 * @returns 空流
 */
async function* noViews(): AsyncIterable<ManagerView[]> {
  return
}

/**
 * 读取 manager 服务；缺失或取值抛错返回 undefined。
 * @private @author ddj 2026年11月23号
 * @param ctx 宿主上下文
 * @returns manager 服务或 undefined
 */
function serviceOf(ctx: HostLike): object | undefined {
  let service: unknown
  try { service = ctx.get('mcpManager') } catch { service = undefined }
  if (!service || typeof service !== 'object') return undefined
  return typeof (service as { register?: unknown }).register === 'function' ? service : undefined
}

/**
 * 调用一个 manager 方法；方法缺失时抛出明确的不可用错误。
 * @private @author ddj 2026年11月23号
 * @param manager manager 服务
 * @param name 方法名
 * @param args 调用参数
 * @returns 方法返回值
 */
function call(manager: Record<string, unknown>, name: string, ...args: unknown[]): Promise<unknown> {
  const method = manager[name]
  if (typeof method !== 'function') return Promise.reject(new Error(UNAVAILABLE + '（缺少 ' + name + '）'))
  try {
    return Promise.resolve(method.apply(manager, args))
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * 无 manager 时的端口：读为空、写明确失败。
 * @private @author ddj 2026年11月23号
 * @returns 空转端口
 */
function unavailablePort(): ManagerPort {
  /** @private @author ddj 2026年11月23号 @returns 不可用错误 */
  const fail = (): Promise<never> => Promise.reject(new Error(UNAVAILABLE))
  return {
    available: () => false,
    register: () => { throw new Error(UNAVAILABLE) },
    list: () => [],
    watch: () => noViews(),
    restart: fail,
    probe: fail,
    authorize: fail,
    cancelAuthorize: fail,
    signOut: fail,
  }
}

/**
 * 按名称找 manager 视图。
 * @public @author ddj 2026年11月23号
 * @param views manager 视图
 * @param name 服务器名
 * @returns 命中的视图或 undefined
 */
export function viewOf(views: readonly ManagerView[], name: string): ManagerView | undefined {
  return views.find((view) => view.name === name)
}
