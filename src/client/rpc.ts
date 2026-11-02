/**
 * dsh-vscode-mode client — 类型化 RPC 包装 + 诊断日志。
 * 迁移自原 src/client/index.ts 的 rpc/dbg，语义不改。
 * 诊断开关运行时化：内存缓存 + localStorage 持久（日志弹窗开关即改即生效，免刷新）。
 * 作者 ddj 2026-08-20 / 2026-09-17
 */
import { svnNotice } from './svnNotice.js'
import { channelPrefix, transportUrl } from '../shared/remoteChannel.js'
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

/**
 * Call the authenticated RPC route using the current application base.
 * @author ddj 2026年09月28号
 * @param method Typed business method.
 * @param args Business arguments.
 * @param signal Optional cancellation signal.
 * @returns A validated business result; transport failures reject with a readable error.
 */
export async function rpc<M extends RpcMethod>(method: M, args: RpcRequestMap[M], signal?: AbortSignal): Promise<RpcResult<M>> {
  try {
    const out = await rpcFetch(method, args, signal)
    svnNotice(method, args, out.ok)
    return out
  } catch (error) { svnNotice(method, args, false); throw error }
}

/** @private @author ddj 2026年10月10号 @param method Typed method. @param args Request. @param signal Fetch lifetime. @returns Validated authenticated business response. @throws Transport/format errors. */
async function rpcFetch<M extends RpcMethod>(method: M, args: RpcRequestMap[M], signal?: AbortSignal): Promise<RpcResult<M>> {
  const res = await fetch(transportUrl(RPC_PATH), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
    signal,
  })
  if (!res.ok) throw new Error(await failureMessage(res))
  if (!/^application\/json(?:\s*;|\s*$)/i.test(res.headers.get('content-type') ?? '')) {
    throw new Error('DSH 返回了非 JSON 响应，请检查应用地址和代理配置')
  }
  const value: unknown = await res.json()
  if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') {
    throw new Error('DSH RPC 响应格式不正确')
  }
  return value as RpcResult<M>
}

/**
 * 非 2xx 响应 → 可读失败原因：403 再区分「远程设备未配对」与「Host 围栏拒绝」。
 * @author ddj 2026年11月02号
 * @param res 失败响应
 * @returns 用户可读原因
 */
async function failureMessage(res: Response): Promise<string> {
  if (res.status === 403) {
    if (await unpairedDenied(res)) return '远程访问设备尚未配对：请在远程访问面板完成配对后重试（HTTP 403）'
    return 'DSH 拒绝了当前页面的访问（HTTP 403，Host 校验未通过）' + channelNote()
  }
  if (res.status === 401) return 'DSH 登录已失效，请重新打开已登录的应用页面'
  if (res.status === 404) return '插件路由不存在（HTTP 404），请确认 dsh-vscode-mode 与宿主版本匹配'
  if (res.status === 413) return '请求超过支持的文件大小'
  if (res.status === 503) return 'DSH 认证服务尚未就绪'
  return 'DSH 请求失败（HTTP ' + res.status + '）'
}

/**
 * 403 是否为远程访问通道的「未配对」拒绝（远程插件以 `{result:{ok:false,error:{code}}}` 回）。
 * @author ddj 2026年11月02号
 * @param res 403 响应
 * @returns 是否为未配对拒绝
 */
async function unpairedDenied(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { result?: { error?: { code?: unknown } }; error?: { code?: unknown } } | null
    const code = body?.result?.error?.code ?? body?.error?.code
    return code === 'unpaired'
  } catch (e) {
    return false
  }
}

/**
 * 网络来源页面却未接入远程通道时的补充提示（本机页面不追加）。
 * @author ddj 2026年11月02号
 * @returns 提示后缀；无需提示时为空串
 */
function channelNote(): string {
  if (channelPrefix() !== '') return ''
  try {
    if (typeof location === 'undefined') return ''
    const host = location.hostname
    if (host === 'localhost' || host === '::1' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)) return ''
    return '；本页未接入远程访问通道（远程访问插件未安装或未完成配对）'
  } catch (e) {
    return ''
  }
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
