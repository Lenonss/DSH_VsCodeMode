/**
 * dsh-vscode-mode client — 类型化 RPC 包装 + 诊断日志。
 * 迁移自原 src/client/index.ts 的 rpc/dbg，语义不改。
 * 诊断开关运行时化：内存缓存 + localStorage 持久（日志弹窗开关即改即生效，免刷新）。
 * 作者 ddj 2026-08-20 / 2026-09-17
 */
import { RPC_PATH } from '../shared/rpc.js'
import type { RpcMethod, RpcRequestMap, RpcResult } from '../shared/rpc.js'
import type { LoggerLevel } from '../shared/logger.js'

/** 诊断开关内存缓存（localStorage 'edrv.debug' 持久；热路径读内存，零 localStorage 开销）。 */
let debugEnabled = (() => {
  try { return localStorage.getItem('edrv.debug') === '1' } catch (e) { return false }
})()

/**
 * 诊断日志开关当前值。
 * @author ddj 2026年09月17号
 * @returns 是否开启
 */
export function isDebug(): boolean {
  return debugEnabled
}

/**
 * 设置诊断日志开关（立即生效；localStorage 持久，写失败仅内存生效不抛错）。
 * @author ddj 2026年09月17号
 * @param on 是否开启
 */
export function setDebugEnabled(on: boolean): void {
  debugEnabled = on
  try {
    if (on) localStorage.setItem('edrv.debug', '1')
    else localStorage.removeItem('edrv.debug')
  } catch (e) { /* 无 localStorage 环境：仅内存生效 */ }
}

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
 * @author ddj 2026年08月26号 / 2026年09月17号
 * @param sessionId 会话 id
 * @param text 日志文本
 * @param level 日志级别（缺省 debug；落盘行与 host 终端回显均带此级别）
 */
export function dbg(sessionId: string | undefined, text: string, level: LoggerLevel = 'debug'): void {
  if (!debugEnabled) return
  try {
    rpc('edrv.debug', { sessionId, text, level }).catch(() => {})
  } catch (e) { /* 日志失败忽略 */ }
}
