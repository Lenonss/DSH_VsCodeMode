import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { acceptsLoad, receiptErrorFor, receiptPath, receiptReadyFor, receiptTabPath } from '../src/client/receiptState.js'
import type { ReceiptView } from '../src/client/receiptState.js'
import type { EditorRequest } from '../src/client/openReceipt.js'

const request: EditorRequest = { requestId: 'request-b', sessionId: 's', path: '/work/B.ts', line: 10, column: 2 }

/** @author ddj 2026年09月28号 @param overrides Render-state differences. @returns Valid correlated text state. */
function view(overrides: Partial<ReceiptView> = {}): ReceiptView {
  return { sessionId: 's', cwd: '/work', active: 'B.ts', sequence: 2,
    load: { sessionId: 's', cwd: '/work', path: 'B.ts', sequence: 2, status: 'ready' }, mounted: true, blocked: false,
    kind: 'text', contentPath: 'B.ts', contentReady: true, modelMatches: true, positionMatches: true,
    imageLoaded: false, pdfLoaded: false, ...overrides }
}

const source = ts.createSourceFile('EditorView.ts', readFileSync(new URL('../src/client/ui/EditorView.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const functions = new Map<string, string>()
/** @author ddj 2026年09月28号 @param node AST node; retain actual adapter functions for behavioral tests. */
function collect(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(source))
  ts.forEachChild(node, collect)
}
collect(source)

/**
 * Execute actual editor adapter code with controlled React/Monaco state.
 * @author ddj 2026年09月28号
 * @param name Existing editor function to exercise.
 * @param scope Explicit dependencies and state facts.
 * @returns Extracted function; tests fail if the production adapter is missing.
 */
function editorFunction(name: string, scope: Record<string, unknown>): (...args: any[]) => any {
  const text = functions.get(name)
  if (!text) throw new Error('Missing editor adapter: ' + name)
  return new Function(...Object.keys(scope), text + '; return ' + name)(...Object.values(scope))
}

/** @author ddj 2026年09月28号 @param overrides Actual editor state overrides. @returns Adapter scope with real receiptView. */
function editorState(overrides: Record<string, unknown> = {}) {
  const model = { validatePosition: (position: unknown) => position }
  const ed = { getModel: () => model, getPosition: () => ({ lineNumber: 10, column: 2 }) }
  const state: Record<string, any> = {
    sessionId: 's', cwd: '/work', active: 'B.ts', loadSeqRef: { current: 2 }, receiptLoad: view().load,
    editorRef: { current: ed }, modelsRef: { current: new Map([['B.ts', model]]) }, viewRootRef: { current: {} },
    contentPath: 'B.ts', contentReady: true, svnDiff: null, isImageActive: false, isPdfActive: false, mdPreviewing: false,
    imageSrc: null, imgBroken: false, imgElRef: { current: null }, pdfBytes: null, pdfHostRef: { current: null }, monacoErr: null,
    receiptReadyFor, receiptErrorFor, ...overrides,
  }
  state.receiptView = editorFunction('receiptView', state)
  return state
}

/** @author ddj 2026年09月28号 @param path Failed active tab. @returns Mutable real-adapter dependencies. */
function openState(path = 'B.ts') {
  return {
    cwd: '/work', active: path, sessionId: 's', tabsRef: { current: [{ path }] }, mdPreviewRef: { current: new Set<string>() },
    receiptLoad: { sessionId: 's', cwd: '/work', path, sequence: 2, status: 'error' }, loadError: 'read failed', monacoErr: null,
    pdfCtlRef: { current: new Map<string, { isDirty(): boolean }>() }, pdfB64CacheRef: { current: new Map<string, string>() },
    receiptPath, receiptTabPath, flushSave: vi.fn(), saveViewState: vi.fn(), recordNav: vi.fn(), setSvnDiff: vi.fn(),
    toggleMdPreview: vi.fn(), setError: vi.fn(), setMonacoErr: vi.fn(), addTab: vi.fn(), stageFileAt: vi.fn(), loadContent: vi.fn(),
  }
}

describe('correlated receipt predicates', () => {
  it('requires target, session, load generation, content and position identity', () => {
    expect(receiptReadyFor(request, view())).toBe(true)
    for (const change of [
      { active: 'A.ts' }, { sessionId: 'other' }, { sequence: 3 }, { contentPath: 'A.ts' },
      { contentReady: false }, { modelMatches: false }, { positionMatches: false }, { blocked: true },
    ]) expect(receiptReadyFor(request, view(change))).toBe(false)
  })

  it.each(['image', 'pdf'] as const)('rejects stale %s data even when its old DOM is completely loaded', (kind) => {
    const target = { ...request, path: '/work/B.' + kind, line: undefined }
    const state = view({ kind, active: 'B.' + kind, imageLoaded: true, pdfLoaded: true,
      load: { sessionId: 's', cwd: '/work', path: 'A.' + kind, sequence: 1, status: 'ready' } })
    expect(receiptReadyFor(target, state)).toBe(false)
    state.load = { sessionId: 's', cwd: '/work', path: state.active!, sequence: 2, status: 'ready' }
    expect(receiptReadyFor(target, state)).toBe(true)
    state.sequence = 3
    expect(receiptReadyFor(target, state)).toBe(false)
  })

  it('reports only the target current generation error', () => {
    const state = view({ load: { sessionId: 's', cwd: '/work', path: 'A.ts', sequence: 1, status: 'error', error: 'A failed' } })
    expect(receiptErrorFor(request, state)).toBeNull()
    state.load = { sessionId: 's', cwd: '/work', path: 'B.ts', sequence: 2, status: 'error', error: 'B failed' }
    expect(receiptErrorFor(request, state)).toBe('B failed')
    state.sequence = 3
    expect(receiptErrorFor(request, state)).toBeNull()
    expect(receiptReadyFor(request, state)).toBe(false)
  })

  it('ignores decoder callbacks from old generations or sessions', () => {
    const current = view().load
    expect(acceptsLoad(current, 's', 'B.ts', 2, 2)).toBe(true)
    expect(acceptsLoad(current, 's', 'B.ts', 1, 2)).toBe(false)
    expect(acceptsLoad(current, 's', 'A.ts', 2, 2)).toBe(false)
    expect(acceptsLoad(current, 'other', 'B.ts', 2, 2)).toBe(false)
  })

  it('rejects prior-workspace data under the same session and relative tab name', () => {
    const state = view({ cwd: '/other' })
    expect(receiptReadyFor({ ...request, path: '/other/B.ts' }, state)).toBe(false)
    expect(receiptErrorFor({ ...request, path: '/other/B.ts' }, state)).toBeNull()
  })

  it('requires source mode for an explicit Markdown line', () => {
    const state = view({ kind: 'markdown' })
    expect(receiptReadyFor(request, state)).toBe(false)
    expect(receiptReadyFor({ ...request, line: undefined }, state)).toBe(false)
    expect(receiptReadyFor({ ...request, line: undefined, column: undefined }, state)).toBe(true)
  })

  it('uses workspace path syntax for case rules, including remote POSIX on Windows', () => {
    expect(receiptPath('B.ts', '/work')).not.toBe(receiptPath('b.ts', '/work'))
    expect(receiptPath('B.ts', 'C:\\Work')).toBe(receiptPath('c:/work/b.ts'))
    expect(receiptTabPath('/WORK/B.ts', '/work')).toBe('/WORK/B.ts')
    expect(receiptTabPath('/work/B.ts', '/work')).toBe('B.ts')
    expect(receiptTabPath('c:/WORK/B.ts', 'C:/work')).toBe('B.ts')
    expect(receiptReadyFor({ ...request, path: '/work/b.ts' }, view())).toBe(false)
  })
})

describe('actual EditorView receipt adapters', () => {
  it('does not acknowledge old decoded image A under newly active B', () => {
    const state = editorState({ active: 'B.png', isImageActive: true, imageSrc: 'data:OLD_A',
      imgElRef: { current: { getAttribute: () => 'data:OLD_A', complete: true, naturalWidth: 100 } },
      receiptLoad: { sessionId: 's', cwd: '/work', path: 'A.png', sequence: 1, status: 'ready' } })
    expect(editorFunction('receiptReady', state)({ ...request, path: '/work/B.png' })).toBe(false)
  })

  it('does not let old loadError or unrelated save/SVN error fail a new target', () => {
    const state = editorState({ error: 'SVN failed', loadError: 'Old A read failed' })
    expect(editorFunction('receiptError', state)(request)).toBeNull()
    expect(editorFunction('receiptReady', state)(request)).toBe(true)
  })

  it('requires the exact cached model instance, even for similarly cased POSIX names', () => {
    const state = editorState({ modelsRef: { current: new Map([['B.ts', {}]]) } })
    expect(editorFunction('receiptReady', state)(request)).toBe(false)
  })

  it('retries failed same-path loads without a forced disk overwrite and exits hidden source modes', () => {
    const scope = openState()
    scope.mdPreviewRef.current.add('B.ts')
    editorFunction('openReceiptFile', scope)(request)
    expect(scope.flushSave).toHaveBeenCalledOnce()
    expect(scope.setSvnDiff).toHaveBeenCalledWith(null)
    expect(scope.toggleMdPreview).toHaveBeenCalledWith('B.ts')
    expect(scope.addTab).toHaveBeenCalledWith('B.ts', true)
    expect(scope.stageFileAt).toHaveBeenCalledWith('B.ts', 10, 2)
    expect(scope.loadContent).toHaveBeenCalledWith('B.ts', 's', false)
  })

  it('evicts failed PDF byte cache before a same-path retry', () => {
    const scope = openState('B.pdf')
    scope.pdfB64CacheRef.current.set('B.pdf', 'old invalid bytes')
    editorFunction('openReceiptFile', scope)({ ...request, path: '/work/B.pdf', line: undefined })
    expect(scope.pdfB64CacheRef.current.has('B.pdf')).toBe(false)
    expect(scope.loadContent).toHaveBeenCalledWith('B.pdf', 's', false)
  })

  it('does not reload a PDF controller that still owns unsaved annotations', () => {
    const scope = openState('B.pdf')
    scope.pdfB64CacheRef.current.set('B.pdf', 'original bytes')
    scope.pdfCtlRef.current.set('B.pdf', { isDirty: () => true })
    editorFunction('openReceiptFile', scope)({ ...request, path: '/work/B.pdf', line: undefined })
    expect(scope.pdfB64CacheRef.current.get('B.pdf')).toBe('original bytes')
    expect(scope.loadContent).not.toHaveBeenCalled()
  })

  it('keeps POSIX tabs with different case distinct in the actual open adapter', () => {
    const scope = { cwd: '/work', active: 'b.ts', sessionId: 's', tabsRef: { current: [{ path: 'b.ts' }] },
      mdPreviewRef: { current: new Set() }, receiptLoad: null, loadError: null, monacoErr: null,
      receiptPath, receiptTabPath, flushSave: vi.fn(), saveViewState: vi.fn(), recordNav: vi.fn(), setSvnDiff: vi.fn(),
      toggleMdPreview: vi.fn(), setError: vi.fn(), setMonacoErr: vi.fn(), addTab: vi.fn(), stageFileAt: vi.fn(), loadContent: vi.fn() }
    editorFunction('openReceiptFile', scope)(request)
    expect(scope.addTab).toHaveBeenCalledWith('B.ts', true)
    expect(scope.loadContent).not.toHaveBeenCalled()
  })

  it('does not revalidate a dirty cached model during receipt retry', () => {
    const scope = { dirtyRef: { current: { 'B.ts': true } }, rpc: vi.fn() }
    editorFunction('checkCached', scope)({ getValue: () => 'unsaved' }, 'B.ts', 's', 2, vi.fn())
    expect(scope.rpc).not.toHaveBeenCalled()
  })

  it('does not replace B content when a flushed save for A finishes late', () => {
    const model = { getValue: () => 'saved A' }
    const scope = { modelsRef: { current: new Map([['A.ts', model]]) }, activeRef: { current: 'B.ts' },
      setDirtyMap: vi.fn(), setContent: vi.fn(), setContentPath: vi.fn(), setStatus: vi.fn(), setDiskFlag: vi.fn() }
    editorFunction('acceptSaved', scope)('A.ts', 'saved A', model)
    expect(scope.setContent).not.toHaveBeenCalled()
    expect(scope.setContentPath).not.toHaveBeenCalled()
    expect(scope.setDirtyMap.mock.calls[0][0]({ 'A.ts': true, 'B.ts': true })).toEqual({ 'A.ts': false, 'B.ts': true })
  })

  it('does not clear edits made after the saved text was captured', () => {
    const model = { getValue: () => 'new unsaved text' }
    const scope = { modelsRef: { current: new Map([['B.ts', model]]) }, activeRef: { current: 'B.ts' },
      setDirtyMap: vi.fn(), setContent: vi.fn(), setContentPath: vi.fn(), setStatus: vi.fn(), setDiskFlag: vi.fn() }
    editorFunction('acceptSaved', scope)('B.ts', 'older saved text', model)
    expect(scope.setDirtyMap).not.toHaveBeenCalled()
    expect(scope.setContent).not.toHaveBeenCalled()
  })

  it('updates the active unchanged saved model normally', () => {
    const model = { getValue: () => 'saved text' }
    const scope = { modelsRef: { current: new Map([['B.ts', model]]) }, activeRef: { current: 'B.ts' },
      setDirtyMap: vi.fn(), setContent: vi.fn(), setContentPath: vi.fn(), setStatus: vi.fn(), setDiskFlag: vi.fn() }
    editorFunction('acceptSaved', scope)('B.ts', 'saved text', model)
    expect(scope.setContent).toHaveBeenCalledWith('saved text')
    expect(scope.setContentPath).toHaveBeenCalledWith('B.ts')
    expect(scope.setDirtyMap).toHaveBeenCalledOnce()
  })

  it('does not replace edits made while clean-cache revalidation was in flight', async () => {
    let text = 'before'
    let reply!: (value: unknown) => void
    const scope = { dirtyRef: { current: {} }, loadCurrent: () => true, saveViewState: vi.fn(), setContent: vi.fn(), setStatus: vi.fn(),
      rpc: () => new Promise((resolve) => { reply = resolve }) }
    editorFunction('checkCached', scope)({ getValue: () => text }, 'B.ts', 's', 2, vi.fn())
    text = 'unsaved user edits'
    reply({ ok: true, content: 'disk data', version: 'v2' })
    await Promise.resolve()
    expect(scope.setContent).not.toHaveBeenCalled()
  })
})
