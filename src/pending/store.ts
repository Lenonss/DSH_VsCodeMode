/**
 * 待审投影的工作区存储：把采集到的写入折进单条累计条目，并承接 Keep/Revert 与外部改动的吸收。
 * @author ddj 2026年10月29号
 */
import type { PendingDecide, PendingDetail, PendingHistoryMove, PendingItem, PendingPage } from '../shared/pendingReview.js'
import type { ReviewBlockState } from '../shared/reviewRegions.js'
import { reviewBlocks } from '../shared/reviewRegions.js'
import { addedFiles } from '../reviewDb.js'
import type { PendingWrite } from './capture.js'
import { readText, pendingGaps } from './capture.js'
import type { ShellLike, VcsImportOptions } from './vcs.js'
import { importVcsChanges } from './vcs.js'
import type { DecideOutcome, WriteResult } from './decide.js'
import { capabilityOf, decide, diffOf } from './decide.js'
import { entryFromNew, isSettled, mergeEntries } from './kernel.js'
import type { PendingEntry } from './kernel.js'
import type { PendingFlags, StoredEntry } from './persist.js'
import type { KeepRecord } from './persist.js'
import {
  dropEntry, earliestUndone, latestApplied, loadBlocks, loadEntries, pendingDb, pushHistory,
  readOp, saveBlocks, saveDecisions, saveEntry, setHistoryState, writeOp,
} from './persist.js'

/**
 * @author ddj 2026年10月29号
 * @description: 统计一次差异的增删行数；非文本差异统一记 0/0。
 * @param entry 待审条目
 * @param baselineEmpty 基线置空（新建文件按全量新增计）
 * @returns 增删行数
 */
function countsOf(entry: PendingEntry, baselineEmpty = false): { added: number; deleted: number } {
  const diff = diffOf(entry, baselineEmpty)
  if (diff.kind !== 'text') return { added: 0, deleted: 0 }
  let added = 0
  let deleted = 0
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) deleted++
    }
  }
  return { added, deleted }
}

/**
 * @author ddj 2026年10月30号
 * @description: 由当前累计条目现场推导块身份；块是差异的纯函数，落库的只是决定状态。
 * @param entry 累计条目
 * @returns 块状态列表（决定一律 pending，判定推进后由下一次推导自然收窄）
 */
function blockStatesOf(entry: PendingEntry): ReviewBlockState[] {
  const diff = diffOf(entry)
  if (diff.kind !== 'text') return []
  return reviewBlocks(diff).map((block) => ({ id: block.id, decision: 'pending' as const }))
}

/**
 * @author ddj 2026年10月29号
 * @description: 把一次已确认写入折进累计条目：同一身份只保留一条，基线留最早、内容取最新。
 * @param stored 已有条目（可为空）
 * @param write 采集到的写入
 * @returns 折叠后的条目与标记
 */
