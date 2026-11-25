import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, dbFor, migrateActive } from '../src/archiveDb.js'
import { captureState, decideReview, keepOfficialAll, repairPaths, reviewDb, reviewDetail, reviewPage, saveSnapshot } from '../src/reviewDb.js'
import type { ReviewSnapshot } from '../src/shared/review.js'
let home = '', previousHome: string | undefined
const cwd = '/official-review-tests'

/** @private @author ddj 2026年10月26号 @param turn Source turn. @param seq Event. @param text Patch variation. @returns Complete official fixture, never disk reconstruction. */
function snapshot(turn: number, seq: number, text = 'B'): ReviewSnapshot {
  return { sourceKind: 'official', sessionId: 'source', turn, seq, capturedAt: '2026-10-26T00:00:00Z',
    summary: { cwd, turn, total: 1, added: 1, deleted: 1, files: [{ path: 'a.lua', display: 'a.lua', added: 1, deleted: 1 }] },
    files: [{ identity: cwd + '/a.lua', diff: { kind: 'text', path: 'a.lua', display: 'a.lua', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A', '+' + text] }] } }] }
}
/** @private @author ddj 2026年10月26号 @param id Version identity. @param seq Event. @param operationId Retry identity. @returns CAS request. */
function decision(id: string, seq: number, operationId = 'keep') {
  return { sessionId: 'view', id, seq, revision: 0, operationId, decision: 'accepted' as const }
}
beforeAll(async () => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-official-db-')); process.env.DSH_HOME = home
  await migrateActive(cwd, null, async () => null)
})
afterAll(() => {
  closeArchiveDbs()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})
describe('official immutable ledger and decisions', () => {
  it('migrates schema and persists official hunks unchanged across close/reopen', () => {
    expect(saveSnapshot(cwd, snapshot(1, 10))).toBe(true)
    const row = reviewPage(cwd).items[0]
    expect(row).toMatchObject({ turn: 1, seq: 10, currentPath: cwd + '/a.lua', added: 1, deleted: 1 })
    closeArchiveDbs()
    expect(reviewDetail(cwd, row.id)?.diff).toEqual(snapshot(1, 10).files[0].diff)
    expect(dbFor(cwd).prepare("SELECT value FROM metadata WHERE name='schema'").get()?.value).toBe('4')
  })
  it('keeps cross-turn pending; read-only keep is idempotent and CAS conflicts stay pending', () => {
    saveSnapshot(cwd, snapshot(2, 20, 'C'))
    // 同一路径跨轮次合并成一条：锚点仍是第一次采集的轮次，差异取最新
    const merged = reviewPage(cwd).items
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ turn: 1, seq: 10, currentPath: cwd + '/a.lua', added: 1, deleted: 1 })
    const request = { ...decision(merged[0].id, merged[0].seq), revision: merged[0].revision }
    const first = decideReview(cwd, request)
    expect(first.revision).toBe(merged[0].revision + 1)
    // 同一 operationId 重放返回同一结果，不再推进 revision
    expect(decideReview(cwd, request)).toEqual(first)
    expect(() => decideReview(cwd, { ...request, operationId: 'other' })).toThrow('版本冲突')
    expect(() => decideReview(cwd, { ...request, id: 'other' })).toThrow('operationId')
    expect(reviewPage(cwd).pending).toBe(0)
  })
  it('same-turn unchanged payload carries decision; changed payload reopens; late seq cannot replace', () => {
    saveSnapshot(cwd, snapshot(2, 21, 'C'))
    // 内容完全相同的重发不重开：已判定的记录保持已判定
    expect(reviewPage(cwd, 0, true).items[0].decision).toBe('accepted')
    saveSnapshot(cwd, snapshot(2, 23, 'D'))
    // 内容真的变了：旧行丢弃，另起一条待审
    expect(reviewPage(cwd).pending).toBe(1)
    expect(saveSnapshot(cwd, snapshot(2, 22, 'late'))).toBe(false)
    expect(reviewPage(cwd).items.find((row) => row.turn === 2)?.seq).toBe(23)
    expect(() => saveSnapshot(cwd, snapshot(2, 23, 'tampered'))).toThrow('内容发生变化')
  })
  it('empty latest snapshot withdraws the merged record for that turn', () => {
    const empty = snapshot(2, 24); empty.files = []; empty.summary.files = []; empty.summary.total = 0
    saveSnapshot(cwd, empty)
    // 合并后每条路径只有一行，撤回该轮就等于撤回这一行（旧轮次不再单独留档）
    expect(reviewPage(cwd).pending).toBe(0)
    expect(reviewPage(cwd, 0, true).items.every((row) => row.current === false)).toBe(true)
  })
  it('failed staging and explicit gap preserve previous complete facts', () => {
    const broken = snapshot(1, 11); broken.files = []
    expect(() => saveSnapshot(cwd, broken)).toThrow('采集不完整')
    captureState(cwd, { sessionId: 'source', turn: 1, seq: 11, error: 'snapshot read failed' }, 'gap')
    expect(reviewPage(cwd).gaps[0].error).toBe('snapshot read failed')
    // 采集失败只记缺口，不写入任何记录，也不把当前待审带进坏状态
    expect(reviewPage(cwd).pending).toBe(0)
    expect(reviewPage(cwd, 0, true).items.some((row) => row.seq === 11)).toBe(false)
  })
  it('binary/oversized and capped official lists retain metadata and expose capability', () => {
    const capped = snapshot(3, 30); capped.summary.total = 5
    capped.files[0].diff = { kind: 'binary', path: 'a.lua', display: 'a.lua' }
    saveSnapshot(cwd, capped)
    const row = reviewPage(cwd).items[0]
    expect(reviewDetail(cwd, row.id)?.capability).toMatchObject({ keep: true, undo: false })
    expect(reviewPage(cwd).gaps.some((gap) => gap.error.includes('总计 5'))).toBe(true)
    expect(() => decideReview(cwd, { ...decision(row.id, 30, 'reject'), decision: 'rejected' })).toThrow('禁止拒绝写回')
    expect(reviewDetail(cwd, row.id)?.item.decision).toBe('pending')
  })
  it('201+ pending survive pagination, unrelated sessions and restart', () => {
    // 分页用例必须用不同路径：同一路径会被合并成一条
    for (let index = 0; index < 205; index++) {
      const next = snapshot(100 + index, 1000 + index)
      next.sessionId = 'other-source'
      next.summary.files[0].path = 'p' + index + '.lua'
      next.summary.files[0].display = 'p' + index + '.lua'
      if (next.files[0].diff.kind === 'text') {
        next.files[0].diff.path = 'p' + index + '.lua'
        next.files[0].diff.display = 'p' + index + '.lua'
      }
      next.files[0].identity = cwd + '/p' + index + '.lua'
      saveSnapshot(cwd, next)
    }
    closeArchiveDbs()
    const first = reviewPage(cwd)
    expect(first.pending).toBe(206); expect(first.items).toHaveLength(50); expect(first.nextCursor).toBe(50)
    expect(reviewPage(cwd, 200).items).toHaveLength(6)
  })
  it('navigation aggregates every pending record across pages and scopes a file detail list', () => {
    const page = reviewPage(cwd)
    expect(page.overview?.files).toHaveLength(206)
    expect(page.overview?.coveredPaths).toContain(cwd + '/a.lua')
    expect(reviewPage(cwd, 0, false, cwd + '/missing.lua').items).toEqual([])
    expect(reviewPage(cwd, 0, false, cwd + '/p0.lua').items).toHaveLength(1)
  })
  it('repairs persisted object identities without changing IDs, decisions, operations or source facts', async () => {
    const broken = snapshot(999, 9999)
    broken.files[0].identity = '[object Object]'
    saveSnapshot(cwd, broken)
    const item = reviewPage(cwd).items.find((entry) => entry.turn === 999)!
    const request = decision(item.id, 9999, 'repair-keep')
    decideReview(cwd, request)
    await repairPaths(cwd, async (workspace, path) => workspace + '/' + path)
    const fixed = reviewDetail(cwd, item.id)!
    expect(fixed.item).toMatchObject({ id: item.id, currentPath: cwd + '/a.lua', decision: 'accepted', revision: 1 })
    expect(fixed.diff).toEqual(broken.files[0].diff)
    expect(decideReview(cwd, request)).toEqual({ revision: 1 })
    expect(saveSnapshot(cwd, snapshot(999, 9999))).toBe(false)
    expect(() => saveSnapshot(cwd, snapshot(999, 9999, 'tampered'))).toThrow('内容发生变化')
    expect(reviewPage(cwd).overview?.coveredPaths).not.toContain('[object Object]')
    await repairPaths(cwd, async () => { throw new Error('must not resolve healthy history') })
  })
  it('block Keep leaves remaining blocks pending, survives reopen and rolls back invalid block requests', () => {
    const fixture = snapshot(1001, 10001)
    if (fixture.files[0].diff.kind !== 'text') throw new Error('invalid fixture')
    fixture.files[0].diff.hunks[0] = { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
      lines: ['-A', '+B', ' middle', '-C', '+D'] }
    saveSnapshot(cwd, fixture)
    const item = reviewPage(cwd).items.find((row) => row.seq === 10001)!
    const detail = reviewDetail(cwd, item.id)!
    expect(detail.blocks).toHaveLength(2)
    const request = { ...decision(item.id, 10001, 'block-keep'), scope: 'hunk' as const, blockId: detail.blocks[0].id }
    expect(decideReview(cwd, request)).toEqual({ revision: 1 })
    expect(decideReview(cwd, request)).toEqual({ revision: 1 })
    closeArchiveDbs()
    expect(reviewDetail(cwd, item.id)?.blocks.map((block) => block.decision)).toEqual(['accepted', 'pending'])
    expect(reviewDetail(cwd, item.id)?.item).toMatchObject({ decision: 'pending', revision: 1 })
    expect(() => decideReview(cwd, { ...request, revision: 1, operationId: 'invalid-block', blockId: 'missing' })).toThrow('差异块')
    expect(reviewDetail(cwd, item.id)?.item.revision).toBe(1)
    decideReview(cwd, { ...request, revision: 1, operationId: 'keep-remaining', scope: 'file' })
    expect(reviewDetail(cwd, item.id)?.blocks.every((block) => block.decision === 'accepted')).toBe(true)
    expect(reviewPage(cwd).items.some((row) => row.id === item.id)).toBe(false)
  })
  it('unknown/partial migration cannot silently become an empty official ledger', async () => {
    const other = '/official-unmigrated'
    expect(() => reviewDb(other)).toThrow('先完成活跃库迁移')
    await expect(migrateActive(other, 'broken', async () => 'broken')).rejects.toThrow('损坏')
    expect(dbFor(other).prepare("SELECT name FROM sqlite_master WHERE name='review_files'").get()).toBeUndefined()
  })
  it('batch Keep accepts the whole list once, tolerates stale revisions and skips only closed or locked rows', () => {
    const before = reviewPage(cwd)
    const targets = before.items.filter((row) => row.current && row.decision === 'pending')
    // 客户端 revision 故意全部是过期值：批量写入以库内当前状态为准
    const items = targets.map((row, index) => ({ id: row.id, seq: row.seq, revision: 900 + index, operationId: `batch-keep-${index}` }))
    const first = keepOfficialAll(cwd, items)
    expect(first.skipped).toEqual([])
    expect(first.paths).toHaveLength(targets.length)
    expect(reviewPage(cwd).pending).toBe(before.pending - targets.length)

    // 同一批次重放按操作号幂等，不再推进 revision
    const replay = keepOfficialAll(cwd, items)
    expect(replay.skipped).toEqual([])
    expect(replay.paths).toEqual(first.paths)

    const closed = keepOfficialAll(cwd, [{ ...items[0], operationId: 'batch-closed' }])
    expect(closed.paths).toEqual([])
    expect(closed.skipped[0].reason).toContain('已结案')

    // 尚待核对的 Undo 只挡住它自己的文件
    const stuck = reviewPage(cwd).items.find((row) => row.decision === 'pending')!
    dbFor(cwd).prepare("INSERT INTO review_ops VALUES(?,?,'prepared',NULL,NULL)").run('undo-pending', JSON.stringify({ id: stuck.id }))
    const blocked = keepOfficialAll(cwd, [
      { id: stuck.id, seq: stuck.seq, revision: 0, operationId: 'batch-stuck' },
      { id: 'missing', seq: 0, revision: 0, operationId: 'batch-missing' },
    ])
    expect(blocked.paths).toEqual([])
    expect(blocked.skipped.map((row) => row.reason).join()).toContain('尚待核对')
    expect(blocked.skipped.some((row) => row.reason.includes('不再是待审'))).toBe(true)
  })
})
