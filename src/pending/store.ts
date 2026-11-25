/**
 * 待审投影的工作区存储：把采集到的写入折进单条累计条目，并承接 Keep/Revert 与外部改动的吸收。
 * @author ddj 2026年10月29号
 */
import type { PendingDecide, PendingDetail, PendingHistoryMove, PendingItem, PendingOrigin, PendingPage } from '../shared/pendingReview.js'
import type { ReviewBlockState } from '../shared/reviewRegions.js'
import { reviewBlocks } from '../shared/reviewRegions.js'
import { pathKeyOf, sourceOfTool, windows } from './provenance.js'
import type { PendingWrite } from './capture.js'
import { readText, pendingGaps } from './capture.js'
import { noteOf } from './notes.js'
import type { DecideOutcome, WriteResult } from './decide.js'
import { capabilityOf, decide, diffOf } from './decide.js'
import { applyTracking, entryFromNew, isSettled, mergeEntries } from './kernel.js'
import type { PendingEntry } from './kernel.js'
import { coveredPathsOf, isOpenEntry, nextTracking, trackingOf } from './tracking.js'
import type { PendingFlags, StoredEntry } from './persist.js'
import type { KeepRecord } from './persist.js'
import {
  dropBlocks, dropEntry, dropHistory, earliestUndone, latestApplied, loadBlocks, loadEntries, loadEntry,
  purgeEntries, pushHistory, readOp, saveBlocks, saveDecisions, saveEntry, setHistoryState, vacuumEntries, writeOp,
} from './persist.js'
import type { HistoryRow, PurgeFilter, PurgeOutcome } from './persist.js'

/** 派生结果缓存：列表每轮都重算全部条目的整文件差异，是卡顿主因之一；键取「revision + 两侧长度」。 */
const derivedCache = new Map<string, { signature: string; added: number; deleted: number; blocks: ReviewBlockState[] }>()
/** 派生缓存条数上限：超过就丢最早的一条，避免长会话无限增长。 */
const DERIVED_MAX = 256

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 一次 diff 同时给出增删行数与块状态，并按内容签名缓存；内容一变缓存自动失效。
 * @param entry 待审条目
 * @param baselineEmpty 基线置空（新建文件按全量新增计）
 * @param revision 条目版本号；未知时传 -1（按内容长度与时间退化判定）
 * @returns 增删行数与块状态
 */
function derivedOf(entry: PendingEntry, baselineEmpty: boolean, revision: number): { added: number; deleted: number; blocks: ReviewBlockState[] } {
  const signature = `${revision}:${baselineEmpty ? 1 : 0}:${entry.earlierVersion}:${entry.oldText.length}:${entry.newText.length}:${entry.updatedAt}`
  const hit = derivedCache.get(entry.id)
  if (hit && hit.signature === signature) return hit
  const diff = diffOf(entry, baselineEmpty)
  let added = 0
  let deleted = 0
  let blocks: ReviewBlockState[] = []
  if (diff.kind === 'text') {
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) added++
        else if (line.startsWith('-')) deleted++
      }
    }
    blocks = reviewBlocks(diff).map((block) => ({ id: block.id, decision: 'pending' as const }))
  }
  const value = { signature, added, deleted, blocks }
  if (derivedCache.size >= DERIVED_MAX) {
    const oldest = derivedCache.keys().next().value
    if (oldest !== undefined) derivedCache.delete(oldest)
  }
  derivedCache.set(entry.id, value)
  return value
}

/**
 * @author ddj 2026年10月29号 / 2026年11月25号
 * @description: 统计一次差异的增删行数；非文本差异统一记 0/0。
 * @param entry 待审条目
 * @param baselineEmpty 基线置空（新建文件按全量新增计）
 * @param revision 条目版本号
 * @returns 增删行数
 */
