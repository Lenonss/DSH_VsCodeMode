import type { MpcServer } from './mcp.js'

type ServerStatus = Pick<MpcServer, 'enabled' | 'status'>
export type McpTone = 'connected' | 'connecting' | 'disabled' | 'error' | 'neutral'

/**
 * @public
 * @author ddj 2026年10月08号
 * @description Display lifecycle evidence; enabled only expresses configuration intent, not connectivity.
 * @param server Server lifecycle snapshot.
 * @returns User-facing status label.
 */
export function statusOf(server: ServerStatus): string {
  if (!server.enabled || server.status === 'disabled') return '已禁用'
  const labels = { connected: '在线', connecting: '装配中', configured: '已配置，等待会话', unverified: '已加载，连接未确认', error: '错误' }
  return labels[server.status] ?? '状态未知'
}

/**
 * @public
 * @author ddj 2026年10月08号
 * @description Use neutral styling unless lifecycle evidence explicitly identifies online, loading or error.
 * @param server Server lifecycle snapshot.
 * @returns CSS tone, independent of configuration-enabled state.
 */
export function statusTone(server: ServerStatus): McpTone {
  if (!server.enabled || server.status === 'disabled') return 'disabled'
  if (server.status === 'connected' || server.status === 'connecting' || server.status === 'error') return server.status
  return 'neutral'
}
