/** Extension registration lifecycle and notification isolation. @author ddj 2026年10月22号 */
import { describe, expect, it, vi } from 'vitest'
import { createSidebarPanelRegistry } from '../src/client/sidebar/registry.js'
import type { SidebarPanelDef } from '../src/client/sidebar/types.js'

/** @private @author ddj 2026年10月22号 @param id Panel identity. @returns Minimal extension definition. */
function panel(id: string): SidebarPanelDef { return { id, title: id, icon: '', render: () => null } }

describe('sidebar extension registry', () => {
  it('preserves replacement, stale disposal and re-registration behavior', () => {
    const registry = createSidebarPanelRegistry()
    const first = panel('acme.panel'), second = panel('acme.panel')
    const removeFirst = registry.register(first)
    const removeSecond = registry.register(second)
    removeFirst(); expect(registry.get(first.id)).toBe(second)
    removeSecond(); expect(registry.list()).toEqual([])
    const removeAgain = registry.register(first)
    expect(registry.get(first.id)).toBe(first)
    removeAgain(); removeAgain(); expect(registry.list()).toEqual([])
  })
  it('isolates failed subscribers during both register and dispose', () => {
    const registry = createSidebarPanelRegistry(), healthy = vi.fn()
    registry.subscribe(() => { throw new Error('bad extension') })
    const unsubscribe = registry.subscribe(healthy)
    const dispose = registry.register(panel('legacy-short-id'))
    dispose(); expect(healthy).toHaveBeenCalledTimes(2)
    unsubscribe(); registry.register(panel('acme.next'))
    expect(healthy).toHaveBeenCalledTimes(2)
  })
  it('uses a bounded notification snapshot under reentrant subscription', () => {
    const registry = createSidebarPanelRegistry(), later = vi.fn()
    registry.subscribe(() => { registry.subscribe(later) })
    registry.register(panel('a')); expect(later).not.toHaveBeenCalled()
    registry.register(panel('b')); expect(later).toHaveBeenCalledTimes(1)
  })
  it('retains validation and ordered listing', () => {
    const registry = createSidebarPanelRegistry()
    expect(() => registry.register({ ...panel('a'), render: undefined } as any)).toThrow(TypeError)
    registry.register({ ...panel('later'), order: 20 }); registry.register({ ...panel('first'), order: 10 })
    expect(registry.list().map((entry) => entry.id)).toEqual(['first', 'later'])
  })
})
