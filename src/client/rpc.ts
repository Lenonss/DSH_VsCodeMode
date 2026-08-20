/**
 * dsh-vscode-mode client — 类型化 RPC 包装 + 诊断日志。
 * 迁移自原 src/client/index.ts 的 rpc/dbg，语义不改。
 * 作者 ddj 2026-08-20
 */
import { RPC_PATH } from '../shared/rpc.js'
import type { RpcMethod, RpcRequestMap, RpcResult } from '../shared/rpc.js'

/** 同源 RPC 调用（host /edrv/rpc 精确路由）。 */
export function rpc<M extends RpcMethod>(method: M, args: RpcRequestMap[M]): Promise<RpcResult<M>> {
  return fetch(RPC_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  }).then((res) => res.json()) as Promise<RpcResult<M>>
}

/**
 * 诊断日志：统一走 host edrv.debug 落盘，避免 console 刷屏。
 * @author ddj 2026年08月20号
 * @param sessionId 会话 id
 * @param text 日志文本
 */
export function dbg(sessionId: string | undefined, text: string): void {
  try {
    rpc('edrv.debug', { sessionId, text }).catch(() => {})
  } catch (e) { /* 日志失败忽略 */ }
}
