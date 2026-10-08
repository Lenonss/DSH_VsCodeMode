import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeArchiveDbs, commitActive, listArchives, migrateActive, readArchives, revertState } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import { buildHandlers } from '../src/rpc.js'
import { loadBucket } from '../src/store.js'
import type { DiffRecord } from '../src/shared/types.js'

const CWD = '/archive-rpc-test'
const FILE = CWD + '/a.ts'
const SIDECAR = CWD + '/.dsh-edit-review.json'
const LEGACY = CWD + '/.dsh-edit-review-archive.json'
let home = ''
let originalHome: string | undefined

/** @author ddj 2026年09月30号 @description 记录侧车测试使用的完整待决策数据。 */
function record(): DiffRecord {
  return {
    callId: 'decision-1', toolName: 'edit', path: FILE, before: 'old', after: 'new',
    create: false, callHunk: null, hunks: [{ oldText: 'old', newText: 'new' }],
    decisions: { call: 'pending', perHunk: ['pending'] }, note: null,
    superseded: false, archived: false, batch: 1, at: '2026-09-30T00:00:00.000Z',
  }
}

/** @author ddj 2026年09月30号 @description 创建内存 fs 并可控制仅 sidecar 写入失败。 */
function fakeFs(failSidecar = false) {
  const files = new Map<string, string>([[FILE, 'new'], [LEGACY, JSON.stringify({ version: 1, batches: [{ cwd: CWD, path: FILE, batch: 99, records: [] }] })]])
  const fs = {
    resolve: vi.fn(async (path: string, opts?: { cwd?: string }) => path.startsWith('/') ? path : (opts?.cwd ?? CWD) + '/' + path),
    readText: vi.fn(async (path: string): Promise<string> => {
      if (!files.has(path)) throw new Error('not found')
      return files.get(path)!
    }),
    writeText: vi.fn(async (path: string, text: string): Promise<void> => {
      if (path === SIDECAR && failSidecar) throw new Error('sidecar denied')
      files.set(path, text)
    }),
    stat: vi.fn(async (path: string) => files.has(path)
      ? { type: 'file', size: files.get(path)!.length, version: String(files.get(path)!.length) + ':' + files.get(path)!.slice(0, 16) } : undefined),
  }
  return { fs, files }
}

/** @author ddj 2026年09月30号 @description 构造真实 RPC session 形状。 */
function fakeCtx(fs: ReturnType<typeof fakeFs>['fs']): any {
  const session = { id: 's1', header: { cwd: CWD } }
  return { get: (name: string) => name === 'fs' ? fs : name === 'sessions'
    ? { get: () => session, list: () => [session] } : undefined }
}

