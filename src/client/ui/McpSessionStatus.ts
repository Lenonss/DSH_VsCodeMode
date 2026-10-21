/** Official session-row slots; no DOM patching or session activation. @author ddj 2026年10月20号 */
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { McpPhase } from '../../shared/mcp.js'
import { McpSessionState, type SessionMcpView } from '../mcpSessionState.js'

const labels: Record<McpPhase, string> = {
  idle: '待使用，尚未启动', preparing: '读取项目配置', queued: '等待 MCP 启动名额', loading: '加载 MCP 插件模块',
  starting: '等待 MCP 插件启动', stopping: '释放旧 MCP 实例', ready: '初始化完成，连接健康未验证',
  error: '初始化异常', none: '无需加载项目 MCP',
}
const busy = new Set<McpPhase>(['preparing', 'queued', 'loading', 'starting', 'stopping'])
export interface McpRowProps { sessionId: string; store: McpSessionState }

/** @private @author ddj 2026年10月20号 @param props Root row identity and shared poller. @returns Stable per-session observation. */
function useMcpView({ sessionId, store }: McpRowProps): SessionMcpView {
  const subscribe = useCallback((notify: () => void) => store.subscribe(sessionId, notify), [store, sessionId])
  const snapshot = useCallback(() => store.get(sessionId), [store, sessionId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** @public @author ddj 2026年10月20号 @param view Current observation. @returns Accessible row label; steady states deliberately do not occupy the leading slot. */
export function mcpRowLabel(view: SessionMcpView): string | undefined {
  if (view.stale) return '项目 MCP 状态暂不可用（上次状态已过期）'
  if (!view.status || (!busy.has(view.status.phase) && view.status.phase !== 'error')) return undefined
  return '项目 MCP：' + labels[view.status.phase]
}

/** @public @author ddj 2026年10月20号 @param props Official row sessionId and poller. @returns 16px loading/error marker; official running/approval states retain precedence. */
export function McpSessionIcon(props: McpRowProps): React.ReactElement | null {
  const view = useMcpView(props)
  const label = mcpRowLabel(view)
  if (!label) return null
  const warning = view.stale || view.status?.phase === 'error'
  return React.createElement('span', {
    role: 'img', 'aria-label': label, title: label,
    style: { display: 'inline-flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center',
      color: warning ? 'var(--color-warning, #b7791f)' : 'var(--color-text-secondary, currentColor)', fontSize: 13 },
  }, warning ? '⚠' : '◌')
}

/** @private @author ddj 2026年10月20号 @param start Stage start. @param end Stage finish or local clock. @returns Human-readable elapsed time, without claiming a timeout. */
function elapsed(start: number, end: number): string { return Math.max(0, (end - start) / 1000).toFixed(1) + ' 秒' }

/** @public @author ddj 2026年10月20号 @param props Official hover sessionId and poller. @returns Project-only diagnostic detail, never transport credentials. */
export function McpSessionDetail(props: McpRowProps): React.ReactElement {
  const view = useMcpView(props)
  const [now, setNow] = useState(Date.now)
  const status = view.status
  useEffect(() => {
    if (!status || view.stale || !busy.has(status.phase)) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [status, view.stale])

  const children: React.ReactNode[] = [React.createElement('strong', { key: 'title' }, '项目 MCP')]
  if (view.stale) children.push(React.createElement('div', { key: 'stale', role: 'status' }, '状态暂不可用；以下如有记录，为上次观测结果'))
  if (!status) children.push(React.createElement('div', { key: 'empty' }, view.stale ? '等待状态查询' : '当前无活跃 MCP 实例'))
  else {
    const end = status.finishedAt ?? now
    const completed = status.servers.filter((server) => server.phase === 'ready').length
    const slow = !view.stale && busy.has(status.phase) && now - status.phaseAt > 10000
    children.push(React.createElement('div', { key: 'phase' }, labels[status.phase], slow ? '（耗时较长，不代表失败）' : ''))
    children.push(React.createElement('div', { key: 'time' }, `${completed}/${status.servers.length} 已初始化 · 总耗时 ${elapsed(status.startedAt, end)} · 当前阶段 ${elapsed(status.phaseAt, end)}`))
    if (status.configMs !== undefined) children.push(React.createElement('div', { key: 'config' }, `配置准备 ${elapsed(0, status.configMs)}`))
    if (status.error) children.push(React.createElement('div', { key: 'error' }, status.error))
    for (const server of status.servers) children.push(React.createElement('div', { key: 'server:' + server.serverName },
      `${server.serverName}：${labels[server.phase]}${server.reused ? ' · 复用已有连接' : ''}${server.phase === 'idle' ? '' : ' · ' + elapsed(server.startedAt, server.finishedAt ?? now)}`,
      server.queuedMs === undefined ? '' : ' · 排队 ' + elapsed(0, server.queuedMs),
      server.connectMs === undefined ? '' : ' · 初始化 ' + elapsed(0, server.connectMs),
      server.firstCallMs === undefined ? '' : ' · 首次工具执行 ' + elapsed(0, server.firstCallMs),
      server.error ? ' · ' + server.error : ''))
  }
  children.push(React.createElement('small', { key: 'scope' }, '仅 VSCodeMode 管理的项目 MCP；不含全局或 preset MCP。'))
  return React.createElement('section', { 'aria-label': '项目 MCP 状态', style: { display: 'grid', gap: 4, maxWidth: 320, overflowWrap: 'anywhere', fontSize: 12 } }, children)
}
