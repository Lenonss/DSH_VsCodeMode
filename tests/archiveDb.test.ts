import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { activeReady, activeSummary, appendArchive, closeArchiveDbs, commitActive, committedRecord, listArchives, migrateActive, pageArchives, readActive, readArchives, revertState, startReverts } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import type { ArchiveBatch, ArchiveRecord, DiffRecord } from '../src/shared/types.js'

const CWD = '/isolated-archive-test'
let home = ''
let previousHome: string | undefined

/** @author ddj 2026年09月30号 @description 创建可读回的归档记录。 */
function record(callId: string): ArchiveRecord {
  return {
    callId, toolName: 'edit', path: CWD + '/a.ts', create: false,
    callHunk: null, hunks: [{ oldText: 'old', newText: 'new' }],
    decisions: { call: 'accepted', perHunk: ['accepted'] },
    note: null, superseded: false, at: '2026-09-30T00:00:00.000Z',
    before: 'old', after: 'new', batch: 1,
    summary: { accepted: 1, rejected: 0, pending: 0, superseded: false },
  }
}

/** @author ddj 2026年09月30号 @description 创建同路径单批次归档。 */
function entry(batch: number | null, ids: string[], cwd = CWD): ArchiveBatch {
  return {
    cwd, path: cwd + '/a.ts', batch, at: '2026-09-30T00:00:00.000Z',
    reason: '已处理', records: ids.map((id) => ({ ...record(id), path: cwd + '/a.ts', batch })),
  }
}