beforeAll(() => {
  originalHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-archive-rpc-'))
  process.env.DSH_HOME = home
})
beforeEach(async () => {
  closeArchiveDbs()
  rmSync(archiveDbFile(CWD), { force: true })
  await migrateActive(CWD, null, async () => null)
})
afterAll(() => {
  closeArchiveDbs()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

describe('SQLite archive RPC', () => {
  it('旧 JSON 保留且不读入新列表；详情仅取目标路径，批次回滚可恢复', async () => {
    const { fs, files } = fakeFs()
    const ctx = fakeCtx(fs)
    const rec = record()
    const handlers = buildHandlers(ctx, new Map([[CWD, new Map([[rec.callId, rec]])]]))
    const empty = await handlers['edrv.archiveList']({ sessionId: 's1' })
    expect(empty.ok && empty.entries).toEqual([])
    const accepted = await handlers['edrv.accept']({ sessionId: 's1', callId: rec.callId, scope: 'call' })
    expect(accepted.ok).toBe(true)
    const list = await handlers['edrv.archiveList']({ sessionId: 's1' })
    expect(list.ok && list.entries.map((item) => item.batch)).toEqual([1])
    const read = await handlers['edrv.archiveRead']({ sessionId: 's1', path: FILE })
    expect(read.ok && read.batches[0].records[0].callId).toBe(rec.callId)
    expect(files.get(LEGACY)).toContain('"batch":99')
    const reverted = await handlers['edrv.rollback']({ sessionId: 's1', path: FILE, batch: 1 })
    expect(reverted.ok).toBe(true)
    expect(files.get(FILE)).toBe('old')
    expect(readArchives(CWD, FILE, 1)[0].records).toHaveLength(1)
  })

  it('同一次决策内不同文件的相同批次分别归档并可按路径查询', async () => {
    const { fs } = fakeFs()
    const first = record()
    first.callId = 'file-one'
    first.batch = 3
    const second = record()
    second.callId = 'file-two'
    second.batch = 3
    second.path = CWD + '/b.ts'
    const bucket = new Map([[first.callId, first], [second.callId, second]])
    const handlers = buildHandlers(fakeCtx(fs), new Map([[CWD, bucket]]))
    const outcome = await handlers['edrv.decideBatch']({ sessionId: 's1', items: [first, second].map((rec) => ({
      callId: rec.callId, scope: 'call' as const, decision: 'accepted' as const,
    })) })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results.map((item) => item.ok)).toEqual([true, true])
    expect(fs.readText.mock.calls.filter(([path]: [string]) => path === SIDECAR)).toHaveLength(0)
    expect(readArchives(CWD, first.path, 3)[0].records.map((rec) => rec.callId)).toEqual([first.callId])
    expect(readArchives(CWD, second.path, 3)[0].records.map((rec) => rec.callId)).toEqual([second.callId])
  })

  it('旧 JSON 含历史但 SQLite 尚空时不误归档活跃记录', async () => {
    const { fs, files } = fakeFs()
    const ctx = fakeCtx(fs)
    const rec = record()
    rec.callId = 'legacy-stays-pending'
    closeArchiveDbs()
    rmSync(archiveDbFile(CWD), { force: true })
    files.set(SIDECAR, JSON.stringify({ version: 2, updatedAt: '', workspaces: {
      [CWD]: { at: 1, records: { [rec.callId]: rec } },
    } }))
    const bucket = await loadBucket(ctx, CWD)
    expect(bucket.get(rec.callId)).toMatchObject({ archived: false, decisions: { perHunk: ['pending'] } })
    expect(files.get(LEGACY)).toContain('"batch":99')
  })

  it('旧 Host 在迁移后写入 sidecar 时拒绝决策，不静默分叉', async () => {
    const { fs, files } = fakeFs()
    const rec = record()
    rec.callId = 'drift-guard'
    const source = JSON.stringify({ version: 2, workspaces: { [CWD]: { at: 1, records: { [rec.callId]: rec } } } })
    closeArchiveDbs()
    rmSync(archiveDbFile(CWD), { force: true })
    files.set(SIDECAR, source)
    const ctx = fakeCtx(fs)
    const bucket = await loadBucket(ctx, CWD)
    files.set(SIDECAR, source + ' ')
    const result = await buildHandlers(ctx, new Map([[CWD, bucket]]))['edrv.accept']({
      sessionId: 's1', callId: rec.callId, scope: 'call',
    })
    expect(result.ok).toBe(false)
    expect(readArchives(CWD, FILE)).toEqual([])
  })

  it('数据库事务被锁住时 Keep 报错、记录继续待处理且旧 JSON 不变', async () => {
    const { fs, files } = fakeFs()
    const rec = record()
    rec.callId = 'locked-keep'
    const handlers = buildHandlers(fakeCtx(fs), new Map([[CWD, new Map([[rec.callId, rec]])]]))
    expect(listArchives(CWD)).not.toBeNull()
    const lock = new DatabaseSync(archiveDbFile(CWD))
    lock.exec('BEGIN IMMEDIATE')
    try {
      const outcome = await handlers['edrv.accept']({ sessionId: 's1', callId: rec.callId, scope: 'call' })
      expect(outcome.ok).toBe(false)
      expect(rec.archived).toBe(false)
      expect(rec.decisions.call).toBe('accepted')
      expect(files.get(LEGACY)).toContain('"batch":99')
    } finally {
      lock.exec('ROLLBACK')
      lock.close()
    }
    const retry = await handlers['edrv.accept']({ sessionId: 's1', callId: rec.callId, scope: 'call' })
    expect(retry.ok).toBe(true)
    expect(rec.archived).toBe(true)
  })

  it('Undo 写文件后状态库被锁：标记不确定，重启禁止再次反替换', async () => {
    const { fs, files } = fakeFs()
    const rec = record()
    rec.callId = 'undo-lock'
    const ctx = fakeCtx(fs)
    commitActive(CWD, { upserts: [rec], removed: [] })
    const db = new DatabaseSync(archiveDbFile(CWD))
    const originalWrite = fs.writeText.getMockImplementation()!
    fs.writeText.mockImplementation(async (path: string, text: string) => {
      await originalWrite(path, text)
      if (path === FILE) db.exec('BEGIN IMMEDIATE')
    })
    try {
      const failed = await buildHandlers(ctx, new Map([[CWD, new Map([[rec.callId, rec]])]]))['edrv.reject']({
        sessionId: 's1', callId: rec.callId, scope: 'hunk', hunkIndex: 0,
      })
      expect(failed.ok).toBe(false)
      expect(files.get(FILE)).toBe('old')
      expect(files.has(SIDECAR)).toBe(false)
      expect(rec.decisions.perHunk).toEqual(['pending'])
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK')
      db.close()
    }
    expect(revertState(CWD, rec.callId, 'hunk', 0)).toBe('started')
    const resumed = await loadBucket(ctx, CWD)
    const again = await buildHandlers(ctx, new Map([[CWD, resumed]]))['edrv.reject']({
      sessionId: 's1', callId: rec.callId, scope: 'hunk', hunkIndex: 0,
    })
    expect(again.ok).toBe(false)
    expect(again.error).toContain('人工核对')
    expect(files.get(FILE)).toBe('old')
    expect(fs.writeText.mock.calls.filter(([path]: [string]) => path === FILE)).toHaveLength(1)
  })

  it('Undo 成功但归档事务失败：重启恢复 applied 并安全补归档', async () => {
    const { fs, files } = fakeFs()
    const rec = record()
    rec.callId = 'undo-archive-failure'
    const ctx = fakeCtx(fs)
    commitActive(CWD, { upserts: [rec], removed: [] })
    const db = new DatabaseSync(archiveDbFile(CWD))
    db.exec("CREATE TRIGGER deny_archive BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT, 'archive denied'); END")
    try {
      const failed = await buildHandlers(ctx, new Map([[CWD, new Map([[rec.callId, rec]])]]))['edrv.reject']({
        sessionId: 's1', callId: rec.callId, scope: 'hunk', hunkIndex: 0,
      })
      expect(failed.ok).toBe(false)
      expect(files.get(FILE)).toBe('old')
      expect(revertState(CWD, rec.callId, 'hunk', 0)).toBe('applied')
    } finally {
      db.exec('DROP TRIGGER deny_archive')
      db.close()
    }
    const resumed = await loadBucket(ctx, CWD)
    expect(resumed.get(rec.callId)?.decisions.perHunk).toEqual(['rejected'])
    const again = await buildHandlers(ctx, new Map([[CWD, resumed]]))['edrv.reject']({
      sessionId: 's1', callId: rec.callId, scope: 'hunk', hunkIndex: 0,
    })
    expect(again.ok).toBe(true)
    expect(files.get(FILE)).toBe('old')
    expect(fs.writeText.mock.calls.filter(([path]: [string]) => path === FILE)).toHaveLength(1)
    expect(readArchives(CWD, FILE, 1)[0].records.map((item) => item.callId)).toContain(rec.callId)
    expect(revertState(CWD, rec.callId, 'hunk', 0)).toBeNull()
  })

  it('DB 归档与活跃行原子提交，重启后重复 Undo 不再反替换', async () => {
    const { fs, files } = fakeFs()
    const ctx = fakeCtx(fs)
    const rec = record()
    rec.callId = 'decision-crash'
    // 旧文件不存在的工作区已初始化；新记录只进 SQLite。
    commitActive(CWD, { upserts: [rec], removed: [] })
    const handlers = buildHandlers(ctx, new Map([[CWD, new Map([[rec.callId, rec]])]]))
    const outcome = await handlers['edrv.reject']({ sessionId: 's1', callId: rec.callId, scope: 'hunk', hunkIndex: 0 })
    expect(outcome.ok).toBe(true)
    expect(files.get(FILE)).toBe('old')
    expect(rec.archived).toBe(true)
    expect(readArchives(CWD, FILE, 1)[0].records.some((item) => item.callId === rec.callId)).toBe(true)
    const resumed = await loadBucket(ctx, CWD)
    expect(resumed.get(rec.callId)).toMatchObject({ archived: true, decisions: { perHunk: ['rejected'] } })
    expect(files.has(SIDECAR)).toBe(false) // 不生成新 sidecar
    const resumedHandlers = buildHandlers(ctx, new Map([[CWD, resumed]]))
    const again = await resumedHandlers['edrv.reject']({ sessionId: 's1', callId: rec.callId, scope: 'hunk', hunkIndex: 0 })
    expect(again.ok).toBe(false)
    expect(files.get(FILE)).toBe('old')
  })
})
