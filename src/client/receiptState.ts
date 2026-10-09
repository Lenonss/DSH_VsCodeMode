import { absoluteOf } from './tabActions.js'
import type { EditorRequest } from './openReceipt.js'

/** Identity of one load, committed together with its text or preview state. */
export interface ReceiptLoad {
  sessionId: string
  cwd: string | null
  path: string
  sequence: number
  status: 'loading' | 'ready' | 'error'
  error?: string
}

/** Current rendered facts; generic save/SVN errors intentionally have no receipt field. */
export interface ReceiptView {
  sessionId: string
  cwd?: string | null
  active: string | null
  sequence: number
  load: ReceiptLoad | null
  mounted: boolean
  blocked: boolean
  kind: 'text' | 'image' | 'pdf' | 'markdown'
  contentPath: string | null
  contentReady: boolean
  modelMatches: boolean
  positionMatches: boolean
  imageLoaded: boolean
  pdfLoaded: boolean
  engineError?: string | null
}

/**
 * Normalize identity using the workspace's path syntax, never the browser OS.
 * @public @author ddj 2026年09月28号
 * @param path File path.
 * @param cwd Workspace root, including remote POSIX roots on Windows clients.
 * @returns Absolute normalized identity, case folded only for Windows paths.
 */
export function receiptPath(path: string, cwd?: string | null): string {
  const value = absoluteOf(path, cwd)
  return /^(?:[a-z]:\/|\/\/)/i.test(value) ? value.toLowerCase() : value
}

/**
 * Preserve POSIX case when converting an external path into a tab path.
 * @public @author ddj 2026年09月28号
 * @param path External file path.
 * @param cwd Workspace root.
 * @returns Relative path only when it is inside the same correctly cased root.
 */
export function receiptTabPath(path: string, cwd?: string | null): string {
  const value = path.replace(/\\/g, '/')
  const base = (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (base && receiptPath(value).startsWith(receiptPath(base) + '/')) return value.slice(base.length + 1)
  return value
}

/**
 * Match a load to the current request, rendered path, and live load sequence.
 * @private @author ddj 2026年09月28号
 * @param request Claimed request.
 * @param view Current render and load metadata.
 * @returns Whether load facts belong to this exact target and generation.
 */
function ownsLoad(request: EditorRequest, view: ReceiptView): boolean {
  const load = view.load
  if (!request.path || !view.active || !load) return false
  const wanted = receiptPath(request.path, view.cwd)
  return request.sessionId === view.sessionId && load.sessionId === view.sessionId
    && load.sequence === view.sequence && receiptPath(load.path, load.cwd) === wanted
    && receiptPath(view.active, view.cwd) === wanted
}

/**
 * Confirm actual content/preview/navigation readiness for a correlated generation.
 * @public @author ddj 2026年09月28号
 * @param request Claimed external open.
 * @param view Rendered state, including model identity and DOM readiness.
 * @returns True only when the requested target is genuinely presented.
 */
export function receiptReadyFor(request: EditorRequest, view: ReceiptView): boolean {
  if (request.sessionId !== view.sessionId) return false
  if (!request.path) return view.mounted
  if (!ownsLoad(request, view) || view.load?.status !== 'ready' || view.blocked || view.engineError) return false
  if (view.kind === 'image') return view.imageLoaded
  if (view.kind === 'pdf') return view.pdfLoaded
  if (!view.contentReady || !view.contentPath || receiptPath(view.contentPath, view.cwd) !== receiptPath(request.path, view.cwd)) return false
  const positioned = request.line != null || request.column != null
  if (request.preview === true && !positioned && view.kind !== 'markdown') return false
  if (view.kind === 'markdown') return !positioned
  return view.modelMatches && (!positioned || view.positionMatches)
}

/**
 * Return only errors from this target's current load/render generation.
 * @public @author ddj 2026年09月28号
 * @param request Claimed request.
 * @param view Rendered metadata and editor-engine startup failure.
 * @returns Correlated error, otherwise null; prior files and save errors are ignored.
 */
export function receiptErrorFor(request: EditorRequest, view: ReceiptView): string | null {
  if (!ownsLoad(request, view)) return null
  if (view.engineError) return view.engineError
  return view.load?.status === 'error' ? view.load.error ?? '文件加载失败' : null
}

/**
 * Guard delayed load/render callbacks against a replacement generation.
 * @public @author ddj 2026年09月28号
 * @param load Current committed metadata.
 * @param sessionId Callback owner.
 * @param path Callback target, already normalized as a tab path.
 * @param sequence Callback load sequence.
 * @param currentSequence Live loader sequence.
 * @returns Whether this callback may update the receipt status.
 */
export function acceptsLoad(load: ReceiptLoad | null, sessionId: string, path: string, sequence: number, currentSequence: number): boolean {
  return Boolean(load && load.sessionId === sessionId && load.path === path
    && load.sequence === sequence && sequence === currentSequence)
}
