import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ slots: [] as any[], effects: [] as any[], cursor: 0,
  effectCursor: 0, layout: [] as any[], passive: [] as any[] }))
vi.mock('react', () => ({ default: {
  useState: (initial: any) => {
    const i = mock.cursor++
    if (!(i in mock.slots)) mock.slots[i] = initial
    return [mock.slots[i], (value: any) => { mock.slots[i] = value }]
  },
  useRef: (initial: any) => {
    const i = mock.cursor++
    if (!(i in mock.slots)) mock.slots[i] = { current: initial }
    return mock.slots[i]
  },
  useEffect: (effect: any, deps: any[]) => queueEffect(effect, deps, mock.passive),
  useLayoutEffect: (effect: any) => queueEffect(effect, undefined, mock.layout),
} }))
import { useExplorerReveal } from '../src/client/sidebar/panels/useExplorerReveal.js'

/** @private @author ddj 2026年10月14号 @param effect Hook effect. @param deps Dependency values. @param queue Commit phase. */
function queueEffect(effect: any, deps: any[] | undefined, queue: any[]): void {
  const i = mock.effectCursor++
  const prev = mock.effects[i]
  if (prev && deps && deps.every((d, j) => Object.is(d, prev.deps[j]))) return
  /** @private @author ddj 2026年10月14号 Commits queued effect and its previous cleanup. */
  function commit(): void { prev?.cleanup?.(); mock.effects[i] = { deps, cleanup: effect() } }
  queue.push(commit)
}
/** @private @author ddj 2026年10月14号 @param options Hook inputs. @returns Hook output after one layout/passive commit. */
function render(options: any) {
  mock.cursor = 0; mock.effectCursor = 0
  const out = useExplorerReveal(options)
  for (const effect of mock.layout.splice(0)) effect()
  for (const effect of mock.passive.splice(0)) effect()
  return out
}
/** @private @author ddj 2026年10月14号 Cleans the mounted instance, including timers and listeners. */
function unmount(): void { for (const effect of mock.effects) effect?.cleanup?.() }
/** @private @author ddj 2026年10月14号 Clears harness instance state for a real remount simulation. */
function reset(): void {
  mock.slots = []; mock.effects = []; mock.layout = []; mock.passive = []
}
/** @private @author ddj 2026年10月14号 @returns Mutable tree host fixture and hook options. */
function fixture() {
  const rows = new Set<string>()
  const query = vi.fn((selector: string) => rows.has(selector) ? {
    getBoundingClientRect: () => ({ top: 350, bottom: 370, height: 20 }),
  } : null)
  const host = { clientHeight: 200, clientTop: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ top: 100 }), querySelector: query }
  return { rows, host, query, options: { scope: 'one', activePath: 'a/b.ts',
    treeRef: { current: host }, prepare: vi.fn() } }
}
/** @private @author ddj 2026年10月14号 @param path Manual target. Dispatches the existing explicit reveal event. */
function manual(path: string): void {
  const event = new Event('edrv:reveal-path') as any
  event.detail = { path }
  window.dispatchEvent(event)
}

beforeEach(() => { reset(); vi.useFakeTimers(); vi.stubGlobal('window', new EventTarget()) })
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('explorer reveal lifecycle', () => {
  it('virtual locator waits for model rows then highlights without querying mounted DOM', () => {
    const f = fixture()
    const locate = vi.fn().mockReturnValue(false)
    const options = { ...f.options, locate }
    render(options); render(options)
    expect(render(options).revealPath).toBeNull()
    expect(locate).toHaveBeenCalledWith('a/b.ts')
    locate.mockReturnValue(true)
    render(options)
    expect(render(options).revealPath).toBe('a/b.ts')
    expect(f.query).not.toHaveBeenCalled()
    expect(f.options.prepare).toHaveBeenCalledTimes(1)
  })
  it('virtual locator never consumes an old scope target when a new scope takes over', () => {
    const f = fixture()
    const locate = vi.fn().mockReturnValue(false)
    const options = { ...f.options, locate }
    render(options); render(options)
    locate.mockClear(); locate.mockReturnValue(true)
    options.scope = 'two'; options.activePath = 'new.ts'
    render(options); render(options)
    expect(locate).not.toHaveBeenCalledWith('a/b.ts')
    expect(locate).toHaveBeenCalledWith('new.ts')
    expect(render(options).revealPath).toBe('new.ts')
    expect(f.query).not.toHaveBeenCalled()
  })
  it('expands on mount and waits beyond the previous short retry window', () => {
    const f = fixture()
    render(f.options); render(f.options)
    expect(f.options.prepare).toHaveBeenCalledWith('a/b.ts')
    vi.advanceTimersByTime(5000)
    f.rows.add('[data-edrv-path="a/b.ts"]')
    render(f.options)
    expect(f.host.scrollTop).toBe(160)
    render(f.options); render(f.options)
    expect(f.host.scrollTop).toBe(160)
    expect(f.options.prepare).toHaveBeenCalledTimes(1)
  })
  it('never completes the obsolete A request after B becomes active', () => {
    const f = fixture()
    render(f.options)
    f.rows.add('[data-edrv-path="a/b.ts"]')
    f.options.activePath = 'c.ts'
    render(f.options); render(f.options)
    expect(f.host.scrollTop).toBe(0)
    f.rows.add('[data-edrv-path="c.ts"]')
    render(f.options)
    expect(render(f.options).revealPath).toBe('c.ts')
  })
  it('remount reads the last active file after hidden-panel changes', () => {
    const f = fixture()
    render(f.options); unmount(); reset()
    f.options.activePath = 'last.ts'
    f.rows.add('[data-edrv-path="last.ts"]')
    render(f.options); render(f.options)
    expect(render(f.options).revealPath).toBe('last.ts')
    expect(f.host.scrollTop).toBe(160)
  })
  it('scope switch invalidates the previous request', () => {
    const f = fixture()
    render(f.options)
    f.options.scope = 'two'; f.options.activePath = 'other.ts'
    f.rows.add('[data-edrv-path="a/b.ts"]')
    render(f.options); render(f.options)
    expect(f.host.scrollTop).toBe(0)
    expect(f.options.prepare).toHaveBeenLastCalledWith('other.ts')
  })
  it('manual reveal replaces the target, and unmount cancels its timer', () => {
    const f = fixture()
    render(f.options)
    f.rows.add('[data-edrv-path="manual.ts"]')
    manual('manual.ts'); render(f.options)
    expect(render(f.options).revealPath).toBe('manual.ts')
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    manual('other.ts')
    expect(f.options.prepare).toHaveBeenCalledTimes(2)
  })
  it('outside-workspace active path clears pending state without preparing directories', () => {
    const f = fixture()
    f.options.activePath = '/tmp/external.ts'
    render(f.options); render(f.options)
    expect(f.options.prepare).not.toHaveBeenCalled()
    expect(f.host.scrollTop).toBe(0)
  })
  it('highlight expires without retrying or scrolling again', () => {
    const f = fixture()
    f.rows.add('[data-edrv-path="a/b.ts"]')
    render(f.options); render(f.options)
    vi.advanceTimersByTime(2000)
    expect(render(f.options).revealPath).toBeNull()
    expect(f.host.scrollTop).toBe(160)
  })
})
