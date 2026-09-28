import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindPanelCommand, panelAvailable, runPanelCommand, setPanelRoute } from '../src/client/panelCommands.js'
import { createCommandBridge } from '../src/client/commandBridge.js'
import { officialCommandOf } from '../src/client/shortcutsOfficial.js'

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).reverse().forEach((off) => off())
  delete (globalThis as any).__edrvPanelCommand__
  vi.restoreAllMocks()
})

/**
 * Install a stateful session route for first-open and scope-switch tests.
 * @author ddj 2026年09月28号
 * @returns Mutable scope and route callbacks.
 */
function setup() {
  const state = { sessionId: 'session-a', cwd: '/workspace/a' }
  const open = vi.fn(() => true)
  const canOpen = vi.fn(() => true)
  cleanup.push(setPanelRoute({ readScope: () => ({ ...state }), canOpen, open }))
  return { state, open, canOpen }
}

describe('scoped panel delivery', () => {
  it.each(['quickOpen', 'searchInFiles'] as const)('opens %s before editor mount and delivers exactly once', (action) => {
    const { open } = setup()
    expect(panelAvailable(action)).toBe(true)
    expect(runPanelCommand(action)).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    const wrong = vi.fn()
    cleanup.push(bindPanelCommand(action, { sessionId: 'other' }, wrong))
    expect(wrong).not.toHaveBeenCalled()
    const receive = vi.fn()
    cleanup.push(bindPanelCommand(action, { sessionId: 'session-a' }, receive))
    expect(receive).toHaveBeenCalledOnce()
    cleanup.push(bindPanelCommand(action, { sessionId: 'session-a' }, vi.fn()))
    expect(receive).toHaveBeenCalledOnce()
  })

  it('direct delivery targets only the current session without reopening', () => {
    const { open } = setup()
    const first = vi.fn(), other = vi.fn()
    cleanup.push(bindPanelCommand('quickOpen', { sessionId: 'session-a' }, first))
    cleanup.push(bindPanelCommand('quickOpen', { sessionId: 'session-b' }, other))
    runPanelCommand('quickOpen')
    expect(first).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['sessionId', 'cwd'] as const)('drops pending intent after %s changes', (field) => {
    const { state } = setup()
    runPanelCommand('searchInFiles')
    state[field] = 'different'
    const receive = vi.fn()
    cleanup.push(bindPanelCommand('searchInFiles', { ...state }, receive))
    expect(receive).not.toHaveBeenCalled()
    expect((globalThis as any).__edrvPanelCommand__).toBeUndefined()
  })

  it('preserves pending request across module reload, then consumes once', async () => {
    setup()
    runPanelCommand('quickOpen')
    vi.resetModules()
    const next = await import('../src/client/panelCommands.js')
    cleanup.push(next.setPanelRoute({ readScope: () => ({ sessionId: 'session-a' }), canOpen: () => true, open: () => true }))
    const receive = vi.fn()
    cleanup.push(next.bindPanelCommand('quickOpen', { sessionId: 'session-a' }, receive))
    expect(receive).toHaveBeenCalledOnce()
    expect((globalThis as any).__edrvPanelCommand__).toBeUndefined()
  })

  it('expires a pending command before an unrelated later mount', () => {
    setup()
    runPanelCommand('quickOpen')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000)
    const receive = vi.fn()
    cleanup.push(bindPanelCommand('quickOpen', { sessionId: 'session-a' }, receive))
    expect(receive).not.toHaveBeenCalled()
  })

  it('returns pass for absent scope or genuinely unavailable route', () => {
    const { canOpen, state } = setup()
    canOpen.mockReturnValue(false)
    const bridge = createCommandBridge()
    cleanup.push(bridge.dispose)
    const command = officialCommandOf({ id: 'edrv.quickOpen', label: 'Open' }, bridge.registry)
    expect(command.resolve({ region: 'page', modal: null })).toEqual({ status: 'pass' })
    state.sessionId = ''
    canOpen.mockReturnValue(true)
    expect(panelAvailable('quickOpen')).toBe(false)
  })

  it('clears failed sidebar opening and does not replay on later mount', () => {
    const { open } = setup()
    open.mockReturnValue(false)
    expect(runPanelCommand('quickOpen')).toBe(false)
    expect((globalThis as any).__edrvPanelCommand__).toBeUndefined()
  })

  it('stages before a synchronous sidebar mount and consumes only once', () => {
    const { open } = setup()
    const receive = vi.fn()
    open.mockImplementation(() => {
      cleanup.push(bindPanelCommand('quickOpen', { sessionId: 'session-a' }, receive))
      return true
    })
    runPanelCommand('quickOpen')
    expect(receive).toHaveBeenCalledOnce()
    expect((globalThis as any).__edrvPanelCommand__).toBeUndefined()
  })
})
