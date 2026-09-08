/**
 * dsh-vscode-mode host — 深链移交（避免重复打开 DSH 页面）。
 * launcher 投递待打开请求（edrv.external.handoff）→ 已打开页面 3s 轮询领取（edrv.external.pending）
 * 并就地执行打开规则；15s 内无页面轮询过 = 无活跃页面 → launcher 回退打开新页。
 * token 防多实例串扰；TTL 兜底防陈旧悬挂。模块级状态（host 单进程单例）。
 * 作者 ddj 2026-09-08
 */
import { randomUUID } from 'node:crypto'

/** 一次外部打开请求（launcher 投递）。 */
export interface ExternalOpenRequest {
  paths: string[]
  line?: number
  column?: number
}

/** 待打开 TTL：超时未领取即丢弃（launcher 回退已自行处理）。 */
const PENDING_TTL_MS = 60_000
/** 活跃页面判定窗口：窗口内有过 pending 轮询 = 有页面在。 */
const PRESENCE_WINDOW_MS = 15_000

let pending: (ExternalOpenRequest & { token: string; at: number }) | null = null
let lastPollAt = 0

/**
 * 投递一次外部打开请求；返回活跃页面数（0 = launcher 应回退开新页）与移交 token。
 * @author ddj 2026年09月08号
 * @param req 打开请求
 * @returns 活跃页面数与 token
 */
export function handoffOpen(req: ExternalOpenRequest): { clients: number; token: string } {
  const token = randomUUID()
  pending = { ...req, token, at: Date.now() }
  return { token, clients: clientsAlive() ? 1 : 0 }
}

/**
 * 页面轮询：刷新活跃态并领取待打开请求（取走即清，多页面仅一方执行）。
 * @author ddj 2026年09月08号
 * @returns 待打开请求或 null
 */
export function pollPending(): ExternalOpenRequest | null {
  lastPollAt = Date.now()
  if (!pending) return null
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pending = null
    return null
  }
  const taken: ExternalOpenRequest = { paths: pending.paths, line: pending.line, column: pending.column }
  pending = null
  return taken
}

/**
 * 查询移交是否已被页面领取（take=true 时未领取则取走清除，供 launcher 回退开新页）。
 * @author ddj 2026年09月08号
 * @param token 移交 token
 * @param take 未领取时是否取走清除
 * @returns delivered=true = 已有页面领取（或已被更新的请求取代）
 */
export function pendingState(token: string, take: boolean): { delivered: boolean } {
  const delivered = pending === null || pending.token !== token
  if (take && !delivered) pending = null
  return { delivered }
}

/** 活跃页面判定。 */
function clientsAlive(): boolean {
  return Date.now() - lastPollAt <= PRESENCE_WINDOW_MS
}
