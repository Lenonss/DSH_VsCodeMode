import { describe, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-settings', () => ({ settingsNamespace: (value: string) => value, installSettingsSection: vi.fn() }))
vi.mock('schemastery', () => ({ default: { object: (value: unknown) => value, string: () => ({ default: (value: unknown) => value }) } }))
import { normalizeFileOpenTool } from '../src/fileOpenSettings.js'

describe('file open settings', () => {
  it('normalizes empty and whitespace values to auto', () => {
    expect(normalizeFileOpenTool(undefined)).toBe('auto')
    expect(normalizeFileOpenTool('  ')).toBe('auto')
    expect(normalizeFileOpenTool('dsh-vscode-mode')).toBe('dsh-vscode-mode')
  })
})
