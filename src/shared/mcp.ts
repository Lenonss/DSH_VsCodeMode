/** dsh-vscode-mode MCP 管理共享数据契约。作者 ddj 2026年08月22号 */

export type MpcTransport = 'stdio' | 'streamable-http'
export type MpcStatus = 'connected' | 'connecting' | 'error' | 'disabled'

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
  workspacePath: string
  serverName: string
  config: MpcConfig
}
