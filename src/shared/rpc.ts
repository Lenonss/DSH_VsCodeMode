/**
 * dsh-vscode-mode RPC contract — method names, per-method request/ok payloads,
 * and the typed handler map shared by the host dispatcher and the client
 * fetch wrapper. 载荷形状与历史实现一字不差，仅把隐式约定类型化。
 *
 * Purity rule: no node/react imports (same as types.ts).
 * 作者 ddj 2026-08-20
 */
import type {
  ArchiveBatch,
  ArchiveEntry,
  RecordView,
  StaleHunk,
} from './types.js'

/** webServer 精确路由。 */
export const RPC_PATH = '/edrv/rpc'

/** 决策作用域：call=整条记录，hunk=单个差异块。 */
export type RpcScope = 'call' | 'hunk'

/** 每个方法的请求参数（sessionId 为公共可选字段）。 */
export interface RpcRequestMap {
  'edrv.list': { sessionId?: string; callIds?: string[] }
  'edrv.accept': { sessionId?: string; callId: string; scope?: RpcScope; hunkIndex?: number }
  'edrv.reject': { sessionId?: string; callId: string; scope?: RpcScope; hunkIndex?: number }
  'edrv.read': { sessionId?: string; path: string }
  'edrv.original': { sessionId?: string; path: string }
  'edrv.save': { sessionId?: string; path: string; content: string }
  'edrv.archiveList': { sessionId?: string }
  'edrv.archiveRead': { sessionId?: string; path?: string }
  'edrv.rollback': { sessionId?: string; path: string; batch?: number }
  'edrv.debug': { sessionId?: string; text: string }
  'edrv.searchFiles': { sessionId?: string; query: string }
}

export type RpcMethod = keyof RpcRequestMap

/** 每个方法成功（ok:true）时的附加载荷。 */
export interface RpcOkMap {
  'edrv.list': { records: RecordView[] }
  'edrv.accept': { record: RecordView }
  'edrv.reject': { record: RecordView }
  'edrv.read': { content: string; size: number }
  'edrv.original': { content: string; size: number; stale: StaleHunk[]; fallback: boolean }
  'edrv.save': object
  'edrv.archiveList': { entries: ArchiveEntry[] }
  'edrv.archiveRead': { batches: ArchiveBatch[] }
  'edrv.rollback': { path: string; batch: number | null }
  'edrv.debug': object
  'edrv.searchFiles': { files: string[]; truncated: boolean }
}

/** 统一响应：{ok:true, ...payload} 或 {ok:false, error}。 */
export type RpcResult<M extends RpcMethod> =
  | ({ ok: true } & RpcOkMap[M])
  | { ok: false; error: string }

/** 每个方法的 handler 签名（host 分发表与 client 类型检查共用）。 */
export type RpcHandler<M extends RpcMethod> = (
  args: RpcRequestMap[M],
) => Promise<RpcResult<M>>

/** host RPC 分发表：method → handler。 */
export type RpcHandlerMap = {
  [M in RpcMethod]: RpcHandler<M>
}
