/**
 * 待审条目内核：纯状态机，逐条对齐 dsh-diff-approval 的 pending 语义。
 * 无 IO、无时钟、不改入参；调用方传入 now 与内容，便于测试与复用。
 * @author ddj 2026年10月29号
 */
import type { PendingBaseKind, PendingEarlier, PendingEvidence, PendingLineage, PendingOrigin, PendingSource, PendingTracking, PendingVerdict } from '../shared/pendingReview.js'
import { logicalLines } from '../shared/lineEndings.js'
import { strongerEvidence, strongerSource } from './provenance.js'

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
  /** 采集通道；缺省按 `tool` 解释。 */
  source?: PendingSource
  /** 归属；缺省按 `agent` 解释。 */
  origin?: PendingOrigin
  /** 修改前内容的可信度；缺省按 `known` 解释。 */
  baseKind?: PendingBaseKind
  /** 证据强度；缺省按 `snapshot` 解释。 */
  evidence?: PendingEvidence
  /** 这次调用的结局；缺省按 `changed` 解释。 */
  verdict?: PendingVerdict
  /** 差异追踪窗口状态；缺省按 `open` 解释。 */
  tracking?: PendingTracking
  /** 开窗时刻；0 表示未知。 */
  openedAt?: number
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
  source?: PendingSource
  origin?: PendingOrigin
  baseKind?: PendingBaseKind
  evidence?: PendingEvidence
  verdict?: PendingVerdict
  tracking?: PendingTracking
  openedAt?: number
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
 * @description: 净零判定与文本差异生成器保持逻辑行口径一致；只忽略 BOM 和换行编码，不改存储原文。
 * @param entry 待审条目
 * @returns 是否已无净差异
 */
export function isSettled(entry: PendingEntry): boolean {
  if (sameEntryText(entry.oldText, entry.newText)) return true

  const baselineLines = logicalLines(entry.oldText)
  const currentLines = logicalLines(entry.newText)
  return baselineLines.length === currentLines.length
    && baselineLines.every((line, index) => line === currentLines[index])
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
    // 采集通道取更强的一侧（工具链路胜过 watch，watch 胜过补扫），归属取最近一次改动。
    source: strongerSource(earlier.source, later.source),
    origin: later.origin ?? earlier.origin,
    // 基线一旦落成"已知内容"，就不再退回未知；未知只来自首次观察失败的那条记录。
    baseKind: later.baseKind ?? earlier.baseKind,
    // 证据强度同样取更强的一侧：回执胜过自己的快照，结局取最近一次调用。
    evidence: strongerEvidence(earlier.evidence, later.evidence),
    verdict: later.verdict ?? earlier.verdict,
    // 合并只发生在同一窗口内：窗口状态与开窗时刻都沿用较早来源。
    tracking: (earlier.tracking ?? 'open') === 'closed' && (later.tracking ?? 'open') === 'closed' ? 'closed' : 'open',
    openedAt: earlier.openedAt ?? later.openedAt,
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
  if (input.source !== undefined) entry.source = input.source
  if (input.origin !== undefined) entry.origin = input.origin
  if (input.baseKind !== undefined) entry.baseKind = input.baseKind
  if (input.evidence !== undefined) entry.evidence = input.evidence
  if (input.verdict !== undefined) entry.verdict = input.verdict
  entry.tracking = input.tracking ?? 'open'
  entry.openedAt = input.openedAt ?? 0
  return entry
}

/**
 * @author ddj 2026年11月25号
 * @description: 只改窗口状态，其余字段原样保留；开窗时同时写入开窗时刻。
 * @param entry 待审条目
 * @param tracking 目标窗口状态
 * @param openedAt 开窗时刻；缺省沿用原值
 * @returns 新的条目
 */
export function applyTracking(entry: PendingEntry, tracking: 'open' | 'closed', openedAt?: number): PendingEntry {
  return { ...entry, tracking, openedAt: openedAt ?? entry.openedAt ?? 0 }
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
