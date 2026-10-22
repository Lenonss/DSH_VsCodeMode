/** Real SvnPanel hook lifecycle under controlled promise ordering. @author ddj 2026年10月22号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as any[], effectCursor: 0, pending: [] as any[], sizes: vi.fn() }))
vi.mock('react', () => ({ default: {
  memo: (component: any) => component,
  createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
  useState: (initial: any) => { const i = mock.cursor++; if (!(i in mock.slots)) mock.slots[i] = typeof initial === 'function' ? initial() : initial; return [mock.slots[i], (next: any) => { mock.slots[i] = typeof next === 'function' ? next(mock.slots[i]) : next }] },
  useRef: (initial: any) => { const i = mock.cursor++; if (!(i in mock.slots)) mock.slots[i] = { current: initial }; return mock.slots[i] },
  useMemo: (factory: any) => factory(), useCallback: (callback: any) => callback,
  useEffect: (effect: any, deps: any[]) => { const i = mock.effectCursor++; const previous = mock.effects[i]; if (previous && deps?.every((entry, index) => Object.is(entry, previous.deps?.[index]))) return; mock.pending.push(() => { previous?.cleanup?.(); mock.effects[i] = { deps, cleanup: effect() } }) },
} }))
vi.mock('../src/client/ui/icons.js', () => ({ IconRefreshOutline16: null, fileIconEl: () => null }))
vi.mock('../src/client/ui/ContextMenu.js', () => ({ ContextMenu: () => null }))
vi.mock('../src/client/ui/SvnAiPlanDialog.js', () => ({ SvnAiPlanDialog: () => null }))
vi.mock('../src/client/svnStatus.js', () => ({ svnFileSizes: mock.sizes, svnChangesCapped: () => false, svnAiPlanPending: () => null,
  refreshSvnChanges: vi.fn(), runPlanSteps: vi.fn(), svnAdd: vi.fn(), svnAiPlan: vi.fn(), svnChangelist: vi.fn(), svnConflictArtifacts: vi.fn(), svnIgnore: vi.fn(), svnRemoteStatus: vi.fn(), svnRevert: vi.fn() }))
import { SvnPanel } from '../src/client/sidebar/panels/SvnPanel.js'

/** @private @author ddj 2026年10月22号 @param sessionId Session. @param suffix Candidate generation. @returns Minimal real panel context. */
function context(sessionId = 's1', suffix = 'a') {
  return { scope: 'workspace', sessionId, svn: { managed: true, svnCli: true }, svnChanges: [
    { path: suffix + '.txt', status: 'missing', versioned: true }, { path: suffix + '-copy.txt', status: 'unversioned', versioned: false },
  ] }
}
/** @private @author ddj 2026年10月22号 @param ctx Panel context. @returns Render result after effect commit. */
function render(ctx: any) { mock.cursor = 0; mock.effectCursor = 0; const result = SvnPanel({ ctx }); for (const commit of mock.pending.splice(0)) commit(); return result }
/** @private @author ddj 2026年10月22号 @returns Controllable size response. */
function deferred() { let resolve!: (sizes: any) => void; let reject!: (error: any) => void; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
/** @private @author ddj 2026年10月22号 @description Release mounted effects. */
function unmount() { for (const effect of mock.effects) effect?.cleanup?.() }
beforeEach(() => { mock.slots = []; mock.effects = []; mock.pending = []; mock.sizes.mockReset(); mock.sizes.mockResolvedValue({}); vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
afterEach(() => { unmount(); vi.unstubAllGlobals() })

describe('SVN pairing request ownership', () => {
  it('ignores an old session response even with identical candidate paths', async () => {
    const first = deferred(), second = deferred(); mock.sizes.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    render(context()); render(context('s2')); second.resolve({ 'a.txt': 22, 'a-copy.txt': 22 }); await Promise.resolve()
    const snapshot = mock.slots[4]; expect(snapshot.table['a.txt']).toBe(22)
    first.resolve({ 'a.txt': 1 }); await Promise.resolve(); expect(mock.slots[4]).toBe(snapshot)
  })
  it('rejects an old candidate generation and scope', async () => {
    const first = deferred(), second = deferred(); mock.sizes.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    render(context()); render({ ...context('s1', 'b'), scope: 'other' }); second.resolve({ 'b.txt': 7 }); await Promise.resolve()
    const snapshot = mock.slots[4]; first.resolve({ 'a.txt': 1 }); await Promise.resolve(); expect(mock.slots[4]).toBe(snapshot)
  })
  it('does not publish after unmount', async () => {
    const pending = deferred(); mock.sizes.mockReturnValueOnce(pending.promise); render(context()); unmount()
    pending.resolve({ 'a.txt': 9 }); await Promise.resolve(); expect(mock.slots[4]).toEqual({})
  })
  it('does not query without both missing and unversioned candidates', () => {
    const ctx = context(); render({ ...ctx, svnChanges: [ctx.svnChanges[1]] }); expect(mock.sizes).not.toHaveBeenCalled()
  })
  it('handles rejection without automatic retry or stale pairing', async () => {
    mock.sizes.mockRejectedValueOnce(new Error('offline')); render(context()); await Promise.resolve(); render(context())
    expect(mock.sizes).toHaveBeenCalledTimes(1); expect(mock.slots[4]).toEqual({})
  })
})
