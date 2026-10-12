/** Host-only scoped SVN index and single-flight invalidation queue. @author ddj 2026年10月10号 */
import type { SvnChangeEntry, SvnItemStatus } from './shared/svn.js'
import { SVN_FOLDER_STATUS_RANK } from './shared/svn.js'
import { explorerMarkOf, localStatusOf } from './shared/svnExplorer.js'
import type { SvnExplorerIndex } from './shared/svnExplorer.js'
import { EXPLORER_CAP } from './svnExplorer.js'

export interface ExplorerScan { entries: SvnChangeEntry[]; truncated: boolean; roots?: readonly string[] }
export type ExplorerScanner = (paths: readonly string[], signal: AbortSignal) => Promise<ExplorerScan>
export interface ExplorerChange { paths?: readonly string[]; full?: boolean; event?: string }
export interface ExplorerState {
  revision: number; generation: number; observedGeneration: number; confirmedAt: number; complete: boolean
  refreshing: boolean; scanMs: number; error: string
}
type StatusCounts = Map<SvnItemStatus, number>
const QUIET_MS = 300
const MAX_WAIT_MS = 1000
const EVENT_CAP = 512

// --region Path sets and normalization
/** @public @author ddj 2026年10月10号 @param path Validated relative path. @param windows Case-insensitive platform. @returns Canonical lookup key, preserving row spelling separately. */
export function explorerKey(path: string, windows = process.platform === 'win32'): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return windows ? normalized.toLowerCase() : normalized
}
/** @private @author ddj 2026年10月10号 @param path Canonical descendant. @param root Canonical subtree. @returns Segment-bound membership including root. */
function within(path: string, root: string): boolean { return !root || path === root || path.startsWith(root + '/') }
/** @private @author ddj 2026年10月10号 @param path Canonical entry. @returns Ancestors excluding virtual scope root. */
function ancestors(path: string): string[] {
  const parents: string[] = []
  let parent = path
  while (parent.includes('/')) { parent = parent.slice(0, parent.lastIndexOf('/')); parents.push(parent) }
  return parents
}
/** @public @author ddj 2026年10月10号 @param paths Changed paths. @param windows Platform matching. @returns Minimal parent subtree set; empty root means full scan. */
export function scanRootsOf(paths: readonly string[], windows = process.platform === 'win32'): string[] {
  const roots: string[] = []
  for (const raw of paths) {
    const path = explorerKey(raw, windows)
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (roots.some((root) => within(parent, root))) continue
    for (let i = roots.length - 1; i >= 0; i--) if (within(roots[i], parent)) roots.splice(i, 1)
    roots.push(parent)
  }
  return roots
}
// --endregion

// --region Incremental subtree index
/** @public @author ddj 2026年10月10号 Retains authoritative entries and decrementable ancestor counts; no client-wide payload. */
export class ExplorerIndex {
  readonly index: SvnExplorerIndex = { entries: new Map(), folders: new Map(), truncated: false }
  private readonly counts = new Map<string, StatusCounts>()
  private readonly children = new Map<string, Set<string>>()
  /** @public @author ddj 2026年10月10号 @param windows Case-insensitive lookup mode. */
  constructor(private readonly windows = process.platform === 'win32') {}

  /** @private @author ddj 2026年10月10号 @param entry Entry contribution. @param delta Add or remove. Updates strongest status after downgrade. */
  private contribute(entry: SvnChangeEntry, delta: number): void {
    const status = localStatusOf(entry)
    if (status === 'normal' || status === 'ignored' || status === 'external') return
    for (const parent of ancestors(entry.path)) {
      const counts = this.counts.get(parent) ?? new Map<SvnItemStatus, number>()
      const next = (counts.get(status) ?? 0) + delta
      if (next > 0) counts.set(status, next)
      else counts.delete(status)
      if (!counts.size) { this.counts.delete(parent); this.index.folders.delete(parent); continue }
      this.counts.set(parent, counts)
      let strongest: SvnItemStatus = 'normal'
      let count = 0
      for (const [item, n] of counts) {
        count += n
        if ((SVN_FOLDER_STATUS_RANK[item] ?? 0) > (SVN_FOLDER_STATUS_RANK[strongest] ?? 0)) strongest = item
      }
      this.index.folders.set(parent, { status: strongest, count })
    }
  }

