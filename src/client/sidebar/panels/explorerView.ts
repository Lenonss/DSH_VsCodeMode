/** Compact explorer lifecycle, independently testable without browser/React. @author ddj 2026年10月10号 */
import type { SvnRefreshReason, SvnViewMark, SvnViewPayload, SvnViewRequest, SvnViewRow } from '../../../shared/svnExplorer.js'

export interface ExplorerNotice { scope?: string; paths?: string[]; eventId?: string; kind?: 'text' | 'structure' | 'svn' | 'unknown' }
export interface ExplorerView extends Omit<SvnViewPayload, 'rows'> { marks: Map<string, SvnViewMark> }
type ViewResult = ({ ok: true } & SvnViewPayload) | { ok: false; error: string }
type ViewFetch = (args: SvnViewRequest, signal: AbortSignal) => Promise<ViewResult>
const EMPTY: ExplorerView = { scopeId: '', prefix: '.', revision: 0, generation: 0, observedGeneration: 0, confirmedAt: 0,
  complete: false, refreshing: false, scanMs: 0, error: '', mismatch: false, marks: new Map() }
let nextClient = 0

/** @public @author ddj 2026年10月10号 @param previous Stable row objects. @param rows Compact projection. @returns Same map when unchanged; otherwise replaces only changed marks. */
export function applyViewRows(previous: Map<string, SvnViewMark>, rows: readonly SvnViewMark[]): Map<string, SvnViewMark> {
  const next = new Map<string, SvnViewMark>()
  let changed = previous.size !== rows.length
  for (const row of rows) {
    const old = previous.get(row.path)
    const equal = old && old.kind === row.kind && old.count === row.count && old.stale === row.stale
    next.set(row.path, equal ? old : row)
    if (!equal) changed = true
  }
  return changed ? next : previous
}
/** @private @author ddj 2026年10月10号 @param path Row. @param root Changed path. @returns Segment-bound overlap incl. ancestors. */
function overlaps(path: string, root: string): boolean {
  const a = path.replace(/\\/g, '/').toLowerCase(), b = root.replace(/\\/g, '/').toLowerCase()
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
}

// --region Single-flight client projection
/** @public @author ddj 2026年10月10号 Owns fetch/debounce/calibration; does not own or cancel shared Host scans. */
export class ExplorerViewClient {
  private view: ExplorerView = { ...EMPTY, marks: new Map() }
  private rows: SvnViewRow[] = []
  private paths = new Set<string>()
  private reason: SvnRefreshReason = 'read'
  private pending = false
  private since = 0
  private last = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private controller: AbortController | null = null
  private stopped = false
  private visible = true
  private rowEpoch = 0
  private sequence = 0
  private readonly clientId = 'explorer-' + Date.now() + '-' + (++nextClient)
  private readonly events = new Set<string>()
  private lastNotice = 0
  sessionId?: string

  /** @public @author ddj 2026年10月10号 @param scope Workspace UI key. @param fetch Authenticated compact RPC. @param publish State callback. @param remoteDrop Evidence invalidation callback. */
  constructor(readonly scope: string, private readonly fetch: ViewFetch, private readonly publish: (view: ExplorerView) => void,
    private readonly remoteDrop: () => void) {}

  /** @public @author ddj 2026年10月10号 @param rows Expanded/displayed paths. Updates projection only, never forces a scan. */
  setRows(rows: readonly SvnViewRow[]): void {
    this.rows = [...rows]; this.rowEpoch++
    this.enqueue('read', 0)
  }
  /** @public @author ddj 2026年10月10号 @param notice Optional scope/path/id and evidence kind. Ignore another scope; repeated IDs do not dirty twice. */
  notify(notice: ExplorerNotice = {}): void {
    if (notice.scope && notice.scope !== this.scope) return
    if (notice.eventId && this.events.has(notice.eventId)) return
    if (notice.eventId) { this.events.add(notice.eventId); if (this.events.size > 512) this.events.delete(this.events.values().next().value!) }
    this.lastNotice = Date.now()
    if (notice.kind !== 'text') this.remoteDrop()
    const paths = notice.paths?.filter(Boolean)
    const invalid = paths?.some((path) => typeof path !== 'string' || path.length > 1024 || /^[\\/]|^[A-Za-z]:|[\x00-\x1f]/.test(path)
      || path.replace(/\\/g, '/').split('/').includes('..'))
    if (!paths?.length || invalid) this.reason = 'full'
    else for (const path of paths) this.paths.add(path)
    if (this.paths.size > 256) this.reason = 'full'
    if (this.reason !== 'full') this.reason = 'paths'
    if (this.reason === 'full') this.paths.clear()
    this.stale(this.reason === 'full' ? null : paths!)
    this.enqueue(this.reason, 300)
  }
  /** @public @author ddj 2026年10月10号 Unknown-origin changes-list replacement requests one calibration, not reference-driven full scan. */
  changes(): void { if (Date.now() - this.lastNotice > 1000) this.enqueue('calibrate', 300) }
  /** @public @author ddj 2026年10月10号 @param visible Page visibility. Hide clears automatic work, show/focus calibrates only after five seconds. */
  visibility(visible: boolean): void {
    this.visible = visible
    if (!visible) { if (this.timer) clearTimeout(this.timer); this.timer = null; return }
    if (Date.now() - this.view.confirmedAt > 5000) this.enqueue('calibrate', 0)
    else this.enqueue('read', 0)
  }
  /** @public @author ddj 2026年10月10号 Explicit offline full refresh; remote evidence no longer trusted. */
  refresh(): void { this.notify({ kind: 'unknown' }) }

