import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ slots: [] as any[], effects: [] as any[], cursor: 0, ec: 0, queue: [] as any[], rpc: vi.fn() }))
vi.mock('../src/client/rpc.js', () => ({ rpc: h.rpc }))
vi.mock('../src/client/ui/ContextMenu.js', () => ({ ContextMenu: 'context-menu' }))
vi.mock('../src/client/ui/ModalShell.js', () => ({ ModalShell: 'modal' }))
vi.mock('react', async (original) => {
  const real = await original<any>()
  return { ...real, default: { ...real.default,
    useState: (initial: any) => {
      const index = h.cursor++
      if (!(index in h.slots)) h.slots[index] = typeof initial === 'function' ? initial() : initial
      return [h.slots[index], (value: any) => { h.slots[index] = typeof value === 'function' ? value(h.slots[index]) : value }]
    },
    useRef: (initial: any) => {
      const index = h.cursor++
      if (!(index in h.slots)) h.slots[index] = { current: initial }
      return h.slots[index]
    },
    useMemo: (factory: any, deps: any[]) => memo(factory, deps),
    useCallback: (fn: any, deps: any[]) => memo(() => fn, deps),
    useEffect: effect, useLayoutEffect: effect,
  } }
})
import { SvnUpdateDialog } from '../src/client/ui/SvnUpdateDialog.js'
const state = { ok: true, jobId: 'j', target: 'Assets', phase: 'completed', counts: { A: 0, U: 0, D: 0, G: 0, C: 2, E: 0, R: 0 },
  revision: 2, elapsedMs: 1, error: '', rawTail: '', truncated: false, nextSeq: 2 }
const rows = [{ seq: 1, action: 'C', path: 'z.txt', relPath: 'z.txt', label: '冲突', raw: 'C z.txt' },
  { seq: 2, action: 'C', path: 'a.txt', relPath: 'a.txt', label: '冲突', raw: 'C a.txt' }]
let clean = false
const host = { scrollTop: 0, scrollHeight: 200, clientHeight: 28 }
const props = { path: 'Assets', sessionId: 's', cwd: '/wc', onClose: vi.fn(), onDone: vi.fn(), onNote: vi.fn(),
  onShowLog: vi.fn(), onCompare: vi.fn(), onOpenFile: vi.fn(), onOpenWith: vi.fn(), onOpenParent: vi.fn() }
/** @private @author ddj 2026年10月14号 @param factory Value producer. @param deps Hook dependencies. @returns Cached identity. */
function memo(factory: any, deps: any[]) {
  const i = h.cursor++, prev = h.slots[i]
  if (!prev || deps.some((value, j) => !Object.is(value, prev.deps[j]))) h.slots[i] = { deps, value: factory() }
  return h.slots[i].value
}
/** @private @author ddj 2026年10月14号 @param fn Effect body. @param deps Effect dependencies. Queue hook commit. */
function effect(fn: any, deps: any[] = []) {
  const i = h.ec++, prev = h.effects[i]
  if (prev && deps.every((value, j) => Object.is(value, prev.deps[j]))) return
  h.queue.push(() => { prev?.cleanup?.(); h.effects[i] = { deps, cleanup: fn() } })
}
/** @private @author ddj 2026年10月14号 @param node React tree. @returns Flattened nodes without invoking overlay components. */
function flatten(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(flatten)
  if (!node || typeof node !== 'object') return []
  return [node, ...flatten(node.props?.children)]
}
/** @private @author ddj 2026年10月14号 @returns Dialog element tree committed to a synthetic scroll host. */
function render() {
  h.cursor = 0; h.ec = 0
  const nodes = flatten(SvnUpdateDialog(props))
  for (const node of nodes) if (node.props.className === 'edrv-update-list') node.ref.current = host
  for (const commit of h.queue.splice(0)) commit()
  return nodes
}
/** @private @author ddj 2026年10月14号 @returns Stable render after promise microtasks. */
async function settle() { for (let i = 0; i < 15; i++) { await Promise.resolve(); render() }; return render() }
/** @private @author ddj 2026年10月14号 @param nodes Render tree. @param text Button text. @returns Exact button. */
function button(nodes: any[], text: string) { return nodes.find((node) => node.type === 'button' && String(node.props.children).startsWith(text)) }
/** @private @author ddj 2026年10月14号 @param nodes Render tree. @param index Display row index. Open single-target context menu. */
function menu(nodes: any[], index: number) {
  nodes.filter((node) => node.props.role === 'row' && node.props.onContextMenu)[index].props.onContextMenu({ clientX: 1, clientY: 1, preventDefault() {}, stopPropagation() {} })
}
beforeEach(() => {
  h.slots = []; h.effects = []; h.queue = []; clean = false; host.scrollTop = 0
  vi.useFakeTimers(); vi.clearAllMocks()
  vi.stubGlobal('window', { innerWidth: 1000, setInterval, clearInterval, setTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => true) })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  h.rpc.mockImplementation(async (method: string, args: any) => {
    if (method === 'svn.updateStart') return state
    if (method === 'svn.updatePoll') return { ...state, rows, offset: 0, totalSeq: 2 }
    if (method === 'edrv.externalStat') return { ok: true, kind: 'file' }
    if (method === 'svn.conflictStatus') return { ok: true, states: args.paths.map((path: string) => ({ path, text: !(clean && path === 'a.txt'), props: false, tree: false, versioned: true })) }
    clean = true; return { ok: true, summary: 'done' }
  })
})
afterEach(() => { for (const entry of h.effects) entry?.cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('SVN update actual component callbacks', () => {
  it('sort headers change display order, conflict navigation scrolls and selects stable seq', async () => {
    render(); let nodes = await settle()
    button(nodes, '路径').props.onClick(); nodes = render()
    expect(nodes.filter((node) => node.props.className === 'edrv-update-path').map((node) => node.props.children)).toEqual(['a.txt', 'z.txt'])
    button(nodes, '跳转冲突').props.onClick(); nodes = render()
    expect(nodes.filter((node) => node.props.role === 'row' && node.props['aria-selected']).map((node) => node.props.title)).toEqual(['C a.txt'])
    button(nodes, '跳转冲突').props.onClick(); render(); expect(host.scrollTop).toBe(28)
  })
  it('cancel confirmation writes nothing; acceptance acts only on right-click target and refreshes evidence', async () => {
    render(); let nodes = await settle(); menu(nodes, 1); nodes = await settle()
    let entry = nodes.find((node) => node.type === 'context-menu').props.entries.find((item: any) => item.id === 'theirs-full')
    window.confirm = vi.fn(() => false); entry.onClick(); await settle()
    expect(h.rpc.mock.calls.filter(([method]) => method === 'svn.resolve')).toHaveLength(0)
    window.confirm = vi.fn(() => true); entry.onClick(); entry.onClick(); nodes = await settle()
    expect(h.rpc.mock.calls.filter(([method]) => method === 'svn.resolve')).toEqual([['svn.resolve', { sessionId: 's', path: 'a.txt', accept: 'theirs-full' }]])
    expect(button(nodes, '跳转冲突').props.children).toBe('跳转冲突（1）')
    expect(nodes.some((node) => node.props.children === '冲突（已解决）')).toBe(true)
  })
})
