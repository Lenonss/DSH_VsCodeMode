/** One official metadata request loop per viewed session, lazy historical patches. @author ddj 2026年10月26号 */
import { rpc } from '../rpc.js'
import type { ReviewPage } from '../../shared/review.js'

export interface ReviewFeed { page: ReviewPage | null; error: string }
type Listener = (feed: ReviewFeed) => void
interface Entry { listeners: Set<Listener>; value: ReviewFeed; controller: AbortController; timer?: ReturnType<typeof setTimeout>; loading: boolean; again: boolean; onRefresh: () => void; onVisible?: () => void; version: number; versionTimer?: ReturnType<typeof setInterval> }
const feeds = new Map<string, Entry>()
/** 列表轮询间隔：版本号没变时不重读列表。 */
const POLL_MS = 5000
/** 待审版本号轮询间隔：只读 Host 内存计数，用来把「新记录出现」的延迟压到 1s 量级。 */
const VERSION_POLL_MS = 1000

/** @private @author ddj 2026年10月26号 @param entry Shared feed. Notify mounted observers only. */
function notify(entry: Entry): void { for (const listener of entry.listeners) listener(entry.value) }

/** @private @author ddj 2026年10月26号 @param sessionId Scope. @param entry Current generation. @returns First-page metadata update; no overlap or late publication. */
async function refresh(sessionId: string, entry: Entry, force = false): Promise<void> {
  if (entry.controller.signal.aborted) return
  if (typeof document !== 'undefined' && document.hidden) { entry.again = true; return }
  if (entry.loading) { entry.again = true; return }
  clearTimeout(entry.timer)
  entry.loading = true
  entry.again = false
  const previous = entry.value
  try {
    const result = await rpc('edrv.review.list', { sessionId }, entry.controller.signal)
    if (!entry.controller.signal.aborted) entry.value = result.ok
      ? { page: result.page, error: result.page.overview ? '' : 'Host 尚未提供官方文件导航，请重启加载新版插件；当前仅可浏览已返回的官方历史，角标不含官方记录。' }
      : { ...entry.value, error: result.error }
  } catch (error) { if (!entry.controller.signal.aborted) entry.value = { ...entry.value, error: String(error) } }
  finally {
    entry.loading = false
    if (!entry.controller.signal.aborted) {
      // Polling returns fresh JSON objects even when nothing changed. Preserve identity so
      // editors do not tear down Monaco zones and reload file details every five seconds.
      if (!force && JSON.stringify(previous) === JSON.stringify(entry.value)) entry.value = previous
      else notify(entry)
      if (entry.again) void refresh(sessionId, entry, true)
      else entry.timer = setTimeout(() => { void refresh(sessionId, entry) }, POLL_MS)
    }
  }
}

/**
 * @private
 * @author ddj 2026年11月24号
 * @description: 轮询待审版本号：只读 Host 内存计数，变号才触发整页重读。
 * 这条通道把「agent 用 bash 改完文件」到「面板出现记录」的延迟从 5s 压到 1s 量级。
 * @param sessionId 会话作用域
 * @param entry 共享订阅
 * @returns 无
 */
function pollVersion(sessionId: string, entry: Entry): void {
  const controller = entry.controller
  const tick = async (): Promise<void> => {
    if (controller.signal.aborted || (typeof document !== 'undefined' && document.hidden)) return
    try {
      const result = await rpc('edrv.pending.version', { sessionId }, controller.signal)
      if (controller.signal.aborted || !result.ok) return
      if (entry.version === 0) { entry.version = result.version; return }
      if (result.version === entry.version) return
      entry.version = result.version
      void refresh(sessionId, entry, true)
    } catch { /* 版本探测失败不影响列表轮询 */ }
  }
  entry.versionTimer = setInterval(() => { void tick() }, VERSION_POLL_MS)
  void tick()
}

/** @public @author ddj 2026年10月26号 @param sessionId Live scope. @param listener Mounted observer. @returns Cleanup cancelling requests and timers when unused. */
export function subscribeReview(sessionId: string, listener: Listener): () => void {
  let entry = feeds.get(sessionId)
  if (!entry) {
    /** @private @author ddj 2026年10月26号 Refresh the shared official metadata after edits/decisions. */
    const onRefresh = (): void => refreshReview(sessionId)
    entry = { listeners: new Set(), value: { page: null, error: '' }, controller: new AbortController(), loading: false, again: false, onRefresh, version: 0 }
    feeds.set(sessionId, entry)
    if (typeof window !== 'undefined') window.addEventListener('edrv:refresh', onRefresh)
    if (typeof document !== 'undefined') {
      const current = entry
      entry.onVisible = () => { if (!document.hidden) void refresh(sessionId, current) }
      document.addEventListener('visibilitychange', entry.onVisible)
    }
    void refresh(sessionId, entry)
    pollVersion(sessionId, entry)
  }
  entry.listeners.add(listener); listener(entry.value)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size || feeds.get(sessionId) !== entry) return
    entry.controller.abort(); clearTimeout(entry.timer); clearInterval(entry.versionTimer); feeds.delete(sessionId)
    if (typeof window !== 'undefined') window.removeEventListener('edrv:refresh', entry.onRefresh)
    if (entry.onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', entry.onVisible)
  }
}

/** @public @author ddj 2026年10月26号 @param sessionId Refresh metadata after a decision; does not alter legacy or disk. */
export function refreshReview(sessionId: string): void {
  const entry = feeds.get(sessionId)
  if (entry) { clearTimeout(entry.timer); void refresh(sessionId, entry, true) }
}
