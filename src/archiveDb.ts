/**
 * 工作区差异归档 V2：SQLite 事务追加与按需读取；旧 JSON 只读留存，不参与热路径。
 * 数据库位于 DSH home 的 data/，不会被缓存清理器删除。
 * 作者 ddj 2026-09-30
 */
import { mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ArchiveBatch, ArchiveEntry, ArchiveRecord, ArchiveSummary, DiffRecord, SidecarData } from './shared/types.js'
import { archiveDbFile } from './paths.js'

export type RevertState = 'started' | 'applied'
export interface ActiveChange { upserts: DiffRecord[]; removed: string[] }
export interface ArchivePage { entries: ArchiveEntry[]; nextCursor: string | null }

/**
 * 数据库行中 null 批次用独立字符串键，避免 SQLite UNIQUE 对 NULL 不去重。
 * @author ddj 2026年09月30号
 * @param batch 原始批次
 * @returns 可用于唯一约束的字符串键
 */
const batchKey = (batch: number | null): string => batch === null ? 'null' : 'n' + batch

/** 仅由本插件打开的工作区连接；插件卸载时 closeArchiveDbs 关闭。 */
const connections = new Map<string, DatabaseSync>()

type Row = Record<string, string | number | null>

/**
 * 打开且核验单工作区数据库；已有异常库绝不重置成空库。
 * @author ddj 2026年09月30号
 * @param cwd 工作区绝对路径
 * @returns 已缓存连接
 */
