/**
 * 待审投影的持久化：与官方历史共用工作区库，但只新增 pending_* 表，绝不改写 review_* 事实。
 * @author ddj 2026年10月29号
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { activeReady, dbFor } from '../archiveDb.js'
import { log } from '../log.js'
import type { PendingBaseKind, PendingEvidence, PendingLineage, PendingOrigin, PendingSource, PendingVerdict } from '../shared/pendingReview.js'
import type { PendingEntry } from './kernel.js'

/** 数据库行。 */
type Row = Record<string, string | number | null>

/** 条目上除两侧全文之外的持久标记。 */
export interface PendingFlags {
  missing: boolean
  diverged: boolean
  oversized: boolean
  revision: number
}

/** 一条已落库的条目。 */
export interface StoredEntry {
  entry: PendingEntry
  flags: PendingFlags
}

/** 待审库版本号，写进 metadata 便于日后迁移。v6 把撤销栈改成「一条路径一行」。 */
const SCHEMA_VERSION = '6'
/** 迁移前的备份后缀。 */
const BACKUP_SUFFIX = '.before-pending.bak'
/** 工作区待审版本号：条目一落库就自增，供客户端轮询判断是否需要重读列表。 */
const versions = new Map<string, number>()

/**
 * @author ddj 2026-11-24
 * @description: 读工作区待审版本号；只在条目真正落库后自增，保证「先记录后通知 UI」。
 * @param cwd 工作区
 * @returns 单调递增的版本号
 */
export function pendingVersion(cwd: string): number {
  return versions.get(cwd) ?? 0
}

/**
 * @private
 * @author ddj 2026-11-24
 * @description: 条目状态变化后自增版本号（进程内计数，不落盘）。
 * @param cwd 工作区
 * @returns 无
 */
function bumpVersion(cwd: string): void {
  versions.set(cwd, (versions.get(cwd) ?? 0) + 1)
}

/**
 * @private
 * @author ddj 2026-11-24
 * @description: 清空某工作区版本号（活跃库重建时用，避免把旧计数当新变化）。
 * @param cwd 工作区
 * @returns 无
 */
export function resetPendingVersion(cwd: string): void {
  versions.delete(cwd)
}

/**
 * @author ddj 2026年10月29号
 * @description: 打开工作区库并确保待审表存在；DDL 与版本标记在同一事务里提交。
 * @param cwd 已迁移工作区
 * @returns 可读写的连接
 * @throws 未完成活跃库迁移时拒绝
 */
export function pendingDb(cwd: string): DatabaseSync {
  if (!activeReady(cwd)) throw new Error('待审投影要求先完成活跃库迁移')
  const db = dbFor(cwd)
  const stamp = db.prepare("SELECT value FROM metadata WHERE name='pending_schema'").get() as Row | undefined
  if (stamp?.value === SCHEMA_VERSION) return db
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(DDL)
    migrateHistory(db)
    migrateHistoryMerge(db)
    migrateProvenance(db)
    migrateEvidence(db)
    db.prepare("INSERT INTO metadata(name,value) VALUES('pending_schema',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value")
      .run(SCHEMA_VERSION)
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
  return db
}

/** 待审表结构：条目、块决定、幂等操作、撤销栈。 */
const DDL = `
CREATE TABLE IF NOT EXISTS pending_entries (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, earlier TEXT NOT NULL,
  old_text TEXT NOT NULL, new_text TEXT NOT NULL, updated_at INTEGER NOT NULL,
  unseen INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0,
  diverged INTEGER NOT NULL DEFAULT 0, oversized INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0, session_id TEXT NOT NULL,
  session_ids TEXT NOT NULL, lineage TEXT,
  source TEXT NOT NULL DEFAULT 'tool', origin TEXT NOT NULL DEFAULT 'agent',
  base_kind TEXT NOT NULL DEFAULT 'known',
  evidence TEXT NOT NULL DEFAULT 'snapshot', verdict TEXT NOT NULL DEFAULT 'changed');
CREATE TABLE IF NOT EXISTS pending_blocks (
  entry_id TEXT NOT NULL, block_id TEXT NOT NULL, decision TEXT NOT NULL,
  PRIMARY KEY(entry_id,block_id));
CREATE TABLE IF NOT EXISTS pending_ops (
  operation_id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL,
  result TEXT, undo TEXT);
CREATE TABLE IF NOT EXISTS pending_history (
  entry_id TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL,
  earlier TEXT NOT NULL DEFAULT 'file', baseline TEXT NOT NULL, content TEXT NOT NULL,
  digest TEXT NOT NULL, wrote INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'applied', merged_at INTEGER NOT NULL);
`

