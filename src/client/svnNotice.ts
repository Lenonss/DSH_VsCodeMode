/** SVN mutation notifications, independent of UI stores. @author ddj 2026年10月10号 */
import type { RpcMethod, RpcRequestMap } from '../shared/rpc.js'
let sequence = 0
const scopes = new Map<string, string>()
/** @public @author ddj 2026年10月10号 @param sessionId Active session. @param scope Canonical client workspace. Record bounded routing hints; unknown sessions invalidate globally, never misapply relative paths. */
export function bindSvnScope(sessionId: string | undefined, scope: string): void {
  if (!sessionId) return
  scopes.delete(sessionId); scopes.set(sessionId, scope)
  if (scopes.size > 512) scopes.delete(scopes.keys().next().value!)
}
const WRITES = new Set<RpcMethod>(['svn.add', 'svn.revert', 'svn.resolve', 'svn.ignore', 'svn.cleanup', 'svn.update', 'svn.tortoise'])
/** @public @author ddj 2026年10月10号 @param method RPC operation. @returns Whether local evidence may change (launching a writable native dialog counts, not its completion). */
export function isSvnWrite(method: RpcMethod): boolean { return WRITES.has(method) }
/** @public @author ddj 2026年10月10号 @param method Operation. @param args Typed request. @param ok Completed successfully. Notify even failed/partially applied operations; no repository access. */
export function svnNotice<M extends RpcMethod>(method: M, args: RpcRequestMap[M], ok: boolean): void {
  if (!isSvnWrite(method) || typeof window === 'undefined') return
  const request = args as { sessionId?: string; path?: string; paths?: string[]; action?: string; items?: { dir: string }[] }
  if (method === 'svn.tortoise' && !['commit', 'revert'].includes(request.action ?? '')) return
  const scope = request.sessionId ? scopes.get(request.sessionId) : undefined
  let paths: string[] | undefined
  if (scope && ok && method !== 'svn.cleanup') paths = request.paths ?? request.items?.map((item) => item.dir) ?? (request.path ? [request.path] : undefined)
  window.dispatchEvent(new CustomEvent('edrv:refresh', { detail: { scope, paths,
    kind: 'svn', eventId: 'svn-write-' + Date.now() + '-' + (++sequence) } }))
}
