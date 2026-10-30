/**
 * 待审投影 → 现有面板的兼容投影：客户端不改渲染，数据源换成累计基线。
 * 同一路径只由待审投影负责，官方旧行让位，避免双权威。
 * @author ddj 2026年10月29号
 */
import type { ReviewDetail, ReviewItem, ReviewPage } from './shared/review.js'
import type { PendingDetail, PendingItem, PendingPage } from './shared/pendingReview.js'

/** 进程内"已被待审接管"的路径集合；旧写入口守卫只读它，绝不碰数据库。 */
const coveredPaths = new Set<string>()

/** 待审条目在面板列表里的 id 前缀，用于把请求路由回待审内核。 */
export { PENDING_PREFIX } from './shared/pendingReview.js'
import { PENDING_PREFIX } from './shared/pendingReview.js'

/**
 * @author ddj 2026年10月29号
 * @description: 由条目 id 派生稳定序号，保证轮询期间面板锚点不跳。
 * @param id 待审条目身份
 * @returns 正整数序号
 */
function stableSeq(id: string): number {
  let hash = 2166136261
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (Math.abs(hash) % 2147483647) + 1
}

/**
 * @author ddj 2026年10月29号
 * @description: 统一路径比较口径，消除分隔符与 Windows 大小写差异；远端身份保留原大小写。
 * @param path 路径
 * @returns 比较键
 */
function pathKey(path: string): string {
  const unified = path.replace(/\\/g, '/')
  // 远端仓库身份区分大小写，折叠成小写会把 Host/Repo 与 host/repo 混成同一个文件。
  if (/^[a-z]+:\/\//i.test(unified)) return unified
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/**
 * @author ddj 2026年10月30号
 * @description: 对外暴露统一路径比较口径，供列表按路径筛选待审条目。
 * @param path 路径
 * @returns 比较键
 */
export function pendingPathKey(path: string): string {
  return pathKey(path)
}

/**
 * @author ddj 2026年10月30号
 * @description: 判断两个路径是否指同一文件：比较键相同，或一方是另一方的工作区相对写法。
 * 面板传下来的路径可能是相对路径，而条目里存的是绝对路径。
 * @param left 路径
 * @param right 路径
 * @returns 是否同一文件
 */
export function pendingSamePath(left: string, right: string): boolean {
  const a = pathKey(left)
  const b = pathKey(right)
  if (!a || !b) return false
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
}

/**
 * @author ddj 2026年10月30号
 * @description: 列表里的条目 id 带待审前缀用于区分通道，内核按原始身份存取，这里统一还原。
 * @param id 请求里的条目 id
 * @returns 待审内核使用的原始 id
 */
export function pendingRawId(id: string): string {
  return id.startsWith(PENDING_PREFIX) ? id.slice(PENDING_PREFIX.length) : id
}

/**
 * @author ddj 2026年10月30号
 * @description: 列表显示用的短路径：工作区内显示相对路径，区外保留原文。
 * @param cwd 工作区
 * @param path 条目路径
 * @returns 显示用路径
 */
export function pendingDisplay(cwd: string, path: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  const unified = path.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/')
  if (base && (unified === base || unified.toLowerCase().startsWith(base.toLowerCase() + '/'))) {
    return unified.slice(base.length + 1)
  }
  return path
}

/**
 * @author ddj 2026年10月29号
 * @description: 待审条目转面板列表项。
 * @param item 待审条目
 * @param cwd 工作区，用于显示相对路径；缺省显示原始路径
 * @returns 面板列表项
 */
export function pendingItemOf(item: PendingItem, cwd?: string): ReviewItem {
  return {
    id: PENDING_PREFIX + item.id,
    sessionId: item.sessionId,
    turn: 0,
    seq: stableSeq(item.id),
    path: item.path,
    currentPath: item.path,
    display: cwd ? pendingDisplay(cwd, item.path) : item.path,
    added: item.added,
    deleted: item.deleted,
    kind: item.oversized ? 'oversized' : 'text',
    decision: item.settled ? 'accepted' : 'pending',
    revision: item.revision,
    current: true,
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 待审详情转面板详情；Revert 映射到面板的 Undo 能力位。
 * @param detail 待审详情
 * @param capturedAt 采集时间文案
 * @returns 面板详情
 */
export function pendingDetailOf(detail: PendingDetail, capturedAt: string, cwd?: string): ReviewDetail {
  return {
    item: pendingItemOf(detail.item, cwd),
    diff: detail.diff,
    capturedAt,
    blocks: detail.blocks,
    capability: {
      keep: detail.capability.keep,
      undo: detail.capability.revert,
      reason: detail.capability.reason,
    },
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 记住/忘记"该路径由待审投影接管"。进程内集合，绝不在旧写入口上查库（避免撞上写事务锁）。
 * @param cwd 工作区
 * @param path 路径
 * @param covered 是否接管
 * @returns 无
 */
export function trackPendingCover(cwd: string, path: string, covered: boolean): void {
  const key = `${pathKey(cwd)}|${pathKey(path)}`
  if (covered) coveredPaths.add(key)
  else coveredPaths.delete(key)
}

/**
 * @author ddj 2026年10月29号
 * @description: 判断某路径是否已由待审投影接管；仅读进程内集合，不产生任何 IO。
 * @param cwd 工作区
 * @param path 请求路径
 * @returns 是否已被接管
 */
export function pendingCovers(cwd: string, path: string): boolean {
  return coveredPaths.has(`${pathKey(cwd)}|${pathKey(path)}`)
}

/**
 * @author ddj 2026年10月29号
 * @description: 合并官方页与待审页：待审覆盖的路径从官方结果中剔除，其余原样保留。
 * @param official 官方页
 * @param pending 待审页
 * @param cwd 工作区，用于把待审行显示成相对路径
 * @returns 合并后的页
 */
export function mergedPage(official: ReviewPage, pending: PendingPage, cwd?: string): ReviewPage {
  const covered = new Set(pending.items.map((item) => pathKey(item.path)))
  const kept = official.items.filter((item) => !covered.has(pathKey(item.currentPath)) && !covered.has(pathKey(item.path)))
  const items = [...pending.items.map((item) => pendingItemOf(item, cwd)), ...kept]
  return {
    items,
    pending: pending.pending + kept.filter((item) => item.decision === 'pending').length,
    nextCursor: official.nextCursor,
    gaps: official.gaps,
    ...(official.overview ? { overview: official.overview } : {}),
  }
}