/**
 * @author ddj 2026-11-24
 * @description: v3 → v4：给条目补三列来源字段。旧行按默认值读成「工具链路 / agent / 已知内容」，
 * 与 v3 的语义一致，不需要回填。
 * @param db 已打开的工作区库
 * @returns 无
 */
function migrateProvenance(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(pending_entries)').all() as Row[]
  const names = new Set(columns.map((column) => String(column.name)))
  if (!names.has('source')) db.exec("ALTER TABLE pending_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'tool'")
  if (!names.has('origin')) db.exec("ALTER TABLE pending_entries ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'")
  if (!names.has('base_kind')) db.exec("ALTER TABLE pending_entries ADD COLUMN base_kind TEXT NOT NULL DEFAULT 'known'")
}

/**
 * @author ddj 2026年11月25号
 * @description: v4 → v5：给条目补证据强度与结局两列。旧行按默认值读成「快照 / 真实改动」，
 * 与 v4 的语义一致，不需要回填。
 * @param db 已打开的工作区库
 * @returns 无
 */
function migrateEvidence(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(pending_entries)').all() as Row[]
  const names = new Set(columns.map((column) => String(column.name)))
  if (!names.has('evidence')) db.exec("ALTER TABLE pending_entries ADD COLUMN evidence TEXT NOT NULL DEFAULT 'snapshot'")
  if (!names.has('verdict')) db.exec("ALTER TABLE pending_entries ADD COLUMN verdict TEXT NOT NULL DEFAULT 'changed'")
}

/**
 * @author ddj 2026年10月29号
 * @description: v1 历史表补 state 列（rebuild 成本高于一次 ALTER）。
 * @param db 已打开的工作区库
 * @returns 无
 */
function migrateHistory(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(pending_history)').all() as Row[]
  if (columns.some((column) => column.name === 'state')) return
  db.exec("ALTER TABLE pending_history ADD COLUMN state TEXT NOT NULL DEFAULT 'applied'")
}

/**
 * @author ddj 2026年11月25号
 * @description: v5 → v6：把「每次决定一行」的撤销栈折成「每条路径一行」。
 * 同一路径只保留最近一次判定，用被替换掉的那一侧全文作撤销依据；其余旧行直接丢弃，
 * 这是合并语义：一段代码改三次仍然只有一份差异，不再堆三次快照。
 * @param db 已打开的工作区库
 * @returns 无
 */
