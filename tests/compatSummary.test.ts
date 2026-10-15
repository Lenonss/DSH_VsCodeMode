import { describe, expect, it } from 'vitest'
import { clientSummary, type ClientCompatState } from '../src/client/compatSummary.js'
import { SIDEBAR_PLUGIN } from '../src/client/compat.js'

const modern: ClientCompatState = {
  settingsService: 'configForms', settingsReady: true,
  openPathReady: false, remoteReady: true, sidebarOpener: false,
  legacySidebar: false, officialSidebar: true, fileClaim: true,
  claimWanted: true, selected: 'auto',
}

/**
 * Produce a minimal capability fixture and read only the visible names.
 * @private @author ddj 2026年10月13号
 * @param version Running DSH version.
 * @param patch Overrides for the modern capability fixture.
 * @returns Visible diagnostic names.
 */
function namesOf(version: string, patch: Partial<ClientCompatState> = {}): string[] {
  return clientSummary({ ...modern, ...patch }, version).map((item) => item.name)
}

const openPath = '文件打开路由（workspaces.openPath）'
const remote = '会话文件链接路由（remote.session.openWorkspacePath）'
const official = '侧边栏编辑区（官方 Sidebar）'
const legacy = '侧边栏编辑区（' + SIDEBAR_PLUGIN + '，归档）'
const opener = '侧边栏打开器（' + SIDEBAR_PLUGIN + '）'
const claim = '文件链接官方认领（dsh-resource://file）'
const missing: Partial<ClientCompatState> = { remoteReady: false, officialSidebar: false, fileClaim: false }

describe('applicable client compatibility diagnostics', () => {
  it.each(['0.1.5-alpha.1', '0.1.7-alpha.2', '0.2.0-rc.2', '0.2.0', '1.0.0', 'v0.2.0-rc.2+build.1'])('hides replaced legacy warnings on %s', (version) => {
    expect(namesOf(version)).toEqual(['设置桥', remote, official, claim])
  })

  it('keeps the old routing and sidebar diagnostics on old DSH', () => {
    expect(namesOf('0.1.2', missing)).toEqual(['设置桥', openPath, opener, legacy])
  })

  it.each(['0.1.3-alpha.1', '0.1.3-rc.1', '0.1.3', '0.1.4'])('expects the remote route but not official sidebar on %s', (version) => {
    const names = namesOf(version, missing)
    expect(names).toContain(remote)
    expect(names).not.toContain(openPath)
    expect(names).not.toContain(official)
    expect(names).not.toContain(claim)
  })

  it.each(['0.1.3-0', '0.1.3-alpha.0'])('does not assume alpha.1 APIs before their boundary on %s', (version) => {
    const names = namesOf(version, missing)
    expect(names).toContain(openPath)
    expect(names).not.toContain(remote)
  })

  it.each(['0.1.5-alpha.1', '0.2.0-rc.2', '2.0.0'])('does not hide expected missing capabilities on %s', (version) => {
    const items = clientSummary({ ...modern, ...missing }, version)
    expect(items.filter((item) => !item.active).map((item) => item.name)).toEqual([remote, official, claim])
  })

  it('shows a missing explicitly selected legacy opener even with official sidebar', () => {
    const items = clientSummary({ ...modern, selected: SIDEBAR_PLUGIN, fileClaim: false, claimWanted: false }, '0.2.0-rc.2')
    expect(items.find((item) => item.name === opener)?.active).toBe(false)
    expect(items.some((item) => item.name === claim || item.name === legacy)).toBe(false)
  })

  it('keeps a registered legacy opener as useful capability information', () => {
    expect(namesOf('0.2.0', { sidebarOpener: true })).toContain(opener)
    expect(namesOf('0.2.0', { legacySidebar: true })).not.toContain(legacy)
  })

  it('does not warn about a deliberately disabled official claim', () => {
    expect(namesOf('0.2.0', { selected: 'system', claimWanted: false, fileClaim: false })).not.toContain(claim)
  })

  it.each(['', 'unknown', '0.2', '0.2.0-'])('retains conservative diagnostics with missing capabilities and unknown version %s', (version) => {
    expect(namesOf(version, missing)).toEqual(['设置桥', openPath, remote, opener, official, legacy, claim])
  })

  it('uses actual replacement capabilities even when the version is unknown', () => {
    expect(namesOf('')).toEqual(['设置桥', remote, official, claim])
  })

  it('does not hide detected capabilities merely because the version says old', () => {
    expect(namesOf('0.1.2')).toEqual(['设置桥', remote, official, claim])
  })

  it('always exposes settings failure and leaves inputs unchanged', () => {
    const state = { ...modern, settingsReady: false }
    const before = { ...state }
    expect(clientSummary(state, '0.2.0')[0].active).toBe(false)
    expect(state).toEqual(before)
  })
})