beforeAll(() => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-archive-db-'))
  process.env.DSH_HOME = home
})
afterAll(() => {
  closeArchiveDbs()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe('SQLite archive', () => {
  it('同批追加去重且 null batch 与数字批次隔离', () => {
    expect(appendArchive(CWD, [entry(1, ['a'])])).toBe(1)
    expect(appendArchive(CWD, [entry(1, ['a', 'b']), entry(null, ['legacy'])])).toBe(1)
    expect(appendArchive(CWD, [entry(null, ['legacy'])])).toBe(0)
    const list = listArchives(CWD)
    expect(list).toHaveLength(2)
    expect(list.find((item) => item.batch === 1)).toMatchObject({ nRecords: 2, summary: { accepted: 2 } })
    expect(readArchives(CWD, CWD + '/a.ts', 1)[0].records.map((item) => item.callId)).toEqual(['a', 'b'])
    expect(readArchives(CWD)[1].batch).toBeNull()
    expect(committedRecord(CWD, 'b', CWD + '/a.ts', 1)?.decisions.call).toBe('accepted')
  })

  it('工作区元数据防哈希别名读错，新工作区完全隔离', () => {
    const other = '/another-archive-test'
    expect(listArchives(other)).toEqual([])
    expect(appendArchive(other, [entry(2, ['other'], other)])).toBe(1)
    expect(readArchives(other)[0].records[0].callId).toBe('other')
    expect(listArchives(CWD)).toHaveLength(2)
  })

  it('事务中途异常不留下半个批次，重新打开后仍能读原条目', () => {
    expect(() => appendArchive(CWD, [entry(3, ['safe']), entry(4, ['bad'], '/wrong-cwd')])).toThrow('工作区不匹配')
    expect(readArchives(CWD, CWD + '/a.ts', 3)).toEqual([])
    closeArchiveDbs()
    expect(readArchives(CWD, CWD + '/a.ts', 1)[0].records).toHaveLength(2)
  })

  it('拒绝损坏或未知 schema 的数据库，不静默回空历史', () => {
    const cwd = '/invalid-archive'
    const file = archiveDbFile(cwd)
    writeFileSync(file, 'not a sqlite database')
    expect(() => listArchives(cwd)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('not a sqlite database')
    rmSync(file)
    const db = new DatabaseSync(file)
    db.exec("CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES('schema','999'); INSERT INTO metadata VALUES('cwd','/invalid-archive')")
    db.close()
    expect(() => listArchives(cwd)).toThrow('schema/工作区不匹配')
  })

  it('数据库被另一连接锁住时抛错且不写半条，解锁后可重试', () => {
    const cwd = '/locked-archive-test'
    expect(listArchives(cwd)).toEqual([])
    const lock = new DatabaseSync(archiveDbFile(cwd), { timeout: 100 })
    lock.exec('BEGIN IMMEDIATE')
    try {
      expect(() => appendArchive(cwd, [entry(1, ['locked'], cwd)])).toThrow()
    } finally {
      lock.exec('ROLLBACK')
      lock.close()
    }
    expect(listArchives(cwd)).toEqual([])
    expect(appendArchive(cwd, [entry(1, ['unlocked'], cwd)])).toBe(1)
  })

  it('批量 Undo 状态登记具有原子性，重复索引不留下半批状态', () => {
    const callId = 'atomic-revert-start'
    expect(() => startReverts(CWD, callId, [0, 0])).toThrow()
    expect(revertState(CWD, callId, 'hunk', 0)).toBeNull()
    startReverts(CWD, callId, [0, 1])
    expect(revertState(CWD, callId, 'hunk', 0)).toBe('started')
    expect(revertState(CWD, callId, 'hunk', 1)).toBe('started')
  })

  it('迁移失败回滚，成功导入活跃记录并增量更新，不动旧归档', async () => {
    const cwd = '/migration-test'
    const rec = { ...record('migrated'), path: cwd + '/a.ts', archived: false, batch: 7,
      decisions: { call: 'pending' as const, perHunk: ['pending' as const] } }
    const source = JSON.stringify({ version: 2, updatedAt: '', workspaces: { [cwd]: { at: 1, records: { [rec.callId]: rec } } } })
    await expect(migrateActive(cwd, source, async () => 'changed')).rejects.toThrow('被修改')
    expect(await migrateActive(cwd, source, async () => source)).toHaveProperty('size', 1)
    const initial = readActive(cwd)
    expect(initial.get(rec.callId)?.batch).toBe(7)
    expect(activeSummary(cwd)).toMatchObject({ active: 1, pendingByFile: [{ path: rec.path, pending: 1 }] })
    const changed = { ...initial.get(rec.callId)!, decisions: { call: 'accepted' as const, perHunk: ['accepted' as const] } }
    commitActive(cwd, { upserts: [changed], removed: [] }, [entry(7, ['migrated'], cwd)])
    expect(readActive(cwd).get(rec.callId)?.decisions.call).toBe('accepted')
    expect(listArchives(cwd)).toHaveLength(1)
    closeArchiveDbs()
    expect(readActive(cwd).get(rec.callId)?.batch).toBe(7)
  })

  it('裁剪删除仅移除指定行并保留其他工作区和活跃记录', async () => {
    const cwd = '/active-prune-test'
    const one = { ...record('prune-old'), path: cwd + '/a.ts', archived: false } as DiffRecord
    const two = { ...record('prune-keep'), path: cwd + '/b.ts', archived: false } as DiffRecord
    const source = JSON.stringify({ version: 2, workspaces: { [cwd]: { at: 1, records: {
      [one.callId]: one, [two.callId]: two,
    } } } })
    await migrateActive(cwd, source, async () => source)
    commitActive(cwd, { upserts: [], removed: [one.callId] })
    expect([...readActive(cwd).keys()]).toEqual([two.callId])
    expect(activeSummary(cwd).active).toBe(1)
  })

  it('损坏的旧记录拒绝迁移，不把缺失决策的记录静默转成待处理', async () => {
    const cwd = '/invalid-active-record'
    const source = JSON.stringify({ version: 2, workspaces: { [cwd]: {
      at: 1, records: { broken: { callId: 'broken', path: cwd + '/a.ts', hunks: [] } },
    } } })
    await expect(migrateActive(cwd, source, async () => source)).rejects.toThrow('旧活跃记录损坏')
    expect(activeReady(cwd)).toBe(false)
  })

  it('迁移中源文件改写或数据库报错时不留半条活跃记录', async () => {
    const cwd = '/migration-rollback'
    const rec = { ...record('safe'), path: cwd + '/a.ts', archived: false } as DiffRecord
    const source = JSON.stringify({ version: 2, workspaces: { [cwd]: { at: 1, records: { safe: rec } } } })
    let reads = 0
    await expect(migrateActive(cwd, source, async () => ++reads === 1 ? source : 'changed')).rejects.toThrow('被修改')
    const db = new DatabaseSync(archiveDbFile(cwd))
    expect(db.prepare("SELECT value FROM metadata WHERE name='schema'").get()).toMatchObject({ value: '2' })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='active_records'").get()).toBeUndefined()
    db.close()
    expect(await migrateActive(cwd, source, async () => source)).toHaveProperty('size', 1)
  })

  it('分页在新增批次后不重漏、相同批次不同路径稳定排序并验证游标', () => {
    const cwd = '/paging-test'
    const first = entry(3, ['p1'], cwd)
    const second = { ...entry(3, ['p2'], cwd), path: cwd + '/b.ts' }
    const older = entry(null, ['p3'], cwd)
    appendArchive(cwd, [first, second, older])
    const p1 = pageArchives(cwd, undefined, 2)
    expect(p1.entries).toHaveLength(2)
    expect(p1.nextCursor).not.toBeNull()
    appendArchive(cwd, [entry(4, ['late'], cwd)])
    const p2 = pageArchives(cwd, p1.nextCursor!, 2)
    expect(p2.entries.map((item) => item.batch)).toEqual([null])
    expect(readArchives(cwd, cwd + '/a.ts', null).map((item) => item.batch)).toEqual([null])
    expect(p2.nextCursor).toBeNull()
    expect(pageArchives(cwd, undefined, 2).entries[0].batch).toBe(4)
    expect(() => pageArchives(cwd, 'bad', 1)).toThrow('游标无效')
    expect(() => pageArchives('/other-cwd', p1.nextCursor!, 1)).toThrow('游标无效')
    expect(() => pageArchives(cwd, undefined, 101)).toThrow('分页大小不合法')
  })

  it('18 MB 活跃记录仅更新一条，既有记录与归档保持不变（定向计时）', async () => {
    const cwd = '/bench-active'
    const payload = 'x'.repeat(90_000)
    const records: Record<string, DiffRecord> = {}
    for (let index = 0; index < 200; index++) {
      const rec = { ...record('active-' + index), path: cwd + '/a.ts', before: payload,
        archived: false, batch: index + 1, decisions: { call: 'pending' as const, perHunk: ['pending' as const] } }
      records[rec.callId] = rec
    }
    const source = JSON.stringify({ version: 2, workspaces: { [cwd]: { at: 1, records } } })
    const start = performance.now()
    await migrateActive(cwd, source, async () => source)
    const migrated = performance.now()
    const rec = { ...records['active-100'], decisions: { call: 'accepted' as const, perHunk: ['accepted' as const] } }
    const batch = entry(101, ['active-100'], cwd)
    batch.records[0].decisions = rec.decisions
    batch.records[0].summary = { accepted: 1, rejected: 0, pending: 0, superseded: false }
    commitActive(cwd, { upserts: [rec], removed: [] }, [batch])
    const committed = performance.now()
    expect(activeSummary(cwd).active).toBe(200)
    expect(readActive(cwd).get('active-101')?.decisions.call).toBe('pending')
    expect(readActive(cwd).get('active-100')?.decisions.call).toBe('accepted')
    expect(listArchives(cwd)).toHaveLength(1)
    console.log(`activeDb bytes=${source.length} records=200 migrateMs=${(migrated - start).toFixed(1)} oneKeepMs=${(committed - migrated).toFixed(1)} rssMB=${(process.memoryUsage().rss / 1048576).toFixed(1)}`)
  }, 15_000)

  it('高批次数下列表/单次追加不读取旧历史记录全文（定向计时）', () => {
    const cwd = '/bench-archive'
    const payload = 'x'.repeat(151_000)
    const start = performance.now()
    for (let offset = 0; offset < 2305; offset += 64) {
      const batches = Array.from({ length: Math.min(64, 2305 - offset) }, (_, index) => {
        const number = offset + index + 1
        const batch = entry(number, ['bench-' + number], cwd)
        batch.records[0].before = payload
        return batch
      })
      appendArchive(cwd, batches)
    }
    const seeded = performance.now()
    expect(listArchives(cwd)).toHaveLength(2305)
    const listed = performance.now()
    appendArchive(cwd, [entry(2306, ['latest'], cwd)])
    const appended = performance.now()
    expect(readArchives(cwd, cwd + '/a.ts', 2306)[0].records[0].callId).toBe('latest')
    const detailStart = performance.now()
    expect(readArchives(cwd, cwd + '/a.ts', 1152)[0].records[0].before).toBe(payload)
    const detailMs = performance.now() - detailStart
    const path = archiveDbFile(cwd)
    const bytes = statSync(path).size + (existsSync(path + '-wal') ? statSync(path + '-wal').size : 0)
    console.log(`archiveDb batches=2305 payloadBytes=${2305 * payload.length} dbBytes=${bytes} seedMs=${(seeded - start).toFixed(1)} listMs=${(listed - seeded).toFixed(1)} appendMs=${(appended - listed).toFixed(1)} detailMs=${detailMs.toFixed(1)} rssMB=${(process.memoryUsage().rss / 1048576).toFixed(1)}`)
  }, 15_000)
})