  /** @private @author ddj 2026年10月10号 @param path Canonical entry. Build direct child membership, including implicit ancestors. */
  private link(path: string): void {
    let child = path
    while (child) {
      const parent = child.includes('/') ? child.slice(0, child.lastIndexOf('/')) : ''
      const siblings = this.children.get(parent) ?? new Set<string>()
      siblings.add(child); this.children.set(parent, siblings)
      child = parent
    }
  }
  /** @private @author ddj 2026年10月10号 @param path Removed entry. Prune only empty implicit ancestors; retained siblings remain indexed. */
  private unlink(path: string): void {
    let child = path
    while (child && !this.index.entries.has(child) && !this.children.get(child)?.size) {
      const parent = child.includes('/') ? child.slice(0, child.lastIndexOf('/')) : ''
      this.children.delete(child)
      const siblings = this.children.get(parent)
      siblings?.delete(child)
      if (!siblings?.size) this.children.delete(parent)
      child = parent
    }
  }
  /** @private @author ddj 2026年10月10号 @param roots Subtree membership roots. @returns Retained affected entries only; no whole-index iteration for local replacement. */
  private members(roots: readonly string[]): string[] {
    const result = new Set<string>(), pending = [...roots], visited = new Set<string>()
    while (pending.length) {
      const path = pending.pop()!
      if (visited.has(path)) continue
      visited.add(path)
      if (this.index.entries.has(path)) result.add(path)
      for (const child of this.children.get(path) ?? []) pending.push(child)
    }
    return [...result]
  }

  /** @public @author ddj 2026年10月10号 @param roots Replaced session-relative subtrees. @param result Complete or bounded scan. @throws Capacity mismatch on partial replacement; caller must full-calibrate. */
  replace(roots: readonly string[], result: ExplorerScan): void {
    const keys = roots.map((root) => explorerKey(root, this.windows))
    const full = keys.includes('')
    const incoming = new Map<string, SvnChangeEntry>()
    for (const entry of result.entries) {
      const path = explorerKey(entry.path, this.windows)
      if (keys.some((root) => within(path, root))) incoming.set(path, { ...entry, path })
    }
    const removed = full ? [] : this.members(keys)
    if (!full && (result.truncated || this.index.entries.size - removed.length + incoming.size > EXPLORER_CAP)) {
      throw new Error('局部 SVN 状态不完整，需要全量校准')
    }
    if (full) this.clear()
    else for (const path of removed) {
      this.contribute(this.index.entries.get(path)!, -1)
      this.index.entries.delete(path)
      this.unlink(path)
    }
    for (const [path, entry] of incoming) { this.index.entries.set(path, entry); this.link(path); this.contribute(entry, 1) }
    if (full) this.index.truncated = result.truncated
  }

  /** @public @author ddj 2026年10月10号 Release retained entries and aggregation counters. */
  clear(): void { this.index.entries.clear(); this.index.folders.clear(); this.counts.clear(); this.children.clear() }

  /** @public @author ddj 2026年10月10号 @param path Display row spelling. @param isDir Directory row. @returns Exact/ancestor mark and dirty descendant count. */
  mark(path: string, isDir: boolean) {
    const key = explorerKey(path, this.windows)
    return { mark: explorerMarkOf(this.index, key, isDir), count: isDir ? this.index.folders.get(key)?.count ?? 0 : 0 }
  }
}
// --endregion

// --region Scoped ownership
/** @public @author ddj 2026年10月10号 Two retained scope indexes; active work is never evicted to satisfy a new reader. */
export class ExplorerScopes {
  private readonly scopes = new Map<string, ExplorerQueue>()
  /** @public @author ddj 2026年10月10号 @param key Canonical root/session key. @param scan Scanner bound to this scope. @param now Clock. @param windows Matching. @returns Shared owner; refuses new scopes if all retained owners are busy. */
  get(key: string, scan: ExplorerScanner, now = Date.now, windows = process.platform === 'win32'): ExplorerQueue {
    const existing = this.scopes.get(key)
    if (existing) { this.scopes.delete(key); this.scopes.set(key, existing); return existing }
    if (this.scopes.size >= 2) {
      const idle = [...this.scopes].find(([, queue]) => queue.idle())
      if (!idle) throw new Error('SVN 状态扫描繁忙，请稍后重试')
      idle[1].dispose()
      this.scopes.delete(idle[0])
    }
    const queue = new ExplorerQueue(scan, now, windows)
    this.scopes.set(key, queue)
    return queue
  }
  /** @public @author ddj 2026年10月10号 Release all scoped work and retained state. */
  dispose(): void { for (const queue of this.scopes.values()) queue.dispose(); this.scopes.clear() }
}
// --endregion

// --region Single-flight dirty queue
/** @public @author ddj 2026年10月10号 Coalesces generations without swallowing changes arriving during a scan. */
export class ExplorerQueue {
  readonly data: ExplorerIndex
  private generation = 0
  private observed = 0
  private revision = 0
  private confirmedAt = 0
  private scanMs = 0
  private error = ''
  private fullDirty = false
  private readonly dirty = new Set<string>()
  private active: readonly string[] | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingSince: number | null = null
  private lastEventAt = 0
  private controller: AbortController | null = null
  private flight: Promise<void> | null = null
  private stopped = false
  private readonly events = new Set<string>()
  private staleRoots: readonly string[] | null = null

  /** @public @author ddj 2026年10月10号 @param scan Managed scoped scan. @param now Injectable clock. @param windows Canonical path matching. */
  constructor(private readonly scan: ExplorerScanner, private readonly now = Date.now, private readonly windows = process.platform === 'win32') {
    this.data = new ExplorerIndex(windows)
  }

