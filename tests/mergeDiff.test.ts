/** 合并语义验收：同一路径改多少次都只有一条差异、一条撤销行。 @author ddj 2026年11月25号 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import { applyDecide, loadDetail, loadPage, recordWrite, undoDecide } from '../src/pending/store.js'
import { pendingDb } from '../src/pending/persist.js'

let home = ''
let workspace = ''
let originalHome: string | undefined

beforeAll(() => {
  originalHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-merge-'))
  workspace = mkdtempSync(join(tmpdir(), 'edrv-merge-ws-'))
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

/** @description 真实文件系统，带 replaceIfVersion 版本守卫。 */
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
      if (expected?.kind === 'replaceIfVersion' && await versionOf(path) !== expected.version) {
        throw Object.assign(new Error('stale'), { code: 'FS_STALE' })
      }
      await writeFile(path, text, { encoding: 'utf8', flag: expected?.kind === 'createIfAbsent' ? 'wx' : 'w' })
    }),
    deleteFile: vi.fn(async (path: string, expected?: { version?: string }) => {
      if (await versionOf(path) !== expected?.version) throw Object.assign(new Error('stale'), { code: 'FS_STALE' })
      await unlink(path)
    }),
  }
}

/** @description 造一条采集写入。 */
function write(file: string, before: string | null, after: string | null, now: number) {
  return { cwd: workspace, sessionId: 's1', path: file, identity: file, before, after, now }
}

/** @description 撤销行条数（一条路径一行）。 */
function historyCount(): number {
  const row = pendingDb(workspace).prepare('SELECT COUNT(*) AS n FROM pending_history').get() as { n: number }
  return Number(row.n)
}

describe('v5 撤销栈迁移', () => {
  it('旧的多行快照折成每条路径一行', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    closeArchiveDbs()
    rmSync(archiveDbFile(workspace), { force: true })
    await migrateActive(workspace, null, async () => null)
    const raw = new DatabaseSync(archiveDbFile(workspace))
    raw.exec(`CREATE TABLE pending_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entry_id TEXT,
      snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'applied')`)
    raw.exec("INSERT INTO metadata(name,value) VALUES('pending_schema','5') ON CONFLICT(name) DO UPDATE SET value='5'")
    const snapshot = JSON.stringify({
      before: { entry: { oldText: 'OLD', newText: 'NEW', earlierVersion: 'file', path: 'p.ts' }, flags: {}, blocks: [] },
      after: { entry: { oldText: 'NEW', newText: 'NEW' }, flags: {}, blocks: [] },
      wrote: false,
    })
    const add = raw.prepare('INSERT INTO pending_history(kind,entry_id,snapshot,created_at) VALUES(?,?,?,?)')
    add.run('decide', 'entry-a', snapshot, 1)
    add.run('decide', 'entry-a', snapshot, 2)
    add.run('decide', 'entry-b', snapshot, 3)
    raw.close()

    const db = pendingDb(workspace)
    const rows = db.prepare('SELECT entry_id,kind,baseline,content FROM pending_history ORDER BY entry_id').all() as Array<Record<string, string>>
    expect(rows.map((row) => row.entry_id)).toEqual(['entry-a', 'entry-b'])
    expect(rows[0]).toMatchObject({ kind: 'keep', baseline: 'OLD', content: 'NEW' })
  })
})

describe('合并式差异', () => {
  it('同一段代码改三次仍然只有一条差异', async () => {
    const file = join(workspace, 'merge.ts')
    await writeFile(file, 'line1\nline2\n', 'utf8')
    recordWrite(write(file, 'line1\n', 'line1\nline2\n', 1))
    recordWrite(write(file, 'line1\nline2\n', 'line1\nline2\nline3\n', 2))
    recordWrite(write(file, 'line1\nline2\nline3\n', 'line1\nline2\nline3\nline4\n', 3))

    const page = loadPage(workspace, 's1')
    expect(page.items).toHaveLength(1)
    const item = page.items[0]!
    // 基线留在第一次修改之前，当前内容是最新一次
    const detail = loadDetail(workspace, item.id)!
    expect(detail.diff.kind).toBe('text')
    expect(detail.item.added).toBe(3)
    expect(detail.item.deleted).toBe(0)
    // 三次修改合并成一条记录，不是三条
    expect(pendingDb(workspace).prepare('SELECT COUNT(*) AS n FROM pending_entries').get()).toMatchObject({ n: 1 })
  })

  it('Keep 之后的新改动相对新基线继续累积，仍然只有一条', async () => {
    const file = join(workspace, 'keep-then-edit.ts')
    await writeFile(file, 'a\n', 'utf8')
    recordWrite(write(file, '', 'a\n', 1))
    const first = loadPage(workspace, 's1').items[0]!
    await applyDecide(realFs(), workspace, {
      sessionId: 's1', id: first.id, revision: first.revision, operationId: 'keep-1', decision: 'accepted', scope: 'file',
    })
    expect(loadPage(workspace, 's1').pending).toBe(0)

    // 采纳之后又改了一次：新差异相对「采纳后的基线」，条目仍只有一条
    recordWrite(write(file, 'a\n', 'a\nb\n', 2))
    const page = loadPage(workspace, 's1')
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.added).toBe(1)
    expect(page.items[0]!.deleted).toBe(0)
  })

  it('撤销行一条路径一行，重复判定覆盖写而不是堆叠', async () => {
    const file = join(workspace, 'history.ts')
    // 新建文件：基线为「不存在」，Revert 的语义就是删除
    recordWrite(write(file, null, 'x\n', 1))
    await writeFile(file, 'x\n', 'utf8')
    const item = loadPage(workspace, 's1').items[0]!
    const fs = realFs()
    expect(historyCount()).toBe(0)

    await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'k1', decision: 'rejected', scope: 'file',
    })
    expect(historyCount()).toBe(1)
    expect(await readFile(file, 'utf8').catch(() => null)).toBe(null)

    // 再判一次：仍是一行，记录的是最近一次判定
    const again = loadPage(workspace, 's1').items[0]
    if (again) {
      await applyDecide(fs, workspace, {
        sessionId: 's1', id: again.id, revision: again.revision, operationId: 'k2', decision: 'accepted', scope: 'file',
      })
    }
    expect(historyCount()).toBe(1)

    // 撤销最近一次判定：回到该次判定前的状态，且不需要多步
    const move = await undoDecide(fs, workspace, { sessionId: 's1', direction: 'undo', operationId: 'u1' })
    expect(move.ok).toBe(true)
  })

  it('块身份随内容稳定：行号整体下移也不换 id', async () => {
    const file = join(workspace, 'shift.ts')
    await writeFile(file, 'a\nb\n', 'utf8')
    recordWrite(write(file, 'a\n', 'a\nb\n', 1))
    const before = loadDetail(workspace, loadPage(workspace, 's1').items[0]!.id)!.blocks[0]!.id

    // 前面插入一行，块内容不变：指纹相同，索引位不同
    await writeFile(file, 'x\na\nb\n', 'utf8')
    recordWrite(write(file, 'a\nb\n', 'x\na\nb\n', 2))
    const after = loadDetail(workspace, loadPage(workspace, 's1').items[0]!.id)!
    const sameBlock = after.blocks.find((block) => block.id.split(':')[1] === before.split(':')[1])
    expect(sameBlock).toBeDefined()
  })
})
