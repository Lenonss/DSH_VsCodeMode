/** dsh-vscode-mode MCP 管理共享数据契约。作者 ddj 2026年08月22号 */

export type MpcTransport = 'stdio' | 'streamable-http'
/** Project initialization only; ready does not establish transport health. */
export type McpPhase = 'preparing' | 'idle' | 'queued' | 'loading' | 'starting' | 'stopping' | 'ready' | 'error' | 'none'

export interface McpPolicy {
  startup: 'on-demand' | 'background'
  sharing: 'agent' | 'workspace'
  startupTimeoutMs: number
}

/** @public @author ddj 2026年10月20号 @param input Project-only policy. @returns Validated defaults. @throws Invalid explicit policy. */
export function parseMcpPolicy(input?: unknown): McpPolicy {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('vscodeMode 必须是对象')
  const policy = (input ?? {}) as Partial<McpPolicy>
  const startup = policy.startup ?? 'on-demand'
  const sharing = policy.sharing ?? 'agent'
  const startupTimeoutMs = policy.startupTimeoutMs ?? 60000
  if (!['on-demand', 'background'].includes(startup)) throw new Error('不支持的 MCP startup')
  if (!['agent', 'workspace'].includes(sharing)) throw new Error('不支持的 MCP sharing')
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > 300000) throw new Error('MCP startupTimeoutMs 必须为 1000–300000 的整数')
  return { startup, sharing, startupTimeoutMs }
}
export interface McpSessionServer {
  queuedMs?: number
  connectMs?: number
  firstCallMs?: number
  reused?: boolean
  serverName: string
  phase: McpPhase
  startedAt: number
  phaseAt: number
  finishedAt?: number
  error?: string
}
export interface McpSessionStatus {
  configMs?: number
  sessionId: string
  phase: McpPhase
  startedAt: number
  phaseAt: number
  finishedAt?: number
  error?: string
  servers: McpSessionServer[]
}

export type MpcStatus = 'connected' | 'connecting' | 'error' | 'disabled' | 'configured' | 'unverified'

export interface MpcTool {
  name: string
  description?: string
}

export interface MpcConfig {
  serverName: string
  transport: MpcTransport
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  maxInstructionBytes?: number
  failOnStartupError?: boolean
  reconnect?: Record<string, unknown>
}

export interface MpcServer {
  id: string
  serverName: string
  enabled: boolean
  transport: MpcTransport
  config: MpcConfig
  status: MpcStatus
  /** Mounted official plugin fibers, not verified live connections. */
  instanceCount?: number
  sessionCount?: number
  policy?: McpPolicy
  toolCount: number
  tools: MpcTool[]
  error?: string
}

/** 项目级 MCP：绑定到一个 workspace 路径，配置存于该项目根 .mcp.json。 */
export interface MpcProject {
  workspacePath: string
  title: string
  servers: MpcServer[]
  source: 'project'
  missingDir?: boolean
  /** .mcp.json 解析失败时携带错误文案（不覆盖文件）。 */
  fileError?: string
}

/** 项目级 MCP 保存入参：config 为该 serverName 的传输配置（不含归属信息）。 */
export interface MpcProjectSaveInput {
  policy?: McpPolicy
  workspacePath: string
  serverName: string
  config: MpcConfig
}