  /** @private @author ddj 2026年10月10号 @param paths Dirty paths or unknown/full. Mark stale immediately, retain independent rows and anomalous evidence. */
  private stale(paths: readonly string[] | null): void {
    const rows = [...this.view.marks.values()].map((row) => !paths || paths.some((path) => overlaps(row.path, path)) ? { ...row, stale: true } : row)
    this.view = { ...this.view, complete: false, refreshing: true, marks: applyViewRows(this.view.marks, rows) }
    this.publish(this.view)
  }
  /** @private @author ddj 2026年10月10号 @param reason Requested work. @param delay Tail wait, bounded by one second. */
  private enqueue(reason: SvnRefreshReason, delay: number): void {
    if (this.stopped) return
    if (this.reason === 'read' || (reason === 'full')) this.reason = reason
    if (!this.pending) this.since = Date.now()
    this.pending = true; this.last = Date.now()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.controller || !this.visible) return
    const wait = Math.max(0, Math.min(this.last + delay, this.since + 1000) - Date.now())
    this.timer = setTimeout(() => { this.timer = null; void this.read() }, wait)
  }
  /** @private @author ddj 2026年10月10号 @param args First page carries idempotent invalidation. @param signal Fetch only cancellation. @returns Version-consistent pages, bounded retries. */
  private async pages(args: SvnViewRequest, signal: AbortSignal): Promise<SvnViewPayload> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let snapshot: SvnViewPayload | null = null
      const rows: SvnViewMark[] = []
      for (let offset = 0; offset < Math.max(1, this.rows.length); offset += 1000) {
        const out = await this.fetch({ ...args, rows: this.rows.slice(offset, offset + 1000),
          revision: snapshot?.revision, generation: snapshot?.generation }, signal)
        if (!out.ok) throw new Error(out.error)
        if (out.mismatch) { snapshot = null; break }
        if (snapshot && snapshot.scopeId !== out.scopeId) throw new Error('SVN 工作区范围发生变化')
        snapshot = out; rows.push(...out.rows)
      }
      if (snapshot) return { ...snapshot, rows }
    }
    throw new Error('SVN 状态正在变化，稍后重新投影')
  }
  /** @private @author ddj 2026年10月10号 Apply compact results; notices during fetch retain dirtiness and receive one follow-up request. */
  private async read(): Promise<void> {
    if (this.stopped || this.controller) return
    const controller = new AbortController(), epoch = this.rowEpoch
    this.controller = controller
    const reason = this.reason, paths = [...this.paths]
    const args: SvnViewRequest = { sessionId: this.sessionId, rows: [], reason, paths,
      clientId: this.clientId, eventId: String(++this.sequence) }
    this.reason = 'read'; this.paths.clear(); this.pending = false
    try {
      const out = await this.pages(args, controller.signal)
      if (this.stopped || controller.signal.aborted) return
      if (epoch !== this.rowEpoch) { this.enqueue('read', 0); return }
      this.view = { ...out, marks: applyViewRows(this.view.marks, out.rows) }
      if (this.pending && this.reason !== 'read') this.stale(this.reason === 'paths' ? [...this.paths] : null)
      else this.publish(this.view)
    } catch (error) {
      if (this.stopped || controller.signal.aborted) return
      this.stale(null)
      this.view = { ...this.view, refreshing: false, error: String(error) }; this.publish(this.view)
    } finally {
      this.controller = null
      if (!this.stopped) this.follow()
    }
  }
  /** @private @author ddj 2026年10月10号 Schedule merged notices, short read-only polls, or completion-based adaptive offline calibration; hidden pages never poll. */
  private follow(): void {
    if (this.pending) { this.enqueue(this.reason, 300); return }
    if (!this.visible) return
    const reason = this.view.refreshing ? 'read' : 'calibrate'
    const delay = this.view.refreshing ? 250 : Math.max(30_000, 20 * this.view.scanMs)
    this.timer = setTimeout(() => { this.timer = null; this.enqueue(reason, 0) }, delay)
  }
  /** @public @author ddj 2026年10月10号 Release UI work; does not terminate shared Host scan. */
  dispose(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.controller?.abort(); this.events.clear(); this.paths.clear()
  }
}
// --endregion