export function foldWrite(stored: StoredEntry | undefined, write: PendingWrite): StoredEntry {
  const fresh: PendingEntry = entryFromNew({
    id: write.identity,
    path: write.path,
    sessionId: write.sessionId,
    earlierVersion: write.before === null ? 'none' : 'file',
    oldText: write.before ?? '',
    newText: write.after ?? '',
    updatedAt: write.now,
  })
  if (!stored) {
    return {
      entry: fresh,
      flags: { missing: write.after === null, diverged: false, oversized: false, revision: 0 },
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
 * @author ddj 2026年10月29号
 * @description: 条目转列表投影，已解决条目仍保留但不可再决定。
 * @param stored 条目与标记
 * @param baselineEmpty 基线置空（新建文件按全量新增计）
 * @returns 列表项
 */
export function itemOf(stored: StoredEntry, baselineEmpty = false): PendingItem {
  const { entry, flags } = stored
  const counts = countsOf(entry, baselineEmpty)
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
  }
  if (entry.lineage !== undefined) item.lineage = entry.lineage
  return item
}

/**
 * @private
 * @author ddj 2026年11月04号
 * @description 从条目来源判断创建基线；任何决定历史都阻止展示层复活已推进的旧基线。
 * @param cwd 工作区
 * @param stored 累计条目
 * @param sourceAdds 单次读取内的来源创建集合缓存
 * @returns 是否将展示基线置空
 */
function emptyBaseOf(cwd: string, stored: StoredEntry, sourceAdds = new Map<string, Set<string>>()): boolean {
  if (isSettled(stored.entry)) return false
  const decided = pendingDb(cwd).prepare('SELECT 1 FROM pending_history WHERE entry_id=? LIMIT 1').get(stored.entry.id)
  if (decided) return false
  for (const sourceId of stored.entry.sessionIds) {
    let createdPaths = sourceAdds.get(sourceId)
    if (!createdPaths) {
      createdPaths = addedFiles(cwd, sourceId)
      sourceAdds.set(sourceId, createdPaths)
    }
    if (createdPaths.has(stored.entry.id)) return true
  }
  return false
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
  const visible = all
  const sourceAdds = new Map<string, Set<string>>()
  const items = visible.map((stored) => itemOf(stored, emptyBaseOf(cwd, stored, sourceAdds)))
  const gaps: string[] = pendingGaps(cwd)
  for (const stored of visible) {
    if (stored.flags.oversized) gaps.push(`${stored.entry.path}: 文本超出上限，仅保留标记`)
  }
  return { items, pending: items.filter((item) => !item.settled).length, nextCursor: null, gaps }
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
  const emptyBase = baselineEmpty || emptyBaseOf(cwd, stored)
  const diff = diffOf(stored.entry, emptyBase)
  return {
    item: itemOf(stored, emptyBase),
    diff,
    blocks: blockStatesOf(stored.entry),
    capability: capabilityOf(stored.entry, stored.flags),
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 采集入口：折叠写入并落库。
 * @param write 已确认写入
 * @returns 无
 */
export function recordWrite(write: PendingWrite): void {
  const stored = loadEntries(write.cwd).find((item) => item.entry.id === write.identity)
  if (stored && stored.entry.oldText === stored.entry.newText && stored.entry.newText === (write.after ?? '')) return
  saveEntry(write.cwd, foldWrite(stored, write))
}

/**
 * @author ddj 2026年10月29号
 * @description: 外部改动吸收：当前内容与条目最新内容不同时采纳并标分歧，基线不动。
 * @param stored 条目
 * @param content 磁盘当前内容
 * @param now 时间
 * @returns 新条目与标记
 */
export function absorbed(stored: StoredEntry, content: string, now: number): StoredEntry {
  return {
    entry: { ...stored.entry, newText: content, updatedAt: now, unseen: true },
    flags: { ...stored.flags, diverged: true, missing: false, revision: stored.flags.revision + 1 },
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 读回磁盘并把可读的外部改动吸收进条目；缺失只标标记不删条目。
 * @param stored 条目
 * @param content 磁盘当前内容，null 表示缺失或不可读
 * @param now 时间
 * @returns 需要落库的新状态，无需改动时为 null
 */
export function refreshed(stored: StoredEntry, content: string | null, now: number): StoredEntry | null {
  if (content === null) {
    if (stored.flags.missing) return null
    return { entry: stored.entry, flags: { ...stored.flags, missing: true, revision: stored.flags.revision + 1 } }
  }
  if (content === stored.entry.newText) {
    if (!stored.flags.missing) return null
    return { entry: stored.entry, flags: { ...stored.flags, missing: false, revision: stored.flags.revision + 1 } }
  }
  return absorbed(stored, content, now)
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
  const beforeBlocks = blockStatesOf(stored.entry)
  const outcome = await decide({
    request,
    entry: stored.entry,
    flags: stored.flags,
    blocks: beforeBlocks,
    now: Date.now(),
    write: (content) => {
      if (content === null) return deleteTarget(fs, cwd, stored.entry.id, stored.entry.newText, signal, policy)
      return writerFor(fs, cwd, stored.entry.id, stored.entry.newText, signal, policy)(content)
    },
  })
  if (!outcome.ok) return { ok: false, reason: outcome.reason }
  saveEntry(cwd, { entry: outcome.entry, flags: outcome.flags })
  saveBlocks(cwd, request.id, outcome.blocks)
  // 记录撤销快照（含是否真的写过盘），撤销/重做都从这条记录反推
  pushHistory(cwd, 'decide', request.id, JSON.stringify({
    before: { entry: stored.entry, flags: stored.flags, blocks: beforeBlocks },
    after: { entry: outcome.entry, flags: outcome.flags, blocks: outcome.blocks as ReviewBlockState[] },
    wrote: outcome.wrote,
  }), Date.now())
  return outcome
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

    const beforeBlocks = blockStatesOf(before.entry)
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
    records.push({ entryId: item.id, stored: before, next: { entry: outcomeOf.entry, flags: outcomeOf.flags },
      blocks: outcomeOf.blocks, snapshot: JSON.stringify({
        before: { entry: before.entry, flags: before.flags, blocks: beforeBlocks },
        after: { entry: outcomeOf.entry, flags: outcomeOf.flags, blocks: outcomeOf.blocks },
        wrote: outcomeOf.wrote,
      }) })
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
 * @description: 版本库导入：把工作副本相对基线的改动折进待审条目，已存在条目按折叠规则并入。
 * @param shell shell 能力
 * @param cwd 工作区
 * @param sessionId 触发导入的会话
 * @param options 导入选项
 * @returns 导入条数与探测到的改动数
 */
export async function importFromVcs(
  shell: ShellLike, cwd: string, sessionId: string, options: VcsImportOptions = {},
): Promise<{ imported: number; changes: number }> {
  const changes = await importVcsChanges(shell, cwd, options)
  const now = Date.now()
  for (const change of changes) {
    recordWrite({
      cwd,
      sessionId,
      path: change.path,
      identity: change.path,
      before: change.earlierVersion === 'none' ? null : change.oldText,
      after: change.newText,
      now,
    })
  }
  return { imported: changes.length, changes: changes.length }
}

/**
 * @author ddj 2026年10月30号
 * @description: 撤销或重做最近一次判定。先按 operationId 判幂等，再据栈顶记录判定方向是否合法，
 * 只有写盘过的判定才反向写盘，写盘失败时条目状态保持原样。
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
  const snapshot = parseSnapshot(record.snapshot)
  if (!snapshot) return { ok: false, reason: 'bad-history' }
  const stored = loadEntries(cwd).find((item) => item.entry.id === record.entryId)
  if (!stored) return { ok: false, reason: 'unknown-item' }
  const target = move.direction === 'undo' ? snapshot.before : snapshot.after

  writeOp(cwd, move.operationId, JSON.stringify(move), 'prepared')
  let wrote = false
  if (snapshot.wrote) {
    const result = await writeBack(fs, cwd, stored, target, signal, policy)
    if (!result.ok) return { ok: false, reason: result.reason }
    wrote = true
  }

  saveEntry(cwd, { entry: target.entry, flags: target.flags })
  saveBlocks(cwd, record.entryId, target.blocks)
  setHistoryState(cwd, record.id, move.direction === 'undo' ? 'undone' : 'applied')
  const outcome = { ok: true as const, item: itemOf({ entry: target.entry, flags: target.flags }), wrote }
  writeOp(cwd, move.operationId, JSON.stringify(move), 'committed', { result: JSON.stringify(outcome) })
  return outcome
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

/** 历史快照中单侧状态。 */
interface HistoryState {
  entry: PendingEntry
  flags: PendingFlags
  blocks: ReviewBlockState[]
}

/** 一次判定的双向快照。 */
interface HistorySnapshot {
  before: HistoryState
  after: HistoryState
  wrote: boolean
}

/**
 * @author ddj 2026年10月30号
 * @description: 解析历史快照；损坏时返回 null，不猜测内容。
 * @param text 快照文本
 * @returns 快照或 null
 */
function parseSnapshot(text: string): HistorySnapshot | null {
  try {
    const parsed = JSON.parse(text) as HistorySnapshot
    if (!parsed?.before?.entry || !parsed?.after?.entry) return null
    return parsed
  } catch {
    return null
  }
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
