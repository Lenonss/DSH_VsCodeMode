/** One official metadata request loop per viewed session, lazy historical patches. @author ddj 2026年10月26号 */
import { rpc } from '../rpc.js'
import type { ReviewPage } from '../../shared/review.js'

export interface ReviewFeed { page: ReviewPage | null; error: string }
type Listener = (feed: ReviewFeed) => void
interface Entry { listeners: Set<Listener>; value: ReviewFeed; controller: AbortController; timer?: ReturnType<typeof setTimeout>; loading: boolean; again: boolean; onRefresh: () => void }
const feeds = new Map<string, Entry>()

/** @private @author ddj 2026年10月26号 @param entry Shared feed. Notify mounted observers only. */
function notify(entry: Entry): void { for (const listener of entry.listeners) listener(entry.value) }

/** @private @author ddj 2026年10月26号 @param sessionId Scope. @param entry Current generation. @returns First-page metadata update; no overlap or late publication. */
async function refresh(sessionId: string, entry: Entry, force = false): Promise<void> {
  if (entry.controller.signal.aborted) return
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
      else entry.timer = setTimeout(() => { void refresh(sessionId, entry) }, 5000)
    }
  }
}

/** @public @author ddj 2026年10月26号 @param sessionId Live scope. @param listener Mounted observer. @returns Cleanup cancelling requests and timers when unused. */
export function subscribeReview(sessionId: string, listener: Listener): () => void {
  let entry = feeds.get(sessionId)
  if (!entry) {
    /** @private @author ddj 2026年10月26号 Refresh the shared official metadata after edits/decisions. */
    const onRefresh = (): void => refreshReview(sessionId)
    entry = { listeners: new Set(), value: { page: null, error: '' }, controller: new AbortController(), loading: false, again: false, onRefresh }
    feeds.set(sessionId, entry)
    if (typeof window !== 'undefined') window.addEventListener('edrv:refresh', onRefresh)
    void refresh(sessionId, entry)
  }
  entry.listeners.add(listener); listener(entry.value)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size) return
    entry.controller.abort(); clearTimeout(entry.timer); feeds.delete(sessionId)
    if (typeof window !== 'undefined') window.removeEventListener('edrv:refresh', entry.onRefresh)
  }
}

/** @public @author ddj 2026年10月26号 @param sessionId Refresh metadata after a decision; does not alter legacy or disk. */
export function refreshReview(sessionId: string): void {
  const entry = feeds.get(sessionId)
  if (entry) { clearTimeout(entry.timer); void refresh(sessionId, entry, true) }
}
