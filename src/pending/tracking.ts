/**
 * 差异追踪窗口：判定一条条目是否仍在追踪、一次变化后应处的窗口状态，
 * 以及为面板提供「已被窗口接管过的路径」覆盖集。
 *
 * 窗口规则：
 * - AI 文件工具确认改了内容 → 开窗，基线 = 写前磁盘内容；
 * - 窗口内任何改动都折进同一条差异，基线不动；
 * - 用户处理完（无净差异）或内容回到基线 → 关窗；
 * - 关窗后外部改动不再生成记录，直到 AI 再次改动该文件。
 * @author ddj 2026年11月25号
 */
import type { StoredEntry } from './persist.js'
import { loadEntry } from './persist.js'
import type { PendingEntry } from './kernel.js'
import { isSettled } from './kernel.js'
import type { PendingTracking } from '../shared/pendingReview.js'

/**
 * @author ddj 2026年11月25号
 * @description: 读条目的窗口状态；缺省按 `open` 解释（旧数据与新建条目默认在追踪中）。
 * @param entry 待审条目
 * @returns 窗口状态
 */
export function trackingOf(entry: PendingEntry): PendingTracking {
  // 旧宿主（0.38）不写 opened_at：这类行不是本模型开的窗口，按已关窗处理，
  // 既不在面板显示，也不接收外部改动，避免旧宿主把 Unity 改动继续灌进来。
  if (!entry.openedAt) return 'closed'
  return entry.tracking === 'closed' ? 'closed' : 'open'
}

/**
 * @author ddj 2026年11月25号
 * @description: 条目是否仍在追踪窗口内（只有窗口内的文件才接收外部改动）。
 * @param entry 待审条目
 * @returns 在窗口内返回 true
 */
export function isOpenEntry(entry: PendingEntry): boolean {
  return trackingOf(entry) === 'open'
}

/**
 * @author ddj 2026年11月25号
 * @description: 一次变化后应处的窗口状态：已无净差异就关窗，否则保持打开。
 * @param entry 待审条目
 * @returns 目标窗口状态
 */
export function nextTracking(entry: PendingEntry): PendingTracking {
  return isSettled(entry) ? 'closed' : 'open'
}

/**
 * @author ddj 2026年11月25号
 * @description: 某个文件当前是否有开着的窗口；官方快照按它决定是否落库。
 * @param cwd 工作区
 * @param identity 后端进程路径（待审条目 id 同源）
 * @returns 开窗中返回 true
 */
export function isTrackedPath(cwd: string, identity: string): boolean {
  const stored = loadEntry(cwd, identity)
  return stored !== undefined && isOpenEntry(stored.entry)
}

/**
 * @author ddj 2026年11月25号
 * @description: 已被窗口接管过的路径（含已关窗条目）：路径与身份两种写法都给出，
 * 用来压住同路径的官方旧行与旧工具记录，避免关窗后它们复活。
 * @param entries 本工作区全部条目（含已关窗）
 * @returns 去重后的路径列表
 */
export function coveredPathsOf(entries: readonly StoredEntry[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const stored of entries) {
    for (const path of [stored.entry.path, stored.entry.id]) {
      if (!path || seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }
  }
  return paths
}
