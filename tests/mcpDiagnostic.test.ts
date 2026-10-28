/** MCP diagnostics redact credentials before durable logging. @author ddj 2026年10月28号 */
import { describe, expect, it } from 'vitest'
import { mcpErrorText } from '../src/mcpDiagnostic.js'

const config = { serverName: 'test', transport: 'stdio' as const, command: 'codegraph' }

describe('MCP failure diagnostics', () => {
  it('preserves actionable errors and bounded nested causes', () => {
    const cause = Object.assign(new Error('spawn codegraph ENOENT'), { code: 'ENOENT' })
    const error = new Error('MCP initialization failed', { cause })
    expect(mcpErrorText(error, config)).toBe('Error: MCP initialization failed <- Error: spawn codegraph ENOENT [ENOENT]')
  })

  it('removes explicit environment/header secrets, URLs and credential fields', () => {
    const error = new Error('env-secret header-secret argument-secret https://user:pass@example.com/mcp?token=hidden token=inline-secret\npassword=pwd')
    const text = mcpErrorText(error, { ...config, args: ['--key', 'argument-secret'], env: { API_KEY: 'env-secret' }, headers: { Authorization: 'header-secret' } })
    expect(text).not.toMatch(/env-secret|header-secret|argument-secret|example.com|hidden|inline-secret|pwd|\n/)
    expect(text).toContain('[REDACTED]')
  })

  it('bounds cycles and oversized failures without serializing unknown objects', () => {
    const error = new Error('x'.repeat(5000))
    error.cause = error
    expect(mcpErrorText(error, config)).toHaveLength(2048)
    expect(mcpErrorText({ token: 'never-log' }, config)).toBe('Unknown MCP failure')
  })
})
