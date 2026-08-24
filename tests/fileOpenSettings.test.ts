import { describe, expect, it, vi } from 'vitest'
import { FILE_OPEN_DEFAULT, FILE_OPEN_SETTINGS_NS, installOpenSettingsSection, normalizeFileOpenTool } from '../src/fileOpenSettings.js'

describe('file open settings', () => {
  it('normalizes empty and whitespace values to auto', () => {
    expect(normalizeFileOpenTool(undefined)).toBe('auto')
    expect(normalizeFileOpenTool('  ')).toBe('auto')
    expect(normalizeFileOpenTool('dsh-vscode-mode')).toBe('dsh-vscode-mode')
  })

  it('installs settings section when deps are available', async () => {
    const install = vi.fn()
    const loader = async () => ({
      installSettingsSection: install,
      z: { object: (shape) => ({ shape }), string: () => ({ default: (value) => value }) },
    })
    const hooks = { setSource: vi.fn(), onChange: vi.fn() }
    const ok = await installOpenSettingsSection({}, FILE_OPEN_SETTINGS_NS, { fileOpenTool: 'auto' }, hooks, loader)
    expect(ok).toBe(true)
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0][1]).toBe(FILE_OPEN_SETTINGS_NS)
  })

  it('degrades gracefully when deps are missing', async () => {
    const install = vi.fn()
    const loader = async () => null
    const ok = await installOpenSettingsSection({}, FILE_OPEN_SETTINGS_NS, { fileOpenTool: FILE_OPEN_DEFAULT }, { setSource: () => {}, onChange: () => {} }, loader)
    expect(ok).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })
})
