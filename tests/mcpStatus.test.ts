import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { statusOf, statusTone } from '../src/shared/mcpStatus.js'

describe('MCP lifecycle display', () => {
  it.each(['configured', 'unverified'])('%s is neutral, not an error or online', (status) => {
    const server = { enabled: true, status } as any
    expect(statusTone(server)).toBe('neutral')
    expect(statusOf(server)).not.toBe('在线')
  })
  it.each([['connected', 'connected'], ['connecting', 'connecting'], ['error', 'error'], ['disabled', 'disabled'], ['unknown', 'neutral']])('maps %s explicitly to %s', (status, tone) => {
    expect(statusTone({ enabled: true, status } as any)).toBe(tone)
  })
  it('disabled wins over a stale connection status', () => {
    expect(statusOf({ enabled: false, status: 'connected' } as any)).toBe('已禁用')
    expect(statusTone({ enabled: false, status: 'error' } as any)).toBe('disabled')
  })
  it('enabled is configuration intent, not proof of an online connection', () => {
    expect(statusOf({ enabled: true, status: 'connected' } as any)).toBe('在线')
    expect(statusOf({ enabled: true, status: 'unverified' } as any)).toContain('未确认')
  })
  it('uses a neutral CSS default and reserves error styling for error', () => {
    const css = readFileSync(new URL('../src/client/styles/mcp.css', import.meta.url), 'utf8')
    expect(css.match(/\.vsm-mcp-dot\{[^}]+\}/)?.[0]).not.toContain('state-error')
    expect(css).toMatch(/\.vsm-mcp-dot\.error\{[^}]*state-error/)
    expect(css).toContain('.vsm-mcp-dot.neutral')
    expect(css).not.toMatch(/\.vsm-switch\.on\{[^}]*state-success/)
  })
})
