import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { bindCatalogChords, migrateLegacyKeybindings, resetPluginKeys } from '../src/client/shortcutsOfficial.js'
import type { ShortcutCatalogRow, ShortcutEditLike, ShortcutsServiceLike } from '../src/client/shortcutsOfficial.js'
import { applyOfficialChords, ariaOf, chordOf } from '../src/client/keybindings.js'
import { bindingToChord } from '../src/shared/keybindings.js'
import type { OfficialBinding } from '../src/shared/keybindings.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/shortcut-catalog.json', import.meta.url), 'utf8'))
const profiles = Object.keys(fixture.profiles)
afterEach(() => { vi.unstubAllGlobals(); applyOfficialChords({}) })

/**
 * Create revision-aware stateful preferences over a captured real official catalog.
 * @author ddj 2026年09月28号
 * @param profile Runtime/platform captured from official 0.1.7-rc.2.
 * @returns Mutable service and catalog used to exercise full transactions.
 */
function statefulService(profile: string) {
  let rows: ShortcutCatalogRow[] = structuredClone(fixture.profiles[profile])
  let revision = 1
  const defaults = structuredClone(rows)
  const listeners = new Set<() => void>()
  const [runtime, platform] = profile.split(':')
  /** @author ddj 2026年09月28号 Notify catalog subscribers after durable mock edits. */
  const publish = (): void => { revision++; listeners.forEach((listener) => listener()) }
  /**
   * Apply a revision-checked operation and preserve unrelated rows.
   * @author ddj 2026年09月28号
   * @param edit Official edit operation.
   * @param expected Draft revision.
   * @returns Official-style edit result.
   */
  const edit = async (edit: ShortcutEditLike, expected: string) => {
    if (expected !== String(revision)) return { status: 'stale' }
    if (edit.type === 'reset-all') throw new Error('Global reset forbidden')
    const index = rows.findIndex((row) => row.id === edit.id)
    if (index < 0) return { status: 'not-ready' }
    if (edit.type === 'reset') rows[index] = structuredClone(defaults.find((row) => row.id === edit.id)!)
    else rows[index] = { ...rows[index], modified: true, binding: edit.binding, keys: [bindingToChord(edit.binding)!] }
    publish()
    return { status: 'saved' }
  }
  const service: ShortcutsServiceLike = {
    runtime, platform, register: () => () => {}, recording: async () => {}, edit: vi.fn(edit),
    describeBinding: (binding) => ({ binding, keys: [], issue: null, conflicts: [] }),
    catalog: { getSnapshot: () => rows, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    config: { getSnapshot: () => ({ revision: String(revision), sequence: revision, status: 'ready', error: null, usingDefaults: false }), subscribe: () => () => {} },
    fixedCatalog: { getSnapshot: () => [], subscribe: () => () => {} },
  }
  return { service, rows, publish }
}

/**
 * Install origin-local storage that survives repeated migration calls.
 * @author ddj 2026年09月28号
 * @returns Persisted marker entries.
 */
function localMarkers() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  return values
}

describe('real normalized official catalog', () => {
  it.each(profiles)('uses official keys and aria for %s, with no bare-key modifier loss', (profile) => {
    const { service, rows } = statefulService(profile)
    const off = bindCatalogChords(service, applyOfficialChords)
    for (const row of rows) {
      expect(chordOf(row.id)).toBe(row.binding && !row.issue ? row.keys.join(' ') : null)
      expect(ariaOf(row.id)).toBe(row.binding && !row.issue ? row.aria : undefined)
      expect(row.binding?.modifiers ?? []).not.toContain('primary')
      if (row.binding?.modifiers.includes('control')) expect(bindingToChord(row.binding)).toContain('Ctrl+')
      if (row.binding?.modifiers.includes('meta')) expect(bindingToChord(row.binding)).toContain('Meta+')
    }
    off()
  })

  it('reacts to normalized modifications and omits ARIA for secondCode', () => {
    const { service, rows, publish } = statefulService('desktop:macos')
    const off = bindCatalogChords(service, applyOfficialChords)
    const save = rows.find((row) => row.id === 'edrv.save')!
    Object.assign(save, { binding: { code: 'KeyD', secondCode: 'KeyS', modifiers: ['control', 'meta'] }, keys: ['⌃', '⌘', 'D', 'S'], aria: undefined, modified: true })
    publish()
    expect(chordOf('edrv.save')).toBe('⌃ ⌘ D S')
    expect(ariaOf('edrv.save')).toBeUndefined()
    off()
    save.keys = ['changed after dispose']; publish()
    expect(chordOf('edrv.save')).toBe('⌃ ⌘ D S')
  })
})

describe('stateful reset and migration', () => {
  it.each(profiles)('preserves official custom values and all legacy preferences in %s', async (profile) => {
    localMarkers()
    const { service, rows } = statefulService(profile)
    const save = rows.find((row) => row.id === 'edrv.save')!
    const official = { code: 'KeyM', modifiers: ['control', 'alt'] } as OfficialBinding
    save.binding = official; save.modified = true
    const legacy = { 'edrv.save': 'Ctrl+Alt+S', 'edrv.quickOpen': 'Ctrl+Home', 'edrv.searchInFiles': '', 'edrv.navigateBack': 'Ctrl+J|Ctrl+K' }
    const snapshot = { status: 'ready', value: { keybindings: legacy } }
    const scope = { getSnapshot: () => snapshot }
    expect(await migrateLegacyKeybindings(service, scope)).toEqual({ imported: 0, skipped: 4, done: true })
    expect(save.binding).toEqual(official)
    expect(snapshot.value.keybindings).toBe(legacy)
    expect(service.edit).not.toHaveBeenCalled()
  })

  it('resets edrv overrides across successive revisions and preserves other products', async () => {
    const { service, rows } = statefulService('desktop:windows')
    rows.find((row) => row.id === 'edrv.save')!.modified = true
    rows.find((row) => row.id === 'edrv.quickOpen')!.modified = true
    const other: ShortcutCatalogRow = { id: 'sidebar.left.toggle', label: 'Sidebar', modified: true, binding: { code: 'KeyQ', modifiers: ['alt'] }, issue: null, conflicts: [], keys: ['Alt', '+', 'Q'] }
    rows.push(other)
    expect(await resetPluginKeys(service)).toEqual({ reset: 2 })
    expect(rows.find((row) => row.id === 'edrv.save')!.modified).toBe(false)
    expect(rows.find((row) => row.id === 'sidebar.left.toggle')).toEqual(other)
    expect(vi.mocked(service.edit).mock.calls.map(([, revision]) => revision)).toEqual(['1', '2'])
  })

  it('migration then reset then reload does not resurrect the old override', async () => {
    localMarkers()
    const { service, rows } = statefulService('desktop:windows')
    const scope = { getSnapshot: () => ({ status: 'ready', value: { keybindings: { 'edrv.save': 'Ctrl+Alt+S' } } }) }
    expect((await migrateLegacyKeybindings(service, scope)).imported).toBe(1)
    expect(rows.find((row) => row.id === 'edrv.save')!.modified).toBe(true)
    expect(await resetPluginKeys(service)).toEqual({ reset: 1 })
    const reloaded = statefulService('desktop:windows').service
    expect((await migrateLegacyKeybindings(reloaded, scope)).imported).toBe(0)
    expect(reloaded.edit).not.toHaveBeenCalled()
    expect(scope.getSnapshot().value.keybindings['edrv.save']).toBe('Ctrl+Alt+S')
  })
})
