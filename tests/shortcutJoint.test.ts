import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { registerOfficialShortcuts } from '../src/client/shortcutsOfficial.js'
import { SHORTCUT_PROFILES } from '../src/shared/keybindings.js'

/**
 * Supply the official registry's snapshot-store dependency without changing its logic.
 * @author ddj 2026年09月28号
 * @param initial Initial snapshot.
 * @returns Stateful get/set/subscribe store.
 */
function makeStore(initial: unknown) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, set: (next: unknown) => { value = next; listeners.forEach((listener) => listener()) },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
}
const engineSource = readFileSync(new URL('./fixtures/official-shortcut-registry.txt', import.meta.url), 'utf8')
const workspaceSource = readFileSync(new URL('./fixtures/official-workspace-shortcuts.txt', import.meta.url), 'utf8')
const Registry = new Function('_deepseek_ai_dsh_client_store', engineSource + '; return ShortcutRegistry;')({ createSnapshotStore: makeStore })
const installWorkspace = new Function(workspaceSource + '; return installWorkspaceShortcuts;')()
const profiles = ['desktop:macos', 'desktop:windows', 'desktop:linux', 'web:macos', 'web:windows', 'web:linux']

/**
 * Register the actual official workspace defaults, including session.fork.
 * @author ddj 2026年09月28号
 * @param profile Current runtime/platform.
 * @returns Real official registry populated by the real official installer.
 */
function registryFor(profile: string) {
  const [runtime, platform] = profile.split(':')
  const registry = new Registry(runtime, platform)
  const ctx = { shortcuts: registry, effect: (install: () => void) => install(), locale: { bind: () => (key: string) => key } }
  installWorkspace(ctx, {}, {}, () => {})
  return registry
}

describe('actual official workspace and plugin joint registration', () => {
  it.each(profiles)('registers all plugin profiles beside official fork without fallback on %s', (profile) => {
    const registry = registryFor(profile)
    const register = vi.fn(registry.register.bind(registry))
    const definitions = Object.keys(SHORTCUT_PROFILES).map((id) => ({ id, label: id }))
    const dispose = registerOfficialShortcuts({ register } as any, definitions, { isAvailable: () => true, run: () => true }, SHORTCUT_PROFILES)
    expect(register).toHaveBeenCalledTimes(definitions.length)
    expect(registry.catalog.getSnapshot().every((row: any) => row.issue === null && row.conflicts.length === 0)).toBe(true)
    const search = registry.catalog.getSnapshot().find((row: any) => row.id === 'edrv.searchInFiles')
    const fork = registry.catalog.getSnapshot().find((row: any) => row.id === 'session.fork')
    const [runtime, platform] = profile.split(':')
    if (profile === 'web:linux') expect(search.binding).toBeNull()
    else {
      expect(search.binding.code).toBe('KeyF')
      const primary = platform === 'macos' ? 'meta' : 'control'
      expect(search.binding.modifiers).toContain(primary)
      expect(search.binding.modifiers).toContain('shift')
      expect(search.binding.modifiers.includes('alt')).toBe(runtime === 'web')
      expect(fork.binding).not.toEqual(search.binding)
    }
    dispose()
    expect(registry.catalog.getSnapshot().some((row: any) => row.id.startsWith('edrv.'))).toBe(false)
    expect(registry.catalog.getSnapshot().some((row: any) => row.id === 'session.fork')).toBe(true)
  })

  it('reproduces both original Web collisions using the real all-profile validator', () => {
    const registry = registryFor('desktop:windows')
    const original = structuredClone(SHORTCUT_PROFILES['edrv.searchInFiles'])
    original['web:macos'] = { code: 'KeyF', modifiers: ['primary', 'shift'] }
    original['web:windows'] = { code: 'KeyF', modifiers: ['primary', 'shift'] }
    const command = { id: 'edrv.searchInFiles', label: () => 'Search', aliases: [], regions: ['page'], modals: [], defaults: original, resolve: () => ({ status: 'pass' }) }
    expect(() => registry.register(command)).toThrow('web:macos')
    delete original['web:macos']
    expect(() => registry.register(command)).toThrow('web:windows')
  })
})
