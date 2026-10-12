/** Minimal hook harness: no browser package/dependency or full UI suite. @author ddj 2026年10月09号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarCtx } from '../src/client/sidebar/types.js'

const rows = [{ path: 'dir/a', isDir: false }, { path: 'dir', isDir: true }]
const mock = vi.hoisted(() => ({ rpc: vi.fn(), slots: [] as any[], effects: [] as any[], cursor: 0, effectCursor: 0, pending: [] as any[] }))
vi.mock('../src/client/rpc.js', () => ({ rpc: mock.rpc }))
vi.mock('react', () => ({ default: {
  useState: (initial: any) => {
    const i = mock.cursor++
    if (!(i in mock.slots)) mock.slots[i] = initial
    return [mock.slots[i], (value: any) => { mock.slots[i] = typeof value === 'function' ? value(mock.slots[i]) : value }]
  },
  useRef: (initial: any) => {
    const i = mock.cursor++
    if (!(i in mock.slots)) mock.slots[i] = { current: initial }
    return mock.slots[i]
  },
  useEffect: (effect: any, deps: any[]) => {
    const i = mock.effectCursor++
    const prev = mock.effects[i]
    if (prev && deps.every((d, j) => Object.is(d, prev.deps[j]))) return
    mock.pending.push(() => { prev?.cleanup?.(); mock.effects[i] = { deps, cleanup: effect() } })
  },
} }))
import { useExplorerSvn } from '../src/client/sidebar/panels/useExplorerSvn.js'

/** @private @author ddj 2026年10月09号 @param scope Workspace key. @returns Sidebar fixture. */
function ctxOf(scope = 'one'): SidebarCtx {
  return { scope, sessionId: scope, openFile: () => {}, activePath: null, pendingByPath: {}, sum: { totalFiles: 0, files: [] },
    svn: { managed: true, svnCli: true } as any }
}
/** @private @author ddj 2026年10月09号 @param ctx Context. @returns Rendered hook state, with committed effects. */
function render(ctx: SidebarCtx) {
  mock.cursor = 0
  mock.effectCursor = 0
  const out = useExplorerSvn(ctx, rows)
  for (const effect of mock.pending.splice(0)) effect()
  return out
}
/** @private @author ddj 2026年10月09号 @param ctx Context. @returns Stable hook view after updates. */
function settle(ctx: SidebarCtx) { render(ctx); return render(ctx) }
/** @private @author ddj 2026年10月09号 @returns Confirmed local RPC response. */
function localOf() {
  return { ok: true, scopeId: 'host', prefix: '.', revision: 1, generation: 1, observedGeneration: 1, confirmedAt: Date.now(),
    complete: true, refreshing: false, scanMs: 10, error: '', mismatch: false,
    rows: rows.map((r) => ({ path: r.path, kind: 'clean', count: 0, stale: false })) }
}
/** @private @author ddj 2026年10月09号 Run effect cleanup without querying repository. */
function unmount() { for (const e of mock.effects) e?.cleanup?.() }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(10000)
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  mock.slots = []; mock.effects = []; mock.pending = []; mock.rpc.mockReset()
  vi.stubGlobal('window', new EventTarget())
  mock.rpc.mockResolvedValue(localOf())
})
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('SVN explorer hook lifecycle', () => {
  it('mount and file events only load local status; no automatic repository calls', async () => {
    const ctx = ctxOf()
    render(ctx)
    await vi.advanceTimersByTimeAsync(300)
    expect(settle(ctx).local).not.toBeNull()
    window.dispatchEvent(new Event('edrv:file-changed'))
    expect(settle(ctx).local?.get('dir/a')?.stale).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(settle(ctx).local?.get('dir/a')?.stale).toBe(false)
    expect(mock.rpc.mock.calls.map((c) => c[0])).toEqual(['svn.explorerView', 'svn.explorerView'])
    expect(mock.rpc.mock.calls[1][1].reason).toBe('full')
  })
  it('explicit check shows remote evidence then expires without rechecking', async () => {
    const ctx = ctxOf()
    render(ctx); await vi.advanceTimersByTimeAsync(300)
    const view = settle(ctx)
    mock.rpc.mockResolvedValueOnce({ ok: true, outdated: [{ path: 'dir/a', item: 'modified' }], againstRev: 9, truncated: false })
    await view.checkRemote()
    expect(settle(ctx).remote?.get('dir')).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settle(ctx).remote).toBeNull()
    expect(mock.rpc.mock.calls.filter((c) => c[0] === 'svn.remoteStatus')).toHaveLength(1)
  })
  it('text saves preserve remote evidence but structural changes clear it', async () => {
    const ctx = ctxOf()
    render(ctx); await vi.advanceTimersByTimeAsync(300)
    mock.rpc.mockResolvedValueOnce({ ok: true, outdated: [{ path: 'dir/a', item: 'modified' }], againstRev: 9, truncated: false })
    await settle(ctx).checkRemote()
    const text = new Event('edrv:file-changed') as any
    text.detail = { scope: 'one', paths: ['dir/a'], kind: 'text', eventId: 'save' }
    window.dispatchEvent(text); settle(ctx)
    await vi.advanceTimersByTimeAsync(300)
    expect(settle(ctx).remote?.get('dir/a')).toBe(1)
    const structural = new Event('edrv:refresh') as any
    structural.detail = { scope: 'one', paths: ['dir/a'], kind: 'structure', eventId: 'rename' }
    window.dispatchEvent(structural)
    expect(settle(ctx).remote).toBeNull()
  })
  it('scope change aborts pending remote and discards late completion', async () => {
    const ctx = ctxOf()
    render(ctx); await vi.advanceTimersByTimeAsync(300)
    let resolve!: (value: any) => void
    mock.rpc.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const work = settle(ctx).checkRemote()
    const signal = mock.rpc.mock.calls.at(-1)![2]
    const next = ctxOf('two')
    expect(settle(next).local).toBeNull()
    expect(signal.aborted).toBe(true)
    resolve({ ok: true, outdated: [{ path: 'dir/a', item: 'modified' }], againstRev: 9 })
    await work
    expect(settle(next).remote).toBeNull()
  })
  it('failed remote check clears previous evidence and is not a clean result', async () => {
    const ctx = ctxOf()
    render(ctx); await vi.advanceTimersByTimeAsync(300)
    mock.rpc.mockResolvedValueOnce({ ok: true, outdated: [{ path: 'dir/a', item: 'modified' }], againstRev: 9 })
    await settle(ctx).checkRemote()
    mock.rpc.mockResolvedValueOnce({ ok: false, error: '仓库离线' })
    await settle(ctx).checkRemote()
    expect(settle(ctx).remote).toBeNull()
    expect(settle(ctx).message).toContain('仓库离线')
  })
  it('late local snapshot after scope change is discarded', async () => {
    let resolve!: (value: any) => void
    mock.rpc.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    render(ctxOf()); await vi.advanceTimersByTimeAsync(300)
    const next = ctxOf('two')
    settle(next)
    resolve(localOf()); await Promise.resolve(); await Promise.resolve()
    expect(settle(next).local).toBeNull()
  })
})
