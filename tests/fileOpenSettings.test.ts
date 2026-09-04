import { describe, expect, it, vi } from 'vitest'
import { FILE_OPEN_DEFAULT, FILE_OPEN_SETTINGS_NS, installOpenSettingsSection, normalizeFileOpenTool } from '../src/fileOpenSettings.js'
import { KEYBINDING_DEFAULTS } from '../src/shared/keybindings.js'

describe('file open settings', () => {
  it('normalizes empty and whitespace values to auto', () => {
    expect(normalizeFileOpenTool(undefined)).toBe('auto')
    expect(normalizeFileOpenTool('  ')).toBe('auto')
    expect(normalizeFileOpenTool('dsh-vscode-mode')).toBe('dsh-vscode-mode')
  })

  it('installs settings section with keybindings schema when deps are available', async () => {
    const install = vi.fn()
    const shapes: Array<Record<string, unknown>> = []
    const loader = async () => ({
      installSettingsSection: install,
      z: {
        object: (shape) => { shapes.push(shape); return { shape, default: (value) => value } },
        string: () => ({ default: (value) => value }),
        number: () => ({ default: (value) => value }),
      },
    })
    const hooks = { setSource: vi.fn(), onChange: vi.fn() }
    const ok = await installOpenSettingsSection({}, FILE_OPEN_SETTINGS_NS, { fileOpenTool: 'auto' }, hooks, loader)
    expect(ok).toBe(true)
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0][1]).toBe(FILE_OPEN_SETTINGS_NS)
    // shapes[0] = keybindings 显式键形状（每命令一项），shapes[1] = 外层 shape
    expect(shapes[0]).toEqual({ ...KEYBINDING_DEFAULTS })
    expect(shapes[1].fileOpenTool).toBe('auto')
    expect(shapes[1].keybindings).toEqual({ ...KEYBINDING_DEFAULTS })
    expect(shapes[1].sidebarMinWidth).toBe(300)
  })

  it('degrades gracefully when deps are missing', async () => {
    const install = vi.fn()
    const loader = async () => null
    const ok = await installOpenSettingsSection({}, FILE_OPEN_SETTINGS_NS, { fileOpenTool: FILE_OPEN_DEFAULT }, { setSource: () => {}, onChange: () => {} }, loader)
    expect(ok).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })
})
