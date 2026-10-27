import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, dbFor, migrateActive } from '../src/archiveDb.js'
import { captureState, decideReview, repairPaths, reviewDb, reviewDetail, reviewPage, saveSnapshot } from '../src/reviewDb.js'
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
    expect(reviewPage(cwd).pending).toBe(2)
    const second = reviewPage(cwd).items.find((row) => row.turn === 2)!
    const request = decision(second.id, 20)
    expect(decideReview(cwd, request)).toEqual({ revision: 1 })
    expect(decideReview(cwd, request)).toEqual({ revision: 1 })
    expect(() => decideReview(cwd, { ...request, operationId: 'other' })).toThrow('版本冲突')
    expect(() => decideReview(cwd, { ...request, id: 'other' })).toThrow('operationId')
    expect(reviewPage(cwd).items.map((row) => row.turn)).toEqual([1])
  })
  it('same-turn unchanged payload carries decision; changed payload reopens; late seq cannot replace', () => {
    saveSnapshot(cwd, snapshot(2, 21, 'C'))
    expect(reviewPage(cwd, 0, true).items[0].decision).toBe('accepted')
    saveSnapshot(cwd, snapshot(2, 23, 'D'))
    expect(reviewPage(cwd).pending).toBe(2)
    expect(saveSnapshot(cwd, snapshot(2, 22, 'late'))).toBe(false)
    expect(reviewPage(cwd).items.find((row) => row.turn === 2)?.seq).toBe(23)
    expect(() => saveSnapshot(cwd, snapshot(2, 23, 'tampered'))).toThrow('内容发生变化')
  })
  it('empty latest snapshot withdraws only that turn, retains old facts and other pending', () => {
    const empty = snapshot(2, 24); empty.files = []; empty.summary.files = []; empty.summary.total = 0
    saveSnapshot(cwd, empty)
    expect(reviewPage(cwd).pending).toBe(1)
    expect(reviewPage(cwd, 0, true).items.find((row) => row.seq === 23)?.current).toBe(false)
  })
  it('failed staging and explicit gap preserve previous complete facts', () => {
    const broken = snapshot(1, 11); broken.files = []
    expect(() => saveSnapshot(cwd, broken)).toThrow('采集不完整')
    captureState(cwd, { sessionId: 'source', turn: 1, seq: 11, error: 'snapshot read failed' }, 'gap')
    expect(reviewPage(cwd).gaps[0].error).toBe('snapshot read failed')
    expect(reviewPage(cwd).items[0].seq).toBe(10)
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
    for (let index = 0; index < 205; index++) {
      const next = snapshot(100 + index, 1000 + index)
      next.sessionId = 'other-source'; saveSnapshot(cwd, next)
    }
    closeArchiveDbs()
    const first = reviewPage(cwd)
    expect(first.pending).toBe(207); expect(first.items).toHaveLength(50); expect(first.nextCursor).toBe(50)
    expect(reviewPage(cwd, 200).items).toHaveLength(7)
  })
  it('navigation aggregates every pending record across pages and scopes a file detail list', () => {
    const page = reviewPage(cwd)
    expect(page.overview?.files).toEqual([{ sourceKind: 'official', path: cwd + '/a.lua', label: 'a.lua', pending: 207 }])
    expect(page.overview?.coveredPaths).toContain(cwd + '/a.lua')
    expect(reviewPage(cwd, 0, false, cwd + '/missing.lua').items).toEqual([])
    expect(reviewPage(cwd, 0, false, cwd + '/a.lua').items).toHaveLength(50)
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
})
