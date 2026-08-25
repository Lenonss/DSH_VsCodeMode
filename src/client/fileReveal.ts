/**
 * dsh-vscode-mode client — 「在文件浏览器中打开」RPC 包装（树菜单与 Monaco 右键共用）。
 * 归一化为 { ok, error? }，不抛异常；无会话/异常降级返回错误文案。
 * 作者 ddj 2026-08-27
 */
import { rpc } from './rpc.js'

export interface RevealOutcome {
  ok: boolean
  error?: string
}

/**
 * 请求 host 在 OS 文件浏览器中打开/定位路径。
 * @author ddj 2026年08月27号
 * @param sessionId 会话 id（可空）
 * @param path 工作区相对路径（'' = 根目录）
 * @returns 成功或失败原因
 */
export async function revealInExplorer(sessionId: string | undefined, path: string): Promise<RevealOutcome> {
  if (!sessionId) return { ok: false, error: '无活动会话' }
  try {
    const res = await rpc('edrv.revealInExplorer', { sessionId, path })
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  } catch (error) {
    return { ok: false, error: '打开异常:' + String(error) }
  }
}
