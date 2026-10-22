/** Real FileExplorer render projection with a minimal React commit harness. @author ddj 2026年10月22号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flattenTree, treeAnchorTop, treeRevealTop, treeWindow, TREE_ROW_HEIGHT } from '../src/client/sidebar/panels/treeWindow.js'
import type { TreeEntry } from '../src/shared/rpc.js'

const harness = vi.hoisted(() => ({ slots: [] as any[], effects: [] as any[], layout: [] as any[], passive: [] as any[],
  cursor: 0, effectCursor: 0, entries: {} as Record<string, any[]>, frames: [] as any[], svnRows: [] as any[], observers: [] as any[] }))
vi.mock('react', () => ({ default: {
  createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
  memo: (render: any) => render,
  useState: (initial: any) => {
    const index = harness.cursor++
    if (!(index in harness.slots)) harness.slots[index] = initial
    return [harness.slots[index], (next: any) => { harness.slots[index] = typeof next === 'function' ? next(harness.slots[index]) : next }]
  },
  useRef: (initial: any) => {
    const index = harness.cursor++
    if (!(index in harness.slots)) harness.slots[index] = { current: initial }
    return harness.slots[index]
  },
  useMemo: (factory: any, deps: any[]) => memoSlot(factory, deps),
  useCallback: (callback: any, deps: any[]) => memoSlot(() => callback, deps),
  useEffect: (effect: any, deps?: any[]) => queueEffect(effect, deps, harness.passive),
  useLayoutEffect: (effect: any, deps?: any[]) => queueEffect(effect, deps, harness.layout),
} }))
vi.mock('../src/client/rpc.js', () => ({ rpc: vi.fn(() => new Promise(() => {})) }))
vi.mock('../src/client/ui/icons.js', () => ({ IconFolderClose16: null, IconFolderOpen16: null, IconRefreshOutline16: null, fileIconEl: () => null }))
vi.mock('../src/client/ui/SvnOverlay.js', () => ({ svnOverlayEl: () => null, viewOverlayOf: () => null }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button' }))
vi.mock('../src/client/ui/ContextMenu.js', () => ({ ContextMenu: 'menu' }))
vi.mock('../src/client/sidebar/contextMenu.js', () => ({ buildTreeMenu: () => [{ id: 'open', label: 'open', run: vi.fn() }] }))
vi.mock('../src/client/state/explorerCache.js', () => ({ explorerLoad: () => null, explorerSave: vi.fn() }))
vi.mock('../src/client/state/explorerEntriesCache.js', () => ({ entriesCacheGet: (_scope: string, rel: string) => harness.entries[rel], entriesCacheIsFresh: () => true, entriesCachePut: vi.fn() }))
vi.mock('../src/client/svnStatus.js', () => ({ refreshSvnChanges: vi.fn(), refreshSvnStatus: vi.fn() }))
vi.mock('../src/client/sidebar/panels/useExplorerSvn.js', () => ({ useExplorerSvn: (_ctx: any, rows: any[]) => {
  harness.svnRows = rows
  return { local: new Map([['f9999.ts', { kind: 'modified' }]]), remote: new Map([['f9999.ts', 1]]) }
} }))
import { FileExplorer } from '../src/client/sidebar/panels/FileExplorer.js'

/** @private @author ddj 2026年10月22号 @param factory Memo calculation. @param deps Dependencies. @returns Stable memo value. */
function memoSlot(factory: any, deps: any[]) {
  const index = harness.cursor++
  const previous = harness.slots[index]
  if (!previous || deps.some((dep, offset) => !Object.is(dep, previous.deps[offset]))) harness.slots[index] = { deps, result: factory() }
  return harness.slots[index].result
}
/** @private @author ddj 2026年10月22号 @param effect Effect callback. @param deps Dependencies. @param queue Commit queue. */
function queueEffect(effect: any, deps: any[] | undefined, queue: any[]) {
  const index = harness.effectCursor++
  const previous = harness.effects[index]
  if (previous && deps && previous.deps && deps.every((dep, offset) => Object.is(dep, previous.deps[offset]))) return
  queue.push(() => { previous?.cleanup?.(); harness.effects[index] = { deps, cleanup: effect() } })
}
/** @private @author ddj 2026年10月22号 @param count Number of files. @returns Ordered host entries. */
function files(count: number): TreeEntry[] {
  return Array.from({ length: count }, (_, index) => ({ name: `f${index}.ts`, path: `f${index}.ts`, type: 'file' }))
}
/** @private @author ddj 2026年10月22号 @param node Element tree. @returns All real render descriptors. */
function nodes(node: any): any[] {
  if (!node || typeof node !== 'object' || !node.props) return []
  return [node, ...(node.children ?? []).flatMap(nodes)]
}
/** @private @author ddj 2026年10月22号 @param ctx Sidebar context. @param host Scroll viewport. @returns Committed FileExplorer output. */
function render(ctx: any, host: any) {
  harness.cursor = 0; harness.effectCursor = 0
  const output = FileExplorer({ ctx })
  for (const node of nodes(output)) if (node.props.ref) node.props.ref.current = host
  for (const effect of harness.layout.splice(0)) effect()
  for (const effect of harness.passive.splice(0)) effect()
  return output
}
/** @private @author ddj 2026年10月22号 @param output Render output. @returns Mounted ExplorerRow descriptors only. */
function mounted(output: any) { return nodes(output).filter((node) => typeof node.type === 'function' && node.props.path !== undefined) }
/** @private @author ddj 2026年10月22号 @returns Viewport and usable sidebar context. */
function fixture() {
  return { host: { clientHeight: 240, scrollTop: 0, querySelector: vi.fn(() => null) },
    ctx: { scope: 'one', sessionId: 'one', activePath: null, openFile: vi.fn(), pendingByPath: { 'f9999.ts': 2 } } as any }
}
/** @private @author ddj 2026年10月22号 @param path Manual reveal target. */
function reveal(path: string) {
  const event = new Event('edrv:reveal-path') as any
  event.detail = { scope: 'one', path }; window.dispatchEvent(event)
}
beforeEach(() => {
  harness.slots = []; harness.effects = []; harness.layout = []; harness.passive = []; harness.frames = []
  harness.entries = { '': files(10000) }; harness.observers = []
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn()
    disconnect = vi.fn()
    /** @public @author ddj 2026年10月22号 @param callback Measured resize callback. */
    constructor(public callback: () => void) { harness.observers.push(this) }
  })
  vi.useFakeTimers()
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout }))
  vi.stubGlobal('document', { visibilityState: 'visible' })
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => { harness.frames.push(callback); return harness.frames.length }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { for (const effect of harness.effects) effect?.cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('file tree viewport', () => {
  it('keeps all 10000 entries and metadata, with bounded first and last windows', () => {
    const entries = [...files(10000), { name: 'tail.meta', path: 'tail.meta', type: 'file' as const }]
    const rows = flattenTree(() => entries, {}, {})
    expect(rows).toHaveLength(10001)
    expect(rows.at(-1)?.e?.name).toBe('tail.meta')
    for (const top of [0, 12345, 1e9]) {
      const range = treeWindow(rows.length, { top, height: 241 })
      expect(range.end - range.start).toBeLessThanOrEqual(Math.ceil(241 / 24) + 17)
    }
    expect(treeWindow(rows.length, { top: 1e9, height: 240 }).end).toBe(rows.length)
  })
  it('preserves expansion order, loading placeholders, anchors and legal clamping', () => {
    const directory: TreeEntry = { name: 'dir', path: 'dir', type: 'directory' }
    const lookup = (rel: string) => rel === '' ? [directory, ...files(20)] : null
    const closed = flattenTree(lookup, {}, {})
    const open = flattenTree(lookup, { dir: true }, { dir: true })
    expect(open[1]).toMatchObject({ depth: 1, text: '加载中…' })
    expect(treeAnchorTop(closed, open, 10 * 24 + 3)).toBe(11 * 24 + 3)
    expect(treeWindow(1, { top: 10000, height: 240 }).top).toBe(0)
    expect(treeRevealTop(open, 'missing', { top: 0, height: 240 })).toBeNull()
    expect(treeRevealTop(open, 'f19.ts', { top: 500, height: 0 })).toBeNull()
    expect(TREE_ROW_HEIGHT).toBe(24)
  })
  it('real FileExplorer slices DOM and reveals an unmounted final file without querying DOM', () => {
    const { ctx, host } = fixture()
    render(ctx, host); render(ctx, host)
    let output = render(ctx, host)
    expect(mounted(output).length).toBeLessThanOrEqual(27)
    expect(mounted(output)[0].props.path).toBe('f0.ts')
    expect(harness.svnRows).toHaveLength(10000)
    reveal('f9999.ts')
    render(ctx, host); output = render(ctx, host)
    const last = mounted(output).find((node) => node.props.path === 'f9999.ts')
    expect(last).toBeDefined()
    expect(last.props).toMatchObject({ reveal: true, pending: 2, remote: 1, mark: { kind: 'modified' } })
    const committedRow = last.type(last.props)
    expect(committedRow.props['data-edrv-path']).toBe('f9999.ts')
    expect(committedRow.props.className).toContain('edrv-tree-reveal')
    expect(host.querySelector).not.toHaveBeenCalled()
    expect(host.scrollTop).toBe(10000 * 24 - 240)
    last.props.onSelect('f9999.ts', false)
    expect(ctx.openFile).toHaveBeenCalledWith('f9999.ts')
  })
  it('scroll frame is coalesced, cancelled on unmount, and zero-height measurement preserves position', () => {
    const { ctx, host } = fixture()
    render(ctx, host); render(ctx, host)
    let output = render(ctx, host)
    const tree = nodes(output).find((node) => node.props.className === 'edrv-tree edrv-tree-virtual')
    host.scrollTop = 2400
    tree.props.onScroll(); tree.props.onScroll()
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
    harness.frames.shift()()
    output = render(ctx, host)
    expect(mounted(output)[0].props.path).toBe('f92.ts')
    host.clientHeight = 0
    for (const observer of harness.observers) observer.callback()
    tree.props.onScroll(); harness.frames.shift()()
    render(ctx, host)
    expect(host.scrollTop).toBe(2400)
    host.clientHeight = 480
    for (const observer of harness.observers) observer.callback()
    output = render(ctx, host)
    expect(mounted(output).length).toBeLessThanOrEqual(37)
    tree.props.onScroll()
    for (const effect of harness.effects) effect?.cleanup?.()
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(harness.observers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true)
  })
  it('real expand/collapse preserves visible path and closes a removed descendant menu', () => {
    harness.entries[''] = [{ name: 'dir', path: 'dir', type: 'directory' }, ...files(10000)]
    harness.entries.dir = [{ name: 'child.meta', path: 'dir/child.meta', type: 'file' }]
    const { ctx, host } = fixture()
    render(ctx, host); render(ctx, host)
    let output = render(ctx, host)
    const select = mounted(output)[0].props.onSelect
    const context = mounted(output)[0].props.onContext
    const tree = nodes(output).find((node) => node.props.onScroll)
    host.scrollTop = 2400
    tree.props.onScroll(); harness.frames.shift()(); render(ctx, host)
    select('dir', true)
    output = render(ctx, host); output = render(ctx, host)
    expect(host.scrollTop).toBe(2424)
    expect(harness.svnRows.some((row) => row.path === 'dir/child.meta')).toBe(true)
    context('dir/child.meta', 'file', { clientX: 1, clientY: 2, preventDefault() {}, stopPropagation() {} })
    output = render(ctx, host)
    expect(nodes(output).some((node) => node.type === 'menu')).toBe(true)
    select('dir', true)
    output = render(ctx, host)
    expect(nodes(output).some((node) => node.type === 'menu')).toBe(false)
    expect(host.scrollTop).toBe(2400)
  })
  it('right-click keeps path identity while recycled, then closes on scope switch', () => {
    const { ctx, host } = fixture()
    render(ctx, host); render(ctx, host)
    let output = render(ctx, host)
    mounted(output)[0].props.onContext('f0.ts', 'file', { clientX: 1, clientY: 2, preventDefault() {}, stopPropagation() {} })
    output = render(ctx, host)
    expect(nodes(output).some((node) => node.type === 'menu')).toBe(true)
    reveal('f9999.ts'); render(ctx, host); output = render(ctx, host)
    expect(nodes(output).some((node) => node.type === 'menu')).toBe(true)
    ctx.scope = 'two'
    output = render(ctx, host)
    expect(nodes(output).some((node) => node.type === 'menu')).toBe(false)
    expect(host.scrollTop).toBe(0)
  })
})