function dbFor(cwd: string): DatabaseSync {
  const existing = connections.get(cwd)
  if (existing) return existing
  const file = archiveDbFile(cwd)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file, { timeout: 2000 })
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000')
    db.exec('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const version = db.prepare("SELECT value FROM metadata WHERE name='schema'").get() as Row | undefined
    const workspace = db.prepare("SELECT value FROM metadata WHERE name='cwd'").get() as Row | undefined
    if ((version && version.value !== '2' && version.value !== '3') || (workspace && workspace.value !== cwd)) throw new Error('归档数据库 schema/工作区不匹配')
    if (!!version !== !!workspace) throw new Error('归档数据库元数据不完整')
    if (!version) {
      const other = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'metadata' LIMIT 1").get()
      if (other) throw new Error('归档数据库缺失元数据且已有数据表')
    }
    db.exec(`CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY, cwd TEXT NOT NULL, path TEXT NOT NULL, batch_key TEXT NOT NULL,
        batch INTEGER, at TEXT NOT NULL, last_at TEXT, reason TEXT,
        accepted INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
        pending INTEGER NOT NULL DEFAULT 0, superseded INTEGER NOT NULL DEFAULT 0,
        n_records INTEGER NOT NULL DEFAULT 0, UNIQUE(cwd,path,batch_key)
      );
      CREATE TABLE IF NOT EXISTS records (
        batch_id INTEGER NOT NULL REFERENCES batches(id), call_id TEXT NOT NULL,
        payload TEXT NOT NULL, accepted INTEGER NOT NULL, rejected INTEGER NOT NULL,
        pending INTEGER NOT NULL, superseded INTEGER NOT NULL,
        PRIMARY KEY(batch_id,call_id)
      );
      CREATE INDEX IF NOT EXISTS archive_by_path ON batches(cwd,path,batch);
      CREATE INDEX IF NOT EXISTS archive_by_call ON records(call_id);
      CREATE TABLE IF NOT EXISTS revert_intents (
        call_id TEXT NOT NULL, scope TEXT NOT NULL, hunk_index INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('started','applied')),
        PRIMARY KEY(call_id,scope,hunk_index)
      )`)
    if (!version) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare("INSERT INTO metadata(name,value) VALUES('schema','2')").run()
        db.prepare("INSERT INTO metadata(name,value) VALUES('cwd',?)").run(cwd)
        db.exec('COMMIT')
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK')
        throw error
      }
    }
    if (version?.value === '3') {
      const active = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='active_records'").get()
      const source = db.prepare("SELECT value FROM metadata WHERE name='active_source'").get()
      if (!active || !source) throw new Error('活跃记录数据库元数据不完整')
    }
    connections.set(cwd, db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * 只在隔离的切换窗口导入旧 sidecar；不接受模糊空库或解析损坏的输入。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param source 旧文件原文（null 仅表示明确不存在）
 * @param confirm 再读源文件原文，防止迁移途中旧 Host 改写
 * @returns 活跃记录 Map
 */
export async function migrateActive(cwd: string, source: string | null, confirm: () => Promise<string | null>): Promise<Map<string, DiffRecord>> {
  const db = dbFor(cwd)
  const version = String((db.prepare("SELECT value FROM metadata WHERE name='schema'").get() as Row).value)
  if (version === '3') return readActive(cwd)
  const digest = source === null ? 'absent' : createHash('sha256').update(source).digest('hex')
  let recs: Record<string, DiffRecord> = {}
  if (source !== null) {
    let parsed: SidecarData
    try { parsed = JSON.parse(source) as SidecarData } catch { throw new Error('旧活跃 sidecar 损坏，停止迁移') }
    if (parsed?.version !== 2 || !parsed.workspaces || typeof parsed.workspaces !== 'object' || Array.isArray(parsed.workspaces)) throw new Error('旧活跃 sidecar 格式无效')
    const workspace = parsed.workspaces[cwd]
    if (workspace && (!workspace.records || typeof workspace.records !== 'object' || Array.isArray(workspace.records))) throw new Error('旧工作区记录格式无效')
    recs = workspace?.records ?? {}
    for (const [key, rec] of Object.entries(recs)) {
      if (!rec || rec.callId !== key || typeof rec.path !== 'string' || !Array.isArray(rec.hunks)
        || !rec.decisions || !Array.isArray(rec.decisions.perHunk) || !Number.isInteger(rec.batch)
        || typeof rec.at !== 'string') throw new Error('旧活跃记录损坏：' + key)
    }
  }
  if (await confirm() !== source) throw new Error('迁移期间旧活跃 sidecar 被修改')
  if (activeReady(cwd)) return readActive(cwd)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE active_records(call_id TEXT PRIMARY KEY, payload TEXT NOT NULL,
      path TEXT NOT NULL, archived INTEGER NOT NULL, pending INTEGER NOT NULL, at TEXT NOT NULL);
      CREATE INDEX active_by_path ON active_records(path,archived)`)
    const add = db.prepare('INSERT INTO active_records(call_id,payload,path,archived,pending,at) VALUES(?,?,?,?,?,?)')
    for (const rec of Object.values(recs)) add.run(rec.callId, JSON.stringify(rec), rec.path, rec.archived ? 1 : 0, rec.decisions?.perHunk?.filter((d) => d === 'pending').length ?? 0, rec.at)
    if (await confirm() !== source) throw new Error('迁移期间旧活跃 sidecar 被修改')
    db.prepare("INSERT INTO metadata(name,value) VALUES('active_source',?)").run(digest)
    db.prepare("UPDATE metadata SET value='3' WHERE name='schema'").run()
    db.exec('COMMIT')
    return new Map(Object.values(recs).map((rec) => [rec.callId, rec]))
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 判断已核验的工作区是否完成活跃表迁移，不写入工作区记录。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @returns 迁移完成返回 true
 */
export function activeReady(cwd: string): boolean {
  return (dbFor(cwd).prepare("SELECT value FROM metadata WHERE name='schema'").get() as Row).value === '3'
}

/**
 * 对旧文件原文核对迁移标记，旧 Host 若继续写旧 sidecar 则拒绝启用新活跃库。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param source 当前遗留文件原文
 */
export function checkActiveSource(cwd: string, source: string | null): void {
  const db = dbFor(cwd)
  const row = db.prepare("SELECT value FROM metadata WHERE name='active_source'").get() as Row | undefined
  if (!row) throw new Error('活跃记录缺少迁移标记')
  const digest = source === null ? 'absent' : createHash('sha256').update(source).digest('hex')
  if (row.value !== digest) throw new Error('旧活跃 sidecar 在迁移后发生变化，请停止操作并人工核对')
}

/**
 * 只读当前工作区活跃表；未迁移时禁止回退到空库。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @returns 完整有限记录桶
 */
export function readActive(cwd: string): Map<string, DiffRecord> {
  const db = dbFor(cwd)
  if ((db.prepare("SELECT value FROM metadata WHERE name='schema'").get() as Row).value !== '3') throw new Error('工作区活跃记录未迁移')
  const rows = db.prepare('SELECT payload FROM active_records ORDER BY rowid').all() as Row[]
  const recs = rows.map((row) => JSON.parse(String(row.payload)) as DiffRecord)
  return new Map(recs.map((rec) => [rec.callId, rec]))
}

/**
 * 单次 SQLite 事务提交活跃行变化及可选归档，绝不重写整个记录桶。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param changes 明确新增、更新和移除的记录
 * @param entries 可选本次归档批次
 * @returns 新增归档批次数
 */
export function commitActive(cwd: string, changes: ActiveChange, entries: ArchiveBatch[] = []): number {
  const db = dbFor(cwd)
  if ((db.prepare("SELECT value FROM metadata WHERE name='schema'").get() as Row).value !== '3') throw new Error('工作区活跃记录未迁移')
  const upsert = db.prepare(`INSERT INTO active_records(call_id,payload,path,archived,pending,at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(call_id) DO UPDATE SET payload=excluded.payload,path=excluded.path,
      archived=excluded.archived,pending=excluded.pending,at=excluded.at`)
  const remove = db.prepare('DELETE FROM active_records WHERE call_id=?')
  db.exec('BEGIN IMMEDIATE')
  try {
    const added = entries.length ? insertArchive(db, cwd, entries) : 0
    for (const rec of changes.upserts) {
      const pending = rec.decisions?.perHunk?.filter((decision) => decision === 'pending').length ?? 0
      upsert.run(rec.callId, JSON.stringify(rec), rec.path, rec.archived ? 1 : 0, pending, rec.at)
    }
    for (const callId of changes.removed) remove.run(callId)
    db.exec('COMMIT')
    return added
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 轻量活跃摘要；旧 JSON 保留为迁移前快照而不参与统计。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @returns 活跃条数和每文件待处理计数
 */
export function activeSummary(cwd: string): { active: number; pendingByFile: { path: string; pending: number }[] } {
  const db = dbFor(cwd)
  if ((db.prepare("SELECT value FROM metadata WHERE name='schema'").get() as Row).value !== '3') throw new Error('工作区活跃记录未迁移')
  const active = Number((db.prepare('SELECT count(*) AS n FROM active_records WHERE archived=0').get() as Row).n)
  const rows = db.prepare('SELECT path, sum(pending) AS pending FROM active_records WHERE archived=0 AND pending>0 GROUP BY path ORDER BY pending DESC').all() as Row[]
  return { active, pendingByFile: rows.map((row) => ({ path: String(row.path), pending: Number(row.pending) })) }
}

/**
 * 对一批同路径记录做事务内去重追加，返回成功插入的批次数。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param entries 已按旧语义构造的归档批次
 * @returns 新增批次数
 */
export function appendArchive(cwd: string, entries: ArchiveBatch[]): number {
  if (!entries.length) return 0
  const db = dbFor(cwd)
  db.exec('BEGIN IMMEDIATE')
  try {
    const added = insertArchive(db, cwd, entries)
    db.exec('COMMIT')
    return added
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 在调用方事务内追加归档批次；归档与活跃行可共用一次提交。
 * @author ddj 2026年09月30号
 * @param db 当前工作区连接
 * @param cwd 工作区
 * @param entries 待归档条目
 * @returns 新增批次数
 */
function insertArchive(db: DatabaseSync, cwd: string, entries: ArchiveBatch[]): number {
  const get = db.prepare('SELECT id FROM batches WHERE cwd=? AND path=? AND batch_key=?')
  const add = db.prepare('INSERT INTO batches(cwd,path,batch_key,batch,at,last_at,reason) VALUES(?,?,?,?,?,?,?)')
  const update = db.prepare('UPDATE batches SET last_at=?, reason=? WHERE id=?')
  const insert = db.prepare('INSERT OR IGNORE INTO records(batch_id,call_id,payload,accepted,rejected,pending,superseded) VALUES(?,?,?,?,?,?,?)')
  const tally = db.prepare(`UPDATE batches SET n_records=n_records+1, accepted=accepted+?, rejected=rejected+?,
    pending=pending+?, superseded=superseded+? WHERE id=?`)
  let added = 0
  for (const entry of entries) {
    if (entry.cwd !== cwd) throw new Error('归档批次工作区不匹配')
    const key = batchKey(entry.batch)
    const found = get.get(cwd, entry.path, key) as Row | undefined
    const id = found ? Number(found.id) : Number(add.run(cwd, entry.path, key, entry.batch, entry.at, entry.lastAt ?? null, entry.reason).lastInsertRowid)
    if (found) update.run(entry.at, entry.reason, id)
    else added++
    for (const record of entry.records) {
      const sum = record.summary
      const result = insert.run(id, record.callId, JSON.stringify(record), sum.accepted, sum.rejected, sum.pending, sum.superseded ? 1 : 0)
      if (result.changes) tally.run(sum.accepted, sum.rejected, sum.pending, sum.superseded ? 1 : 0, id)
    }
  }
  const clear = db.prepare('DELETE FROM revert_intents WHERE call_id=?')
  for (const entry of entries) for (const record of entry.records) clear.run(record.callId)
  return added
}

/**
 * 返回某工作区所有归档批次的轻量摘要，不取记录 JSON。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @returns 归档列表
 */
export function listArchives(cwd: string): ArchiveEntry[] {
  const rows = dbFor(cwd).prepare(`SELECT path,batch,at,last_at,reason,n_records,accepted,rejected,pending,superseded
    FROM batches WHERE cwd=? ORDER BY COALESCE(batch,-1) DESC, at DESC`).all(cwd) as Row[]
  return rows.map((row) => ({
    path: String(row.path), batch: row.batch === null ? null : Number(row.batch),
    at: String(row.at), lastAt: String(row.last_at ?? row.at), reason: row.reason === null ? null : String(row.reason),
    nRecords: Number(row.n_records), summary: {
      accepted: Number(row.accepted), rejected: Number(row.rejected), pending: Number(row.pending), superseded: Number(row.superseded),
    } as ArchiveSummary,
  }))
}

/**
 * 固定快照上界的 keyset 分页，新增批次不挤动后续页面。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param cursor 上页返回的不透明游标
 * @param limit 每页条数，缺省 50，最多 100
 * @returns 摘要页和下一页游标
 */
export function pageArchives(cwd: string, cursor?: string, limit = 50): ArchivePage {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('归档分页大小不合法')
  const db = dbFor(cwd)
  const newest = Number((db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM batches WHERE cwd=?').get(cwd) as Row).id)
  let snapshot = newest
  let last: [number, string, number] | null = null
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { cwd: string; snapshot: number; last: [number, string, number] }
      if (value.cwd !== cwd || !Number.isSafeInteger(value.snapshot) || value.snapshot < 0 || value.snapshot > newest
        || !Array.isArray(value.last) || value.last.length !== 3 || !Number.isSafeInteger(value.last[0])
        || typeof value.last[1] !== 'string' || !Number.isSafeInteger(value.last[2]) || value.last[2] > value.snapshot) throw new Error('invalid')
      snapshot = value.snapshot
      last = value.last
    } catch { throw new Error('归档分页游标无效') }
  }
  const args: Array<string | number> = [cwd, snapshot]
  let where = 'WHERE cwd=? AND id<=?'
  if (last) {
    where += ' AND (COALESCE(batch,-1),at,id) < (?,?,?)'
    args.push(...last)
  }
  const rows = db.prepare(`SELECT id,path,batch,at,last_at,reason,n_records,accepted,rejected,pending,superseded
    FROM batches ${where} ORDER BY COALESCE(batch,-1) DESC, at DESC, id DESC LIMIT ?`).all(...args, limit + 1) as Row[]
  const entries = rows.slice(0, limit).map((row) => ({
    path: String(row.path), batch: row.batch === null ? null : Number(row.batch), at: String(row.at),
    lastAt: String(row.last_at ?? row.at), reason: row.reason === null ? null : String(row.reason),
    nRecords: Number(row.n_records), summary: {
      accepted: Number(row.accepted), rejected: Number(row.rejected), pending: Number(row.pending), superseded: Number(row.superseded),
    },
  }))
  const tail = rows[limit - 1]
  const nextCursor = rows.length > limit && tail
    ? Buffer.from(JSON.stringify({ cwd, snapshot, last: [tail.batch === null ? -1 : Number(tail.batch), tail.at, tail.id] })).toString('base64url') : null
  return { entries, nextCursor }
}

/**
 * 仅查询需要展开的路径/批次（无 path 时维持 RPC 返回全库语义）。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param path 可选目标路径
 * @param batch 可选批次
 * @returns 原有 ArchiveBatch 格式
 */
export function readArchives(cwd: string, path?: string, batch?: number | null): ArchiveBatch[] {
  const db = dbFor(cwd)
  let where = 'WHERE cwd=?'
  const args: Array<string | number> = [cwd]
  if (path) { where += ' AND path=?'; args.push(path) }
  if (batch !== undefined) { where += ' AND batch_key=?'; args.push(batchKey(batch)) }
  const rows = db.prepare(`SELECT id,cwd,path,batch,at,last_at,reason FROM batches ${where} ORDER BY id`).all(...args) as Row[]
  const records = db.prepare('SELECT payload FROM records WHERE batch_id=? ORDER BY rowid')
  return rows.map((row) => ({
    cwd: String(row.cwd), path: String(row.path), batch: row.batch === null ? null : Number(row.batch),
    at: String(row.at), ...(row.last_at === null ? {} : { lastAt: String(row.last_at) }), reason: String(row.reason ?? ''),
    records: (records.all(row.id as number) as Row[]).map((record) => JSON.parse(String(record.payload)) as ArchiveRecord),
  }))
}

/**
 * 查询已提交的归档记录，用于数据库成功但活跃 sidecar 写入失败后的幂等补偿。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param callId 调用标识
 * @param path 目标文件路径
 * @param batch 对应文件批次
 * @returns 已归档快照或 null
 */
export function committedRecord(cwd: string, callId: string, path: string, batch: number | null): ArchiveRecord | null {
  const row = dbFor(cwd).prepare(`SELECT r.payload FROM records r JOIN batches b ON b.id=r.batch_id
    WHERE b.cwd=? AND b.path=? AND b.batch_key=? AND r.call_id=? LIMIT 1`).get(cwd, path, batchKey(batch), callId) as Row | undefined
  return row ? JSON.parse(String(row.payload)) as ArchiveRecord : null
}

/**
 * 查询一次 Undo 的持久化阶段；started 表示写入结果无法仅凭 sidecar 判断。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param callId 记录标识
 * @param scope 决策范围
 * @param hunkIndex 块索引（整调用为 -1）
 * @returns 阶段或 null
 */
export function revertState(cwd: string, callId: string, scope: string, hunkIndex: number): RevertState | null {
  const row = dbFor(cwd).prepare('SELECT state FROM revert_intents WHERE call_id=? AND scope=? AND hunk_index=?')
    .get(callId, scope, hunkIndex) as Row | undefined
  return row ? String(row.state) as RevertState : null
}

/**
 * 持久化 Undo 阶段（started 在写文件前，applied 在写文件后）。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param callId 记录标识
 * @param scope 决策范围
 * @param hunkIndex 块索引
 * @param state 阶段
 */
export function setRevertState(cwd: string, callId: string, scope: string, hunkIndex: number, state: RevertState): void {
  dbFor(cwd).prepare(`INSERT INTO revert_intents(call_id,scope,hunk_index,state) VALUES(?,?,?,?)
    ON CONFLICT(call_id,scope,hunk_index) DO UPDATE SET state=excluded.state`).run(callId, scope, hunkIndex, state)
}

/**
 * 一次事务登记同记录的所有批量 Undo 意图，登记不完整时不写任何文件。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param callId 记录标识
 * @param indices 块索引
 */
export function startReverts(cwd: string, callId: string, indices: number[]): void {
  const db = dbFor(cwd)
  const insert = db.prepare(`INSERT INTO revert_intents(call_id,scope,hunk_index,state) VALUES(?,'hunk',?,'started')`)
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const index of indices) insert.run(callId, index)
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 撤销尚未执行成功的 Undo 意图，保留成功写入后的阶段供补偿。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param callId 记录标识
 * @param scope 决策范围
 * @param hunkIndex 块索引
 */
export function clearRevertState(cwd: string, callId: string, scope: string, hunkIndex: number): void {
  dbFor(cwd).prepare('DELETE FROM revert_intents WHERE call_id=? AND scope=? AND hunk_index=?')
    .run(callId, scope, hunkIndex)
}

/**
 * 已执行但 sidecar 未更新的 Undo，从磁盘恢复决定而不重写文件。
 * @author ddj 2026年09月30号
 * @param cwd 工作区
 * @param record 活跃记录
 * @returns 是否应用了持久化决定
 */
export function restoreReverts(cwd: string, record: DiffRecord): boolean {
  const rows = dbFor(cwd).prepare('SELECT scope,hunk_index,state FROM revert_intents WHERE call_id=?')
    .all(record.callId) as Row[]
  let changed = false
  for (const row of rows) {
    if (row.state !== 'applied') continue
    if (row.scope === 'call') {
      record.decisions.call = 'rejected'
      record.decisions.perHunk = record.decisions.perHunk.map(() => 'rejected')
    } else if (row.scope === 'hunk' && Number(row.hunk_index) >= 0 && Number(row.hunk_index) < record.hunks.length) {
      record.decisions.perHunk[Number(row.hunk_index)] = 'rejected'
    } else continue
    changed = true
  }
  return changed
}

/**
 * 关闭所有工作区连接，供 Host 卸载以及测试释放 SQLite 句柄。
 * @author ddj 2026年09月30号
 */
export function closeArchiveDbs(): void {
  for (const db of connections.values()) db.close()
  connections.clear()
}
