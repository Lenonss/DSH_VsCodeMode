/** Capability-gated Forge navigation. @author ddj 2026年11月04号 */
import { describe, it, expect, vi } from 'vitest'
import { forgeBridge } from '../src/client/forgeBridge.js'

describe('Forge navigation', () => {
  it('does not expose missing capability', () => {
    expect(forgeBridge({ get: () => undefined }, () => 's').available()).toBe(false)
  })
  it('encodes local session navigation without inventing repository paths', () => {
    const service = { openTab: vi.fn(), openResource: vi.fn() }
    const bridge = forgeBridge({ get: (key) => key === 'sidebarRightTabs' ? { get: () => ({}) } : service }, () => 's /1')
    expect(bridge.open('s /1', true)).toBe(true)
    expect(service.openResource).toHaveBeenCalledWith('dsh-resource://forge-changes/s%20%2F1/local', { kind: 'forge-changes' })
    expect(bridge.open('other')).toBe(false)
    expect(service.openTab).not.toHaveBeenCalled()
    expect(bridge.open('s /1')).toBe(true)
    expect(service.openTab).toHaveBeenCalledWith('forge-panel')
  })
})
