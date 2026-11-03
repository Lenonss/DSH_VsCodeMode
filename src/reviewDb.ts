/** Official history shares the archive connection, but never the legacy callId namespace. @author ddj 2026年10月26号 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { archiveDbFile } from './paths.js'
import { reviewBlocks } from './shared/reviewRegions.js'
import type { ReviewBlockState } from './shared/reviewRegions.js'
import type { DatabaseSync } from 'node:sqlite'
import { activeReady, dbFor } from './archiveDb.js'
import type { CaptureGap, DecideReview, OfficialDiff, ReviewDetail, ReviewItem, ReviewPage, ReviewSnapshot } from './shared/review.js'

type Row = Record<string, string | number | null>

/** @public @author ddj 2026年10月26号 @param cwd Migrated workspace. @returns Schema4 connection; DDL and version change roll back together. */
export function reviewDb(cwd: string): DatabaseSync {
  if (!activeReady(cwd)) throw new Error('官方审查要求先完成活跃库迁移')
  const db = dbFor(cwd)
  const version = db.prepare("SELECT value FROM metadata WHERE name='schema'").get() as Row
  if (version.value === '4') { migrateBlocks(cwd, db); return db }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE review_snapshots (
      session_id TEXT NOT NULL, turn INTEGER NOT NULL, seq INTEGER NOT NULL,
      payload TEXT NOT NULL, digest TEXT NOT NULL, current INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(session_id,turn,seq));
      CREATE TABLE review_files (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn INTEGER NOT NULL, seq INTEGER NOT NULL,
      identity TEXT NOT NULL, summary TEXT NOT NULL, diff TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'pending', revision INTEGER NOT NULL DEFAULT 0,
      current INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX review_pending ON review_files(current,decision,id);
      CREATE INDEX review_turn ON review_files(session_id,turn,seq);
      CREATE TABLE review_capture (
      session_id TEXT NOT NULL, turn INTEGER NOT NULL, seq INTEGER NOT NULL,
      state TEXT NOT NULL, error TEXT, PRIMARY KEY(session_id,turn,seq));
      CREATE TABLE review_ops (
      operation_id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
      evidence TEXT);
      UPDATE metadata SET value='4' WHERE name='schema';`)
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
  migrateBlocks(cwd, db)
  return db
}

/** @private @author ddj 2026年10月27号 @param cwd Workspace backup identity. @param db Open schema4 database. Extends the official-review sub-schema without changing legacy archive schema. @throws Migration failure, leaving prior decisions intact. */
function migrateBlocks(cwd: string, db: DatabaseSync): void {
  if (db.prepare("SELECT value FROM metadata WHERE name='review_schema'").get()) return
  const backup = archiveDbFile(cwd) + '.before-review-blocks.bak'
  if (!existsSync(backup)) db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)

  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE review_blocks (file_id TEXT NOT NULL, block_id TEXT NOT NULL,
      decision TEXT NOT NULL, PRIMARY KEY(file_id,block_id));
      CREATE TABLE review_evidence (file_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO metadata(name,value) VALUES('review_schema','2');`)
    const files = db.prepare('SELECT id,diff,decision FROM review_files').all() as Row[]
    for (const file of files) seedBlocks(db, String(file.id), JSON.parse(String(file.diff)), String(file.decision))
    db.exec('COMMIT')
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/** @private @author ddj 2026年10月27号 @param db Transaction connection. @param id File record. @param diff Immutable official source. @param decision Prior file decision. Seeds deterministic blocks without changing source facts. */
function seedBlocks(db: DatabaseSync, id: string, diff: OfficialDiff, decision: string): void {
  const insert = db.prepare('INSERT INTO review_blocks VALUES(?,?,?)')
  for (const block of reviewBlocks(diff)) insert.run(id, block.id, decision)
}

/** @private @author ddj 2026年10月26号 @param text Canonical serialized input. @returns Collision-resistant identity. */
function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }

