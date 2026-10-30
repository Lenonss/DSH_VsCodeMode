/**
 * 待审条目内核：纯状态机，逐条对齐 dsh-diff-approval 的 pending 语义。
 * 无 IO、无时钟、不改入参；调用方传入 now 与内容，便于测试与复用。
 * @author ddj 2026年10月29号
 */
import type { PendingEarlier, PendingLineage } from '../shared/pendingReview.js'

/** 内存态条目：比展示投影多保存两侧全文。 */
export interface PendingEntry {
  id: string
  path: string
  earlierVersion: PendingEarlier
  oldText: string
  newText: string
  updatedAt: number
  unseen?: boolean
  sessionId: string
  sessionIds: string[]
  lineage?: PendingLineage
}

/** 新建条目的入参。 */
export interface NewPending {
  id: string
  path: string
  sessionId: string
  earlierVersion: PendingEarlier
  oldText: string
  newText: string
  updatedAt: number
  lineage?: PendingLineage
}

/** 决定后对条目的局部推进；未出现的字段表示不改。 */
export interface PendingPatch {
  oldText?: string
  newText?: string
}

/**
 * @author ddj 2026年10月29号
 * @description: 严格比较两侧文本：不做 BOM/行尾归一化，归一化只允许用于展示。
 * @param left 一侧全文
 * @param right 另一侧全文
 * @returns 两者是否逐码元相等
 */
export function sameEntryText(left: string, right: string): boolean {
  return left === right
}

/**
 * @author ddj 2026年10月29号
 * @description: 净零判定：基线等于当前内容即为已解决，但条目仍留在列表等待移除。
 * @param entry 待审条目
 * @returns 是否已无净差异
 */
export function isSettled(entry: PendingEntry): boolean {
  return sameEntryText(entry.oldText, entry.newText)
}

/**
 * @author ddj 2026年10月29号
 * @description: 合并同一身份的两条条目：基线取较早来源，最新内容取较晚来源，会话取并集。
 * @param earlier 较早记录
 * @param later 较晚记录
 * @returns 合并后的新条目
 */
export function mergeEntries(earlier: PendingEntry, later: PendingEntry): PendingEntry {
  const merged: PendingEntry = {
    ...later,
    updatedAt: later.updatedAt,
    sessionIds: unionSessions(earlier, later),
  }
  if (later.lineage === undefined && earlier.lineage !== undefined) merged.lineage = earlier.lineage
  if (earlier.earlierVersion === 'none' && later.earlierVersion === 'none') {
    merged.earlierVersion = 'none'
    merged.oldText = earlier.oldText
    return merged
  }
  // 基线一旦有历史版本，Revert 就是写回内容而不是删除文件；创建期的内容成为新基线。
  merged.earlierVersion = 'file'
  merged.oldText = earlier.earlierVersion === 'none' ? earlier.newText : earlier.oldText
  return merged
}

/**
 * @author ddj 2026年10月29号
 * @description: 由新建入参构造条目，并把首个会话写进会话集合。
 * @param input 新建入参
 * @returns 新条目
 */
export function entryFromNew(input: NewPending): PendingEntry {
  const entry: PendingEntry = {
    id: input.id,
    path: input.path,
    earlierVersion: input.earlierVersion,
    oldText: input.oldText,
    newText: input.newText,
    updatedAt: input.updatedAt,
    sessionId: input.sessionId,
    sessionIds: [input.sessionId],
  }
  if (input.lineage !== undefined) entry.lineage = input.lineage
  return entry
}

/**
 * @author ddj 2026年10月29号
 * @description: 应用一次决定带来的局部推进：块级 Keep 推进基线，块级 Revert 推进当前内容。
 * @param entry 待审条目
 * @param patch 要推进的一侧
 * @param now 本次更新时间
 * @returns 新条目；基线被推进时"创建"身份结束
 */
export function applyUpdate(entry: PendingEntry, patch: PendingPatch, now: number): PendingEntry {
  const next: PendingEntry = { ...entry, updatedAt: now }
  if (patch.oldText !== undefined) {
    next.oldText = patch.oldText
    next.earlierVersion = 'file'
  }
  if (patch.newText !== undefined) next.newText = patch.newText
  delete next.unseen
  return next
}

/**
 * @author ddj 2026年10月29号
 * @description: 采纳外部改动：只替换当前内容并标记未读，基线保持不动。
 * @param entry 待审条目
 * @param content 磁盘上的最新全文
 * @param now 本次更新时间
 * @returns 新条目
 */
export function adoptExternal(entry: PendingEntry, content: string, now: number): PendingEntry {
  return { ...entry, newText: content, updatedAt: now, unseen: true }
}

/**
 * @author ddj 2026年10月29号
 * @description: 设置或清除未读圆点。
 * @param entry 待审条目
 * @param seen 是否已读
 * @returns 新条目
 */
export function touchSeen(entry: PendingEntry, seen: boolean): PendingEntry {
  const next: PendingEntry = { ...entry }
  if (seen) delete next.unseen
  else next.unseen = true
  return next
}

/**
 * @author ddj 2026年10月29号
 * @description: 撤销重放：条目内容回滚到快照，未读标记保留实时值。
 * @param entry 快照条目
 * @param live 实时条目，用于取未读标记
 * @returns 重放后的新条目
 */
export function withUnseen(entry: PendingEntry, live: PendingEntry | undefined): PendingEntry {
  return touchSeen(entry, live ? live.unseen !== true : entry.unseen !== true)
}

/**
 * @author ddj 2026年10月29号
 * @description: 列表排序：按更新时间升序，与上游一致。
 * @param left 左侧条目
 * @param right 右侧条目
 * @returns 比较结果
 */
export function byUpdatedAt(left: PendingEntry, right: PendingEntry): number {
  return left.updatedAt - right.updatedAt
}

/**
 * @author ddj 2026年10月29号
 * @description: 合并两条条目的会话集合并去重，且保证首会话在列。
 * @param earlier 较早记录
 * @param later 较晚记录
 * @returns 去重后的会话集合
 */
function unionSessions(earlier: PendingEntry, later: PendingEntry): string[] {
  const merged: string[] = []
  for (const sessionId of [earlier.sessionId, ...earlier.sessionIds, later.sessionId, ...later.sessionIds]) {
    if (sessionId && !merged.includes(sessionId)) merged.push(sessionId)
  }
  return merged
}

/**
 * 内容版本号分配器：只有内容变化才递增，条目删除后编号不复用。
 * @author ddj 2026年10月29号
 */
export class ContentVersions {
  /** 已分配编号与快照文本。 */
  private readonly state = new Map<string, { version: number; text: string }>()
  /** 下一个可用编号。 */
  private next = 1

  /**
   * @author ddj 2026年10月29号
   * @description: 记录条目当前内容并返回其版本号；内容未变时沿用旧号。
   * @param id 条目身份
   * @param text 当前内容
   * @returns 该条目的版本号
   */
  note(id: string, text: string): number {
    const known = this.state.get(id)
    if (known && known.text === text) return known.version
    const version = this.next++
    this.state.set(id, { version, text })
    return version
  }

  /**
   * @author ddj 2026年10月29号
   * @description: 查询已分配版本号，供评论锚定校验。
   * @param id 条目身份
   * @returns 版本号，未记录时为 undefined
   */
  versionOf(id: string): number | undefined {
    return this.state.get(id)?.version
  }

  /**
   * @author ddj 2026年10月29号
   * @description: 条目离开列表时丢弃其版本号，且不回收编号。
   * @param id 条目身份
   * @returns 无
   */
  drop(id: string): void {
    this.state.delete(id)
  }
}
