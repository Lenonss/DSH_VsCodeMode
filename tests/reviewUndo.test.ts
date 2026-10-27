import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { decideReview, reviewDb, reviewDetail, reviewPage, saveSnapshot } from '../src/reviewDb.js'
import { rawReviewFile } from '../src/reviewEvidence.js'
import { undoReview } from '../src/reviewUndo.js'
import type { ReviewSnapshot } from '../src/shared/review.js'
let home = '', original: string | undefined
const cwd = '/undo-evidence'
beforeAll(async () => { original = process.env.DSH_HOME; home = mkdtempSync(join(tmpdir(), 'review-undo-')); process.env.DSH_HOME = home; await migrateActive(cwd, null, async () => null) })
afterAll(() => { closeArchiveDbs(); if (original === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = original; rmSync(home, { recursive: true, force: true }) })
/** @private @author ddj 2026年10月27号 @param turn Unique source. @returns Evidence-backed official two-block file. */
function setup(turn: number) {
  const before = '\uFEFFhead\r\nold\nmid\r\nwas\ntail', after = '\uFEFFhead\r\nnew\nmid\r\nnow\ntail'
  const snapshot: ReviewSnapshot = { sourceKind: 'official', sessionId: 's', turn, seq: turn, capturedAt: '',
    summary: { cwd, turn, total: 1, added: 2, deleted: 2, files: [{ path: 'a' + turn, display: 'a', added: 2, deleted: 2 }] },
    files: [{ identity: cwd + '/a' + turn, diff: { kind: 'text', path: 'a' + turn, display: 'a', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, newStart: 1, oldLines: 5, newLines: 5, lines: [' head', '-old', '+new', ' mid', '-was', '+now', ' tail'] }] } }] }
  saveSnapshot(cwd, snapshot)
  const item = reviewPage(cwd).items.find((row) => row.turn === turn)!
  reviewDb(cwd).prepare('INSERT INTO review_evidence VALUES(?,?)').run(item.id, JSON.stringify({ before: rawReviewFile(Buffer.from(before)), after: rawReviewFile(Buffer.from(after)) }))
  const disk = { text: after, version: 'v1', fail: false }
  const fs = { resolve: async (path: string) => path, stat: async () => ({ type: 'file', version: disk.version }),
    readBytes: async () => Buffer.from(disk.text), writeText: vi.fn(async (_path: string, text: string, intent: any) => {
      if (disk.fail || intent.version !== disk.version) throw new Error('FS_STALE_VERSION')
      disk.text = text; disk.version = 'v2'
    }) }
  const ctx = { get: (name: string) => name === 'fs' ? fs : undefined }
  const request = { sessionId: 's', id: item.id, seq: turn, revision: 0, operationId: 'undo' + turn, decision: 'rejected' as const }
  return { before, after, item, disk, fs, ctx, request }
}
describe('guarded official undo journal', () => {
  it('restores raw BOM and mixed endings; duplicate retry does not write twice', async () => {
    const fixture = setup(1)
    expect(await undoReview(fixture.ctx, {}, cwd, fixture.request)).toEqual({ revision: 1 })
    expect(fixture.disk.text).toBe(fixture.before)
    expect(reviewDetail(cwd, fixture.item.id)?.item.decision).toBe('rejected')
    expect(await undoReview(fixture.ctx, {}, cwd, fixture.request)).toEqual({ revision: 1 })
    expect(fixture.fs.writeText).toHaveBeenCalledTimes(1)
  })
  it('keeps accepted blocks while reversing the other block and aggregates mixed state', async () => {
    const fixture = setup(2), detail = reviewDetail(cwd, fixture.item.id)!
    decideReview(cwd, { ...fixture.request, decision: 'accepted', operationId: 'keep2', scope: 'hunk', blockId: detail.blocks[0].id })
    await undoReview(fixture.ctx, {}, cwd, { ...fixture.request, revision: 1, scope: 'hunk', blockId: detail.blocks[1].id })
    expect(fixture.disk.text).toBe('\uFEFFhead\r\nnew\nmid\r\nwas\ntail')
    expect(reviewDetail(cwd, fixture.item.id)?.item.decision).toBe('mixed')
  })
  it('rejects later edits without modifying disk', async () => {
    const fixture = setup(3); fixture.disk.text += 'later'
    await expect(undoReview(fixture.ctx, {}, cwd, fixture.request)).rejects.toThrow('版本与回滚证据冲突')
    expect(fixture.fs.writeText).not.toHaveBeenCalled()
  })
  it('reconciles a durable prepared operation after write success but lost response', async () => {
    const fixture = setup(4)
    reviewDb(cwd).prepare("INSERT INTO review_ops VALUES(?,?,'prepared',NULL,?)").run(fixture.request.operationId, JSON.stringify(fixture.request),
      JSON.stringify({ before: rawReviewFile(Buffer.from(fixture.after)).hash, after: rawReviewFile(Buffer.from(fixture.before)).hash }))
    fixture.disk.text = fixture.before
    expect(await undoReview(fixture.ctx, {}, cwd, fixture.request)).toEqual({ revision: 1 })
    expect(fixture.fs.writeText).not.toHaveBeenCalled()
  })
  it('serializes concurrent duplicate clicks and commits only one mutation', async () => {
    const fixture = setup(6)
    const results = await Promise.all([undoReview(fixture.ctx, {}, cwd, fixture.request), undoReview(fixture.ctx, {}, cwd, fixture.request)])
    expect(results).toEqual([{ revision: 1 }, { revision: 1 }])
    expect(fixture.fs.writeText).toHaveBeenCalledTimes(1)
  })
  it('retains mixed block decisions and byte evidence on identical official republish', async () => {
    const fixture = setup(7), detail = reviewDetail(cwd, fixture.item.id)!
    decideReview(cwd, { ...fixture.request, decision: 'accepted', operationId: 'keep7', scope: 'hunk', blockId: detail.blocks[0].id })
    const snapshot = JSON.parse(String(reviewDb(cwd).prepare('SELECT payload FROM review_snapshots WHERE turn=7').get()!.payload)) as ReviewSnapshot
    snapshot.seq = 77
    saveSnapshot(cwd, snapshot)
    const next = reviewPage(cwd).items.find((item) => item.seq === 77)!
    expect(reviewDetail(cwd, next.id)?.blocks.map((block) => block.decision)).toEqual(['accepted', 'pending'])
    expect(reviewDetail(cwd, next.id)?.capability.undo).toBe(true)
  })
  it('failed guarded write remains pending and prevents another Keep; original operation may retry', async () => {
    const fixture = setup(5); fixture.disk.fail = true
    await expect(undoReview(fixture.ctx, {}, cwd, fixture.request)).rejects.toThrow('FS_STALE_VERSION')
    expect(reviewDetail(cwd, fixture.item.id)?.item.decision).toBe('pending')
    expect(() => decideReview(cwd, { ...fixture.request, operationId: 'keep5', decision: 'accepted' })).toThrow('尚待核对')
    fixture.disk.fail = false
    await undoReview(fixture.ctx, {}, cwd, fixture.request)
    expect(fixture.disk.text).toBe(fixture.before)
  })
})
