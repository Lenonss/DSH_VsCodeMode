/** 归档库清理：保留期、每文件上限、未判保护与撤销栈截断。 @author ddj 2026年11月24号 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, dbFor, migrateActive } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import { pendingDb } from '../src/pending/persist.js'
import { KEEP_BATCHES, KEEP_OPS, purgeArchiveDb, RETENTION_DAYS, sweepArchives } from '../src/archivePurge.js'

let home = ''
let workspace = ''
let originalHome: string | undefined
let seq = 0

beforeAll(() => {
  originalHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-archive-purge-'))
  workspace = mkdtempSync(join(tmpdir(), 'edrv-archive-ws-'))
  process.env.DSH_HOME = home
})
beforeEach(async () => {
  closeArchiveDbs()
  rmSync(archiveDbFile(workspace), { force: true })
  rmSync(archiveDbFile(workspace) + '-wal', { force: true })
  rmSync(archiveDbFile(workspace) + '-shm', { force: true })
  await migrateActive(workspace, null, async () => null)
  pendingDb(workspace)
  seq = 0
})
afterEach(() => { closeArchiveDbs() })
afterAll(() => {
  closeArchiveDbs()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

/** 天数 → 距今的 ISO 时间。 */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

/**
 * @description: 造一个归档批次（含一条记录）。
 * @param path 文件路径
 * @param at 归档时间
 * @param opts 未判定数、记录未判定数、显式 callId
 * @returns 批次 id 与 callId
 */
