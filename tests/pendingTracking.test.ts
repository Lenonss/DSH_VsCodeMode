/** 差异追踪窗口：开窗、折叠、关窗、重开与覆盖集。 @author ddj 2026年11月25号 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, dbFor, migrateActive, takeActiveReset } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import { loadBlocks, loadEntries, latestApplied } from '../src/pending/persist.js'
import { applyDecide, foldTracked, loadDetail, loadPage, recordWrite, undoDecide } from '../src/pending/store.js'
import { coveredPathsOf, isOpenEntry, isTrackedPath, nextTracking } from '../src/pending/tracking.js'

let home = ''
let workspace = ''
let originalHome: string | undefined

beforeAll(() => {
  originalHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-tracking-'))
  workspace = mkdtempSync(join(tmpdir(), 'edrv-tracking-ws-'))
  process.env.DSH_HOME = home
})
beforeEach(async () => {
  closeArchiveDbs()
  rmSync(archiveDbFile(workspace), { force: true })
  await migrateActive(workspace, null, async () => null)
})
afterAll(() => {
  closeArchiveDbs()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

/** @author ddj 2026年11月25号 @description 真实文件系统，带 replaceIfVersion 版本守卫。 */
function realFs() {
  const versionOf = async (path: string): Promise<string | undefined> => {
    const info = await stat(path).catch(() => undefined)
    return info ? `${info.size}:${info.mtimeMs}` : undefined
  }
  return {
    processPath: (path: string) => path,
    resolve: async (path: string) => path,
    readBytes: async (path: string) => readFile(path),
    readText: async (path: string) => readFile(path, 'utf8'),
    stat: async (path: string) => {
      const version = await versionOf(path)
      return version === undefined ? undefined : { type: 'file', version }
    },
    writeText: vi.fn(async (path: string, text: string, expected?: { kind: string; version?: string }) => {
      if (expected?.kind === 'replaceIfVersion') {
        const version = await versionOf(path)
        if (version !== expected.version) throw Object.assign(new Error('stale'), { code: 'FS_STALE' })
      }
      await writeFile(path, text, { encoding: 'utf8', flag: expected?.kind === 'createIfAbsent' ? 'wx' : 'w' })
    }),
    deleteFile: vi.fn(async (path: string, expected?: { version?: string }) => {
      if (await versionOf(path) !== expected?.version) throw Object.assign(new Error('stale'), { code: 'FS_STALE' })
      await unlink(path)
    }),
  }
}

/** 造一次工具写入。 */
function toolWrite(file: string, before: string | null, after: string | null, now = Date.now()) {
  return { cwd: workspace, sessionId: 's1', path: file, identity: file, before, after, now, tool: 'write' }
}

/** 造一次外部折叠。 */
function externalWrite(file: string, before: string, after: string | null, now = Date.now()) {
  return {
    cwd: workspace, sessionId: 's1', path: file, identity: file, before, after, now,
    tool: 'watch', origin: 'external' as const, baseKind: 'known' as const,
  }
}