function migrateHistoryMerge(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(pending_history)').all() as Row[]
  if (!columns.some((column) => column.name === 'snapshot')) return
  const rows = db.prepare(`SELECT h.entry_id, h.snapshot, h.created_at, h.state, e.path AS entry_path
    FROM pending_history h LEFT JOIN pending_entries e ON e.id = h.entry_id
    WHERE h.id IN (SELECT MAX(id) FROM pending_history GROUP BY entry_id)`).all() as Row[]
  db.exec(`CREATE TABLE IF NOT EXISTS pending_history_v6 (
    entry_id TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL,
    earlier TEXT NOT NULL DEFAULT 'file', baseline TEXT NOT NULL, content TEXT NOT NULL,
    digest TEXT NOT NULL, wrote INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'applied', merged_at INTEGER NOT NULL)`)
  const insert = db.prepare(`INSERT OR REPLACE INTO pending_history_v6
    (entry_id,path,kind,earlier,baseline,content,digest,wrote,state,merged_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
  for (const row of rows) {
    const folded = foldLegacySnapshot(row)
    if (!folded) continue
    insert.run(String(row.entry_id), String(row.entry_path ?? folded.path), folded.kind, folded.earlier,
      folded.baseline, folded.content, digestOf(folded.content), folded.wrote ? 1 : 0,
      row.state === 'undone' ? 'undone' : 'applied', Number(row.created_at) || Date.now())
  }
  db.exec('DROP TABLE pending_history')
  db.exec('ALTER TABLE pending_history_v6 RENAME TO pending_history')
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 把旧的「before/after 条目快照」还原成一条合并撤销行；解析不了就丢弃。
 * @param row 旧历史行
 * @returns 折叠结果，无法解析时为 null
 */
function foldLegacySnapshot(row: Row): { kind: 'keep' | 'revert'; earlier: string; baseline: string; content: string; wrote: boolean; path: string } | null {
  try {
    const snapshot = JSON.parse(String(row.snapshot)) as {
      before?: { entry?: { oldText?: unknown; newText?: unknown; earlierVersion?: unknown; path?: unknown } }
      after?: { entry?: { oldText?: unknown; newText?: unknown } }
      wrote?: unknown
    }
    const before = snapshot.before?.entry
    const after = snapshot.after?.entry
    if (!before || !after) return null
    const baseline = String(before.oldText ?? '')
    const content = String(before.newText ?? '')
    return {
      kind: String(after.oldText ?? '') !== baseline ? 'keep' : 'revert',
      earlier: String(before.earlierVersion ?? 'file') === 'none' ? 'none' : 'file',
      baseline,
      content,
      wrote: snapshot.wrote === true,
      path: String(before.path ?? ''),
    }
  } catch {
    return null
  }
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 撤销行内容指纹，用于重试幂等与诊断，不参与判定。
 * @param text 被替换掉的那一侧全文
 * @returns 十六进制摘要
 */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/**
 * @author ddj 2026年10月29号
 * @description: 读出全部待审条目，按更新时间升序。
 * @param cwd 工作区
 * @returns 条目与标记
 */
export function loadEntries(cwd: string): StoredEntry[] {
  const rows = pendingDb(cwd).prepare('SELECT * FROM pending_entries ORDER BY updated_at ASC').all() as Row[]
  return rows.map((row) => ({ entry: entryOfRow(row), flags: flagsOfRow(row) }))
}

/**
 * @author ddj 2026年11月25号
 * @description: 按身份读单条条目：watch 批次快照可能早于工具落库，重读一条比整表便宜。
 * @param cwd 工作区
 * @param id 条目身份（后端进程路径）
 * @returns 条目与标记，缺失时 undefined
 */
export function loadEntry(cwd: string, id: string): StoredEntry | undefined {
  const db = pendingDb(cwd)
  // Windows 上盘符与路径大小写不敏感：精确命中失败再按 NOCASE 找一次。
  const row = (db.prepare('SELECT * FROM pending_entries WHERE id=?').get(id)
    ?? db.prepare('SELECT * FROM pending_entries WHERE id=? COLLATE NOCASE').get(id)) as Row | undefined
  return row ? { entry: entryOfRow(row), flags: flagsOfRow(row) } : undefined
}

/**
 * @author ddj 2026年10月29号
 * @description: 写入或更新一条条目（含标记），单条原子完成。
 * @param cwd 工作区
 * @param stored 条目与标记
 * @returns 无
 */
export function saveEntry(cwd: string, stored: StoredEntry): void {
  upsertEntry(pendingDb(cwd), cwd, stored)
}

/**
 * @private
 * @author ddj 2026年11月03号
 * @description: 在给定连接上写入或更新一条条目（含标记），供单条与批量两个入口复用。
 * @param db 已迁移连接（可能已在事务中）
 * @param stored 条目与标记
 * @returns 无
 */
function upsertEntry(db: DatabaseSync, cwd: string, stored: StoredEntry): void {
  const { entry, flags } = stored
  db.prepare(`INSERT INTO pending_entries
    (id,path,earlier,old_text,new_text,updated_at,unseen,missing,diverged,oversized,revision,session_id,session_ids,lineage,
     source,origin,base_kind,evidence,verdict)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET path=excluded.path,earlier=excluded.earlier,old_text=excluded.old_text,
      new_text=excluded.new_text,updated_at=excluded.updated_at,unseen=excluded.unseen,missing=excluded.missing,
      diverged=excluded.diverged,oversized=excluded.oversized,revision=excluded.revision,
      session_id=excluded.session_id,session_ids=excluded.session_ids,lineage=excluded.lineage,
      source=excluded.source,origin=excluded.origin,base_kind=excluded.base_kind,
      evidence=excluded.evidence,verdict=excluded.verdict`)
    .run(entry.id, entry.path, entry.earlierVersion, entry.oldText, entry.newText, entry.updatedAt,
      entry.unseen === true ? 1 : 0, flags.missing ? 1 : 0, flags.diverged ? 1 : 0, flags.oversized ? 1 : 0,
      flags.revision, entry.sessionId, JSON.stringify(entry.sessionIds), entry.lineage ? JSON.stringify(entry.lineage) : null,
      entry.source ?? 'tool', entry.origin ?? 'agent', entry.baseKind ?? 'known',
      entry.evidence ?? 'snapshot', entry.verdict ?? 'changed')
  bumpVersion(cwd)
}

/**
 * @author ddj 2026年10月29号
 * @description: 删除条目及其块决定，用于"已解决条目移除"。
 * @param cwd 工作区
 * @param id 条目身份
 * @returns 无
 */
export function dropEntry(cwd: string, id: string): void {
  const db = pendingDb(cwd)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM pending_entries WHERE id=?').run(id)
    db.prepare('DELETE FROM pending_blocks WHERE entry_id=?').run(id)
    db.exec('COMMIT')
    bumpVersion(cwd)
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 读出某条目的块决定。
 * @param cwd 工作区
 * @param entryId 条目身份
 * @returns 块决定列表
 */
export function loadBlocks(cwd: string, entryId: string): { id: string; decision: string }[] {
  const rows = pendingDb(cwd).prepare('SELECT block_id AS id,decision FROM pending_blocks WHERE entry_id=? ORDER BY rowid')
    .all(entryId) as Row[]
  return rows.map((row) => ({ id: String(row.id), decision: String(row.decision) }))
}

/**
 * @author ddj 2026年10月29号
 * @description: 覆盖某条目的块决定集合。
 * @param cwd 工作区
 * @param entryId 条目身份
 * @param blocks 块决定
 * @returns 无
 */
export function saveBlocks(cwd: string, entryId: string, blocks: { id: string; decision: string }[]): void {
  const db = pendingDb(cwd)
  db.exec('BEGIN IMMEDIATE')
  try {
    writeBlocks(db, entryId, blocks)
    db.exec('COMMIT')
    bumpVersion(cwd)
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/**
 * @private
 * @author ddj 2026年11月03号
 * @description: 在给定连接上覆盖某条目的块决定集合，供单条与批量两个入口复用。
 * @param db 已迁移连接（可能已在事务中）
 * @param entryId 条目身份
 * @param blocks 块决定
 * @returns 无
 */
function writeBlocks(db: DatabaseSync, entryId: string, blocks: { id: string; decision: string }[]): void {
  db.prepare('DELETE FROM pending_blocks WHERE entry_id=?').run(entryId)
  const insert = db.prepare('INSERT INTO pending_blocks VALUES(?,?,?)')
  for (const block of blocks) insert.run(entryId, block.id, block.decision)
}


/**
 * @author ddj 2026年10月29号
 * @description: 读取幂等操作记录；同 operationId 的重复请求必须复用结果。
 * @param cwd 工作区
 * @param operationId 操作身份
 * @returns 请求原文、状态与结果
 */
export function readOp(cwd: string, operationId: string): { request: string; state: string; result: string | null } | undefined {
  const row = pendingDb(cwd).prepare('SELECT request,state,result FROM pending_ops WHERE operation_id=?').get(operationId) as Row | undefined
  return row ? { request: String(row.request), state: String(row.state), result: row.result === null ? null : String(row.result) } : undefined
}

/**
 * @author ddj 2026年10月29号
 * @description: 记录一次操作的阶段与撤销快照。
 * @param cwd 工作区
 * @param operationId 操作身份
 * @param request 请求原文
 * @param state prepared / committed
 * @param payload 结果与撤销快照
 * @returns 无
 */
export function writeOp(
  cwd: string,
  operationId: string,
  request: string,
  state: 'prepared' | 'committed',
  payload: { result?: string; undo?: string } = {},
): void {
  pendingDb(cwd).prepare(`INSERT INTO pending_ops VALUES(?,?,?,?,?)
    ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,
      result=COALESCE(excluded.result,pending_ops.result), undo=COALESCE(excluded.undo,pending_ops.undo)`)
    .run(operationId, request, state, payload.result ?? null, payload.undo ?? null)
}

/**
 * @author ddj 2026年10月29号 / 2026年11月25号
 * @description: 写一条撤销行（同一路径覆盖写）。
 * @param cwd 工作区
 * @param record 撤销行内容
 * @param now 时间
 * @returns 无
 */
export function pushHistory(cwd: string, record: HistoryRecord, now: number): void {
  insertHistory(pendingDb(cwd), record, now)
}

/**
 * @private
 * @author ddj 2026年11月03号 / 2026年11月25号
 * @description: 写一条合并撤销行：同一路径永远只有一行，新判定覆盖写，不再堆叠。
 * @param db 已迁移连接（可能已在事务中）
 * @param record 撤销行内容
 * @param now 时间
 * @returns 无
 */
function insertHistory(db: DatabaseSync, record: HistoryRecord, now: number): void {
  db.prepare(`INSERT INTO pending_history(entry_id,path,kind,earlier,baseline,content,digest,wrote,state,merged_at)
    VALUES(?,?,?,?,?,?,?,?,'applied',?)
    ON CONFLICT(entry_id) DO UPDATE SET path=excluded.path,kind=excluded.kind,earlier=excluded.earlier,
      baseline=excluded.baseline,content=excluded.content,digest=excluded.digest,wrote=excluded.wrote,
      state='applied',merged_at=excluded.merged_at`)
    .run(record.entryId, record.path, record.kind, record.earlier, record.baseline, record.content,
      digestOf(record.content), record.wrote ? 1 : 0, now)
}

/**
 * @author ddj 2026年10月30号 / 2026年11月25号
 * @description: 取最近一条仍生效的撤销行，撤销就作用在它上面。
 * @param cwd 工作区
 * @returns 记录或 undefined
 */
export function latestApplied(cwd: string): HistoryRow | undefined {
  const row = pendingDb(cwd).prepare(
    "SELECT * FROM pending_history WHERE state='applied' ORDER BY merged_at DESC LIMIT 1",
  ).get() as Row | undefined
  return row ? rowOfHistory(row) : undefined
}

/**
 * @author ddj 2026年10月30号 / 2026年11月25号
 * @description: 取最早一条被撤销的记录，重做按「撤销的逆序」重新生效。
 * @param cwd 工作区
 * @returns 记录或 undefined
 */
export function earliestUndone(cwd: string): HistoryRow | undefined {
  const row = pendingDb(cwd).prepare(
    "SELECT * FROM pending_history WHERE state='undone' ORDER BY merged_at ASC LIMIT 1",
  ).get() as Row | undefined
  return row ? rowOfHistory(row) : undefined
}

/**
 * @author ddj 2026年10月30号 / 2026年11月25号
 * @description: 翻转一条撤销行的生效状态。
 * @param cwd 工作区
 * @param entryId 条目身份（一条路径一行）
 * @param state applied / undone
 * @returns 无
 */
export function setHistoryState(cwd: string, entryId: string, state: 'applied' | 'undone'): void {
  pendingDb(cwd).prepare('UPDATE pending_history SET state=? WHERE entry_id=?').run(state, entryId)
}

/**
 * @author ddj 2026年10月30号 / 2026年11月25号
 * @description: 把数据库行还原成撤销记录。
 * @param row 数据库行
 * @returns 记录
 */
function rowOfHistory(row: Row): HistoryRow {
  return {
    entryId: String(row.entry_id), path: String(row.path),
    kind: String(row.kind) === 'revert' ? 'revert' : 'keep',
    earlier: String(row.earlier ?? 'file') === 'none' ? 'none' : 'file',
    baseline: String(row.baseline), content: String(row.content),
    wrote: Number(row.wrote) === 1, state: row.state === 'undone' ? 'undone' : 'applied',
    mergedAt: Number(row.merged_at) || 0,
  }
}

/** 一条撤销行的内容：被这次判定替换掉的两侧全文，用于撤销与重做。 */
export interface HistoryRecord {
  entryId: string
  path: string
  kind: 'keep' | 'revert'
  earlier: 'file' | 'none'
  baseline: string
  content: string
  wrote: boolean
}

/** 撤销行形态（一条路径一行）。 */
export interface HistoryRow extends HistoryRecord {
  state: 'applied' | 'undone'
  mergedAt: number
}

/**
 * @author ddj 2026年10月29号
 * @description: 迁移前备份库文件路径，便于回退只读旧视图。
 * @param dbFile 工作区库文件
 * @returns 备份路径
 */
export function backupPath(dbFile: string): string {
  return dbFile + BACKUP_SUFFIX
}

/**
 * @author ddj 2026年10月29号
 * @description: 由数据库行还原条目。
 * @param row 数据库行
 * @returns 条目
 */
function entryOfRow(row: Row): PendingEntry {
  const lineage = row.lineage === null ? undefined : JSON.parse(String(row.lineage)) as PendingLineage
  const entry: PendingEntry = {
    id: String(row.id), path: String(row.path),
    earlierVersion: String(row.earlier) === 'none' ? 'none' : 'file',
    oldText: String(row.old_text), newText: String(row.new_text), updatedAt: Number(row.updated_at),
    sessionId: String(row.session_id), sessionIds: JSON.parse(String(row.session_ids)) as string[],
    source: sourceOfRow(row),
    origin: originOfRow(row),
    baseKind: baseKindOfRow(row),
    evidence: evidenceOfRow(row),
    verdict: verdictOfRow(row),
  }
  if (Number(row.unseen) === 1) entry.unseen = true
  if (lineage !== undefined) entry.lineage = lineage
  return entry
}

/**
 * @private
 * @author ddj 2026-11-24
 * @description: 读采集通道列；v3 旧库升级后该列有默认值，异常值按 `tool` 处理。
 * @param row 数据库行
 * @returns 采集通道
 */
function sourceOfRow(row: Row): PendingSource {
  const value = String(row.source ?? 'tool')
  return (value === 'edit' || value === 'write' || value === 'remote_ssh_write' || value === 'watch'
    || value === 'scan' || value === 'vcs') ? value : 'tool'
}

/**
 * @private
 * @author ddj 2026-11-24
 * @description: 读归属列；异常值按 `agent` 处理（与 v3 语义一致）。
 * @param row 数据库行
 * @returns 归属
 */
function originOfRow(row: Row): PendingOrigin {
  const value = String(row.origin ?? 'agent')
  return value === 'editor' || value === 'vcs' || value === 'external' ? value : 'agent'
}

/**
 * @private
 * @author ddj 2026-11-24
 * @description: 读基线可信度列；异常值按 `known` 处理。
 * @param row 数据库行
 * @returns 基线可信度
 */
function baseKindOfRow(row: Row): PendingBaseKind {
  const value = String(row.base_kind ?? 'known')
  return value === 'absent' || value === 'vcs' || value === 'normalized' || value === 'unknown' ? value : 'known'
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 读证据强度列；v4 旧库升级后该列有默认值，异常值按 `snapshot` 处理。
 * @param row 数据库行
 * @returns 证据强度
 */
function evidenceOfRow(row: Row): PendingEvidence {
  const value = String(row.evidence ?? 'snapshot')
  return value === 'authoritative' || value === 'receipt' || value === 'none' ? value : 'snapshot'
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 读调用结局列；异常值按 `changed` 处理（旧条目的语义就是真实改动）。
 * @param row 数据库行
 * @returns 调用结局
 */
function verdictOfRow(row: Row): PendingVerdict {
  const value = String(row.verdict ?? 'changed')
  return value === 'noop' || value === 'failed' || value === 'unverified' ? value : 'changed'
}

/**
 * @author ddj 2026年10月29号
 * @description: 由数据库行还原标记。
 * @param row 数据库行
 * @returns 标记
 */
function flagsOfRow(row: Row): PendingFlags {
  return {
    missing: Number(row.missing) === 1,
    diverged: Number(row.diverged) === 1,
    oversized: Number(row.oversized) === 1,
    revision: Number(row.revision),
  }
}

/** 批量 Keep 的一条落库记录：stored 提供 CAS 依据与撤销依据，next 是推进后的条目。 */
export interface KeepRecord {
  entryId: string
  stored: StoredEntry
  next: StoredEntry
  blocks: { id: string; decision: string }[]
}

/**
 * @public
 * @author ddj 2026年11月03号
 * @description: 在一次事务内批量推进多条待审条目（批量 Keep 用）。每条按 revision 做 CAS，
 * 只跳过冲突的那一条，不牵连整批；块决定与撤销快照与单条路径同口径。
 * @param cwd 工作区
 * @param records 待落库记录
 * @returns 因版本已变被跳过的条目
 * @throws 事务级异常（SQL/程序错误）整体回滚后抛出
 */
export function saveDecisions(cwd: string, records: KeepRecord[]): { id: string; reason: string }[] {
  const db = pendingDb(cwd)
  const skipped: { id: string; reason: string }[] = []
  const advance = db.prepare(`UPDATE pending_entries SET path=?,earlier=?,old_text=?,new_text=?,updated_at=?,unseen=?,
    missing=?,diverged=?,oversized=?,revision=?,session_id=?,session_ids=?,lineage=?,source=?,origin=?,base_kind=?,
    evidence=?,verdict=?
    WHERE id=? AND revision=?`)

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const record of records) {
      const { entry, flags } = record.next
      const expected = record.stored.flags.revision
      const changed = advance.run(entry.path, entry.earlierVersion, entry.oldText, entry.newText, entry.updatedAt,
        entry.unseen === true ? 1 : 0, flags.missing ? 1 : 0, flags.diverged ? 1 : 0, flags.oversized ? 1 : 0,
        flags.revision, entry.sessionId, JSON.stringify(entry.sessionIds),
        entry.lineage ? JSON.stringify(entry.lineage) : null,
        entry.source ?? 'tool', entry.origin ?? 'agent', entry.baseKind ?? 'known',
        entry.evidence ?? 'snapshot', entry.verdict ?? 'changed',
        record.entryId, expected)
      // 读条目到落库之间被别的决定推进过：只放弃这一条
      if (changed.changes !== 1) {
        skipped.push({ id: record.entryId, reason: '待审条目已变化，请重试' })
        continue
      }
      writeBlocks(db, record.entryId, record.blocks)
      // 撤销行每条路径只留一行：批量 Keep 也按同一口径覆盖写，不再追加
      insertHistory(db, {
        entryId: record.entryId,
        path: record.stored.entry.path,
        kind: 'keep',
        earlier: record.stored.entry.earlierVersion,
        baseline: record.stored.entry.oldText,
        content: record.stored.entry.newText,
        wrote: false,
      }, Date.now())
    }
    db.exec('COMMIT')
    if (records.length) bumpVersion(cwd)
    return skipped
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/** 清理筛选条件：只按「采集通道 + 基线可信度 + 时间窗」命中，不猜内容。 */
export interface PurgeFilter {
  /** 采集通道（缺省 watch）。 */
  sources?: string[]
  /** 基线可信度（缺省 absent）。 */
  baseKinds?: string[]
  /** 只清这个时间之前更新的条目（毫秒时间戳）。 */
  before?: number
}

/** 一次清理的结果。 */
export interface PurgeOutcome {
  /** 命中多少条（dryRun 也算）。 */
  matched: number
  /** 真正删掉多少条；dryRun 恒为 0。 */
  removed: number
  /** 命中但因为有判定历史而保留的条数。 */
  kept: number
}

/**
 * @public
 * @author ddj 2026-11-24
 * @description: 按条件清理待审条目（清幽灵记录用）。命中判定与删除在同一份读结果上做：
 * 有 pending_history 的条目（已经 Keep/Revert 过）一律保留，绝不按内容猜。
 * @param cwd 工作区
 * @param filter 筛选条件
 * @param dryRun 只数不删
 * @returns 命中、删除与保留条数
 * @throws 事务级异常整体回滚后抛出
 */
export function purgeEntries(cwd: string, filter: PurgeFilter = {}, dryRun = false): PurgeOutcome {
  const db = pendingDb(cwd)
  const sources = filter.sources && filter.sources.length ? new Set(filter.sources) : null
  const baseKinds = filter.baseKinds && filter.baseKinds.length ? new Set(filter.baseKinds) : null
  const before = typeof filter.before === 'number' ? filter.before : null
  // 只读三列，不把两侧全文拉进内存（大库上单条全文可达百 KB）
  const rows = db.prepare(`SELECT id, source, base_kind, updated_at,
      EXISTS(SELECT 1 FROM pending_history h WHERE h.entry_id = pending_entries.id) AS decided
    FROM pending_entries`).all() as Row[]

  const hits: string[] = []
  let kept = 0
  for (const row of rows) {
    if (sources && !sources.has(String(row.source))) continue
    if (baseKinds && !baseKinds.has(String(row.base_kind))) continue
    if (before !== null && Number(row.updated_at) >= before) continue
    if (Number(row.decided) === 1) kept += 1
    else hits.push(String(row.id))
  }
  if (dryRun || !hits.length) return { matched: hits.length, removed: 0, kept }

  db.exec('BEGIN IMMEDIATE')
  try {
    const dropEntryRow = db.prepare('DELETE FROM pending_entries WHERE id=?')
    const dropBlockRows = db.prepare('DELETE FROM pending_blocks WHERE entry_id=?')
    for (const id of hits) {
      dropEntryRow.run(id)
      dropBlockRows.run(id)
    }
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
  bumpVersion(cwd)
  return { matched: hits.length, removed: hits.length, kept }
}

/**
 * @public
 * @author ddj 2026-11-24
 * @description: 回收已删行占用的页；失败只记日志，不影响已完成的删除。
 * @param cwd 工作区
 * @returns 耗时毫秒
 */
export function vacuumEntries(cwd: string): number {
  const started = Date.now()
  try {
    pendingDb(cwd).exec('VACUUM')
  } catch (error) {
    log.warn('待审库 VACUUM 失败：' + String(error))
  }
  return Date.now() - started
}
