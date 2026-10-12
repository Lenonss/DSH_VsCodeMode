/** Explorer-only SVN presentation; change-list/menu semantics stay untouched. @author ddj 2026年10月09号 */
import type { SvnChangeEntry, SvnItemStatus, SvnRemoteOutdatedEntry } from './svn.js'
import { SVN_FOLDER_STATUS_RANK, SVN_STATUS_LABEL } from './svn.js'

export type SvnIconKind = 'clean' | 'modified' | 'conflict' | 'added' | 'deleted' | 'unversioned' | 'ignored' | 'external'
export interface SvnExplorerIndex {
  entries: Map<string, SvnChangeEntry>
  folders: Map<string, { status: SvnItemStatus; count: number }>
  truncated: boolean
}
export interface SvnExplorerMark { kind: SvnIconKind; title: string }
export interface SvnViewRow { path: string; isDir: boolean }
export type SvnRefreshReason = 'read' | 'paths' | 'full' | 'calibrate'
export interface SvnViewRequest {
  sessionId?: string; rows: SvnViewRow[]; reason?: SvnRefreshReason; paths?: string[]
  clientId?: string; eventId?: string; revision?: number; generation?: number
}
export interface SvnViewMark { path: string; kind: SvnIconKind | null; count: number; stale: boolean }
export interface SvnViewPayload {
  scopeId: string; prefix: string; revision: number; generation: number; observedGeneration: number
  confirmedAt: number; complete: boolean; refreshing: boolean; scanMs: number; error: string
  mismatch: boolean; rows: SvnViewMark[]
}
const ICON_KIND: Record<SvnItemStatus, SvnIconKind> = {
  normal: 'clean', modified: 'modified', replaced: 'modified', added: 'added',
  deleted: 'deleted', missing: 'deleted', incomplete: 'conflict', obstructed: 'conflict',
  conflicted: 'conflict', unversioned: 'unversioned', ignored: 'ignored', external: 'external',
}

/** @public @author ddj 2026年10月09号 @param entry Local status. @returns Effective content/property status. */
export function localStatusOf(entry: SvnChangeEntry): SvnItemStatus {
  if (entry.props === 'conflicted') return 'conflicted'
  if (entry.status === 'normal' && entry.props === 'modified') return 'modified'
  return entry.status
}

/** @private @author ddj 2026年10月09号 @param path Relative path. @returns Ancestors, excluding self/root. */
function parentsOf(path: string): string[] {
  const result: string[] = []
  let dir = path
  while (dir.includes('/')) {
    dir = dir.slice(0, dir.lastIndexOf('/'))
    result.push(dir)
  }
  return result
}

/** @public @author ddj 2026年10月09号 @param entries Confirmed verbose statuses. @param truncated Incomplete snapshot. @returns Indexed entries and descendant changes. */
export function explorerIndexOf(entries: readonly SvnChangeEntry[], truncated = false): SvnExplorerIndex {
  const index: SvnExplorerIndex = { entries: new Map(), folders: new Map(), truncated }
  for (const entry of entries) {
    index.entries.set(entry.path, entry)
    const status = localStatusOf(entry)
    if (status === 'normal' || status === 'ignored' || status === 'external') continue
    for (const dir of parentsOf(entry.path)) {
      const prev = index.folders.get(dir)
      if (!prev) { index.folders.set(dir, { status, count: 1 }); continue }
      prev.count++
      if ((SVN_FOLDER_STATUS_RANK[status] ?? 0) > (SVN_FOLDER_STATUS_RANK[prev.status] ?? 0)) prev.status = status
    }
  }
  return index
}

/** @public @author ddj 2026年10月09号 @param index Confirmed snapshot. @param path Row path. @param isDir Directory row. @returns Overlay or null; absent entries never imply clean. */
export function explorerMarkOf(index: SvnExplorerIndex | null, path: string, isDir: boolean): SvnExplorerMark | null {
  if (!index) return null
  let entry = index.entries.get(path)
  if (!entry) {
    for (const parent of parentsOf(path)) {
      const ancestor = index.entries.get(parent)
      if (ancestor?.status === 'ignored' || ancestor?.status === 'unversioned') { entry = ancestor; break }
    }
  }
  let status = entry ? localStatusOf(entry) : null
  const agg = isDir ? index.folders.get(path) : null
  if (agg && (!status || (SVN_FOLDER_STATUS_RANK[agg.status] ?? 0) > (SVN_FOLDER_STATUS_RANK[status] ?? 0))) status = agg.status
  if (!status) return null
  if (status === 'normal' && (entry?.versioned !== true || (isDir && index.truncated))) return null
  const title = status === 'normal' ? '本地正常（已受控，未修改；不表示仓库无更新）' : SVN_STATUS_LABEL[status]
  return { kind: ICON_KIND[status], title: title + (agg ? '；子项 ' + agg.count + ' 处变更' : '') }
}

/** @public @author ddj 2026年10月09号 @param entries Remote changes. @returns Exact and ancestor update counts. */
export function remoteIndexOf(entries: readonly SvnRemoteOutdatedEntry[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const entry of entries) {
    for (const path of [entry.path, ...parentsOf(entry.path)]) result.set(path, (result.get(path) ?? 0) + 1)
  }
  return result
}

/** @public @author ddj 2026年10月09号 @param path WC-relative path. @param prefix Session path under WC. @returns Session-relative path or null outside session. */
export function explorerPathOf(path: string, prefix: string): string | null {
  if (!prefix || prefix === '.') return path
  return path.startsWith(prefix + '/') ? path.slice(prefix.length + 1) : null
}