describe('窗口生命周期', () => {
  it('AI 文件工具确认改动后开窗：基线是写前内容，面板可见', async () => {
    const file = join(workspace, 'open.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(toolWrite(file, 'A', 'B', 1))

    const page = loadPage(workspace)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ path: file, tracking: 'open', openedAt: 1, settled: false })
    expect(loadDetail(workspace, file)?.diff).toMatchObject({ kind: 'text' })
    expect(isTrackedPath(workspace, file)).toBe(true)
  })

  it('窗口内再次写盘：基线不动，内容取最新，开窗时刻不变', async () => {
    const file = join(workspace, 'fold.ts')
    await writeFile(file, 'C', 'utf8')
    recordWrite(toolWrite(file, 'A', 'B', 1))
    recordWrite(toolWrite(file, 'B', 'C', 2))

    const entry = loadEntries(workspace).find((stored) => stored.entry.id === file)!
    expect(entry.entry).toMatchObject({ oldText: 'A', newText: 'C', openedAt: 1, tracking: 'open' })
  })

  it('外部改动只折进开窗文件：未开窗返回 false 且不建行', async () => {
    const untracked = join(workspace, 'untracked.ts')
    expect(foldTracked(externalWrite(untracked, 'OLD', 'NEW'))).toBe(false)
    expect(loadEntries(workspace)).toHaveLength(0)
  })

  it('外部改动折进开窗文件：基线不动、内容更新并标未读', async () => {
    const file = join(workspace, 'external.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(toolWrite(file, 'A', 'B', 1))
    expect(foldTracked(externalWrite(file, 'B', 'C'))).toBe(true)

    const entry = loadEntries(workspace).find((stored) => stored.entry.id === file)!
    expect(entry.entry).toMatchObject({ oldText: 'A', newText: 'C', tracking: 'open' })
    expect(entry.entry.unseen).toBe(true)
    expect(loadPage(workspace).items[0]!.origin).toBe('external')
  })

  it('内容回到基线时自动关窗，面板不再显示', async () => {
    const file = join(workspace, 'reverted.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(toolWrite(file, 'A', 'B', 1))
    expect(foldTracked(externalWrite(file, 'B', 'A'))).toBe(true)

    const entry = loadEntries(workspace).find((stored) => stored.entry.id === file)!
    expect(entry.entry.tracking).toBe('closed')
    expect(loadPage(workspace).items).toHaveLength(0)
  })

  it('文件级 Keep 关窗；关窗后外部改动不再复活', async () => {
    const file = join(workspace, 'keep.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(toolWrite(file, 'A', 'B', 1))
    const item = loadPage(workspace).items[0]!
    await applyDecide(realFs(), workspace, {
      sessionId: 's1', id: file, revision: item.revision, operationId: 'op-keep', decision: 'accepted', scope: 'file',
    })

    expect(loadPage(workspace).items).toHaveLength(0)
    expect(loadEntries(workspace).find((stored) => stored.entry.id === file)!.entry.tracking).toBe('closed')
    expect(foldTracked(externalWrite(file, 'B', 'UNITY'))).toBe(false)
    expect(loadEntries(workspace).find((stored) => stored.entry.id === file)!.entry.newText).toBe('B')
  })

  it('关窗后再由 AI 写盘：以这次写前内容重开，并清掉旧窗口的撤销行', async () => {
    const file = join(workspace, 'reopen.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(toolWrite(file, 'A', 'B', 1))
    const item = loadPage(workspace).items[0]!
    await applyDecide(realFs(), workspace, {
      sessionId: 's1', id: file, revision: item.revision, operationId: 'op-keep2', decision: 'accepted', scope: 'file',
    })
    expect(latestApplied(workspace)).toBeDefined()

    // 关窗后 Unity 改了文件；AI 再写时基线要取这次写前内容（UNITY），不是上一窗口的 A
    await writeFile(file, 'UNITY', 'utf8')
    recordWrite(toolWrite(file, 'UNITY', 'AI2', 5))

    const entry = loadEntries(workspace).find((stored) => stored.entry.id === file)!
    expect(entry.entry).toMatchObject({ oldText: 'UNITY', newText: 'AI2', tracking: 'open', openedAt: 5 })
    expect(latestApplied(workspace)).toBeUndefined()
    expect(loadBlocks(workspace, file)).toEqual([])
    expect(loadPage(workspace).items).toHaveLength(1)
    expect(loadPage(workspace).items[0]!.added).toBe(1)
  })

  it('撤销 Keep 会重新开窗，撤销行保留', async () => {
    const file = join(workspace, 'undo.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(toolWrite(file, 'A', 'B', 1))
    const item = loadPage(workspace).items[0]!
    await applyDecide(realFs(), workspace, {
      sessionId: 's1', id: file, revision: item.revision, operationId: 'op-k', decision: 'accepted', scope: 'file',
    })
    const move = await undoDecide(realFs(), workspace, { sessionId: 's1', direction: 'undo', operationId: 'op-u' })
    expect(move.ok).toBe(true)
    expect(loadPage(workspace).items).toHaveLength(1)
    expect(loadEntries(workspace).find((stored) => stored.entry.id === file)!.entry.tracking).toBe('open')
  })

  it('覆盖集包含已关窗路径，面板据此压住官方旧行', async () => {
    const file = join(workspace, 'cover.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(toolWrite(file, 'A', 'B', 1))
    const item = loadPage(workspace).items[0]!
    await applyDecide(realFs(), workspace, {
      sessionId: 's1', id: file, revision: item.revision, operationId: 'op-cover', decision: 'accepted', scope: 'file',
    })
    const page = loadPage(workspace)
    expect(page.items).toHaveLength(0)
    expect(page.coveredPaths).toContain(file)
    expect(coveredPathsOf(loadEntries(workspace))).toContain(file)
  })
})

describe('窗口状态纯函数', () => {
  it('净差异决定关窗，无净差异保持开窗', async () => {
    const file = join(workspace, 'state.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(toolWrite(file, 'A', 'B', 1))
    const open = loadEntries(workspace)[0]!
    expect(isOpenEntry(open.entry)).toBe(true)
    expect(nextTracking(open.entry)).toBe('open')
    // 两侧相等即视为已解决
    expect(nextTracking({ ...open.entry, oldText: 'X', newText: 'X' })).toBe('closed')
  })
})

describe('旧宿主兼容', () => {
  it('旧宿主写入的行没有开窗时刻：不在面板显示，也不接收外部改动', async () => {
    const file = join(workspace, 'legacy-row.ts')
    await writeFile(file, 'B', 'utf8')
    loadPage(workspace) // 先完成建表
    dbFor(workspace).prepare(`INSERT INTO pending_entries
      (id,path,earlier,old_text,new_text,updated_at,session_id,session_ids,tracking,opened_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(file, file, 'file', 'OLD', 'LEGACY', Date.now(), 's1', '["s1"]', 'open', 0)

    expect(loadPage(workspace).items).toHaveLength(0)
    expect(isTrackedPath(workspace, file)).toBe(false)
    expect(foldTracked(externalWrite(file, 'LEGACY', 'NEW'))).toBe(false)
  })

  it('旧宿主把 pending_schema 写回旧值后不再重复迁移', () => {
    loadPage(workspace)
    const db = dbFor(workspace)
    db.prepare("UPDATE metadata SET value='6' WHERE name='pending_schema'").run()
    expect(loadPage(workspace).items).toHaveLength(0)
    // 命中 tracking_schema 快路径：不重写 pending_schema、不清数据
    expect((db.prepare("SELECT value FROM metadata WHERE name='pending_schema'").get() as { value: string }).value).toBe('6')
    expect((db.prepare("SELECT value FROM metadata WHERE name='tracking_schema'").get() as { value: string }).value).toBe('7')
  })
})

describe('v6 库升级', () => {
  it('补窗口列并清空旧待审、官方与活跃记录，同时留下重置标记', () => {
    const db = dbFor(workspace)
    // 手工造一份 v6 形状：pending_entries 没有 tracking/opened_at
    db.exec(`CREATE TABLE IF NOT EXISTS pending_entries (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, earlier TEXT NOT NULL,
      old_text TEXT NOT NULL, new_text TEXT NOT NULL, updated_at INTEGER NOT NULL,
      unseen INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0,
      diverged INTEGER NOT NULL DEFAULT 0, oversized INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0, session_id TEXT NOT NULL,
      session_ids TEXT NOT NULL, lineage TEXT,
      source TEXT NOT NULL DEFAULT 'tool', origin TEXT NOT NULL DEFAULT 'agent',
      base_kind TEXT NOT NULL DEFAULT 'known',
      evidence TEXT NOT NULL DEFAULT 'snapshot', verdict TEXT NOT NULL DEFAULT 'changed');
      CREATE TABLE IF NOT EXISTS review_files (id TEXT PRIMARY KEY, identity TEXT, decision TEXT);`)
    db.prepare(`INSERT INTO pending_entries(id,path,earlier,old_text,new_text,updated_at,session_id,session_ids)
      VALUES(?,?,?,?,?,?,?,?)`).run('/old.ts', '/old.ts', 'file', 'A', 'B', 1, 's1', '["s1"]')
    db.prepare("INSERT INTO review_files(id,identity,decision) VALUES('r1','/old.ts','pending')").run()
    db.prepare("INSERT INTO active_records(call_id,payload,path,archived,pending,at) VALUES('c1','{}','/old.ts',0,1,'2026-01-01')").run()
    db.prepare("INSERT INTO metadata(name,value) VALUES('pending_schema','6') ON CONFLICT(name) DO UPDATE SET value='6'").run()

    expect(loadPage(workspace).items).toHaveLength(0)
    const columns = (db.prepare('PRAGMA table_info(pending_entries)').all() as Array<{ name: string }>)
      .map((column) => String(column.name))
    expect(columns).toContain('tracking')
    expect(columns).toContain('opened_at')
    expect((db.prepare('SELECT COUNT(*) AS n FROM review_files').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM active_records').get() as { n: number }).n).toBe(0)
    // 已加载进内存的记录桶靠这个标记一起清
    expect(takeActiveReset(workspace)).toBe(true)
  })
})
