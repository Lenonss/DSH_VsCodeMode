import { afterEach, describe, expect, it, vi } from 'vitest'

const viewHooks = vi.hoisted(() => ({ refs: [] as any[], states: [] as any[], effects: [] as any[], refIndex: 0, stateIndex: 0, effectIndex: 0 }))
vi.mock('react', () => ({ default: {
  createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
  useRef: (initial: any) => viewHooks.refs[viewHooks.refIndex++] ?? (viewHooks.refs[viewHooks.refIndex - 1] = { current: initial }),
  useState: (initial: any) => {
    const index = viewHooks.stateIndex++
    if (!(index in viewHooks.states)) viewHooks.states[index] = initial
    return [viewHooks.states[index], (value: any) => { viewHooks.states[index] = value }]
  },
  useEffect: (effect: any, deps: any[]) => {
    const index = viewHooks.effectIndex++, previous = viewHooks.effects[index]
    if (previous && deps.every((entry, i) => entry === previous.deps[i])) return
    previous?.cleanup?.(); viewHooks.effects[index] = { cleanup: effect(), deps }
  },
} }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button' }))
import { LargeTextView } from '../src/client/ui/LargeTextView.js'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

/** @private @author ddj 2026年10月22号 @param name Production function name. @param dependencies Explicit isolated closure. @returns Transpiled real production function, never copied implementation. */
async function editorFunction(name: string, dependencies: Record<string, unknown>): Promise<any> {
  const source = await readFile(new URL('../src/client/ui/EditorView.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('EditorView.ts', source, ts.ScriptTarget.Latest, true)
  let found: ts.FunctionDeclaration | undefined
  /** @private @author ddj 2026年10月22号 @param node Source AST node. @returns Find actual named declaration. */
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!found) throw new Error('Missing production function: ' + name)
  const javascript = ts.transpileModule(found.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(dependencies), javascript + `;return ${name}`)(...Object.values(dependencies))
}

/** @private @author ddj 2026年10月22号 @returns Passive production closure with observable page-root and focus ownership. */
async function passiveFixture() {
  const listeners = new Map<string, any>()
  const button: any = {}
  const host = { textContent: '', appendChild: vi.fn(), addEventListener: (kind: string, run: any) => listeners.set(kind, run),
    removeEventListener: (kind: string, run: any) => { if (listeners.get(kind) === run) listeners.delete(kind) } }
  vi.stubGlobal('document', { createElement: () => button })
  const pageRoot = { render: vi.fn(), unmount: vi.fn() }
  const dirtyRef = { current: {} as Record<string, boolean> }, savingRef = { current: new Set<string>() }
  const selectGroup = vi.fn(), flushSave = vi.fn(), createRoot = vi.fn(() => pageRoot)
  const mount = await editorFunction('mountPassive', { ownerOf: () => ({ id: 'g' }), benchRef: { current: {} }, selectGroup,
    isPdfPath: () => false, isImagePath: () => false, pdfNodes: { current: new Map() }, modelsRef: { current: new Map() },
    rpc: async () => ({ ok: false, code: 'file-too-large', error: 'too big' }), sessionId: 's', dirtyRef, savingRef,
    flushSave, createRoot, paneEditors: { current: new Map() },
    React: { createElement: (type: any, props: any) => ({ type, props }) }, LargeTextView, loadTextPage: vi.fn() })
  const cleanup = mount(host, 'f', 'g')
  await Promise.resolve(); await Promise.resolve()
  return { host, button, listeners, pageRoot, dirtyRef, savingRef, selectGroup, flushSave, createRoot, cleanup }
}

/** @private @author ddj 2026年10月22号 @param props Preview identity. @returns Real component virtual tree using retained hook slots. */
function renderView(props: any): any {
  viewHooks.refIndex = 0; viewHooks.stateIndex = 0; viewHooks.effectIndex = 0
  return LargeTextView(props)
}
/** @private @author ddj 2026年10月22号 @returns Clear retained hook resources and globals. */
function clearView(): void {
  for (const effect of viewHooks.effects) effect?.cleanup?.()
  viewHooks.refs = []; viewHooks.states = []; viewHooks.effects = []
  vi.unstubAllGlobals()
}
afterEach(clearView)

/** @private @author ddj 2026年10月22号 @param paging Active read-only surface. @returns Real disk-change handler and observable notifications. */
async function changeFixture(paging = true, pageChanged: string | null = null) {
  const loadContent = vi.fn(), setPageChanged = vi.fn(), setStatus = vi.fn(), setDiskFlag = vi.fn()
  const run = await editorFunction('onDiskChange', { paging, pageChanged, activeRef: { current: 'f' }, sessionId: 's', scope: 'w',
    pageIdentity: 'identity-f', loadContent, setPageChanged, setStatus, setDiskFlag,
    emitFileChanged: vi.fn(() => 'event'), emitRefresh: vi.fn(), clearSync: vi.fn(),
    readSync: vi.fn(), markDiskFlag: vi.fn(), modelsRef: { current: new Map() }, dirtyRef: { current: {} },
    rpc: vi.fn(async () => ({ ok: false })) })
  return { run, loadContent, setPageChanged, setStatus, setDiskFlag }
}

describe('paged external change notification', () => {
  it('acknowledges observed changes without a full buffer so polling can advance its baseline', async () => {
    const run = await editorFunction('readDiskCompare', { paging: true, pageChanged: null, pageIdentity: 'identity-f',
      activeRef: { current: 'f' }, modelsRef: { current: new Map() } })
    expect(await run('f')).toEqual({ equal: false })
    expect(await run('other')).toBeNull()
  })
  it('invalidates the active preview and retains an explicit identity-scoped change notice', async () => {
    const fixture = await changeFixture()
    fixture.run({ kind: 'modified', path: 'f' })
    expect(fixture.loadContent).toHaveBeenCalledWith('f', 's', true)
    expect(fixture.setPageChanged).toHaveBeenCalledWith('identity-f')
    expect(fixture.setStatus).toHaveBeenCalledWith('文件已变化，请重新读取')
    expect(fixture.loadContent.mock.invocationCallOrder[0]).toBeLessThan(fixture.setPageChanged.mock.invocationCallOrder[0])
  })
  it('preserves the notice across repeated polling after paging was invalidated', async () => {
    const fixture = await changeFixture(false, 'identity-f')
    fixture.run({ kind: 'modified', path: 'f' })
    expect(fixture.setPageChanged).toHaveBeenCalledWith('identity-f')
    expect(fixture.setStatus).toHaveBeenCalledWith('文件已变化，请重新读取')
    expect(fixture.setDiskFlag).not.toHaveBeenCalled()
  })
  it('keeps ordinary clean-file synchronization unchanged', async () => {
    const fixture = await changeFixture(false)
    fixture.run({ kind: 'modified', path: 'f' })
    expect(fixture.loadContent).toHaveBeenCalledWith('f', 's', true)
    expect(fixture.setPageChanged).not.toHaveBeenCalled()
    expect(fixture.setDiskFlag).toHaveBeenCalled()
  })
  it('does not attach the active preview notice to another path', async () => {
    const fixture = await changeFixture()
    fixture.run({ kind: 'modified', path: 'other' })
    expect(fixture.loadContent).not.toHaveBeenCalled()
    expect(fixture.setPageChanged).not.toHaveBeenCalled()
    await Promise.resolve()
  })
  it('clears the notice only after the explicit guarded reread is accepted', async () => {
    const setPageChanged = vi.fn(), setPagedFile = vi.fn()
    const run = await editorFunction('openTextPages', { largeCandidate: 'identity-f', pageIdentity: 'identity-f', active: 'f',
      dirtyRef: { current: {} }, savingRef: { current: new Set() }, flushSave: vi.fn(), setPageChanged, setPagedFile })
    run()
    expect(setPageChanged).toHaveBeenCalledWith(null)
    expect(setPagedFile).toHaveBeenCalledWith('identity-f')
  })
})
import { createTextPager } from '../src/client/textPages.js'
import { TEXT_PAGE_BYTES, TEXT_VIEW_BYTES, TEXT_VIEW_LINES } from '../src/shared/textPages.js'
import type { TextPageResult } from '../src/shared/textPages.js'

/** @private @author ddj 2026年10月22号 @param text Page content. @param offset Byte position. @param eof End marker. @returns Valid server envelope. */
function page(text: string, offset = text.length, eof = false): TextPageResult {
  return { ok: true, text, offset, size: eof ? offset : TEXT_VIEW_BYTES * 2, version: 'v1', eof,
    nextCursor: eof ? null : 'signed-' + offset, encoding: 'utf-8', partialLine: !eof }
}

describe('actual EditorView paging integration', () => {
  it.each([
    { label: 'ordinary text', response: { ok: true, content: 'text' } },
    { label: 'explicit size limit', response: { ok: false, code: 'file-too-large', error: 'too big' } },
  ])('opens $label through the real typed-path entry without saving', async ({ response }) => {
    const openFile = vi.fn(), setOpenInput = vi.fn(), setPathDraft = vi.fn(), setStatus = vi.fn(), setError = vi.fn()
    const rpc = vi.fn().mockResolvedValue(response), doSave = vi.fn()
    const open = await editorFunction('openPath', { pathDraft: '  sample.txt  ', sessionId: 's',
      isImagePath: () => false, isPdfPath: () => false, rpc, openFile, setOpenInput, setPathDraft, setStatus, setError, doSave })

    await open()
    expect(rpc).toHaveBeenCalledExactlyOnceWith('edrv.read', { sessionId: 's', path: 'sample.txt' })
    expect(openFile).toHaveBeenCalledExactlyOnceWith('sample.txt', false)
    expect(setOpenInput).toHaveBeenCalledWith(false)
    expect(setPathDraft).toHaveBeenCalledWith('')
    expect(setError).toHaveBeenLastCalledWith(null)
    expect(doSave).not.toHaveBeenCalled()
  })
  it.each([
    { label: 'permission denied', response: { ok: false, error: 'FS_PERMISSION_DENIED' } },
    { label: 'missing file', response: { ok: false, error: 'FS_NOT_FOUND' } },
    { label: 'unstructured size message', response: { ok: false, error: 'file-too-large' } },
    { label: 'transport failure', failure: new Error('offline') },
  ])('preserves $label failure without creating a tab', async ({ response, failure }) => {
    const openFile = vi.fn(), setOpenInput = vi.fn(), setPathDraft = vi.fn(), setStatus = vi.fn(), setError = vi.fn()
    const rpc = vi.fn()
    if (failure) rpc.mockRejectedValue(failure)
    else rpc.mockResolvedValue(response)
    const open = await editorFunction('openPath', { pathDraft: 'sample.txt', sessionId: 's',
      isImagePath: () => false, isPdfPath: () => false, rpc, openFile, setOpenInput, setPathDraft, setStatus, setError })

    await open()
    expect(openFile).not.toHaveBeenCalled()
    expect(setOpenInput).not.toHaveBeenCalled()
    expect(setPathDraft).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenLastCalledWith('打开失败')
    expect(setError).toHaveBeenLastCalledWith(expect.stringContaining(failure ? 'offline' : response!.error))
  })
  it('keeps passive pointerdown from focusing before click and releases the page root', async () => {
    const sample = await passiveFixture()
    let stopped = false
    sample.button.onpointerdown({ stopPropagation() { stopped = true } })
    if (!stopped) sample.listeners.get('pointerdown')?.()
    sample.button.onclick()
    expect(sample.selectGroup).not.toHaveBeenCalled()
    expect(sample.createRoot).toHaveBeenCalledTimes(1)
    expect(sample.listeners.has('pointerdown')).toBe(false)
    expect(sample.pageRoot.render.mock.calls[0][0].props).toMatchObject({ sessionId: 's', path: 'f' })
    sample.cleanup()
    expect(sample.pageRoot.unmount).toHaveBeenCalledTimes(1)
    sample.button.onclick()
    expect(sample.createRoot).toHaveBeenCalledTimes(1)
  })
  it('does not replace dirty or saving passive documents', async () => {
    const sample = await passiveFixture()
    sample.dirtyRef.current.f = true; sample.button.onclick()
    expect(sample.flushSave).not.toHaveBeenCalled()
    sample.dirtyRef.current.f = false; sample.savingRef.current.add('f'); sample.button.onclick()
    expect(sample.createRoot).not.toHaveBeenCalled()
    sample.cleanup()
  })
  it('checks active identity and dirty/saving state before entering paging', async () => {
    const setPagedFile = vi.fn(), flushSave = vi.fn()
    const dirtyRef = { current: { f: true } }, savingRef = { current: new Set<string>() }
    const open = await editorFunction('openTextPages', { largeCandidate: 'identity', pageIdentity: 'identity',
      active: 'f', dirtyRef, savingRef, flushSave, setPagedFile, setPageChanged: vi.fn() })
    open(); expect(setPagedFile).not.toHaveBeenCalled()
    dirtyRef.current.f = false; savingRef.current.add('f'); open()
    expect(setPagedFile).not.toHaveBeenCalled()
    savingRef.current.clear(); open()
    expect(flushSave).toHaveBeenCalledTimes(1)
    expect(setPagedFile).toHaveBeenCalledWith('identity')
  })
})

describe('LargeTextView visibility and identity lifecycle', () => {
  it('defers hidden first load and never auto-loads another page on visibility changes', async () => {
    const document = new EventTarget() as EventTarget & { hidden: boolean }
    document.hidden = true; vi.stubGlobal('document', document)
    const load = vi.fn(async () => page('abc'))
    const props = { sessionId: 's', path: 'a', loadPage: load }
    renderView(props); await Promise.resolve()
    expect(load).not.toHaveBeenCalled()
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve(); await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    document.hidden = true
    const tree = renderView(props)
    tree.children[0].children[1].props.onClick()
    expect(load).toHaveBeenCalledTimes(1)
    document.hidden = false; document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('waits for the old transport then reads the new identity exactly once', async () => {
    let resolveOld!: (result: TextPageResult) => void
    const load = vi.fn().mockImplementationOnce(() => new Promise<TextPageResult>(done => { resolveOld = done }))
      .mockResolvedValue(page('fresh', 5, true))
    renderView({ sessionId: 's', path: 'a', loadPage: load })
    renderView({ sessionId: 'other', path: 'b', loadPage: load })
    expect(load).toHaveBeenCalledTimes(1)
    resolveOld(page('obsolete'))
    for (let index = 0; index < 5; index++) await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    expect(load.mock.calls[1][0]).toMatchObject({ sessionId: 'other', path: 'b' })
    expect(viewHooks.states[0].text).toBe('fresh')
    expect(viewHooks.states[0].text).not.toContain('obsolete')
  })
  it('does not start a deferred identity request after unmount', async () => {
    let resolveOld!: (result: TextPageResult) => void
    const load = vi.fn(() => new Promise<TextPageResult>(done => { resolveOld = done }))
    renderView({ sessionId: 's', path: 'a', loadPage: load })
    renderView({ sessionId: 's', path: 'b', loadPage: load })
    clearView(); resolveOld(page('obsolete'))
    for (let index = 0; index < 4; index++) await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('bounded text pager', () => {
  it('allows only one in-flight request and only explicit continuation', async () => {
    let resolve!: (result: TextPageResult) => void
    const load = vi.fn(() => new Promise<TextPageResult>(done => { resolve = done }))
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a', sessionId: 's' })
    const pending = pager.loadNext()
    await pager.loadNext()
    expect(load).toHaveBeenCalledTimes(1)
    resolve(page('abc'))
    await pending
    expect(pager.getState().text).toBe('abc')
    expect(load).toHaveBeenCalledTimes(1)
    expect(pager.getState().loading).toBe(false)
  })
  it('invalidates identity changes without overlapping the old transport', async () => {
    let resolve!: (result: TextPageResult) => void
    const load = vi.fn(() => new Promise<TextPageResult>(done => { resolve = done }))
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a', sessionId: 's' })
    const pending = pager.loadNext()
    pager.reset({ path: 'a', sessionId: 'other-session' })
    await pager.loadNext()
    expect(load).toHaveBeenCalledTimes(1)
    resolve(page('obsolete'))
    await pending
    expect(pager.getState().text).toBe('')
    expect(pager.getState().loading).toBe(false)
  })
  it('ignores responses after disposal', async () => {
    let resolve!: (result: TextPageResult) => void
    const changed = vi.fn()
    const pager = createTextPager(() => new Promise(done => { resolve = done }), changed)
    pager.reset({ path: 'a' })
    const pending = pager.loadNext()
    pager.dispose()
    const count = changed.mock.calls.length
    resolve(page('obsolete'))
    await pending
    expect(changed).toHaveBeenCalledTimes(count)
    expect(pager.getState().text).toBe('')
  })
  it('enforces 8 MiB for huge lines and stops issuing requests', async () => {
    let offset = 0
    const load = vi.fn(async () => { offset += TEXT_PAGE_BYTES; return page('a'.repeat(TEXT_PAGE_BYTES), offset) })
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a' })
    for (let index = 0; index < 35; index++) await pager.loadNext()
    expect(pager.getState().text.length).toBe(TEXT_VIEW_BYTES)
    expect(pager.getState().capped).toBe(true)
    expect(load).toHaveBeenCalledTimes(32)
  })
  it('enforces 50000 displayed lines without retaining the rest of a dense page', async () => {
    const load = vi.fn(async () => page('a\n'.repeat(TEXT_VIEW_LINES + 20)))
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a' })
    await pager.loadNext()
    expect(pager.getState().lines).toBe(TEXT_VIEW_LINES)
    expect(pager.getState().text.split('\n')).toHaveLength(TEXT_VIEW_LINES)
    await pager.loadNext()
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('retries a failed page explicitly without dropping already loaded content', async () => {
    const load = vi.fn().mockResolvedValueOnce(page('abc')).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page('def', 6, true))
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a' })
    await pager.loadNext(); await pager.loadNext()
    expect(pager.getState()).toMatchObject({ text: 'abc', error: 'Error: offline' })
    await pager.loadNext()
    expect(pager.getState()).toMatchObject({ text: 'abcdef', error: null, eof: true })
    expect(load.mock.calls[2][0].cursor).toBe('signed-3')
  })
  it('counts CRLF and bare CR lines without exceeding the line cap', async () => {
    for (const ending of ['\r\n', '\r']) {
      const pager = createTextPager(async () => page(('x' + ending).repeat(TEXT_VIEW_LINES + 2)), vi.fn())
      pager.reset({ path: 'a' }); await pager.loadNext()
      expect(pager.getState().lines).toBe(TEXT_VIEW_LINES)
      expect(pager.getState().text.split(/\r\n|\r|\n/)).toHaveLength(TEXT_VIEW_LINES)
    }
  })
  it('rejects malformed and version-mixed pages; propagates unsupported', async () => {
    const load = vi.fn().mockResolvedValueOnce(page('abc')).mockResolvedValueOnce({ ...page('def', 6), version: 'v2' })
    const pager = createTextPager(load, vi.fn())
    pager.reset({ path: 'a' })
    await pager.loadNext()
    await pager.loadNext()
    expect(pager.getState()).toMatchObject({ text: 'abc', error: 'Invalid or stale text page' })
    pager.reset({ path: 'b' })
    load.mockResolvedValueOnce({ ok: false, reason: 'unsupported', error: 'No authorized range read' })
    await pager.loadNext()
    expect(pager.getState().error).toBe('No authorized range read')
  })
})
