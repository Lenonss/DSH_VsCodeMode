/**
 * dsh-vscode-mode client — 官方变更视图的行级待审注解（DSH 0.2.3 forge.changes）。
 * 数据链路：会话待审页（`edrv.review.list`，复用共享 5 秒订阅）→ 条目详情
 * （`edrv.review.detail`）→ 未决差异块 → 行级注解（新增/修改落 R 侧，纯删除落 L 侧）。
 * 约束：不 import 官方包（形状用本地最小 interface 描述）；取不到会话、RPC 失败、
 *       块没有可用行号都发布空表，绝不抛；一个会话只开一路订阅，多个视图共用。
 * 作者 ddj 2026年11月23号
 */
import { rpc } from './rpc.js'
import { subscribeReview } from './state/reviewFeed.js'
import { reviewBlocks } from '../shared/reviewRegions.js'
import type { ReviewBlock, ReviewBlockState } from '../shared/reviewRegions.js'
import type { OfficialDiff, ReviewDecision, ReviewItem, ReviewPage } from '../shared/review.js'

// #region 形状与常量

/** 注解位置：官方 forge 的 L（旧）/R（新）侧行号，闭区间、1 起。 */
export interface AnnotationPlace {
  side: 'L' | 'R'
  startLine: number
  endLine: number
}

/** 官方 ForgeLineAnnotation 的最小形状：不带 digest，所以不进「较早改动」区。 */
export interface LineAnnotation {
  key: string
  place: AnnotationPlace
  version: string
}

/** 官方 HostObservable 的最小形状。 */
export interface AnnotationFeed {
  getSnapshot(): ReadonlyMap<string, readonly LineAnnotation[]>
  subscribe(listener: () => void): () => void
}

/** 官方 ForgeAnnotationSource 的最小形状。 */
export interface AnnotationSource {
  id: string
  order?: number
  observe(target: unknown): AnnotationFeed
}

/** 注解源 id：同时是 keyed slot 的 key，两处必须一致。 */
export const ANNOTATION_ID = 'dsh-vscode-mode'

/** 一次最多看多少条待审条目：详情是一条一条拉的，不能让大仓库拖死页面。 */
const MAX_ITEMS = 40

/** 单个文件最多发布几条块注解：官方对单文件另有上限，这里先自我约束。 */
const MAX_BLOCKS = 8

/** 详情请求的并发批大小。 */
const FETCH_BATCH = 4

/** 没有注解时共用的空表。 */
const EMPTY: ReadonlyMap<string, readonly LineAnnotation[]> = new Map()

/** 取不到会话时的空观察对象。 */
const EMPTY_FEED: AnnotationFeed = { getSnapshot: () => EMPTY, subscribe: () => () => {} }

/** 一条条目详情的缓存值：差异与块级决定。 */
interface Detail {
  diff: OfficialDiff
  blocks: ReviewBlockState[]
}

// #endregion

// #region 派生

/**
 * 从官方 target 取会话 id；形状不认识时返回 undefined。
 * @public @author ddj 2026年11月23号
 * @param target 官方 observe 入参（ChangesTarget）
 * @returns 会话 id 或 undefined
 */
export function sessionOf(target: unknown): string | undefined {
  if (!target || typeof target !== 'object') return undefined
  const value = (target as { sessionId?: unknown }).sessionId
  return typeof value === 'string' && value ? value : undefined
}

/**
 * 一个差异块 → 注解位置：有新增行落 R 侧，纯删除落 L 侧，空块跳过。
 * @private @author ddj 2026年11月23号
 * @param block 差异块（源码坐标）
 * @returns 注解位置或 undefined
 */
function placeOfBlock(block: ReviewBlock): AnnotationPlace | undefined {
  const added = block.newLines.length
  const removed = block.oldLines.length
  if (added > 0) return { side: 'R', startLine: block.newStart, endLine: block.newStart + added - 1 }
  if (removed > 0) return { side: 'L', startLine: block.oldStart, endLine: block.oldStart + removed - 1 }
  return undefined
}