function addBatch(
  path: string, at: Date,
  opts: { pending?: number; recordPending?: number; callId?: string } = {},
): { batchId: number; callId: string } {
  const db = dbFor(workspace)
  seq += 1
  const callId = opts.callId ?? 'call-' + seq
  const batchId = Number(db.prepare(`INSERT INTO batches(cwd,path,batch_key,batch,at,last_at,reason,pending,n_records)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(workspace, path, 'k' + seq, null, at.toISOString(), null, null, opts.pending ?? 0, 1).lastInsertRowid)
  db.prepare('INSERT INTO records(batch_id,call_id,payload,accepted,rejected,pending,superseded) VALUES(?,?,?,?,?,?,?)')
    .run(batchId, callId, '{"path":"' + path + '"}', 1, 0, opts.recordPending ?? 0, 0)
  return { batchId, callId }
}

/** 表内行数。 */
function countOf(table: string): number {
  return Number((dbFor(workspace).prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n)
}

describe('归档库清理', () => {
  it('超过保留期的已判定批次被删掉，近期的不动', () => {
    addBatch('a.lua', daysAgo(RETENTION_DAYS + 10))
    addBatch('a.lua', daysAgo(1))
    const outcome = purgeArchiveDb(workspace, { dryRun: false, vacuum: false })
    expect(outcome.expired).toBe(1)
    expect(outcome.removed.batches).toBe(1)
    expect(outcome.removed.records).toBe(1)
    expect(countOf('batches')).toBe(1)
    expect(countOf('records')).toBe(1)
  })

  it('还有未判定内容的旧批次整批保留', () => {
    addBatch('b.lua', daysAgo(RETENTION_DAYS + 30), { pending: 2 })
    addBatch('c.lua', daysAgo(RETENTION_DAYS + 30), { recordPending: 1 })
    const outcome = purgeArchiveDb(workspace, { dryRun: false, vacuum: false })
    expect(outcome.keptPending).toBe(2)
    expect(outcome.removed.batches).toBe(0)
    expect(countOf('batches')).toBe(2)
    expect(countOf('records')).toBe(2)
  })

  it('同一路径只留最近 K 批，超出的按时间从旧到新删', () => {
    const total = KEEP_BATCHES + 5
    for (let index = 0; index < total; index++) addBatch('d.lua', new Date(Date.now() - index * 60_000))
    const outcome = purgeArchiveDb(workspace, { dryRun: false, vacuum: false })
    expect(outcome.overCap).toBe(5)
    expect(outcome.removed.batches).toBe(5)
    expect(countOf('batches')).toBe(KEEP_BATCHES)
    const kept = dbFor(workspace).prepare('SELECT at FROM batches').all() as Array<{ at: string }>
    const times = kept.map((row) => new Date(row.at).getTime()).sort((a, b) => b - a)
    // 留下的 20 批就是最近的 20 批：最老那条不应超过第 20 新的时间
    expect(times[0]! - times[times.length - 1]!).toBeLessThan(KEEP_BATCHES * 60_000)
  })

  it('dryRun 只报数，库体一行不动', () => {
    addBatch('e.lua', daysAgo(RETENTION_DAYS + 1))
    const outcome = purgeArchiveDb(workspace, {})
    expect(outcome.expired).toBe(1)
    expect(outcome.removed).toEqual({ records: 0, batches: 0, history: 0 })
    expect(countOf('batches')).toBe(1)
  })

  it('撤销栈每条路径只有一行，清理不再按步裁剪', () => {
    const db = pendingDb(workspace)
    const add = db.prepare(`INSERT INTO pending_history(entry_id,path,kind,earlier,baseline,content,digest,wrote,state,merged_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(entry_id) DO UPDATE SET kind=excluded.kind,baseline=excluded.baseline,
        content=excluded.content,digest=excluded.digest,merged_at=excluded.merged_at`)
    add.run('entry-a', 'a.lua', 'keep', 'file', 'A', 'B', 'd1', 0, 'applied', 1)
    add.run('entry-b', 'b.lua', 'revert', 'file', 'C', 'D', 'd2', 1, 'applied', 2)
    // 同一路径重复写：主键覆盖，仍然只有一行
    add.run('entry-a', 'a.lua', 'keep', 'file', 'B', 'C', 'd3', 0, 'applied', 3)
    const before = db.prepare('SELECT COUNT(*) AS n FROM pending_history').get() as { n: number }
    expect(Number(before.n)).toBe(2)

    const ops = db.prepare('INSERT INTO pending_ops(operation_id,request,state) VALUES(?,?,?)')
    for (let index = 0; index < KEEP_OPS + 25; index++) ops.run('op-' + index, '{}', 'committed')
    const outcome = purgeArchiveDb(workspace, { dryRun: false, vacuum: false })
    expect(outcome.removed.history).toBe(0)
    const after = db.prepare('SELECT COUNT(*) AS n FROM pending_history').get() as { n: number }
    expect(Number(after.n)).toBe(2)
    const left = db.prepare('SELECT COUNT(*) AS n FROM pending_ops').get() as { n: number }
    expect(Number(left.n)).toBe(KEEP_OPS)
  })

  it('删批次时连带清掉它的撤销意图，不留孤儿行', () => {
    const doomed = addBatch('f.lua', daysAgo(RETENTION_DAYS + 1))
    const kept = addBatch('g.lua', daysAgo(1))
    const db = dbFor(workspace)
    const addIntent = db.prepare("INSERT INTO revert_intents(call_id,scope,hunk_index,state) VALUES(?,?,?,?)")
    addIntent.run(doomed.callId, 'file', 0, 'started')
    addIntent.run(kept.callId, 'file', 0, 'started')
    purgeArchiveDb(workspace, { dryRun: false, vacuum: false })
    expect(countOf('revert_intents')).toBe(1)
    const left = db.prepare('SELECT call_id FROM revert_intents').get() as { call_id: string }
    expect(left.call_id).toBe(kept.callId)
  })

  it('每日扫描能列出本机所有归档库并逐个执行', () => {
    addBatch('h.lua', daysAgo(RETENTION_DAYS + 1))
    const visited: string[] = []
    const rewrites: string[] = []
    const result = sweepArchives({
      home,
      run: (cwd) => {
        visited.push(cwd)
        return { expired: 0, overCap: 0, keptPending: 0, removed: { records: 0, batches: 0, history: 0 } }
      },
      rewrite: (jobs) => { for (const job of jobs) rewrites.push(job.file) },
    })
    expect(visited).toEqual([workspace])
    expect(result.workspaces).toBe(1)
    // 没有删到任何行就不该起重写子进程
    expect(rewrites).toEqual([])
  })

  it('删到行之后才把整库重写交给子进程', () => {
    addBatch('i.lua', daysAgo(RETENTION_DAYS + 1))
    const rewrites: string[] = []
    const result = sweepArchives({ home, rewrite: (jobs) => { for (const job of jobs) rewrites.push(job.file) } })
    expect(result.removed).toBeGreaterThan(0)
    expect(rewrites).toEqual([archiveDbFile(workspace)])
    // 进程内不再做 VACUUM：删行已完成
    expect(result.rewrites).toBe(1)
  })
})
