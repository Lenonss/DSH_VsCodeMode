import type { IWorkbookData } from '@univerjs/presets'
import { decodeExcel } from './codec.js'
import { downloadExcel } from './export.js'
import type { ExcelDocument } from './model.js'

export interface ExcelState {
  document?: ExcelDocument
  path?: string
  generation: number
  released?: boolean
  exporting?: boolean
  node?: HTMLElement
  dispose?: () => void
  capture?: () => IWorkbookData
  loading?: Promise<void>
  error?: string
  notice?: string
  editRevision: number
  exportRevision: number
  dirty: boolean
  listeners: Set<() => void>
}
// Session/path controllers deliberately survive view unmount and session switches.
// Only an explicitly confirmed close/reload can release them; no cell content enters tab settings.
const sessions = new Map<string, Map<string, ExcelState>>()

/** @public @author ddj 2026年10月28号 @param scope Session/workspace scope. @param path Canonical path. @returns Shared controller for every pane and floating view. */
export function excelState(scope: string, path: string): ExcelState {
  let paths = sessions.get(scope)
  if (!paths) { paths = new Map(); sessions.set(scope, paths) }
  let state = paths.get(path)
  if (!state) { state = { path, generation: 0, editRevision: 0, exportRevision: -1, dirty: false, listeners: new Set() }; paths.set(path, state) }
  return state
}

/** @public @author ddj 2026年10月28号 @param state Shared state. @sideEffects Notifies every owner without changing the original disk baseline. */
export function notifyExcel(state: ExcelState): void {
  for (const listener of state.listeners) listener()
}

/** @public @author ddj 2026年10月28号 @param state Shared state. @sideEffects Records an edit only, never saves to disk. */
export function editExcel(state: ExcelState): void {
  if (state.document?.reasons.length) return
  state.dirty = true
  state.editRevision++
  notifyExcel(state)
}

/** @public @author ddj 2026年10月28号 @param state Controller. @param read Bounded binary reader. @param force Explicit reload request. @returns Identity-guarded parse completion. */
export async function loadExcel(state: ExcelState, read: () => Promise<{ bytes: Uint8Array; version?: string }>, force = false): Promise<void> {
  if (state.released) throw new Error('Excel 已关闭')
  if (state.loading) return state.loading
  if (state.document && !force) { if (state.dirty) state.notice = '已恢复此会话中保留的 Excel 编辑；原件未修改，不承诺崩溃恢复。'; return }
  const generation = ++state.generation
  if (state.dirty) throw new Error('Excel 含未导出的编辑，拒绝覆盖；请先明确放弃或取消')
  /** @private @author ddj 2026年10月28号 @sideEffects Loads this controller only; stale unmounted views never own the result. */
  async function parse(): Promise<void> {
    try {
      const source = await read()
      const document = await decodeExcel(source.bytes)
      if (state.released || generation !== state.generation) return
      document.baseline = source.version
      state.dispose?.()
      state.dispose = undefined
      state.node = undefined
      state.capture = undefined
      state.document = document
      state.error = undefined
      state.notice = undefined
    } catch (error) { state.error = String(error); throw error }
    finally { state.loading = undefined; notifyExcel(state) }
  }
  state.loading = parse()
  return state.loading
}

/** @public @author ddj 2026年10月28号 @param state Shared controller. @param path Download filename. @returns Captured revision whose download was initiated, not proof the browser saved it. */
export async function exportExcel(state: ExcelState, path: string): Promise<number> {
  if (!state.document || state.document.reasons.length) throw new Error('只读或未加载的 Excel 不允许导出')
  if (state.exporting || state.released) throw new Error('Excel 已关闭或正在导出')
  const revision = state.editRevision
  const generation = state.generation
  const snapshot = structuredClone(state.capture?.() || state.document.snapshot)
  state.exporting = true
  try { await downloadExcel(snapshot, state.path || path, () => !state.released && state.generation === generation) }
  finally { state.exporting = false }
  if (state.released || state.generation !== generation) throw new Error('Excel 导出已取消，文档身份变化')
  state.exportRevision = revision
  state.notice = '仅已发起下载，请确认浏览器保存。原件未修改，编辑仍保留。'
  notifyExcel(state)
  return revision
}

/** @public @author ddj 2026年10月28号 @param state Dirty shared controller. @param path Download name. @returns True only after explicit abandonment; exporting alone never authorizes close. */
export async function allowClose(state: ExcelState, path: string): Promise<boolean> {
  if (!state.dirty) return true
  const revision = state.editRevision
  const choice = window.prompt('Excel 编辑尚未保存到原件。输入：导出 / 放弃 / 取消。导出后仍需确认放弃，取消保留编辑。', '取消')
  if (choice === '放弃') return window.confirm('明确放弃此文件的所有未导出编辑？（原件不受影响）')
  if (choice !== '导出') return false
  try { await exportExcel(state, path) } catch (error) { state.notice = String(error); notifyExcel(state); return false }
  if (state.released || state.editRevision !== revision) return false
  return window.confirm('仅已发起下载，请先确认浏览器保存成功。是否明确放弃当前编辑并关闭？取消将继续保留编辑。')
}

/** @public @author ddj 2026年10月28号 @param scope Session. @param path Confirmed-close path. @sideEffects Releases shared view only after the caller has confirmed abandonment. */
export function releaseExcel(scope: string, path: string): void {
  const state = sessions.get(scope)?.get(path)
  if (state) { state.released = true; state.generation++; state.dispose?.(); state.listeners.clear() }
  sessions.get(scope)?.delete(path)
}

/** @public @author ddj 2026年10月28号 @returns Whether retained edits in any session require beforeunload warning. */
export function unsafeExcel(): boolean {
  for (const paths of sessions.values()) for (const state of paths.values()) if (state.dirty) return true
  return false
}

/** @public @author ddj 2026年10月28号 @param scope Session. @param from Old path. @param to Renamed path. @sideEffects Migrates shared identity without touching edits. */
export function renameExcel(scope: string, from: string, to: string): void {
  const paths = sessions.get(scope)
  if (!paths) return
  for (const [path, state] of [...paths]) {
    if (path !== from && !path.startsWith(from + '/')) continue
    paths.delete(path)
    state.generation++
    state.path = to + path.slice(from.length)
    paths.set(state.path, state)
  }
}
