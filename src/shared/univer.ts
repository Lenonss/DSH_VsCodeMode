/** Optional Univer Office bridge contracts; no runtime engine dependency. @author ddj 2026年11月12号 */
export interface UniverCacheEntry {
  id: string
  revision: string
  source: string
  file: string
  createdAt: number
  bytes: number
  complete: boolean
}
export interface UniverCacheList {
  workspace: string
  root: string
  entries: UniverCacheEntry[]
  truncated: boolean
  writable: boolean
}
export interface UniverCachedOpen {
  imported: UniverImportResult
  sourceChanged: boolean
  reused: boolean
}
export interface UniverCleanItem {
  id: string
  status: 'deleted' | 'skipped' | 'failed'
  reason?: string
}

export interface UniverCapability {
  available: boolean
  writable: boolean
  reason?: string
  gateway?: string
}

export interface UniverImport {
  sessionId: string
  source: string
  target: string
  operationId: string
}

export interface UniverImportResult {
  success: boolean
  file?: string
  worktreeId?: string
  unitId?: string
  stage: 'validate' | 'create' | 'draft' | 'import' | 'complete'
  error?: string
}

export interface UniverUnit {
  unitId: string
  name?: string
  worktreeUrl?: string
  mergeUrl?: string
}

export interface UniverWorktree {
  worktreeId: string
  name?: string
  status: 'draft' | 'ready' | 'merged' | 'discarded'
  units: UniverUnit[]
  openUrl?: string
  worktreeUrl?: string
  mergeUrl?: string
}

export interface UniverFileState {
  ok: true
  file: string
  gatewayRunning?: boolean
  viewerUrl: string | null
  worktrees: UniverWorktree[]
}

/** @public @author ddj 2026年11月12号 @param path File identity. @returns True for binary Univer containers. */
export function isUniverPath(path: string): boolean {
  return /\.univer$/i.test(path)
}

/** @public @author ddj 2026年11月12号 @param path Source identity. @returns Office formats automatically offered to Univer. */
export function isOfficePath(path: string): boolean {
  return /\.(xlsx|docx|pptx)$/i.test(path)
}

/** @public @author ddj 2026年11月12号 @param path Source identity. @returns Formats accepted by the import bridge. */
export function canImportOffice(path: string): boolean {
  return isOfficePath(path) || /\.(csv|tsv)$/i.test(path)
}
