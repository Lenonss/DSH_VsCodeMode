/** 待审清库：dryRun、筛选口径与「有判定历史的保留」。 @author ddj 2026年11月24号 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import { loadEntries } from '../src/pending/persist.js'
import { applyDecide, loadPage, purgePending, recordWrite } from '../src/pending/store.js'
import { windows } from '../src/pending/provenance.js'
import { disposeIndex } from '../src/treeIndex.js'

let home = ''
let workspace = ''
let originalHome: string | undefined

beforeAll(() => {
  originalHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-purge-'))
  workspace = mkdtempSync(join(tmpdir(), 'edrv-purge-ws-'))
  process.env.DSH_HOME = home
})
beforeEach(async () => {
  closeArchiveDbs()
  rmSync(archiveDbFile(workspace), { force: true })
  await migrateActive(workspace, null, async () => null)
  windows.dispose()
})
afterEach(() => { windows.dispose(); disposeIndex(workspace) })
afterAll(() => {
  closeArchiveDbs()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

/** 真实文件系统桩（撤写校验用；本文件只用到版本守卫）。 */
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
    writeText: vi.fn(async (path: string, text: string) => { await writeFile(path, text, 'utf8') }),
    deleteFile: vi.fn(async (path: string) => { await unlink(path) }),
  }
}

/**
 * @description: 造一条 watch 通道的幽灵记录（改前内容缺失）。
 * @param name 文件名
 * @returns 绝对路径
 */
function ghost(name: string): string {
  const path = join(workspace, name)
  recordWrite({ cwd: workspace, sessionId: 's1', path, identity: path, before: null, after: 'WHOLE FILE', now: Date.now(), tool: 'watch', origin: 'external' })
  return path
}

describe('待审清库', () => {
  it('dryRun 只报命中数，不删任何条目', () => {
    ghost('a.lua')
    ghost('b.lua')
    const outcome = purgePending(workspace, {}, { dryRun: true })
    expect(outcome).toMatchObject({ matched: 2, removed: 0 })
    expect(loadEntries(workspace)).toHaveLength(2)
  })

  it('默认只清 watch 通道的空基线条目，不动工具通道的记录', () => {
    ghost('a.lua')
    const toolPath = join(workspace, 'b.lua')
    recordWrite({ cwd: workspace, sessionId: 's1', path: toolPath, identity: toolPath, before: 'OLD', after: 'NEW', now: Date.now(), tool: 'write' })

    const outcome = purgePending(workspace, {}, { vacuum: false })
    expect(outcome).toMatchObject({ matched: 1, removed: 1, kept: 0 })
    const left = loadEntries(workspace).map((item) => item.entry.id)
    expect(left).toEqual([toolPath])
    expect(loadPage(workspace).items).toHaveLength(1)
  })

  it('已判定过的条目保留，并在回执里单独计数', async () => {
    const fs = realFs()
    const kept = ghost('kept.lua')
    ghost('gone.lua')
    await writeFile(kept, 'WHOLE FILE', 'utf8')
    const revision = loadEntries(workspace).find((item) => item.entry.id === kept)!.flags.revision
    const decided = await applyDecide(fs as never, workspace, {
      sessionId: 's1', id: kept, revision, operationId: 'op-keep', decision: 'accepted', scope: 'file',
    })
    expect(decided.ok, JSON.stringify(decided)).toBe(true)

    const outcome = purgePending(workspace, {}, { vacuum: false })
    expect(outcome).toMatchObject({ matched: 1, removed: 1, kept: 1 })
    expect(loadEntries(workspace).map((item) => item.entry.id)).toEqual([kept])
  })

  it('按通道与时间窗筛选：早于窗外的记录不动', () => {
    const path = join(workspace, 'later.lua')
    recordWrite({ cwd: workspace, sessionId: 's1', path, identity: path, before: null, after: 'X', now: Date.now(), tool: 'watch', origin: 'external' })
    const outcome = purgePending(workspace, { before: Date.now() - 60_000 }, { dryRun: true })
    expect(outcome.matched).toBe(0)
    expect(loadEntries(workspace)).toHaveLength(1)
  })

  it('没有命中时不触发 VACUUM，回执里没有耗时', () => {
    const outcome = purgePending(workspace, {}, { vacuum: true })
    expect(outcome).toMatchObject({ matched: 0, removed: 0 })
    expect(outcome.vacuumMs).toBeUndefined()
  })
})
