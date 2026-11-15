/** Optional document routing without importing an Office engine. @author ddj 2026年11月12号 */
import { isOfficePath, isUniverPath } from '../../shared/univer.js'
import type { UniverCapability, UniverFileState, UniverWorktree } from '../../shared/univer.js'

/** @public @author ddj 2026年11月12号 @param path File. @param capability Optional installed capability. @returns Whether the document uses the embedded host. */
export function routesUniver(path: string, capability?: UniverCapability): boolean {
  return isUniverPath(path) || (isOfficePath(path) && capability?.available === true)
}

/** @public @author ddj 2026年11月12号 @param value Server-provided URL. @param origin Current application origin. @param sessionId Current session. @returns Validated same-origin Viewer URL. @throws Unsafe or unscoped address. */
export function viewerAddress(value: string, origin: string, sessionId: string): string {
  const url = new URL(value, origin)
  if (url.origin !== origin || !/^\/univer-viewer(?:\/|$)/.test(url.pathname) || url.searchParams.get('sessionId') !== sessionId) {
    throw new Error('Univer 返回了不安全或缺少会话作用域的 Viewer 地址')
  }
  url.searchParams.set('sidebar', 'collapsed')
  return url.toString()
}

/** @public @author ddj 2026年11月12号 @param state Current file state. @param worktreeId Selected draft. @returns Upstream address appropriate to status. */
export function reviewAddress(state: UniverFileState, worktreeId?: string): string | undefined {
  const selected = state.worktrees.find((entry) => entry.worktreeId === worktreeId)
  const worktree = selected ?? (state.viewerUrl ? undefined : state.worktrees.find(activeWorktree))
  if (!worktree || !activeWorktree(worktree)) return state.viewerUrl ?? undefined
  if (worktree.status === 'ready') return worktree.mergeUrl
  return worktree.worktreeUrl ?? worktree.openUrl
}

/** @public @author ddj 2026年11月12号 @param worktree Current worktree. @returns True for unmerged drafts. */
export function activeWorktree(worktree: UniverWorktree): boolean {
  return worktree.status === 'draft' || worktree.status === 'ready'
}
