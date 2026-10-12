/** Bounded verbose status reader for confirmed clean icons. @author ddj 2026年10月09号 */
import type { SvnChangeEntry } from './shared/svn.js'
import { explorerPathOf } from './shared/svnExplorer.js'
import type { SvnViewPayload, SvnViewRequest } from './shared/svnExplorer.js'
import type { ExplorerQueue } from './svnExplorerCache.js'

/** Covers measured 125415-entry WC while bounding retained RPC objects, not XML bytes. */
export const EXPLORER_CAP = 250_000
export const EXPLORER_ROWS = 1000

/** @public @author ddj 2026年10月10号 @param raw Untrusted RPC request. @returns Whether bounded relative row/invalidation paths and tokens are legal. */
export function viewArgsValid(raw: unknown): raw is SvnViewRequest {
  if (!raw || typeof raw !== 'object') return false
  const args = raw as SvnViewRequest
  if (!Array.isArray(args.rows) || args.rows.length > EXPLORER_ROWS) return false
  if (args.reason && !['read', 'paths', 'full', 'calibrate'].includes(args.reason)) return false
  if (args.paths && (!Array.isArray(args.paths) || args.paths.length > 256 || !args.paths.every(viewPathValid))) return false
  if (!args.rows.every((row) => row && typeof row.isDir === 'boolean' && viewPathValid(row.path))) return false
  if (args.rows.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row.path)) + 80, 0) > 240 * 1024) return false
  if ([args.clientId, args.eventId].some((id) => id !== undefined && (typeof id !== 'string' || !id || id.length > 128))) return false
  if (args.reason && args.reason !== 'read' && (!args.clientId || !args.eventId)) return false
  return [args.revision, args.generation].every((n) => n === undefined || (Number.isSafeInteger(n) && n >= 0))
}
/** @private @author ddj 2026年10月10号 @param path Untrusted relative path. @returns No absolute/traversal/control characters; max row size bounds JSON. */
function viewPathValid(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > 1024 || /[\x00-\x1f]/.test(path)) return false
  const normalized = path.replace(/\\/g, '/')
  return !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..')
}

/** @public @author ddj 2026年10月10号 @param queue Scope-owned index. @param scopeId Canonical scope. @param prefix WC prefix. @param args Rows and consistency token. @returns Compact rows; page mismatch returns no mixed-version data. */
export function explorerViewOf(queue: ExplorerQueue, scopeId: string, prefix: string, args: SvnViewRequest): SvnViewPayload {
  const state = queue.state()
  const mismatch = (args.revision !== undefined && args.revision !== state.revision)
    || (args.generation !== undefined && args.generation !== state.generation)
  const rows = mismatch ? [] : args.rows.map((row) => {
    const { mark, count } = queue.data.mark(row.path, row.isDir)
    return { path: row.path, kind: mark?.kind ?? null, count, stale: queue.stale(row.path, row.isDir) }
  })
  return { scopeId, prefix, ...state, mismatch, rows }
}

/** @public @author ddj 2026年10月09号 @param xml Collected CLI output. @returns True only for a complete status document. */
export function statusXmlValid(xml: string): boolean {
  return /^\s*(?:<\?xml[^>]*>\s*)?<status(?:\s[^>]*)?>/.test(xml) && /<\/status>\s*$/.test(xml)
}

/** @public @author ddj 2026年10月09号 @param entries WC-relative statuses. @param prefix Session prefix. @returns Session-relative subset. */
export function scopeEntriesOf(entries: readonly SvnChangeEntry[], prefix: string): SvnChangeEntry[] {
  const scoped: SvnChangeEntry[] = []
  for (const entry of entries) {
    const path = explorerPathOf(entry.path, prefix)
    if (path !== null) scoped.push({ ...entry, path })
  }
  return scoped
}
