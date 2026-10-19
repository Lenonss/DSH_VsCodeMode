/**
 * dsh-vscode-mode client — 会话级差异记录共享订阅。
 * 原先 DiffBadge / ConversationDiffDock / EditorView 各自 5s 轮询同一个
 * `edrv.list`，同一会话一轮要打 3 次 RPC。本模块按会话收敛为单一定时器：
 * 订阅者共享一次拉取，`edrv:refresh` 事件与主动刷新也走同一条通道。
 * 作者 ddj 2026年10月19号
 */
import type { RecordView } from '../../shared/types.js'
import { rpc } from '../rpc.js'

/** 兜底轮询周期（毫秒）：仅作事件丢失时的兜底，正常由 edrv:refresh 驱动。 */
export const FEED_INTERVAL_MS = 5000

/** 记录变化回调。 */
export type RecordsListener = (records: RecordView[]) => void

/** 周期心跳回调（给只关心「该刷新了」的订阅者复用同一定时器）。 */
export type TickListener = () => void

/** 拉取失败回调。 */
export type ErrorListener = (message: string) => void

/** 单会话的共享订阅状态。 */
interface FeedEntry {
  records: RecordView[] | null
  listeners: Set<RecordsListener>
  tickers: Set<TickListener>
  errorListeners: Set<ErrorListener>
  timer: ReturnType<typeof setInterval> | null
  onRefresh: (() => void) | null
  seq: number
  inflight: boolean
}

const feeds = new Map<string, FeedEntry>()

/** 取全局 window（Node 测试环境无 window）。 */
function win(): (Window & typeof globalThis) | undefined {
  return typeof window === 'undefined' ? undefined : window
}

/**
 * 取或建会话订阅槽位。
 * @author ddj 2026年10月19号
 * @param sessionId 会话 id
 * @returns 订阅槽位
 */
function entryOf(sessionId: string): FeedEntry {
  let entry = feeds.get(sessionId)
  if (!entry) {
    entry = { records: null, listeners: new Set(), tickers: new Set(), errorListeners: new Set(), timer: null, onRefresh: null, seq: 0, inflight: false }
    feeds.set(sessionId, entry)
  }
  return entry
}

/**
 * 把最新记录分发给订阅者（快照相等时也分发，交由消费方自行比对）。
 * @author ddj 2026年10月19号
 * @param entry 订阅槽位
 */
function notifyRecords(entry: FeedEntry): void {
  const snapshot = entry.records
  if (!snapshot) return
  for (const listener of Array.from(entry.listeners)) {
    try {
      listener(snapshot)
    } catch {
      // 单个订阅者异常不得影响其余订阅者。
    }
  }
}

/**
 * 拉取一次该会话的差异记录。
 * @author ddj 2026年10月19号
 * @param sessionId 会话 id
 * @param skipStale 是否跳过过期判定（与 edrv.list 参数同名同义）
 * @returns 拉取完成 Promise
 */
export function refreshFeed(sessionId: string, skipStale = false): Promise<void> {
  const entry = entryOf(sessionId)
  const current = ++entry.seq
  entry.inflight = true
  const payload: { sessionId: string; skipStale?: boolean } = { sessionId }
  if (skipStale) payload.skipStale = true

  return rpc('edrv.list', payload)
    .then((res) => {
      if (current !== entry.seq) return
      if (!res || !res.ok || !Array.isArray(res.records)) return
      entry.records = res.records as RecordView[]
      notifyRecords(entry)
    })
    .catch((e) => {
      // 拉取失败保留上一次快照，等下一轮心跳重试；同时把错误交给关心者（EditorView 报错条）。
      if (current !== entry.seq) return
      const message = String(e)
      for (const listener of Array.from(entry.errorListeners)) {
        try {
          listener(message)
        } catch {
          // 单个错误订阅者异常不得影响其余订阅者。
        }
      }
    })
    .finally(() => {
      if (current === entry.seq) entry.inflight = false
    })
}

/**
 * 确保该会话的定时器与 refresh 事件监听已就绪（首个订阅者到来时启动）。
 * @author ddj 2026年10月19号
 * @param sessionId 会话 id
 * @param entry 订阅槽位
 */
