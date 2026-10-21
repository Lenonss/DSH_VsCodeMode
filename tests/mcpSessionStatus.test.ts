/** Row and hover contract regressions. @author ddj 2026年10月20号 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { McpSessionState, type SessionMcpView } from '../src/client/mcpSessionState.js'
import { McpSessionDetail, McpSessionIcon, mcpRowLabel } from '../src/client/ui/McpSessionStatus.js'

/** @private @author ddj 2026年10月20号 @param view Controlled observation. @returns Read-only render fixture; rendering must never query or activate a session. */
function viewStore(view: SessionMcpView): McpSessionState {
  const store = new McpSessionState(async () => { throw new Error('render must not fetch') })
  store.get = () => view
  return store
}

describe('session MCP row presentation', () => {
  it('renders a 16px accessible loading marker and only observed stages', () => {
    const store = viewStore({ stale: false, status: { sessionId: 'A', phase: 'starting', startedAt: Date.now() - 12000,
      phaseAt: Date.now() - 11000, servers: [{ serverName: '<codegraph>', phase: 'starting', startedAt: Date.now() - 11000, phaseAt: Date.now() - 11000 }] } })
    const props = { sessionId: 'A', store }
    const icon = renderToStaticMarkup(React.createElement(McpSessionIcon, props))
    expect(icon).toContain('width:16px')
    expect(icon).toContain('aria-label="项目 MCP：等待 MCP 插件启动"')
    const detail = renderToStaticMarkup(React.createElement(McpSessionDetail, props))
    expect(detail).toContain('耗时较长，不代表失败')
    expect(detail).toContain('&lt;codegraph&gt;')
    expect(detail).toContain('0/1')
    expect(detail).toContain('不含全局或 preset MCP')
    expect(detail).not.toContain('握手成功')
  })

  it('keeps steady state quiet and describes absent agents honestly', () => {
    expect(mcpRowLabel({ stale: false })).toBeUndefined()
    for (const phase of ['idle', 'ready', 'none'] as const) expect(mcpRowLabel({ stale: false,
      status: { sessionId: 'A', phase, startedAt: 1, phaseAt: 2, servers: [] } })).toBeUndefined()
    const detail = renderToStaticMarkup(React.createElement(McpSessionDetail, { sessionId: 'old', store: viewStore({ stale: false }) }))
    expect(detail).toContain('当前无活跃 MCP 实例')
    expect(detail).not.toContain('初始化完成')
  })

  it('shows idle without an endless timer and reports reuse and segmented timing', () => {
    const status: NonNullable<SessionMcpView['status']> = { sessionId: 'A', phase: 'idle', startedAt: 100, phaseAt: 100, finishedAt: 200, configMs: 100,
      servers: [{ serverName: 'cold', phase: 'idle', startedAt: 200, phaseAt: 200 }, { serverName: 'warm', phase: 'ready', reused: true, startedAt: 300, phaseAt: 300, finishedAt: 300, queuedMs: 0, connectMs: 0, firstCallMs: 12 }] }
    const detail = renderToStaticMarkup(React.createElement(McpSessionDetail, { sessionId: 'A', store: viewStore({ stale: false, status }) }))
    expect(detail).toContain('cold：待使用，尚未启动')
    expect(detail).toContain('复用已有连接')
    expect(detail).toContain('配置准备 0.1 秒')
    expect(detail).toContain('首次工具执行')
    expect(detail).not.toContain('耗时较长')
  })

  it('marks stale observations and errors without claiming connection health', () => {
    expect(mcpRowLabel({ stale: true })).toContain('已过期')
    const store = viewStore({ stale: true, status: { sessionId: 'A', phase: 'ready', startedAt: 1, phaseAt: 2, finishedAt: 3, servers: [] } })
    const detail = renderToStaticMarkup(React.createElement(McpSessionDetail, { sessionId: 'A', store }))
    expect(detail).toContain('上次观测结果')
    expect(detail).toContain('连接健康未验证')
    expect(mcpRowLabel({ stale: false, status: { sessionId: 'A', phase: 'error', startedAt: 1, phaseAt: 2, servers: [] } })).toContain('初始化异常')
  })
})
