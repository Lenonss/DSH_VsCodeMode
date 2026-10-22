/** Lazy module cache and mounted component ownership. @author ddj 2026年10月22号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
const hooks = vi.hoisted(() => ({ state: [] as any[], cursor: 0, cleanup: null as any, deps: null as any, writes: 0 }))
vi.mock('react', () => ({ default: {
  createElement: (type: any, props: any, ...children: any[]) => ({ type, props, children }),
  useState: (initial: any) => {
    const index = hooks.cursor++
    if (!(index in hooks.state)) hooks.state[index] = initial
    return [hooks.state[index], (next: any) => { hooks.state[index] = next; hooks.writes++ }]
  },
  useEffect: (effect: any, deps: any[]) => {
    if (hooks.deps && deps.every((entry, index) => entry === hooks.deps[index])) return
    hooks.cleanup?.(); hooks.cleanup = effect(); hooks.deps = deps
  },
} }))
import { LazyPanel, loadPanel, setPanelImport } from '../src/client/lazyPanel.js'
/** @private @author ddj 2026年10月22号 @returns Controlled transport response. */
function deferred() {
  let resolve!: (exports: Record<string, unknown>) => void
  const promise = new Promise<Record<string, unknown>>((ready) => { resolve = ready })
  return { promise, resolve }
}
/** @private @author ddj 2026年10月22号 @description Test component exported by the chunk. */
function RulesPanel() { return null }
/** @private @author ddj 2026年10月22号 @description Render with stable hook slots. */
function render() { hooks.cursor = 0; return LazyPanel({ panel: 'rules', ctx: {} as any }) as any }
afterEach(() => { hooks.cleanup?.(); hooks.state = []; hooks.deps = null; hooks.cleanup = null; hooks.writes = 0; setPanelImport() })

describe('lazy panel loading', () => {
  it('does not request until explicitly loaded and shares pending/success state', async () => {
    const result = deferred(), transport = vi.fn(() => result.promise)
    setPanelImport(transport); expect(transport).not.toHaveBeenCalled()
    const first = loadPanel('rules'), second = loadPanel('rules'); expect(first).toBe(second)
    result.resolve({ RulesPanel }); expect(await first).toBe(RulesPanel)
    expect(await loadPanel('rules')).toBe(RulesPanel)
    expect(transport).toHaveBeenCalledExactlyOnceWith('./client.rules.js')
  })
  it('clears failed transports and malformed exports for explicit retry', async () => {
    const transport = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({}).mockResolvedValue({ RulesPanel })
    setPanelImport(transport)
    await expect(loadPanel('rules')).rejects.toThrow('offline')
    await expect(loadPanel('rules')).rejects.toThrow('组件导出')
    expect(await loadPanel('rules')).toBe(RulesPanel); expect(transport).toHaveBeenCalledTimes(3)
  })
  it('invalidates a prior generation and supports re-opening after HMR', async () => {
    const result = deferred(); setPanelImport(() => result.promise)
    const previous = loadPanel('rules'); await Promise.resolve()
    setPanelImport(async () => ({ RulesPanel })); result.resolve({ RulesPanel })
    await expect(previous).rejects.toThrow('已失效'); expect(await loadPanel('rules')).toBe(RulesPanel)
  })
  it('does not publish after unmount and reuses a completed load when remounted', async () => {
    const result = deferred(); setPanelImport(() => result.promise)
    render(); const pending = loadPanel('rules'); hooks.cleanup(); const writes = hooks.writes
    result.resolve({ RulesPanel }); await pending; await Promise.resolve()
    expect(hooks.writes).toBe(writes)
    hooks.deps = null; render(); await Promise.resolve(); await Promise.resolve()
    expect(render().type).toBe(RulesPanel)
  })
  it('fails clearly on older hosts without async chunk support', async () => {
    setPanelImport(); await expect(loadPanel('rules')).rejects.toThrow('升级宿主')
  })
})
