/** Official history shares the archive connection, but never the legacy callId namespace. @author ddj 2026年10月26号 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { activeReady, dbFor } from './archiveDb.js'
import type { CaptureGap, DecideReview, OfficialDiff, ReviewDetail, ReviewItem, ReviewPage, ReviewSnapshot } from './shared/review.js'

type Row = Record<string, string | number | null>

/** @public @author ddj 2026年10月26号 @param cwd Migrated workspace. @returns Schema4 connection; DDL and version change roll back together. */
export function reviewDb(cwd: string): DatabaseSync {
  if (!activeReady(cwd)) throw new Error('官方审查要求先完成活跃库迁移')
  const db = dbFor(cwd)
  const version = db.prepare("SELECT value FROM metadata WHERE name='schema'").get() as Row
  if (version.value === '4') return db
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
  return db
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
  const previous = db.prepare('SELECT identity,diff,decision FROM review_files WHERE session_id=? AND turn=? AND current=1').all(sessionId, turn) as Row[]
  db.prepare('UPDATE review_snapshots SET current=0 WHERE session_id=? AND turn=?').run(sessionId, turn)
  db.prepare('UPDATE review_files SET current=0 WHERE session_id=? AND turn=?').run(sessionId, turn)
  db.prepare('INSERT INTO review_snapshots VALUES(?,?,?,?,?,1)').run(sessionId, turn, seq, JSON.stringify(snapshot), hash)
  const insert = db.prepare('INSERT INTO review_files VALUES(?,?,?,?,?,?,?,?,0,1)')
  for (const [index, file] of snapshot.files.entries()) {
    const encoded = JSON.stringify(file.diff)
    const unchanged = previous.find((item) => item.identity === file.identity && item.diff === encoded)
    const id = digest(JSON.stringify([sessionId, turn, seq, file.identity]))
    insert.run(id, sessionId, turn, seq, file.identity, JSON.stringify(snapshot.summary.files[index]), encoded, unchanged?.decision ?? 'pending')
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

/** @public @author ddj 2026年10月26号 @param cwd Migrated workspace. @param path Legacy write target. @returns Whether any official version owns the file, including decided history. */
export function hasOfficial(cwd: string, path: string): boolean {
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
  return { item: itemOf(row), diff: JSON.parse(String(row.diff)), capturedAt: String(row.captured_at),
    capability: { keep: row.current === 1 && row.decision === 'pending', undo: false,
      reason: '官方仅提供差异块，缺少可验证的历史全文及原始字节；拒绝写回已禁用。可标记已审或打开当前文件继续编辑。' } }
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
      db.exec('COMMIT')
      return JSON.parse(String(previous.result))
    }
    if (request.decision !== 'accepted') throw new Error('缺少可信全文证据，禁止拒绝写回')
    const change = db.prepare(`UPDATE review_files SET decision='accepted',revision=revision+1
      WHERE id=? AND seq=? AND revision=? AND current=1 AND decision='pending'`).run(request.id, request.seq, request.revision)
    if (change.changes !== 1) throw new Error('审查版本冲突，请刷新后重试')
    const result = { revision: request.revision + 1 }
    db.prepare("INSERT INTO review_ops VALUES(?,?,'committed',?,NULL)").run(request.operationId, encoded, JSON.stringify(result))
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}
