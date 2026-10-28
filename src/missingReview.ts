/** Missing historical files: frozen, whole-file deletion reviews. */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { DiffRecord, MissingReview } from './shared/types.js'
import type { Ctx, Session } from './store.js'
import { archiveRecords, policyOf, READ_CAP, resolveTargetIn } from './store.js'
import { hasOfficial } from './reviewDb.js'
import { recordResolved } from './model.js'

interface FrozenReview {
  view: MissingReview
  cwd: string
  session: Session
  revision: string
  expires: number
  operation?: { id: string; undo: boolean; restored: boolean; done: boolean }
}
const frozen = new Map<string, FrozenReview>()
const locks = new Set<string>()

/** @private @author ddj 2026年10月28号 @param target Resolved absolute path. @returns Platform file identity. */
function fileKey(target: string): string {
  const normalized = resolve(target).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** @private @author ddj 2026年10月28号 @param records Ordered records. @returns Full evidence and decision revision, excluding transient conflict flags. */
function revisionOf(records: DiffRecord[]): string {
  const evidence = records.map(({ callId, path, at, after, hunks, decisions, archived, superseded }) =>
    ({ callId, path, at, after, hunks, decisions, archived, superseded }))
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
}

/** @private @author ddj 2026年10月28号 @param ctx Host capability. @param cwd Workspace. @param bucket Records. @param target Resolved file. @returns Records for the same physical path spelling, oldest first. */
async function fileRecords(ctx: Ctx, cwd: string, bucket: Map<string, DiffRecord>, target: string): Promise<DiffRecord[]> {
  const matches: DiffRecord[] = []
  const identity = fileKey(target)
  for (const record of bucket.values()) {
    if (record.superseded) continue
    if (fileKey(await resolveTargetIn(ctx, cwd, record.path)) === identity) matches.push(record)
  }
  return matches.sort((left, right) => left.at.localeCompare(right.at))
}

/** @public @author ddj 2026年10月28号 @param ctx Host. @param cwd Workspace. @param path Requested file. @returns True only for confirmed absence; directories and IO failures are not missing files. */
export async function fileAbsent(ctx: Ctx, cwd: string, path: string): Promise<boolean> {
  const fs = ctx.get('fs')
  if (!fs) throw new Error('缺少 fs')
  const target = await resolveTargetIn(ctx, cwd, path)
  try { return !(await fs.stat(target)) }
  catch (error) {
    if (['ENOENT', 'FS_NOT_FOUND'].includes(String((error as { code?: string }).code))) return true
    throw error
  }
}

/** @public @author ddj 2026年10月28号 @param ctx Host. @param session Live session. @param cwd Workspace. @param bucket Records. @param path Requested file. @returns Frozen complete snapshot; never constructs text from hunks or writes files. @throws Missing evidence or nonmissing target. */
export async function missingReview(ctx: Ctx, session: Session, cwd: string, bucket: Map<string, DiffRecord>, path: string): Promise<MissingReview> {
  const target = await resolveTargetIn(ctx, cwd, path)
  if (hasOfficial(cwd, path) || hasOfficial(cwd, target)) throw new Error('该文件已有官方审查记录，请使用官方审查入口')
  if (!await fileAbsent(ctx, cwd, target)) throw new Error('文件已重新出现，请刷新')
  const records = await fileRecords(ctx, cwd, bucket, target)
  const latest = records.at(-1)
  if (!records.some((record) => !record.archived && !recordResolved(record))) throw new Error('没有待审历史记录')
  if (!latest || typeof latest.after !== 'string') throw new Error('缺少可靠的完整历史快照，无法展示或恢复；不会用局部差异拼接文件')
  if (Buffer.byteLength(latest.after, 'utf8') > READ_CAP) throw new Error('历史快照过大，无法整文件预览')

  for (const [token, item] of frozen) if (item.expires < Date.now()) frozen.delete(token)
  if (frozen.size >= 256) throw new Error('缺失文件预览过多，请稍后重试')
  const view: MissingReview = { token: randomUUID(), path, content: latest.after, callIds: records.filter((record) => !record.archived && !recordResolved(record)).map((record) => record.callId), at: latest.at }
  frozen.set(view.token, { view, cwd, session, revision: revisionOf(records), expires: Date.now() + 30 * 60_000 })
  return view
}

/** @private @author ddj 2026年10月28号 @param ctx Host. @param item Frozen evidence. @param target Resolved path. @param undo Restore instead of keeping absence. @sideEffects Atomically creates absent file, verifies exact bytes; retries never overwrite an existing file. */
async function applyDisk(ctx: Ctx, item: FrozenReview, target: string, undo: boolean): Promise<void> {
  const fs = ctx.get('fs')
  const absent = await fileAbsent(ctx, item.cwd, target)
  if (!undo) { if (!absent) throw new Error('文件已重新出现，未执行 Keep'); return }
  const operation = item.operation!
  if (!absent && !operation.restored) throw new Error('文件已重新出现，未执行 Undo')
  if (absent && !operation.restored) {
    // Publish through the official capability and session sandbox, never unconditional overwrite.
    await fs.writeText(target, item.view.content, { kind: 'createIfAbsent' }, undefined, policyOf(ctx, item.session))
    operation.restored = true
  }
  if (absent && operation.restored && !await fs.stat(target)) throw new Error('恢复后的文件再次缺失，未结清记录')
  if (await fs.readText(target) !== item.view.content) throw new Error('恢复内容校验失败，未结清记录')
}

/** @public @author ddj 2026年10月28号 @param ctx Host. @param session Requesting session. @param cwd Workspace. @param bucket Records. @param token Frozen preview token. @param operationId Stable retry ID. @param undo True restores shown snapshot; false keeps deletion. @returns Covered call IDs. @throws Changed evidence, concurrent action or sandbox/IO failure. */
export async function missingDecide(ctx: Ctx, session: Session, cwd: string, bucket: Map<string, DiffRecord>, token: string, operationId: string, undo: boolean): Promise<string[]> {
  const item = frozen.get(token)
  if (!item || item.expires < Date.now() || item.cwd !== cwd || item.session.id !== session.id) throw new Error('删除预览已过期，请刷新后重试')
  if (!operationId || operationId.length > 128) throw new Error('缺少有效操作 ID')
  const target = await resolveTargetIn(ctx, cwd, item.view.path)
  const key = JSON.stringify([cwd, fileKey(target)])
  if (locks.has(key)) throw new Error('该文件正在处理，请稍后重试')
  locks.add(key)
  item.session = session
  try { return await commitMissing(ctx, item, bucket, target, operationId, undo) }
  finally { locks.delete(key) }
}

/** @private @author ddj 2026年10月28号 @param ctx Host. @param item Frozen preview. @param bucket Live records. @param target Resolved target. @param operationId Retry identity. @param undo Restore action. @returns Archived pending call IDs; disk success survives bookkeeping failure in the same Host lifetime. */
async function commitMissing(ctx: Ctx, item: FrozenReview, bucket: Map<string, DiffRecord>, target: string, operationId: string, undo: boolean): Promise<string[]> {
  const previous = item.operation
  if (previous && (previous.id !== operationId || previous.undo !== undo)) throw new Error('已有不同操作，请刷新后重试')
  if (previous?.done) return item.view.callIds
  if (hasOfficial(item.cwd, target) || hasOfficial(item.cwd, item.view.path)) throw new Error('该文件已有官方审查记录，请刷新')
  const records = await fileRecords(ctx, item.cwd, bucket, target)
  if (revisionOf(records) !== item.revision) throw new Error('历史记录已变化，请刷新删除预览')
  item.operation ??= { id: operationId, undo, restored: false, done: false }
  await applyDisk(ctx, item, target, undo)

  // Recheck after awaited IO: capture/another review must not silently join this decision.
  const current = await fileRecords(ctx, item.cwd, bucket, target)
  if (revisionOf(current) !== item.revision) throw new Error('历史记录已变化，未结清记录，请刷新')
  const pending = current.filter((record) => item.view.callIds.includes(record.callId))
  const decisions = pending.map((record) => record.decisions)
  const decision = undo ? 'rejected' : 'accepted'
  for (const record of pending) record.decisions = { call: decision, perHunk: record.hunks.map(() => decision) }
  try { await archiveRecords(ctx, item.session, item.cwd, bucket, pending, undo ? '已恢复删除文件快照' : '已保留文件删除') }
  catch (error) { pending.forEach((record, index) => { record.decisions = decisions[index] }); throw error }
  item.operation.done = true
  return item.view.callIds
}
