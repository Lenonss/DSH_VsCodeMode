/**
 * dsh-vscode-mode client — 类型化 RPC 包装 + 诊断日志。
 * 迁移自原 src/client/index.ts 的 rpc/dbg，语义不改。
 * 作者 ddj 2026-08-20
 */
import { RPC_PATH } from '../shared/rpc.js'
import type { RpcMethod, RpcRequestMap, RpcResult } from '../shared/rpc.js'

/**
 * 诊断日志开关（默认关）：diff 渲染热路径每条日志 = 1 次 RPC 往返 +
 * host 端 debug 文件全量读改写（上限 512KB），高频渲染下开销可观。
 * 排查问题时在浏览器控制台执行 localStorage.setItem('edrv.debug','1') 后刷新开启。
 * @author ddj 2026年08月26号
 */
const DEBUG = (() => {
  try { return localStorage.getItem('edrv.debug') === '1' } catch (e) { return false }
})()

/** 同源 RPC 调用（host /edrv/rpc 精确路由）。 */
export function rpc<M extends RpcMethod>(method: M, args: RpcRequestMap[M]): Promise<RpcResult<M>> {
  return fetch(RPC_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  }).then((res) => res.json()) as Promise<RpcResult<M>>
}

/**
 * 诊断日志：开关关闭时直接返回（零 RPC 零落盘）；开启时走 host edrv.debug 落盘。
 * @author ddj 2026年08月26号
 * @param sessionId 会话 id
 * @param text 日志文本
 */
export function dbg(sessionId: string | undefined, text: string): void {
  if (!DEBUG) return
  try {
    rpc('edrv.debug', { sessionId, text }).catch(() => {})
  } catch (e) { /* 日志失败忽略 */ }
}