  /** @public @author ddj 2026年10月10号 @param change Path/full invalidation and idempotency token. @returns Whether a new change was registered. */
  invalidate(change: ExplorerChange = { full: true }): boolean {
    if (this.stopped || (change.event && this.events.has(change.event))) return false
    if (change.event) {
      this.events.add(change.event)
      if (this.events.size > EVENT_CAP) this.events.delete(this.events.values().next().value!)
    }
    this.generation++
    this.staleRoots = null
    this.lastEventAt = this.now()
    if (this.pendingSince === null) this.pendingSince = this.lastEventAt
    if (change.full || !change.paths?.length || !this.confirmedAt || this.data.index.truncated) this.fullDirty = true
    for (const path of change.paths ?? []) this.dirty.add(explorerKey(path, this.windows))
    if (this.dirty.size > 256 || scanRootsOf([...this.dirty], this.windows).length > 32) this.fullDirty = true
    if (this.fullDirty) this.dirty.clear()
    this.schedule()
    return true
  }

  /** @private @author ddj 2026年10月10号 Tail debounce has a hard max wait; active scans retain one merged follow-up batch. */
  private schedule(): void {
    if (this.stopped || this.active || this.pendingSince === null) return
    if (this.timer) clearTimeout(this.timer)
    const delay = Math.max(0, Math.min(this.lastEventAt + QUIET_MS, this.pendingSince + MAX_WAIT_MS) - this.now())
    this.timer = setTimeout(() => { this.timer = null; this.launch() }, delay)
  }

  /** @private @author ddj 2026年10月10号 Starts one scan, snapshots generation and dirtiness before yielding. */
  private launch(): void {
    if (this.stopped || this.active || this.pendingSince === null) return
    const roots = this.fullDirty ? [''] : scanRootsOf([...this.dirty], this.windows)
    const generation = this.generation
    this.fullDirty = false
    this.dirty.clear()
    this.pendingSince = null
    this.active = roots
    this.staleRoots = null
    this.controller = new AbortController()
    this.flight = this.run(roots, generation, this.controller.signal)
  }

  /** @private @author ddj 2026年10月10号 @param roots Scan subtrees. @param generation Captured invalidation generation. @param signal Owner disposal. Applies known evidence but never confirms newer dirty paths. */
  private async run(roots: readonly string[], generation: number, signal: AbortSignal): Promise<void> {
    const started = this.now()
    try {
      const result = await this.scan(roots, signal)
      if (this.stopped) return
      this.data.replace(result.roots ?? roots, result)
      this.observed = generation
      this.revision++
      this.error = ''
      if (generation === this.generation && !result.truncated) this.confirmedAt = this.now()
    } catch (failure) {
      if (this.stopped) return
      this.error = String(failure)
      // A failed subtree must not keep green evidence. Retry only on a later read/event, not a spin loop.
      this.fullDirty = true
    } finally {
      this.scanMs = Math.max(0, this.now() - started)
      this.active = null
      this.staleRoots = null
      this.controller = null
      this.flight = null
      this.schedule()
    }
  }

  /** @public @author ddj 2026年10月10号 @param path Display row. @param isDir Directory membership. @returns Whether evidence intersects active/queued changes or incomplete state. */
  stale(path: string, isDir: boolean): boolean {
    if (!this.confirmedAt || this.fullDirty || this.data.index.truncated) return true
    const key = explorerKey(path, this.windows)
    const roots = this.staleRoots ??= [...(this.active ?? []), ...scanRootsOf([...this.dirty], this.windows)]
    return roots.some((root) => within(key, root) || (isDir && within(root, key)))
  }

  /** @public @author ddj 2026年10月10号 @returns Lightweight scope metadata; freshness is independent of cache TTL. */
  state(): ExplorerState {
    return { revision: this.revision, generation: this.generation, observedGeneration: this.observed, confirmedAt: this.confirmedAt,
      complete: this.confirmedAt > 0 && !this.data.index.truncated && !this.fullDirty && !this.active && !this.dirty.size,
      refreshing: this.active !== null || this.timer !== null, scanMs: this.scanMs, error: this.error }
  }

  /** @public @author ddj 2026年10月10号 @returns First-load confirmation; warm callers project immediately with stale flags. */
  async initial(): Promise<void> {
    if (this.stopped) throw new Error('SVN 状态调度已释放')
    if (this.confirmedAt || this.revision || this.error) return
    if (this.pendingSince === null && !this.active) this.invalidate({ full: true })
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.launch()
    await this.flight
  }

  /** @public @author ddj 2026年10月10号 @returns Whether an owner may evict this scope without killing shared work. */
  idle(): boolean { return !this.active && !this.timer }

  /** @public @author ddj 2026年10月10号 Abort owned scans and timers; late completions cannot restore state. */
  dispose(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.controller?.abort(new Error('SVN 状态调度已释放'))
    this.dirty.clear()
    this.events.clear()
    this.data.clear()
  }
}
// --endregion