/** @public @author ddj 2026年10月26号 @param cwd Workspace. @param snapshot Complete staged event. @returns False for late versions; commits facts, pointers and capture state atomically. */
export function saveSnapshot(cwd: string, snapshot: ReviewSnapshot): boolean {
  const db = reviewDb(cwd)
  const { sessionId, turn, seq } = snapshot
  if (snapshot.summary.cwd !== cwd || snapshot.summary.turn !== turn || snapshot.files.length !== snapshot.summary.files.length) throw new Error('官方采集不完整')
  const identities = new Set(snapshot.files.map((file) => file.identity))
  if (identities.size !== snapshot.files.length) throw new Error('官方文件身份重复')
  // capturedAt is acquisition metadata, not part of the immutable source identity.
  const hash = digest(JSON.stringify({ ...snapshot, capturedAt: '' }))
  db.exec('BEGIN IMMEDIATE')
  try {
    const prior = db.prepare('SELECT digest FROM review_snapshots WHERE session_id=? AND turn=? AND seq=?').get(sessionId, turn, seq) as Row | undefined
    if (prior && prior.digest !== hash) throw new Error('同一官方事件的内容发生变化')
    const latest = db.prepare('SELECT MAX(seq) AS seq FROM review_snapshots WHERE session_id=? AND turn=?').get(sessionId, turn) as Row
    if (prior || (typeof latest.seq === 'number' && latest.seq > seq)) { db.exec('COMMIT'); return false }
    insertSnapshot(db, snapshot, hash)
    db.prepare("INSERT INTO review_capture VALUES(?,?,?,'complete',NULL) ON CONFLICT(session_id,turn,seq) DO UPDATE SET state='complete',error=NULL").run(sessionId, turn, seq)
    db.exec('COMMIT')
    return true
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/** @public @author ddj 2026年10月27号 @param cwd Workspace. @param resolvePath Backend path adapter. @returns Repairs only historical object-string identities; preserves IDs, decisions and immutable official facts. @throws Resolution or concurrent payload changes. */
export async function repairPaths(cwd: string, resolvePath: (cwd: string, path: string) => Promise<string>): Promise<void> {
  const db = reviewDb(cwd)
  const broken = db.prepare(`SELECT DISTINCT s.* FROM review_snapshots s JOIN review_files f
    USING(session_id,turn,seq) WHERE f.identity='[object Object]'`).all() as Row[]
  for (const row of broken) {
    const snapshot = JSON.parse(String(row.payload)) as ReviewSnapshot
    for (const file of snapshot.files) {
      if (file.identity !== '[object Object]') continue
      file.identity = await resolvePath(snapshot.summary.cwd, file.diff.path)
      if (!file.identity || file.identity === '[object Object]') throw new Error('官方文件路径修复失败')
    }
    if (new Set(snapshot.files.map((file) => file.identity)).size !== snapshot.files.length) throw new Error('官方文件身份重复')

    // All IO is staged before locking; compare the persisted payload to avoid overwriting newer repairs.
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare('SELECT payload FROM review_snapshots WHERE session_id=? AND turn=? AND seq=?')
        .get(snapshot.sessionId, snapshot.turn, snapshot.seq) as Row | undefined
      if (current?.payload === row.payload) {
        for (const file of snapshot.files) {
          db.prepare(`UPDATE review_files SET identity=? WHERE session_id=? AND turn=? AND seq=?
            AND identity='[object Object]' AND json_extract(diff,'$.path')=?`)
            .run(file.identity, snapshot.sessionId, snapshot.turn, snapshot.seq, file.diff.path)
        }
        db.prepare('UPDATE review_snapshots SET payload=?,digest=? WHERE session_id=? AND turn=? AND seq=?')
          .run(JSON.stringify(snapshot), digest(JSON.stringify({ ...snapshot, capturedAt: '' })), snapshot.sessionId, snapshot.turn, snapshot.seq)
      }
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }
}

/** @private @author ddj 2026年10月26号 @param db Transaction. @param snapshot Source payload. @param hash Source digest. */
function insertSnapshot(db: DatabaseSync, snapshot: ReviewSnapshot, hash: string): void {
  const { sessionId, turn, seq } = snapshot
  const previous = db.prepare('SELECT id,identity,diff,decision FROM review_files WHERE session_id=? AND turn=? AND current=1').all(sessionId, turn) as Row[]
  db.prepare('UPDATE review_snapshots SET current=0 WHERE session_id=? AND turn=?').run(sessionId, turn)
  db.prepare('UPDATE review_files SET current=0 WHERE session_id=? AND turn=?').run(sessionId, turn)
  db.prepare('INSERT INTO review_snapshots VALUES(?,?,?,?,?,1)').run(sessionId, turn, seq, JSON.stringify(snapshot), hash)
  const insert = db.prepare('INSERT INTO review_files VALUES(?,?,?,?,?,?,?,?,0,1)')
  for (const [index, file] of snapshot.files.entries()) {
    const encoded = JSON.stringify(file.diff)
    const unchanged = previous.find((item) => item.identity === file.identity && item.diff === encoded)
    const id = digest(JSON.stringify([sessionId, turn, seq, file.identity]))
    const decision = String(unchanged?.decision ?? 'pending')
    insert.run(id, sessionId, turn, seq, file.identity, JSON.stringify(snapshot.summary.files[index]), encoded, decision)
    seedBlocks(db, id, file.diff, decision)
    if (unchanged) {
      // A same-turn republish must preserve mixed per-block decisions, not seed all blocks as mixed.
      db.prepare(`UPDATE review_blocks SET decision=(SELECT p.decision FROM review_blocks p
        WHERE p.file_id=? AND p.block_id=review_blocks.block_id)
        WHERE file_id=? AND EXISTS(SELECT 1 FROM review_blocks p WHERE p.file_id=? AND p.block_id=review_blocks.block_id)`)
        .run(unchanged.id, id, unchanged.id)
      db.prepare('INSERT INTO review_evidence SELECT ?,payload FROM review_evidence WHERE file_id=?').run(id, unchanged.id)
    }
  }
}

/** @public @author ddj 2026年10月26号 @param cwd Workspace. @param gap Announced event identity. @param state Durable inbox or explicit failure. */
export function captureState(cwd: string, gap: CaptureGap, state: 'queued' | 'gap'): void {
  reviewDb(cwd).prepare(`INSERT INTO review_capture VALUES(?,?,?,?,?) ON CONFLICT(session_id,turn,seq)
    DO UPDATE SET state=excluded.state,error=excluded.error WHERE review_capture.state<>'complete'`).run(gap.sessionId, gap.turn, gap.seq, state, gap.error)
}

/** @private @author ddj 2026年10月26号 @param row File and state. @returns Wire-safe summary without hunks. */
function itemOf(row: Row): ReviewItem {
  const summary = JSON.parse(String(row.summary))
  const kind = row.kind ?? (JSON.parse(String(row.diff)) as OfficialDiff).kind
  return { id: String(row.id), sessionId: String(row.session_id), turn: Number(row.turn), seq: Number(row.seq),
    ...summary, currentPath: String(row.identity), kind: kind as ReviewItem['kind'], decision: row.decision as ReviewItem['decision'], revision: Number(row.revision), current: row.current === 1 }
}

/** @public @author ddj 2026年10月26号 @param cwd Workspace. @param cursor Page offset. @param history Include withdrawn/decided history. @returns Bounded metadata page; pending across all source sessions/turns. */
export function reviewPage(cwd: string, cursor = 0, history = false, path?: string): ReviewPage {
  const db = reviewDb(cwd)
  const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
  const conditions = history ? [] : ["current=1 AND decision='pending'"]
  if (path !== undefined) conditions.push('identity=?')
  const clause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const parameters = path === undefined ? [offset] : [path, offset]
  const rows = db.prepare(`SELECT id,session_id,turn,seq,identity,summary,decision,revision,current,
    json_extract(diff,'$.kind') AS kind FROM review_files ${clause} ORDER BY rowid DESC LIMIT 51 OFFSET ?`).all(...parameters) as Row[]
  const count = db.prepare("SELECT COUNT(*) AS n FROM review_files WHERE current=1 AND decision='pending'").get() as Row
  const gaps = db.prepare("SELECT * FROM review_capture WHERE state<>'complete' ORDER BY seq DESC LIMIT 50").all() as Row[]
  const capped = db.prepare(`SELECT session_id,turn,seq,json_extract(payload,'$.summary.total') AS total,
    json_array_length(payload,'$.summary.files') AS listed FROM review_snapshots WHERE current=1
    AND json_extract(payload,'$.summary.total')>json_array_length(payload,'$.summary.files') LIMIT 50`).all() as Row[]
  // Navigation is metadata-only and independent of the 50-row patch-history page.
  const files = db.prepare(`SELECT identity,MIN(json_extract(summary,'$.display')) AS label,COUNT(*) AS n
    FROM review_files WHERE current=1 AND decision='pending' GROUP BY identity ORDER BY identity`).all() as Row[]
  const covered = db.prepare('SELECT DISTINCT identity FROM review_files').all() as Row[]
  return { overview: { files: files.map((row) => ({ sourceKind: 'official', path: String(row.identity), label: String(row.label), pending: Number(row.n) })),
    coveredPaths: covered.map((row) => String(row.identity)) },
    items: rows.slice(0, 50).map(itemOf), pending: Number(count.n), nextCursor: rows.length > 50 ? offset + 50 : null,
    gaps: [
      ...gaps.map((row) => ({ sessionId: String(row.session_id), turn: Number(row.turn), seq: Number(row.seq), error: String(row.error || '采集中或上次采集被中断') })),
      ...capped.map((row) => ({ sessionId: String(row.session_id), turn: Number(row.turn), seq: Number(row.seq), error: `官方列表已截断：总计 ${row.total} 个文件，仅提供 ${row.listed} 个` })),
    ] }

}

/**
 * @public
 * @author ddj 2026年10月31号
 * @description: 该会话里由官方记录判为「整文件新增」的文件身份集合。待审条目命中时基线要置空：
 * 文件是本会话新建的，累计基线只是会话自己的中间产物，拿它做旧侧会把新增文件渲染成一堆修改块。
 * @param cwd 迁移后的工作区
 * @param sessionId 会话
 * @returns 整文件新增的文件身份集合
 */
export function addedFiles(cwd: string, sessionId: string): Set<string> {
  try {
    const db = dbFor(cwd)
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='review_files' AND type='table'").get()) return new Set()
    // 先按会话收窄再取每个文件最早的那条官方记录：首个块是整文件新增（before=false）才说明文件
    // 由本次会话创建，后续修改块不能反过来把新建成改写成「有旧基线的修改」。
    const rows = db.prepare(`SELECT identity FROM (SELECT identity,
      json_extract(diff,'$.before') AS before, ROW_NUMBER() OVER (PARTITION BY identity ORDER BY turn, seq) AS rank
      FROM review_files WHERE session_id=?) WHERE rank=1 AND before=0`).all(sessionId) as Row[]
    return new Set(rows.map((row) => String(row.identity)))
  } catch {
    // 判定失败只退回旧的累计基线口径，不影响列表与详情可用
    return new Set()
  }
}

/**
 * @public
 * @author ddj 2026年10月31号
 * @description: 该文件是否还有未处理的官方待审改动。缺失文件预览据此区分「需要去差异栏 Keep 结案」
 * 与「记录都已处理、可直接关闭标签页」，避免已结案的删除文件继续提示待审。
 * @param cwd Migrated workspace
 * @param path Host path of the file
 * @returns 存在未决官方记录时为 true
 */
export function officialPending(cwd: string, path: string): boolean {
  if (typeof path !== 'string') return false
  const db = dbFor(cwd)
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='review_files' AND type='table'").get()) return false
  // Windows 盘符路径按「反斜杠折成正斜杠 + 折大小写」比较（与 hasOfficial 的 SQL 归一化等价）；
  // 其余平台按身份精确比较，别把大小写不同的两个文件当成同一个。
  if (path.length > 1 && path[1] === ':') {
    const folded = path.split(String.fromCharCode(92)).join('/').toLowerCase()
    return !!db.prepare("SELECT 1 FROM review_files WHERE current=1 AND decision='pending'"
      + " AND lower(replace(identity,char(92),'/'))=? LIMIT 1").get(folded)
  }
  return !!db.prepare("SELECT 1 FROM review_files WHERE current=1 AND decision='pending' AND identity=? LIMIT 1").get(path)
}

/** @public @author ddj 2026年10月26号 @param cwd Migrated workspace. @param path Legacy write target. @returns Whether any official version owns the file, including decided history. */
export function hasOfficial(cwd: string, path: string): boolean {
  // 防御：解析结果若被误当成路径传进来（不透明对象），按「无官方记录」处理，
  // 否则 SQLite 会把对象当命名参数绑定，抛出与真实原因无关的错误。
  if (typeof path !== 'string') return false
  const db = dbFor(cwd)
  // A read guard must not acquire a migration write lock on legacy-only databases.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='review_files' AND type='table'").get()) return false
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return !!db.prepare("SELECT 1 FROM review_files WHERE lower(replace(identity,char(92),'/'))=? LIMIT 1")
      .get(path.replace(/\\/g, '/').toLowerCase())
  }
  return !!db.prepare('SELECT 1 FROM review_files WHERE identity=? LIMIT 1').get(path)
}

/** @public @author ddj 2026年10月26号 @param cwd Workspace. @param id Immutable file identity. @returns Historical patch, not a reconstruction from disk. */
export function reviewDetail(cwd: string, id: string): ReviewDetail | null {
  const db = reviewDb(cwd)
  const row = db.prepare(`SELECT f.*,json_extract(s.payload,'$.capturedAt') AS captured_at FROM review_files f JOIN review_snapshots s
    USING(session_id,turn,seq) WHERE f.id=?`).get(id) as Row | undefined
  if (!row) return null
  const blocks = db.prepare('SELECT block_id AS id,decision FROM review_blocks WHERE file_id=? ORDER BY rowid').all(id) as unknown as ReviewBlockState[]
  const diff = JSON.parse(String(row.diff)) as OfficialDiff
  const evidence = db.prepare('SELECT 1 FROM review_evidence WHERE file_id=?').get(id)
  const pending = row.current === 1 && row.decision === 'pending'
  const undo = pending && !!evidence && diff.kind === 'text' && diff.before && diff.after && !diff.coarse
  return { item: itemOf(row), diff, capturedAt: String(row.captured_at), blocks,
    capability: { keep: pending, undo,
      reason: undo ? 'Undo 将校验原始字节、当前文件版本及已处理差异块；文件变化会安全拒绝。'
        : '该记录缺少可验证的原始字节或受控写回能力；仍可显示差异和 Keep，不能猜测历史全文执行 Undo。' } }
}

/**
 * @private
 * @author ddj 2026年11月03号
 * @description: 把一个文件的待处理差异块整体置为目标决策，块级判定仍走 changeBlocks 的 hunk 分支。
 * @param db 判定事务连接
 * @param id 文件身份
 * @param decision 目标决策
 * @returns 无
 */
function markBlocks(db: DatabaseSync, id: string, decision: DecideReview['decision']): void {
  db.prepare("UPDATE review_blocks SET decision=? WHERE file_id=? AND decision='pending'").run(decision, id)
}

/**
 * @private
 * @author ddj 2026年11月03号
 * @description: 按块决定聚合回写文件决定：仍含 pending 即 pending，多值即 mixed，单一值取该值。
 * @param db 判定事务连接
 * @param id 文件身份
 * @param fallback 没有任何块时的兜底决策
 * @returns 无
 */
function aggregateDecision(db: DatabaseSync, id: string, fallback: string): void {
  const states = db.prepare('SELECT DISTINCT decision FROM review_blocks WHERE file_id=?').all(id) as Row[]
  const decisions = states.map((row) => String(row.decision))
  let aggregate = fallback
  if (decisions.includes('pending')) aggregate = 'pending'
  else if (decisions.length > 1) aggregate = 'mixed'
  else if (decisions.length === 1) aggregate = decisions[0]
  db.prepare('UPDATE review_files SET decision=? WHERE id=?').run(aggregate, id)
}

/** @public @author ddj 2026年10月27号 @param db Active decision transaction. @param request File or block action. Updates aggregate without losing mixed decisions. @throws Invalid or already-decided block. */
export function changeBlocks(db: DatabaseSync, request: DecideReview): void {
  if (request.scope === 'hunk') {
    const changed = db.prepare("UPDATE review_blocks SET decision=? WHERE file_id=? AND block_id=? AND decision='pending'")
      .run(request.decision, request.id, request.blockId ?? '')
    if (changed.changes !== 1) throw new Error('差异块不存在或已处理')
  } else {
    markBlocks(db, request.id, request.decision)
  }
  aggregateDecision(db, request.id, request.decision)
}

/** @public @author ddj 2026年10月26号 @param cwd Workspace. @param request Frozen identity/revision. @returns Idempotent decision; rejection never guesses a target. */
export function decideReview(cwd: string, request: DecideReview): { revision: number } {
  const db = reviewDb(cwd)
  const encoded = JSON.stringify(request)
  if (!request.operationId || request.operationId.length > 128) throw new Error('operationId 无效')
  db.exec('BEGIN IMMEDIATE')
  try {
    const previous = db.prepare('SELECT request,result FROM review_ops WHERE operation_id=?').get(request.operationId) as Row | undefined
    if (previous) {
      if (previous.request !== encoded) throw new Error('operationId 已用于其他请求')
      if (!previous.result) throw new Error('Undo 尚待写后核对，请重试原操作')
      db.exec('COMMIT')
      return JSON.parse(String(previous.result))
    }
    if (db.prepare("SELECT 1 FROM review_ops WHERE state='prepared' AND json_extract(request,'$.id')=?").get(request.id)) {
      throw new Error('该文件有尚待核对的 Undo，暂不能 Keep')
    }
    if (request.decision !== 'accepted') throw new Error('缺少可信全文证据，禁止拒绝写回')
    const change = db.prepare(`UPDATE review_files SET decision='accepted',revision=revision+1
      WHERE id=? AND seq=? AND revision=? AND current=1 AND decision='pending'`).run(request.id, request.seq, request.revision)
    if (change.changes !== 1) throw new Error('审查版本冲突，请刷新后重试')
    changeBlocks(db, request)
    const result = { revision: request.revision + 1 }
    db.prepare("INSERT INTO review_ops VALUES(?,?,'committed',?,NULL)").run(request.operationId, encoded, JSON.stringify(result))
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/** 官方批量 Keep 的一条目标：id/seq 参与幂等编码，revision 只用于审计。 */
export interface OfficialKeepItem {
  id: string
  seq: number
  revision: number
  operationId: string
}
/** 官方批量 Keep 的结果；skipped 只记录条目级原因，段级异常由调用方捕获。 */
export interface OfficialKeepOutcome {
  paths: string[]
  skipped: { id: string; reason: string }[]
}

/**
 * @private
 * @author ddj 2026年11月03号
 * @description: 取当前仍待审的官方记录摘要，作为批量写入的权威依据（不用客户端快照值）。
 * @param db 判定事务连接
 * @returns id → 库内 seq/revision/identity
 */
function pendingRows(db: DatabaseSync): Map<string, { seq: number; revision: number; identity: string }> {
  const rows = db.prepare("SELECT id,seq,revision,identity FROM review_files WHERE current=1 AND decision='pending'").all() as Row[]
  const map = new Map<string, { seq: number; revision: number; identity: string }>()
  for (const row of rows) map.set(String(row.id), { seq: Number(row.seq), revision: Number(row.revision), identity: String(row.identity) })
  return map
}

/**
 * @public
 * @author ddj 2026年11月03号
 * @description: 一次事务内批量保留官方待审记录。写入条件取库内当前 revision，客户端的 seq/revision 只用于派生操作号，
 * 因此快照漂移不会让整批中止；已结案、有尚待核对 Undo、操作号冲突的条目只跳过自己。
 * @param cwd 工作区
 * @param items 待保留条目（含派生好的 operationId）
 * @returns 成功保留的 identity 列表与跳过明细
 * @throws 事务级异常（SQL/程序错误）整体回滚后抛出
 */
export function keepOfficialAll(cwd: string, items: OfficialKeepItem[]): OfficialKeepOutcome {
  const db = reviewDb(cwd)
  const rows = pendingRows(db)
  const outcome: OfficialKeepOutcome = { paths: [], skipped: [] }
  const keep = db.prepare(`UPDATE review_files SET decision='accepted',revision=revision+1
    WHERE id=? AND seq=? AND revision=? AND current=1 AND decision='pending'`)
  const prepared = db.prepare("SELECT 1 FROM review_ops WHERE state='prepared' AND json_extract(request,'$.id')=?")

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const item of items) {
      const encoded = JSON.stringify({ id: item.id, seq: item.seq })
      const previous = db.prepare('SELECT request,result FROM review_ops WHERE operation_id=?').get(item.operationId) as Row | undefined

      // 同一批次重放（客户端重试）按操作号幂等返回，不重复推进 revision
      if (previous) {
        if (previous.request !== encoded || !previous.result) outcome.skipped.push({ id: item.id, reason: '该条目已由其他操作处理' })
        else outcome.paths.push(String((JSON.parse(String(previous.result)) as { identity: string }).identity))
        continue
      }

      const row = rows.get(item.id)
      if (!row || prepared.get(item.id)) {
        outcome.skipped.push({ id: item.id, reason: row ? '该文件有尚待核对的 Undo，暂不能 Keep' : '已结案或不再是待审记录' })
        continue
      }

      // 权威条件用库内 revision：客户端没看见的中间版本也能安全保留，落笔后仍由 CAS 兜住并发
      if (keep.run(item.id, row.seq, row.revision).changes !== 1) {
        outcome.skipped.push({ id: item.id, reason: '审查版本冲突，请刷新后重试' })
        continue
      }

      markBlocks(db, item.id, 'accepted')
      aggregateDecision(db, item.id, 'accepted')
      db.prepare("INSERT INTO review_ops VALUES(?,?,'committed',?,NULL)")
        .run(item.operationId, encoded, JSON.stringify({ identity: row.identity }))
      outcome.paths.push(row.identity)
      rows.delete(item.id)
    }
    db.exec('COMMIT')
    return outcome
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}
