import { describe, it, expect, vi, afterEach } from 'vitest'
import { excelState, editExcel, exportExcel, allowClose, releaseExcel, renameExcel, loadExcel } from '../src/client/excel/controller.js'
import { LocaleType } from '@univerjs/presets'
import { downloadExcel } from '../src/client/excel/export.js'
import { decodeExcel } from '../src/client/excel/codec.js'
import { readFileSync } from 'node:fs'
vi.mock('../src/client/excel/export.js', () => ({ downloadExcel: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../src/client/excel/codec.js', () => ({ decodeExcel: vi.fn() }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

/** @private @author ddj 2026年10月28号 @returns Explicit deferred boundary for race assertions. */
function deferred<T>() {
  let resolve!: (result: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

/** @private @author ddj 2026年10月28号 @param scope Unique test scope. @returns Minimal loaded controller. */
function fixture(scope: string) {
  const state = excelState(scope, 'book.xlsx')
  state.document = { reasons: [], baseline: 'original', snapshot: { id: scope, name: 'Book', locale: LocaleType.ZH_CN, appVersion: '1.2.0', sheets: {}, sheetOrder: [], styles: {} } }
  return state
}

describe('Excel isolated lifecycle', () => {
  it('keeps every EditorView text-save entry behind an Excel guard', () => {
    const source = readFileSync(new URL('../src/client/ui/EditorView.ts', import.meta.url), 'utf8')
    const save = source.slice(source.indexOf('function saveDocument('), source.indexOf('const onEdit ='))
    expect(save).toMatch(/function saveDocument\(path, manual\)\s*\{\s*if \(isExcelPath\(path\)\) return/)
    expect(save).toMatch(/if \(isExcelPath\(active\)\).*return/)
    expect(save).toMatch(/const persistDirty[\s\S]*if \(isExcelPath\(path\)\) continue/)
    expect(source).toMatch(/if \(isExcelPath\(change.path\)\)/)
    const close = source.slice(source.indexOf('const closeTab ='), source.indexOf('const remapRenamedTabs ='))
    expect(close).toContain('lifetime !== reviewLifeRef.current')
    expect(close).toContain('state.editRevision !== revision')
    expect(close).not.toContain('commitClose(result)')
    expect(close).toContain('new Set(removable.map')
  })
  it('keeps later edits dirty while an older revision exports', async () => {
    const state = fixture('race-edit')
    const pending = deferred<void>()
    vi.mocked(downloadExcel).mockReturnValueOnce(pending.promise)
    editExcel(state)
    const exported = exportExcel(state, 'book.xlsx')
    editExcel(state)
    pending.resolve()
    await exported
    expect(state.exportRevision).toBe(1)
    expect(state.editRevision).toBe(2)
    expect(state.dirty).toBe(true)
    expect(state.document?.baseline).toBe('original')
  })
  it.each(['release', 'rename'])('invalidates pending encode/download on %s', async (operation) => {
    const state = fixture('race-' + operation)
    const pending = deferred<void>()
    let allowed!: () => boolean
    vi.mocked(downloadExcel).mockImplementationOnce(async (_snapshot, _path, current) => { allowed = current!; await pending.promise })
    const exported = exportExcel(state, 'book.xlsx')
    if (operation === 'release') releaseExcel('race-' + operation, 'book.xlsx')
    else renameExcel('race-' + operation, 'book.xlsx', 'new.xlsx')
    expect(allowed()).toBe(false)
    pending.resolve()
    await expect(exported).rejects.toThrow('身份变化')
    expect(state.exportRevision).toBe(-1)
  })
  it.each(['release', 'rename'])('drops pending parse result on %s', async (operation) => {
    const scope = 'parse-' + operation
    const state = excelState(scope, 'book.xlsx')
    const pending = deferred<NonNullable<typeof state.document>>()
    vi.mocked(decodeExcel).mockReturnValueOnce(pending.promise)
    const loaded = loadExcel(state, async () => ({ bytes: new Uint8Array() }))
    await Promise.resolve()
    if (operation === 'release') releaseExcel(scope, 'book.xlsx')
    else renameExcel(scope, 'book.xlsx', 'new.xlsx')
    pending.resolve(fixture('template').document!)
    await loaded
    expect(state.document).toBeUndefined()
  })
  it('does not close after a new edit arrives during export', async () => {
    const state = fixture('race-close')
    const pending = deferred<void>()
    vi.mocked(downloadExcel).mockReturnValueOnce(pending.promise)
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('window', { prompt: () => '导出', confirm })
    editExcel(state)
    const closing = allowClose(state, 'book.xlsx')
    editExcel(state)
    pending.resolve()
    expect(await closing).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })
  it('keeps dirty buffer and baseline after download fails', async () => {
    const state = fixture('download-fail')
    vi.mocked(downloadExcel).mockRejectedValueOnce(new Error('download failed'))
    editExcel(state)
    await expect(exportExcel(state, 'book.xlsx')).rejects.toThrow('download failed')
    expect(state.dirty).toBe(true)
    expect(state.exporting).toBe(false)
    expect(state.document?.baseline).toBe('original')
  })
  it('shares per-session/path state, never across sessions', () => {
    const state = fixture('one')
    expect(excelState('one', 'book.xlsx')).toBe(state)
    expect(excelState('two', 'book.xlsx')).not.toBe(state)
  })
  it('download captures revision and never clears dirty or baseline', async () => {
    const state = fixture('export')
    editExcel(state)
    await exportExcel(state, 'book.xlsx')
    expect(state.exportRevision).toBe(1)
    expect(state.dirty).toBe(true)
    expect(state.document?.baseline).toBe('original')
    expect(downloadExcel).toHaveBeenCalled()
  })
  it('unsupported preview cannot edit or export', async () => {
    const state = fixture('readonly')
    state.document!.reasons.push('chart')
    editExcel(state)
    expect(state.dirty).toBe(false)
    await expect(exportExcel(state, 'book.xlsx')).rejects.toThrow('不允许导出')
  })
  it('reload refuses dirty data without even reading disk', async () => {
    const state = fixture('reload')
    editExcel(state)
    const read = vi.fn()
    await expect(loadExcel(state, read, true)).rejects.toThrow('拒绝覆盖')
    expect(read).not.toHaveBeenCalled()
  })
  it('export alone never authorizes close when confirmation is cancelled', async () => {
    const state = fixture('close')
    editExcel(state)
    vi.stubGlobal('window', { prompt: () => '导出', confirm: () => false })
    expect(await allowClose(state, 'book.xlsx')).toBe(false)
    expect(state.dirty).toBe(true)
    vi.unstubAllGlobals()
  })
  it('rename migrates identity and release invalidates operations', () => {
    const state = fixture('rename')
    editExcel(state)
    renameExcel('rename', 'book.xlsx', 'new.xlsx')
    expect(excelState('rename', 'new.xlsx')).toBe(state)
    expect(state.path).toBe('new.xlsx')
    releaseExcel('rename', 'new.xlsx')
    expect(state.released).toBe(true)
    expect(excelState('rename', 'new.xlsx')).not.toBe(state)
  })
})