/**
 * 一条待审详情 → 该文件的行级注解：只画还没被接受或拒绝的块。
 * @public @author ddj 2026年11月23号
 * @param detail 条目详情（差异 + 块级决定）
 * @param itemId 条目身份（进注解 key，保证同一文件多条目不互撞）
 * @param revision 条目修订号（变化即重画）
 * @returns 注解清单
 */
export function placesOf(detail: Detail, itemId: string, revision: number): LineAnnotation[] {
  const decisions = new Map<string, ReviewDecision>(detail.blocks.map((state) => [state.id, state.decision]))
  const annotations: LineAnnotation[] = []
  for (const block of reviewBlocks(detail.diff)) {
    if ((decisions.get(block.id) ?? 'pending') !== 'pending') continue
    const place = placeOfBlock(block)
    if (!place) continue
    const span = place.side + ':' + place.startLine + '-' + place.endLine
    annotations.push({ key: 'vsm-pending:' + itemId + ':' + block.id, place, version: revision + ':' + span })
    if (annotations.length >= MAX_BLOCKS) break
  }
  return annotations
}

/**
 * 本页值得拉详情的条目：文本类、还没审完、按页面顺序截断。
 * @private @author ddj 2026年11月23号
 * @param page 待审页
 * @returns 待拉取条目
 */
function pendingOf(page: ReviewPage | null): ReviewItem[] {
  if (!page) return []
  return page.items
    .filter((item) => item.kind === 'text' && (item.decision === 'pending' || item.decision === 'mixed'))
    .slice(0, MAX_ITEMS)
}

/**
 * 缓存键：同一套差异只在修订号变化时重新拉。
 * @private @author ddj 2026年11月23号
 * @param item 待审条目
 * @returns 缓存键
 */
function cacheKeyOf(item: ReviewItem): string {
  return item.id + '|' + item.revision
}

/**
 * 把条目切成固定大小的批，控制并发。
 * @private @author ddj 2026年11月23号
 * @param items 全部条目
 * @returns 批次序列
 */
function batchesOf(items: readonly ReviewItem[]): ReviewItem[][] {
  const batches: ReviewItem[][] = []
  for (let index = 0; index < items.length; index += FETCH_BATCH) batches.push(items.slice(index, index + FETCH_BATCH))
  return batches
}

/**
 * 文件路径：优先当前路径，退回差异里的路径。
 * @private @author ddj 2026年11月23号
 * @param item 待审条目
 * @returns 路径或空串
 */
function pathOf(item: ReviewItem): string {
  return item.currentPath || item.path || ''
}

// #endregion

// #region 会话观察对象

/** 一个会话的注解观察对象：首个读者订阅时开流，最后一个离开时停。 */
class SessionFeed implements AnnotationFeed {
  private snapshot: ReadonlyMap<string, readonly LineAnnotation[]> = EMPTY
  private page: ReviewPage | null = null
  private readonly details = new Map<string, Detail>()
  private readonly listeners = new Set<() => void>()
  private stop?: () => void
  private generation = 0

  /** @author ddj 2026年11月23号 @param sessionId 会话 id */
  constructor(private readonly sessionId: string) {}

  /** @author ddj 2026年11月23号 @returns 当前快照（引用稳定） */
  getSnapshot = (): ReadonlyMap<string, readonly LineAnnotation[]> => this.snapshot

  /** @author ddj 2026年11月23号 @param listener 订阅者 @returns 退订函数 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.stop = subscribeReview(this.sessionId, (feed) => this.publish(feed.page))
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size > 0) return
      this.stop?.()
      this.stop = undefined
      this.generation += 1
    }
  }

  /** @private @author ddj 2026年11月23号 @param page 待审页 @returns 无 */
  private publish(page: ReviewPage | null): void {
    this.generation += 1
    this.page = page
    void this.load(this.generation)
  }

  /** @private @author ddj 2026年11月23号 @param generation 本轮代数 @returns 拉取与发布完成 */
  private async load(generation: number): Promise<void> {
    const items = pendingOf(this.page)
    const missing = items.filter((item) => !this.details.has(cacheKeyOf(item)))
    for (const batch of batchesOf(missing)) {
      await Promise.all(batch.map((item) => this.fetch(item)))
      if (generation !== this.generation) return
      this.commit(items)
    }
    if (!missing.length) this.commit(items)
  }