function countsOf(entry: PendingEntry, baselineEmpty = false, revision = -1): { added: number; deleted: number } {
  const derived = derivedOf(entry, baselineEmpty, revision)
  return { added: derived.added, deleted: derived.deleted }
}

/**
 * @author ddj 2026年10月30号 / 2026年11月25号
 * @description: 由当前累计条目现场推导块身份；块是差异的纯函数，落库的只是决定状态。
 * @param entry 累计条目
 * @param revision 条目版本号
 * @returns 块状态列表（决定一律 pending，判定推进后由下一次推导自然收窄）
 */
function blockStatesOf(entry: PendingEntry, revision = -1): ReviewBlockState[] {
  return derivedOf(entry, false, revision).blocks
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 由一次采集写入构造新窗口条目；基线取写前内容，开窗时刻取本次写入时间。
 * @param write 采集到的写入
 * @returns 新条目（窗口状态 open）
 */
function freshEntryOf(write: PendingWrite, tracking: 'open' | 'closed' = 'open'): PendingEntry {
  return entryFromNew({
    id: write.identity,
    path: write.path,
    sessionId: write.sessionId,
    earlierVersion: write.before === null ? 'none' : 'file',
    oldText: write.before ?? '',
    newText: write.after ?? '',
    updatedAt: write.now,
    source: sourceOfTool(write.tool),
    origin: originOf(write),
    baseKind: write.before === null ? 'absent' : (write.baseKind ?? 'known'),
    evidence: write.evidence ?? 'snapshot',
    verdict: write.verdict ?? 'changed',
    tracking,
    openedAt: write.now,
  })
}

/**
 * @author ddj 2026年10月29号 / 2026年11月25号
 * @description: 把一次工具写入折进窗口：窗口关闭时按本次写前内容重开新窗口，窗口打开时基线留最早、内容取最新。
 * 重开属于新窗口，调用方负责清掉旧窗口的块决定与撤销行。
 * @param stored 已有条目（可为空）
 * @param write 采集到的写入
 * @returns 折叠后的条目与标记
 */
export function foldWrite(stored: StoredEntry | undefined, write: PendingWrite): StoredEntry {
  const fresh = freshEntryOf(write)
  if (!stored) {
    return {
      entry: fresh,
      flags: { missing: write.after === null, diverged: false, oversized: false, revision: 0 },
    }
  }
  if (!isOpenEntry(stored.entry)) {
    // 新窗口：基线是这次写前内容；旧窗口的判定、块与撤销都不跨窗。
    return {
      entry: fresh,
      flags: { missing: write.after === null, diverged: false, oversized: stored.flags.oversized, revision: stored.flags.revision + 1 },
    }
  }
  const merged = mergeEntries(stored.entry, fresh)
  merged.path = write.path
  return {
    entry: merged,
    flags: {
      missing: write.after === null,
      diverged: false,
      oversized: stored.flags.oversized,
      revision: stored.flags.revision + 1,
    },
  }
}

/**
 * @private
 * @author ddj 2026-11-24
 * @description: 本次写入的归属：显式指定优先，否则按窗口判定（工具链路默认 agent）。
 * @param write 采集到的写入
 * @returns 归属
 */
function originOf(write: PendingWrite): PendingOrigin {
  if (write.origin) return write.origin
  const window = windows.windowOf(pathKeyOf(write.identity))
  if (window === 'self') return 'agent'
  if (window === 'editor') return 'editor'
  return 'agent'
}

/**
 * @author ddj 2026年10月29号
 * @description: 条目转列表投影，已解决条目仍保留但不可再决定。
 * @param stored 条目与标记
 * @param baselineEmpty 基线置空（新建文件按全量新增计）
 * @returns 列表项
 */
export function itemOf(stored: StoredEntry, baselineEmpty = false): PendingItem {
  const { entry, flags } = stored
  const counts = countsOf(entry, baselineEmpty, flags.revision)
  const item: PendingItem = {
    id: entry.id,
    path: entry.path,
    earlierVersion: entry.earlierVersion,
    added: counts.added,
    deleted: counts.deleted,
    settled: isSettled(entry),
    unseen: entry.unseen === true,
    missing: flags.missing,
    diverged: flags.diverged,
    oversized: flags.oversized,
    revision: flags.revision,
    updatedAt: entry.updatedAt,
    sessionId: entry.sessionId,
    sessionIds: entry.sessionIds,
    source: entry.source ?? 'tool',
    origin: entry.origin ?? 'agent',
    baseKind: entry.baseKind ?? 'known',
    evidence: entry.evidence ?? 'snapshot',
    verdict: entry.verdict ?? 'changed',
    tracking: trackingOf(entry),
    openedAt: entry.openedAt ?? 0,
  }
  if (entry.lineage !== undefined) item.lineage = entry.lineage
  return item
}

/**
 * @private
 * @author ddj 2026年11月04号 / 2026年11月25号
 * @description: 从条目基线判断创建来源：只有窗口自己的基线是"文件不存在"时才按整文件新增渲染。
 * 重开窗口的基线是磁盘真实内容，不再借官方快照把整个文件算成新增。
 * @param stored 累计条目
 * @returns 是否将展示基线置空
 */
function emptyBaseOf(stored: StoredEntry): boolean {
  return stored.entry.earlierVersion === 'none'
}

/**
 * @author ddj 2026年10月29号
 * @description: 读工作区全部待审条目，按更新时间升序；来源会话仅用于追溯。
 * @param cwd 工作区
 * @param _sessionId 兼容旧调用签名，不再用于可见性过滤
 * @returns 列表
 */
export function loadPage(cwd: string, _sessionId?: string): PendingPage {
  const all = loadEntries(cwd)
  // 列表只显示开窗中的文件：已关窗条目仍留在库里供撤销判定，但不再出现在面板。
  const visible = all.filter((stored) => isOpenEntry(stored.entry))
  const items = visible.map((stored) => withNote(cwd, itemOf(stored, emptyBaseOf(stored))))
  const gaps: string[] = pendingGaps(cwd)
  for (const stored of visible) {
    if (stored.flags.oversized) gaps.push(`${stored.entry.path}: 文本超出上限，仅保留标记`)
  }
  return {
    items,
    pending: items.filter((item) => !item.settled).length,
    nextCursor: null,
    gaps,
    coveredPaths: coveredPathsOf(all),
  }
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 挂上模型的只读说明；说明只在内存里，不落库也不参与判定。
 * @param cwd 工作区
 * @param item 列表项
 * @returns 可能带说明的列表项
 */
function withNote(cwd: string, item: PendingItem): PendingItem {
  const note = noteOf(cwd, item.id)
  return note === undefined ? item : { ...item, note }
}

/**
 * @author ddj 2026年10月29号
 * @description: 读单条详情，包含可交给现有面板渲染的差异与块决定。
 * @param cwd 工作区
 * @param id 条目身份
 * @param baselineEmpty 基线置空（新建文件按全量新增渲染）
 * @returns 详情，条目不存在时 null
 */
export function loadDetail(cwd: string, id: string, baselineEmpty = false): PendingDetail | null {
  const stored = loadEntries(cwd).find((item) => item.entry.id === id)
  if (!stored) return null
  const emptyBase = baselineEmpty || emptyBaseOf(stored)
  const diff = diffOf(stored.entry, emptyBase)
  return {
    item: withNote(cwd, itemOf(stored, emptyBase)),
    diff,
    blocks: blockStatesOf(stored.entry, stored.flags.revision),
    capability: capabilityOf(stored.entry, stored.flags),
  }
}

/**
 * @author ddj 2026年10月29号 / 2026年11月25号
 * @description: 工具写入入口：开窗或折进当前窗口；关窗后再次写入按新窗口处理。
 * @param write 已确认写入
 * @returns 无
 */
export function recordWrite(write: PendingWrite): void {
  const stored = loadEntries(write.cwd).find((item) => item.entry.id === write.identity)
  // 开窗中的重复上报且内容没变：不重复落库
  if (stored && isOpenEntry(stored.entry) && stored.entry.oldText === stored.entry.newText
    && stored.entry.newText === (write.after ?? '')) return
  const next = foldWrite(stored, write)
  // 重开属于新窗口：旧窗口的块决定与撤销行不跨窗
  if (stored && !isOpenEntry(stored.entry)) {
    dropBlocks(write.cwd, write.identity)
    dropHistory(write.cwd, write.identity)
  }
  saveEntry(write.cwd, withWindow(next))
}

/**
 * @author ddj 2026年11月25号
 * @description: 外部/编辑器改动入口：只折进已开窗的文件，其余路径一律不建记录。
 * @param write 采集到的外部改动
 * @returns 是否折进了窗口
 */
export function foldTracked(write: PendingWrite): boolean {
  const stored = loadEntries(write.cwd).find((item) => item.entry.id === write.identity)
  if (!stored || !isOpenEntry(stored.entry)) return false
  const merged = mergeEntries(stored.entry, freshEntryOf(write))
  merged.path = write.path
  const closed = nextTracking(merged) === 'closed'
  const entry = applyTracking(merged, closed ? 'closed' : 'open')
  // 外部改动默认标未读；已经回到基线的窗口没有可看内容，不标
  if (!closed) entry.unseen = true
  saveEntry(write.cwd, {
    entry,
    flags: {
      missing: write.after === null,
      diverged: !closed,
      oversized: stored.flags.oversized,
      revision: stored.flags.revision + 1,
    },
  })
  return true
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 按净差异收尾窗口状态：内容回到基线就关窗，否则保持打开。
 * @param stored 条目与标记
 * @returns 收尾后的条目与标记
 */
function withWindow(stored: StoredEntry): StoredEntry {
  const state = nextTracking(stored.entry)
  return { ...stored, entry: applyTracking(stored.entry, state) }
}

/**
 * @author ddj 2026年10月29号
 * @description: 构造带版本守卫与读回校验的写盘函数；内容已被外部改动时直接拒绝。
 * @param fs 文件系统
 * @param cwd 工作区
 * @param identity 目标身份
 * @param expected 写前应当具备的内容
 * @param signal 取消信号
 * @param policy 沙箱策略
 * @param allowCreate 文件已被删除时是否允许按快照重建（仅撤销/重做路径使用）
 * @returns 写盘函数
 */
export function writerFor(
  fs: any, cwd: string, identity: string, expected: string, signal?: AbortSignal, policy?: unknown,
  allowCreate = false,
): (content: string | null) => Promise<WriteResult> {
  return async (content) => {
    let target: any
    try {
      target = await fs.resolve(identity, { cwd, signal })
    } catch {
      return { ok: false, reason: 'resolve-failed' }
    }
    const snapshot = await stableRead(fs, target, signal)
    if (!snapshot.ok) return snapshot
    // 缺失仅允许撤销/重做重建；原子 createIfAbsent 防止检查后被其他写入抢占。
    const recreate = allowCreate && snapshot.content === null
    if (!recreate && snapshot.content !== expected) return { ok: false, reason: 'diverged' }
    if (snapshot.content === null && !recreate) return { ok: false, reason: 'missing' }
    const intent = recreate
      ? { kind: 'createIfAbsent' }
      : { kind: 'replaceIfVersion', version: snapshot.version }
    try {
      const written = await fs.writeText(target, content ?? '', intent, signal, policy)
      const readBack = await readText(fs, target)
      if (content !== readBack) return { ok: false, reason: 'read-back-mismatch' }
      if (content === null && readBack !== null) return { ok: false, reason: 'delete-failed' }
      void written
      return { ok: true, content }
    } catch (error) {
      return { ok: false, reason: reasonOf(error) }
    }
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 执行一次 Keep/Revert 并把结果落库；失败只返回原因，不写任何状态。
 * @param fs 文件系统
 * @param cwd 工作区
 * @param request 判定请求
 * @param signal 取消信号
 * @returns 判定结果
 */
export async function applyDecide(
  fs: any, cwd: string, request: PendingDecide, signal?: AbortSignal, policy?: unknown,
): Promise<DecideOutcome | { ok: false; reason: string }> {
  const stored = loadEntries(cwd).find((item) => item.entry.id === request.id)
  if (!stored) return { ok: false, reason: 'unknown-item' }
  // 撤销会写盘：先打自写标记，避免 watch 把插件自己的写回折成一次外部改动。
  if (request.decision === 'rejected') windows.markSelf(pathKeyOf(stored.entry.id))
  const beforeBlocks = blockStatesOf(stored.entry, stored.flags.revision)
  const outcome = await decide({
    request,
    entry: stored.entry,
    flags: stored.flags,
    blocks: beforeBlocks,
    now: Date.now(),
    write: (content) => {
      if (content === null) return deleteTarget(fs, cwd, stored.entry.id, stored.entry.newText, signal, policy)
      // 允许重建：文件已被删除时撤销的语义就是「恢复修改前内容」。createIfAbsent 原子创建，
      // 期间有人抢先写了同名文件会失败并回到 diverged，不会覆盖别人的新内容。
      return writerFor(fs, cwd, stored.entry.id, stored.entry.newText, signal, policy, true)(content)
    },
  })
  if (!outcome.ok) return { ok: false, reason: outcome.reason }
  // 判定把两侧推平就关窗；还有剩余块就保持打开。
  const entry = applyTracking(outcome.entry, nextTracking(outcome.entry))
  saveEntry(cwd, { entry, flags: outcome.flags })
  saveBlocks(cwd, request.id, outcome.blocks)
  // 撤销行按路径覆盖写：同一路径永远只有一行，撤销回到判定前的基线或内容
  pushHistory(cwd, {
    entryId: request.id,
    path: stored.entry.path,
    kind: request.decision === 'accepted' ? 'keep' : 'revert',
    earlier: stored.entry.earlierVersion,
    baseline: stored.entry.oldText,
    content: stored.entry.newText,
    wrote: outcome.wrote,
  }, Date.now())
  return { ...outcome, entry }
}

/** 批量 Keep 的目标条目：display 只用于回报，operationId 由 host 按批次派生。 */
export interface PendingKeepTarget {
  id: string
  display: string
  operationId: string
}
/** 批量 Keep 的结果：kept 是真正推进到保留态的条目，skipped 说明该条为什么没保留。 */
export interface PendingKeepOutcome {
  kept: { id: string; path: string }[]
  skipped: { id: string; display: string; reason: string }[]
}

/**
 * @public
 * @author ddj 2026年11月03号
 * @description: 一次读取全表后批量保留待审条目（Keep 不写盘）。写入用刚读到的最新 revision，
 * 客户端快照漂移不会整批中止；单条 oversized、不存在或落库时被抢先推进只跳过自己。
 * @param cwd 工作区
 * @param items 待保留条目
 * @returns 保留成功与跳过的明细
 * @throws 待审库迁移未就绪等存储级异常
 */
export async function keepAll(cwd: string, items: PendingKeepTarget[]): Promise<PendingKeepOutcome> {
  const stored = new Map(loadEntries(cwd).map((item) => [item.entry.id, item]))
  const now = Date.now()
  const outcome: PendingKeepOutcome = { kept: [], skipped: [] }
  const records: KeepRecord[] = []

  for (const item of items) {
    const before = stored.get(item.id)
    if (!before) {
      outcome.skipped.push({ id: item.id, display: item.display, reason: '待审条目不存在' })
      continue
    }
    if (before.flags.oversized) {
      outcome.skipped.push({ id: item.id, display: item.display, reason: '文本超出上限，不能整文件保留' })
      continue
    }
    // 已经是保留态：幂等无操作，仍算保留成功
    if (isSettled(before.entry)) {
      outcome.kept.push({ id: item.id, path: before.entry.path })
      continue
    }

    const beforeBlocks = blockStatesOf(before.entry, before.flags.revision)
    const outcomeOf = await decide({
      request: { sessionId: before.entry.sessionId, id: item.id, revision: before.flags.revision,
        operationId: item.operationId, decision: 'accepted', scope: 'file' },
      entry: before.entry, flags: before.flags, blocks: beforeBlocks, now,
      // Keep 永不写盘：真走到写回说明逻辑被改坏，宁可炸掉也不静默落盘
      write: () => { throw new Error('批量 Keep 不写盘') },
    })
    if (!outcomeOf.ok) {
      outcome.skipped.push({ id: item.id, display: item.display, reason: outcomeOf.reason })
      continue
    }
    outcome.kept.push({ id: item.id, path: before.entry.path })
    records.push({
      entryId: item.id,
      stored: before,
      next: { entry: applyTracking(outcomeOf.entry, nextTracking(outcomeOf.entry)), flags: outcomeOf.flags },
      blocks: outcomeOf.blocks,
    })
  }

  // 落库阶段被别的决定抢先推进的条目从 kept 挪到 skipped，如实反映磁盘状态
  const displayOf = new Map(items.map((item) => [item.id, item.display]))
  for (const conflict of saveDecisions(cwd, records)) {
    outcome.kept = outcome.kept.filter((entry) => entry.id !== conflict.id)
    outcome.skipped.push({ id: conflict.id, display: displayOf.get(conflict.id) ?? conflict.id, reason: conflict.reason })
  }
  return outcome
}

/**
 * @author ddj 2026年10月30号
 * @description: 撤销或重做最近一次判定。一条路径只有一行撤销记录：撤销回到判定前的两侧内容，
 * 重做再按同一判定推进一次；只有写盘过的判定才反向写盘，写盘失败时条目状态保持原样。
 * @param fs 文件系统
 * @param cwd 工作区
 * @param move 撤销/重做请求
 * @param signal 取消信号
 * @returns 结果条目与是否写盘
 */
export async function undoDecide(
  fs: any, cwd: string, move: PendingHistoryMove, signal?: AbortSignal, policy?: unknown,
): Promise<{ ok: true; item: PendingItem; wrote: boolean } | { ok: false; reason: string }> {
  const replay = readOp(cwd, move.operationId)
  if (replay && replay.state === 'committed' && replay.result) return JSON.parse(replay.result) as { ok: true; item: PendingItem; wrote: boolean }

  const record = move.direction === 'undo' ? latestApplied(cwd) : earliestUndone(cwd)
  if (!record) return { ok: false, reason: move.direction === 'undo' ? 'no-undo' : 'no-redo' }
  const stored = loadEntry(cwd, record.entryId)
  if (!stored) return { ok: false, reason: 'unknown-item' }
  const target = replayTargetOf(stored, record, move.direction === 'undo')

  writeOp(cwd, move.operationId, JSON.stringify(move), 'prepared')
  let wrote = false
  if (target.write) {
    // 插件写回会触发 watch：先打自写标记，避免折成一次外部改动。
    windows.markSelf(pathKeyOf(stored.entry.id))
    const result = await writeBack(fs, cwd, stored, target.state, signal, policy)
    if (!result.ok) return { ok: false, reason: result.reason }
    wrote = true
  }

  // 撤销/重做后按净差异收尾窗口：撤销 Keep 会重新出现差异 → 重开；重做 → 关窗。
  const entry = applyTracking(target.state.entry, nextTracking(target.state.entry))
  saveEntry(cwd, { entry, flags: target.state.flags })
  saveBlocks(cwd, record.entryId, target.state.blocks)
  setHistoryState(cwd, record.entryId, move.direction === 'undo' ? 'undone' : 'applied')
  const outcome = { ok: true as const, item: itemOf({ entry, flags: target.state.flags }), wrote }
  writeOp(cwd, move.operationId, JSON.stringify(move), 'committed', { result: JSON.stringify(outcome) })
  return outcome
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 由当前条目与撤销行推导撤销/重做后的状态：Keep 只动基线，Revert 还要把内容写回盘。
 * @param stored 当前条目
 * @param record 撤销行
 * @param undone 是否撤销（false 为重做）
 * @returns 目标状态与是否需要写盘
 */
function replayTargetOf(stored: StoredEntry, record: HistoryRow, undone: boolean): { state: HistoryState; write: boolean } {
  const revision = stored.flags.revision + 1
  if (record.kind === 'keep') {
    const baseline = undone ? record.baseline : stored.entry.newText
    const entry: PendingEntry = {
      ...stored.entry,
      oldText: baseline,
      earlierVersion: undone ? record.earlier : 'file',
      updatedAt: Date.now(),
    }
    delete entry.unseen
    return { state: { entry, flags: { ...stored.flags, missing: false, revision }, blocks: [] }, write: false }
  }
  // Revert 写过盘：撤销写回判定前的内容，重做写回基线；新建文件的 Revert 重做等价于删除
  const missing = !undone && record.earlier === 'none'
  const entry: PendingEntry = {
    ...stored.entry,
    newText: missing ? '' : (undone ? record.content : record.baseline),
    updatedAt: Date.now(),
  }
  delete entry.unseen
  return { state: { entry, flags: { ...stored.flags, missing, revision }, blocks: [] }, write: true }
}

/**
 * @author ddj 2026年10月30号
 * @description: 把文件内容恢复到目标快照：目标为缺失则删除，否则按版本守卫写回并读回校验。
 * @param fs 文件系统
 * @param cwd 工作区
 * @param stored 当前条目
 * @param target 目标快照
 * @param signal 取消信号
 * @returns 写盘结果
 */
async function writeBack(
  fs: any, cwd: string, stored: StoredEntry, target: HistoryState, signal?: AbortSignal, policy?: unknown,
): Promise<WriteResult> {
  if (target.flags.missing) return deleteTarget(fs, cwd, stored.entry.id, stored.entry.newText, signal, policy)
  const write = writerFor(fs, cwd, stored.entry.id, stored.entry.newText, signal, policy, true)
  return write(target.entry.newText)
}

/** 撤销/重做时的单侧目标状态。 */
interface HistoryState {
  entry: PendingEntry
  flags: PendingFlags
  blocks: ReviewBlockState[]
}

/** 稳定快照；缺失与读取失败严格区分，不允许省略现存文件的版本。 */
type StableFile = { ok: true; content: string | null; version?: string } | { ok: false; reason: string }

/**
 * @private
 * @author ddj 2026年11月04号
 * @description 版本—内容—版本读取，防止将新版本令牌与旧内容拼成写入依据。
 * @param fs 文件提供方
 * @param target 已解析目标
 * @param signal 取消信号
 * @returns 稳定快照或拒绝原因
 */
async function stableRead(fs: any, target: any, signal?: AbortSignal): Promise<StableFile> {
  try {
    const before = await fs.stat(target, signal)
    if (!before) return { ok: true, content: null }
    if (before.type !== 'file' || !before.version) return { ok: false, reason: 'unguarded-file' }
    const content = await readText(fs, target, signal)
    if (content === null) return { ok: false, reason: 'revision-mismatch' }
    const after = await fs.stat(target, signal)
    if (after?.type !== 'file' || after.version !== before.version) return { ok: false, reason: 'revision-mismatch' }
    return { ok: true, content, version: before.version }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}

/**
 * @private
 * @author ddj 2026年11月04号
 * @description 通过 provider 受控删除，保留会话策略与原子版本校验；旧 Host 不回落直删。
 * @param fs 文件提供方
 * @param cwd 工作目录
 * @param identity 目标身份
 * @param expected 应有内容
 * @param signal 取消信号
 * @param policy 会话沙箱策略
 * @returns 删除结果；结果不明不提交决定
 */
async function deleteTarget(
  fs: any, cwd: string, identity: string, expected: string, signal?: AbortSignal, policy?: unknown,
): Promise<WriteResult> {
  if (typeof fs.deleteFile !== 'function') return { ok: false, reason: 'delete-unavailable' }
  try {
    const target = await fs.resolve(identity, { cwd, signal })
    const snapshot = await stableRead(fs, target, signal)
    if (!snapshot.ok) return snapshot
    if (snapshot.content === null) return { ok: true, content: null }
    if (snapshot.content !== expected) return { ok: false, reason: 'diverged' }

    await fs.deleteFile(target, { version: snapshot.version }, signal, policy)
    const after = await fs.stat(target, signal)
    return after ? { ok: false, reason: 'delete-failed' } : { ok: true, content: null }
  } catch (error) {
    return { ok: false, reason: reasonOf(error) }
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 从列表移除已解决条目；未解决条目拒绝移除，避免表里看不到却被删掉。
 * @param cwd 工作区
 * @param id 条目身份
 * @param revision 并发校验版本
 * @returns 是否移除
 */
export function removeEntry(cwd: string, id: string, revision: number): boolean {
  const stored = loadEntries(cwd).find((item) => item.entry.id === id)
  if (!stored || stored.flags.revision !== revision || !isSettled(stored.entry)) return false
  dropEntry(cwd, id)
  return true
}

/** 清库回执：命中、删除、保留条数，以及可选的 VACUUM 耗时。 */
export interface PendingPurgeOutcome extends PurgeOutcome {
  /** VACUUM 耗时毫秒；dryRun 或未清理时为 undefined。 */
  vacuumMs?: number
}

/** 清库默认口径：只清 watch 通道、空基线的条目——幽灵记录就长这样。 */
export const PURGE_DEFAULT_SOURCES = ['watch']
/** 清库默认基线口径：空基线（改前内容缺失）。 */
export const PURGE_DEFAULT_BASE_KINDS = ['absent']

/**
 * @public
 * @author ddj 2026-11-24
 * @description: 清掉指定通道的待审条目（幽灵记录治理入口）。dryRun 只报数；
 * 真删之后按需 VACUUM，把已删行占的页还给磁盘。
 * @param cwd 工作区
 * @param filter 筛选条件（缺省 watch + absent）
 * @param options dryRun 只数不删；vacuum 删除后是否回收
 * @returns 命中、删除、保留条数与 VACUUM 耗时
 */
export function purgePending(
  cwd: string, filter: PurgeFilter = {}, options: { dryRun?: boolean; vacuum?: boolean } = {},
): PendingPurgeOutcome {
  const scoped: PurgeFilter = {
    sources: filter.sources && filter.sources.length ? filter.sources : PURGE_DEFAULT_SOURCES,
    baseKinds: filter.baseKinds && filter.baseKinds.length ? filter.baseKinds : PURGE_DEFAULT_BASE_KINDS,
    before: filter.before,
  }
  const outcome = purgeEntries(cwd, scoped, options.dryRun === true)
  if (options.dryRun || !outcome.removed || !options.vacuum) return outcome
  return { ...outcome, vacuumMs: vacuumEntries(cwd) }
}

/**
 * @author ddj 2026年10月29号
 * @description: 取错误码用于拒绝原因，没有则回落到消息文本。
 * @param error 抛出的错误
 * @returns 原因字符串
 */
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : String(error)
}
