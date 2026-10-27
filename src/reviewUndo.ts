/** Guarded official undo with a durable write-intent journal. @author ddj 2026年10月27号 */
import { changeBlocks, reviewDb, reviewDetail } from './reviewDb.js'
import { evidenceBlocks, evidenceText, rawReviewFile } from './reviewEvidence.js'
import type { ReviewEvidence } from './reviewEvidence.js'
import type { DecideReview } from './shared/review.js'
import type { Ctx, Session } from './store.js'
import { policyOf, resolveTarget } from './store.js'

type OperationRow = { request: string; state: string; result: string | null; evidence: string }
interface UndoJournal { before: string; after: string }
const writes = new Map<string, Promise<unknown>>()

/** @public @author ddj 2026年10月27号 @param ctx Host capability. @param session Authenticated caller. @param cwd Workspace. @param request Frozen file/block version. @returns Durable decision; retries reconcile disk hashes and never blindly repeat a write. @throws Missing evidence, stale state, policy or uncertain write failure. */
export async function undoReview(ctx: Ctx, session: Session, cwd: string, request: DecideReview): Promise<{ revision: number }> {
  const detail = reviewDetail(cwd, request.id)
  const key = JSON.stringify([cwd, detail?.item.currentPath ?? request.id])
  const prior = writes.get(key) ?? Promise.resolve()
  const operation = prior.catch(() => undefined).then(() => runUndo(ctx, session, cwd, request))
  writes.set(key, operation)
  try { return await operation }
  finally { if (writes.get(key) === operation) writes.delete(key) }
}

/** @private @author ddj 2026年10月27号 @param ctx Host. @param session Caller. @param cwd Workspace. @param request Frozen decision. @returns Serialized guarded mutation and journal reconciliation. @throws Conflicting bytes or decisions. */
async function runUndo(ctx: Ctx, session: Session, cwd: string, request: DecideReview): Promise<{ revision: number }> {
  const db = reviewDb(cwd)
  const encoded = JSON.stringify(request)
  if (!request.operationId || request.operationId.length > 128) throw new Error('operationId 无效')
  const prior = db.prepare('SELECT * FROM review_ops WHERE operation_id=?').get(request.operationId) as OperationRow | undefined
  if (prior && prior.request !== encoded) throw new Error('operationId 已用于其他请求')
  if (prior?.state === 'committed') return JSON.parse(prior.result!)
  const detail = reviewDetail(cwd, request.id)
  if (!detail || !detail.item.current || detail.item.seq !== request.seq || detail.item.revision !== request.revision
    || detail.item.decision !== 'pending') throw new Error('审查版本冲突，请刷新后重试')
  const fs = ctx.get('fs')
  if (!fs?.readBytes || !fs?.writeText || !fs?.stat) throw new Error('后端缺少受控回滚能力')
  const target = await resolveTarget(ctx, session, detail.item.currentPath)
  const info = await fs.stat(target)
  if (!info || info.type !== 'file' || !info.version) throw new Error('文件不存在或缺少版本守卫，不能安全 Undo')
  const bytes = await fs.readBytes(target, undefined, 8 * 1024 * 1024)
  const current = rawReviewFile(bytes)
  const observed = await fs.stat(target)
  if (observed?.version !== info.version) throw new Error('文件在回滚读取期间变化，未修改文件')
  if (prior) {
    const journal = JSON.parse(prior.evidence) as UndoJournal
    if (current.hash === journal.after) return finishUndo(cwd, request)
    if (current.hash !== journal.before) throw new Error('上次 Undo 状态不确定：磁盘既非写前也非写后，禁止重复执行')
  }
  const unresolved = db.prepare("SELECT operation_id FROM review_ops WHERE state='prepared' AND json_extract(request,'$.id')=? AND operation_id<>?")
    .get(request.id, request.operationId)
  if (unresolved) throw new Error('存在未核对的 Undo，请使用原操作重试，不能创建另一项写入')
  const row = db.prepare('SELECT payload FROM review_evidence WHERE file_id=?').get(request.id) as { payload: string } | undefined
  if (!row) throw new Error('该历史记录缺少可信原始字节证据，不能 Undo；差异仍可展示和 Keep')
  const evidence = JSON.parse(row.payload) as ReviewEvidence
  const segments = evidenceBlocks(detail.diff, evidence)
  const texts = evidenceText(evidence)
  if (!evidence.before.present || !evidence.after.present) throw new Error('当前后端未提供受控原子删除/重建能力')
  const selected = detail.blocks.filter((block) => block.decision === 'pending' && (request.scope !== 'hunk' || block.id === request.blockId))
  if (!selected.length) throw new Error('差异块不存在或已处理')
  // Build the expected disk version by removing only previously rejected blocks.
  const rejected = new Set(detail.blocks.filter((block) => block.decision === 'rejected').map((block) => block.id))
  const expected = reverseBlocks(texts.after, segments, rejected)
  if (rawReviewFile(Buffer.from(expected)).hash !== current.hash) throw new Error('当前文件已被后续编辑，版本与回滚证据冲突，未修改文件')
  const undo = new Set([...rejected, ...selected.map((block) => block.id)])
  const next = reverseBlocks(texts.after, segments, undo)
  const journal = { before: current.hash, after: rawReviewFile(Buffer.from(next)).hash }
  const latest = reviewDetail(cwd, request.id)
  if (!latest?.item.current || latest.item.revision !== request.revision || latest.item.decision !== 'pending') {
    throw new Error('审查版本在回滚校验期间变化，未修改文件')
  }
  db.prepare("INSERT INTO review_ops VALUES(?,?,'prepared',NULL,?) ON CONFLICT(operation_id) DO NOTHING")
    .run(request.operationId, encoded, JSON.stringify(journal))
  // Provider checks the exact observation inside its atomic mutation critical section.
  await fs.writeText(target, next, { kind: 'replaceIfVersion', version: info.version }, undefined, policyOf(ctx, session))
  const written = rawReviewFile(await fs.readBytes(target, undefined, 8 * 1024 * 1024))
  if (written.hash !== journal.after) throw new Error('Undo 写后内容不确定，请保留原操作重试核对')
  return finishUndo(cwd, request)
}

/** @private @author ddj 2026年10月27号 @param text Captured result. @param segments Validated raw ranges. @param rejected Blocks to reverse. @returns Raw storage text preserving unselected blocks. */
function reverseBlocks(text: string, segments: ReturnType<typeof evidenceBlocks>, rejected: Set<string>): string {
  let result = text
  for (const segment of [...segments].reverse()) {
    if (!rejected.has(segment.id)) continue
    result = result.slice(0, segment.offset) + segment.before + result.slice(segment.offset + segment.after.length)
  }
  return result
}

/** @private @author ddj 2026年10月27号 @param cwd Workspace. @param request Frozen action. @returns Transactionally committed status, or a retryable prepared journal if the database fails. */
function finishUndo(cwd: string, request: DecideReview): { revision: number } {
  const db = reviewDb(cwd)
  db.exec('BEGIN IMMEDIATE')
  try {
    const updated = db.prepare("UPDATE review_files SET revision=revision+1 WHERE id=? AND seq=? AND revision=? AND current=1 AND decision='pending'")
      .run(request.id, request.seq, request.revision)
    if (updated.changes !== 1) throw new Error('审查版本冲突，请核对已执行 Undo')
    changeBlocks(db, request)
    const result = { revision: request.revision + 1 }
    db.prepare("UPDATE review_ops SET state='committed',result=? WHERE operation_id=?").run(JSON.stringify(result), request.operationId)
    db.exec('COMMIT')
    return result
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error }
}
