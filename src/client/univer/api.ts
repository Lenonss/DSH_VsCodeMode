/** Authenticated same-origin Univer transport. @author ddj 2026年11月12号 */
import { transportUrl } from '../../shared/remoteChannel.js'
import type { UniverFileState } from '../../shared/univer.js'

/** @private @author ddj 2026年11月12号 @param path Known API path. @param signal Component lifetime. @param method Explicit HTTP method. @returns Checked JSON object. @throws Authentication, network or response failures. */
async function request(path: string, signal?: AbortSignal, method = 'GET'): Promise<Record<string, unknown>> {
  const response = await fetch(transportUrl(path), { credentials: 'same-origin', method, signal })
  if (!response.ok) throw new Error('Univer HTTP ' + response.status + (response.status === 401 ? '：请重新登录' : response.status === 403 ? '：访问被拒绝' : ''))
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Univer 返回的不是 JSON')
  const result: unknown = await response.json()
  if (!result || typeof result !== 'object') throw new Error('Univer 响应格式不正确')
  return result as Record<string, unknown>
}

/** @public @author ddj 2026年11月12号 @param file Container path. @param sessionId Active session. @param signal Request lifetime. @returns Validated file state, never starts Gateway explicitly. */
export async function fileState(file: string, sessionId: string, signal?: AbortSignal): Promise<UniverFileState> {
  const result = await request('/univer-api/state?file=' + encodeURIComponent(file) + '&sessionId=' + encodeURIComponent(sessionId), signal)
  if (result.ok !== true || !Array.isArray(result.worktrees) || typeof result.file !== 'string') throw new Error('Univer 文件状态不兼容')
  if (result.viewerUrl !== null && typeof result.viewerUrl !== 'string') throw new Error('Univer Viewer 地址格式不兼容')
  for (const worktree of result.worktrees) {
    if (!worktree || typeof worktree.worktreeId !== 'string' || !Array.isArray(worktree.units) || !['draft', 'ready', 'merged', 'discarded'].includes(worktree.status)) throw new Error('Univer 草稿状态不兼容')
  }
  return result as unknown as UniverFileState
}

/** @public @author ddj 2026年11月12号 @param signal Request lifetime. @returns Explicit Gateway startup outcome. */
export async function startGateway(signal?: AbortSignal): Promise<void> {
  const result = await request('/univer-api/gateway/start', signal, 'POST')
  if (result.ok !== true) throw new Error(String(result.reason ?? 'Univer 服务启动失败'))
}
