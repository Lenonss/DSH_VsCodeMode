import { describe, expect, it, vi } from 'vitest'
import { createFileOpenerRegistry, selectOpener, officialSidebarOpener, shouldClaimFiles, OFFICIAL_OPEN_TOOL } from '../src/client/fileOpeners.js'
import { installOpenPathRouter } from '../src/client/openPathRouter.js'

describe('file opener registry', () => {
  it('sorts available openers and falls back from unavailable selection', () => {
    const registry = createFileOpenerRegistry()
    registry.register({ id: 'system', label: 'System', priority: 0, open: vi.fn() })
    registry.register({ id: 'editor', label: 'Editor', priority: 10, isAvailable: () => false, open: vi.fn() })
    expect(selectOpener(registry, 'editor')?.id).toBe('system')
  })

  it('removes an opener with its disposer', () => {
    const registry = createFileOpenerRegistry()
    const dispose = registry.register({ id: 'x', label: 'X', open: vi.fn() })
    expect(registry.get('x')).toBeDefined()
    dispose()
    expect(registry.get('x')).toBeUndefined()
  })
})

describe('open path router', () => {
  it('routes to selected opener and restores the original method', async () => {
    const original = vi.fn(async () => {})
    const selected = vi.fn(async () => {})
    const workspaces = { openPath: original }
    const registry = createFileOpenerRegistry()
    registry.register({ id: 'selected', label: 'Selected', open: selected })
    const dispose = installOpenPathRouter({
      workspaces,
      registry,
      selected: () => 'selected',
      context: () => ({ sessionId: 's1' }),
    })
    await workspaces.openPath('a.ts')
    expect(selected).toHaveBeenCalledWith('a.ts', { sessionId: 's1' })
    dispose()
    expect(workspaces.openPath).toBe(original)
  })
})

describe('official sidebar opener', () => {
  it('opens via openResource with a session address for relative paths', () => {
    const openResource = vi.fn()
    const opener = officialSidebarOpener({ openResource })
    expect(opener.id).toBe(OFFICIAL_OPEN_TOOL)
    opener.open!('src/a b.ts', { sessionId: 's1' })
    expect(openResource).toHaveBeenCalledWith('dsh-resource://file/session/s1/src/a%20b.ts')
  })
  it('opens via openResource with an absolute address for absolute paths', () => {
    const openResource = vi.fn()
    const opener = officialSidebarOpener({ openResource })
    opener.open!('C:\\repo\\x.ts', { sessionId: 's1' })
    expect(openResource).toHaveBeenCalledWith('dsh-resource://file/absolute/C:/repo/x.ts')
  })
  it('throws for relative path without session (routing falls back)', () => {
    const opener = officialSidebarOpener({ openResource: vi.fn() })
    expect(() => opener.open!('src/a.ts', {})).toThrow()
  })
})

describe('shouldClaimFiles', () => {
  it('claims only for auto and vscode-mode selections', () => {
    expect(shouldClaimFiles('auto')).toBe(true)
    expect(shouldClaimFiles('dsh-vscode-mode')).toBe(true)
    expect(shouldClaimFiles(OFFICIAL_OPEN_TOOL)).toBe(false)
    expect(shouldClaimFiles('system')).toBe(false)
    expect(shouldClaimFiles(undefined)).toBe(false)
  })
})
