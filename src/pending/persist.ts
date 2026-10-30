/**
 * 待审投影的持久化：与官方历史共用工作区库，但只新增 pending_* 表，绝不改写 review_* 事实。
 * @author ddj 2026年10月29号
 */
import type { DatabaseSync } from 'node:sqlite'
import { activeReady, dbFor } from '../archiveDb.js'
import type { PendingLineage } from '../shared/pendingReview.js'
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

/** 待审库版本号，写进 metadata 便于日后迁移。v3 给评论表加了引文与上下文列。 */
const SCHEMA_VERSION = '3'
/** 迁移前的备份后缀。 */
const BACKUP_SUFFIX = '.before-pending.bak'

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
  session_ids TEXT NOT NULL, lineage TEXT);
CREATE TABLE IF NOT EXISTS pending_blocks (
  entry_id TEXT NOT NULL, block_id TEXT NOT NULL, decision TEXT NOT NULL,
  PRIMARY KEY(entry_id,block_id));
CREATE TABLE IF NOT EXISTS pending_ops (
  operation_id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL,
  result TEXT, undo TEXT);
CREATE TABLE IF NOT EXISTS pending_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entry_id TEXT,
  snapshot TEXT NOT NULL, created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'applied');
`

/** v1 历史表补 state 列（rebuild 成本高于一次 ALTER）。 */
function migrateHistory(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(pending_history)').all() as Row[]
  if (columns.some((column) => column.name === 'state')) return
  db.exec("ALTER TABLE pending_history ADD COLUMN state TEXT NOT NULL DEFAULT 'applied'")
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
 * @author ddj 2026年10月29号
 * @description: 写入或更新一条条目（含标记），单条原子完成。
 * @param cwd 工作区
 * @param stored 条目与标记
 * @returns 无
 */
export function saveEntry(cwd: string, stored: StoredEntry): void {
  const { entry, flags } = stored
  pendingDb(cwd).prepare(`INSERT INTO pending_entries
    (id,path,earlier,old_text,new_text,updated_at,unseen,missing,diverged,oversized,revision,session_id,session_ids,lineage)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET path=excluded.path,earlier=excluded.earlier,old_text=excluded.old_text,
      new_text=excluded.new_text,updated_at=excluded.updated_at,unseen=excluded.unseen,missing=excluded.missing,
      diverged=excluded.diverged,oversized=excluded.oversized,revision=excluded.revision,
      session_id=excluded.session_id,session_ids=excluded.session_ids,lineage=excluded.lineage`)
    .run(entry.id, entry.path, entry.earlierVersion, entry.oldText, entry.newText, entry.updatedAt,
      entry.unseen === true ? 1 : 0, flags.missing ? 1 : 0, flags.diverged ? 1 : 0, flags.oversized ? 1 : 0,
      flags.revision, entry.sessionId, JSON.stringify(entry.sessionIds), entry.lineage ? JSON.stringify(entry.lineage) : null)
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
    db.prepare('DELETE FROM pending_blocks WHERE entry_id=?').run(entryId)
    const insert = db.prepare('INSERT INTO pending_blocks VALUES(?,?,?)')
    for (const block of blocks) insert.run(entryId, block.id, block.decision)
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
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
 * @author ddj 2026年10月29号
 * @description: 追加一条撤销栈记录，并截断重做分支（新决定之后旧的"已撤销"记录不能再重做）。
 * @param cwd 工作区
 * @param kind 操作种类
 * @param entryId 涉及的条目
 * @param snapshot 可重放快照
 * @param now 时间
 * @returns 无
 */
export function pushHistory(cwd: string, kind: string, entryId: string, snapshot: string, now: number): void {
  const db = pendingDb(cwd)
  db.prepare("DELETE FROM pending_history WHERE state='undone'").run()
  db.prepare("INSERT INTO pending_history(kind,entry_id,snapshot,created_at,state) VALUES(?,?,?,?,'applied')")
    .run(kind, entryId, snapshot, now)
}

/**
 * @author ddj 2026年10月30号
 * @description: 取最近一条仍生效的历史记录，撤销就作用在它上面。
 * @param cwd 工作区
 * @returns 记录或 undefined
 */
export function latestApplied(cwd: string): HistoryRow | undefined {
  const row = pendingDb(cwd).prepare(
    "SELECT id,kind,entry_id,snapshot FROM pending_history WHERE state='applied' ORDER BY id DESC LIMIT 1",
  ).get() as Row | undefined
  return row ? rowOfHistory(row) : undefined
}

/**
 * @author ddj 2026年10月30号
 * @description: 取最早一条被撤销的记录，重做按"撤销的逆序"重新生效。
 * @param cwd 工作区
 * @returns 记录或 undefined
 */
export function earliestUndone(cwd: string): HistoryRow | undefined {
  const row = pendingDb(cwd).prepare(
    "SELECT id,kind,entry_id,snapshot FROM pending_history WHERE state='undone' ORDER BY id ASC LIMIT 1",
  ).get() as Row | undefined
  return row ? rowOfHistory(row) : undefined
}

/**
 * @author ddj 2026年10月30号
 * @description: 翻转一条历史记录的生效状态。
 * @param cwd 工作区
 * @param id 记录主键
 * @param state applied / undone
 * @returns 无
 */
export function setHistoryState(cwd: string, id: number, state: 'applied' | 'undone'): void {
  pendingDb(cwd).prepare('UPDATE pending_history SET state=? WHERE id=?').run(state, id)
}

/**
 * @author ddj 2026年10月30号
 * @description: 把数据库行还原成历史记录。
 * @param row 数据库行
 * @returns 记录
 */
function rowOfHistory(row: Row): HistoryRow {
  return { id: Number(row.id), kind: String(row.kind), entryId: String(row.entry_id), snapshot: String(row.snapshot) }
}

/** 历史记录行形态（快照为 JSON 文本）。 */
export interface HistoryRow {
  id: number
  kind: string
  entryId: string
  snapshot: string
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
  }
  if (Number(row.unseen) === 1) entry.unseen = true
  if (lineage !== undefined) entry.lineage = lineage
  return entry
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