function ensureTimer(sessionId: string, entry: FeedEntry): void {
  if (entry.timer === null) {
    entry.timer = setInterval(() => {
      const tickers = Array.from(entry.tickers)
      for (const tick of tickers) {
        try {
          tick()
        } catch {
          // 心跳订阅者异常不得中断定时器。
        }
      }
      // 只有存在记录/错误订阅者时才拉取记录；纯心跳订阅者（如体积徽章）不额外制造 RPC。
      if (entry.listeners.size > 0 || entry.errorListeners.size > 0) void refreshFeed(sessionId)
    }, FEED_INTERVAL_MS)
  }
  if (entry.onRefresh === null) {
    const handler = () => {
      void refreshFeed(sessionId)
    }
    const target = win()
    if (target) target.addEventListener('edrv:refresh', handler)
    entry.onRefresh = handler
  }
}

/**
 * 会话无任何订阅者时释放定时器、事件监听与缓存快照。
 * @author ddj 2026年10月19号
 * @param sessionId 会话 id
 * @param entry 订阅槽位
 */
function releaseIfIdle(sessionId: string, entry: FeedEntry): void {
  if (entry.listeners.size || entry.tickers.size || entry.errorListeners.size) return
  if (entry.timer !== null) clearInterval(entry.timer)
  if (entry.onRefresh !== null) {
    const target = win()
    if (target) target.removeEventListener('edrv:refresh', entry.onRefresh)
  }
  feeds.delete(sessionId)
}

/**
 * 订阅会话的差异记录。
 * 首个订阅者触发一次立即拉取；同会话多订阅者共享一次 RPC。
 * @author ddj 2026年10月19号
 * @param sessionId 会话 id
 * @param listener 记录变化回调
 * @returns 取消订阅函数
 */
export function subscribeRecords(sessionId: string, listener: RecordsListener): () => void {
  const entry = entryOf(sessionId)
  entry.listeners.add(listener)
  ensureTimer(sessionId, entry)

  if (entry.records) listener(entry.records)
  else if (!entry.inflight) void refreshFeed(sessionId)

  return () => {
    entry.listeners.delete(listener)
    releaseIfIdle(sessionId, entry)
  }
}

/**
 * 订阅会话的周期心跳（复用同一定时器，不额外制造定时器）。
 * @author ddj 2026年10月19号
 * @param sessionId 会话 id
 * @param listener 心跳回调
 * @returns 取消订阅函数
 */
export function subscribeTick(sessionId: string, listener: TickListener): () => void {
  const entry = entryOf(sessionId)
  entry.tickers.add(listener)
  ensureTimer(sessionId, entry)

  return () => {
    entry.tickers.delete(listener)
    releaseIfIdle(sessionId, entry)
  }
}

/**
 * 订阅会话记录拉取失败（错误提示用；同样复用该会话的共享通道）。
 * @author ddj 2026年10月19号
 * @param sessionId 会话 id
 * @param listener 失败回调，参数为已字符串化的错误
 * @returns 取消订阅函数
 */
export function subscribeErrors(sessionId: string, listener: ErrorListener): () => void {
  const entry = entryOf(sessionId)
  entry.errorListeners.add(listener)
  ensureTimer(sessionId, entry)

  return () => {
    entry.errorListeners.delete(listener)
    releaseIfIdle(sessionId, entry)
  }
}

/**
 * 读取会话的最近一次记录快照。
 * @author ddj 2026年10月19号
 * @param sessionId 会话 id
 * @returns 记录数组或 null（尚未拉到过）
 */
export function readRecords(sessionId: string): RecordView[] | null {
  return feeds.get(sessionId)?.records ?? null
}

/**
 * 主动丢弃会话的共享通道（会话销毁或测试复位用）。
 * @author ddj 2026年10月19号
 * @param sessionId 会话 id
 */
export function disposeFeed(sessionId: string): void {
  const entry = feeds.get(sessionId)
  if (!entry) return
  if (entry.timer !== null) clearInterval(entry.timer)
  if (entry.onRefresh !== null) {
    const target = win()
    if (target) target.removeEventListener('edrv:refresh', entry.onRefresh)
  }
  feeds.delete(sessionId)
}