  /**
   * 拉一条详情；失败与过期修订都只丢弃这一条，不补假数据。
   * @private @author ddj 2026年11月23号
   * @param item 待审条目
   * @returns 无
   */
  private async fetch(item: ReviewItem): Promise<void> {
    try {
      const result = await rpcOf(this.sessionId, item.id)
      if (result) this.details.set(cacheKeyOf(item), result)
    } catch { /* 单条失败：该文件本轮不画注解 */ }
  }

  /** @private @author ddj 2026年11月23号 @param items 本轮条目 @returns 无 */
  private commit(items: readonly ReviewItem[]): void {
    const next = this.build(items)
    if (sameMap(next, this.snapshot)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  /** @private @author ddj 2026年11月23号 @param items 本轮条目 @returns 路径 → 注解清单 */
  private build(items: readonly ReviewItem[]): Map<string, readonly LineAnnotation[]> {
    const next = new Map<string, readonly LineAnnotation[]>()
    for (const item of items) {
      const detail = this.details.get(cacheKeyOf(item))
      const path = pathOf(item)
      if (!detail || !path) continue
      const annotations = placesOf(detail, item.id, item.revision)
      if (!annotations.length) continue
      next.set(path, [...next.get(path) ?? [], ...annotations])
    }
    this.prune(items)
    return next
  }

  /**
   * 丢掉本轮不再需要的详情缓存，避免长会话无限增长。
   * @private @author ddj 2026年11月23号
   * @param items 本轮条目
   * @returns 无
   */
  private prune(items: readonly ReviewItem[]): void {
    const keep = new Set(items.map((item) => cacheKeyOf(item)))
    for (const key of [...this.details.keys()]) if (!keep.has(key)) this.details.delete(key)
  }
}

/**
 * 取一条条目的差异与块级决定；会话过期或 RPC 失败返回 undefined。
 * @private @author ddj 2026年11月23号
 * @param sessionId 会话 id
 * @param id 条目身份
 * @returns 详情或 undefined
 */
async function rpcOf(sessionId: string, id: string): Promise<Detail | undefined> {
  const result = await rpc('edrv.review.detail', { sessionId, id })
  if (!result.ok) return undefined
  const detail = (result as { detail?: Detail }).detail
  return detail && detail.diff ? detail : undefined
}

/**
 * 内容相同就不通知：官方每次轮询都回新对象，不比较会让视图白重画。
 * @private @author ddj 2026年11月23号
 * @param left 新快照
 * @param right 旧快照
 * @returns 是否等价
 */
function sameMap(left: ReadonlyMap<string, readonly LineAnnotation[]>, right: ReadonlyMap<string, readonly LineAnnotation[]>): boolean {
  if (left.size !== right.size) return false
  for (const [path, list] of left) {
    const other = right.get(path)
    if (!other || other.length !== list.length) return false
    if (other.some((item, index) => item.key !== list[index].key || item.version !== list[index].version)) return false
  }
  return true
}

/** 会话 → 共享观察对象；同一会话的多个视图共用一路订阅与一份详情缓存。 */
const feeds = new Map<string, SessionFeed>()

/**
 * 取会话的共享观察对象；没有就建一个。
 * @private @author ddj 2026年11月23号
 * @param sessionId 会话 id
 * @returns 观察对象
 */
function feedOf(sessionId: string): SessionFeed {
  const existing = feeds.get(sessionId)
  if (existing) return existing
  const created = new SessionFeed(sessionId)
  feeds.set(sessionId, created)
  return created
}

// #endregion

// #region 注解源

/**
 * 造注解源：官方每个视图调用一次 observe，这里按会话复用观察对象。
 * @public @author ddj 2026年11月23号
 * @returns 注解源
 */
export function annotationSource(): AnnotationSource {
  return {
    id: ANNOTATION_ID,
    order: 10,
    observe: (target) => {
      const sessionId = sessionOf(target)
      return sessionId ? feedOf(sessionId) : EMPTY_FEED
    },
  }
}

// #endregion
