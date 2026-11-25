/** 差异窗口端到端：真实 SQLite + 真实文件，显式 flush 驱动。 @author ddj 2026年11月25号 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import { loadEntries } from '../src/pending/persist.js'
import { applyDecide, foldTracked, loadPage, recordWrite } from '../src/pending/store.js'
import { installExternalCapture } from '../src/pending/externalCapture.js'
import { windows } from '../src/pending/provenance.js'
import { rawReviewFile, rawText } from '../src/reviewEvidence.js'
import type { PendingWrite } from '../src/pending/capture.js'
import { pendingGaps } from '../src/pending/capture.js'
import { disposeIndex } from '../src/treeIndex.js'

let home = ''
let workspace = ''
let originalHome: string | undefined

beforeAll(() => {
  originalHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-ext-capture-'))
  workspace = mkdtempSync(join(tmpdir(), 'edrv-ext-ws-'))
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

/** 真实文件系统 + 版本守卫（与 pendingStore 用例同口径）。 */
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

/**
 * @description: 端到端夹具：真读盘（严格 UTF-8 往返）、真待审库、真实折叠入口。
 * @returns 跟随器、fs 与折入记录
 */
function harness() {
  const fs = realFs()
  const writes: PendingWrite[] = []
  const capture = installExternalCapture({
    ctx: { get: () => undefined } as never,
    settings: () => ({ watch: true, scan: false }),
    fold: (write) => { writes.push(write); return foldTracked(write) },
    read: async (_cwd, absolute) => {
      try {
        const bytes = await readFile(absolute)
        // 与生产一致：严格 UTF-8 往返，非文本直接抛错由调用点记缺口
        return rawText(rawReviewFile(bytes))
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return null
        throw error
      }
    },
    entries: () => loadEntries(workspace),
  })
  return { capture, fs, writes }
}

/** 用工具链路开一个窗口（模拟 edit/write 已经采过）。 */
function openWindow(path: string, before: string, after: string): void {
  recordWrite({ cwd: workspace, sessionId: 's1', path, identity: path, before, after, now: Date.now(), tool: 'write' })
}

describe('差异窗口端到端', () => {
  it('窗口内的外部写盘折进同一条，撤销恢复窗口基线', async () => {
    const file = join(workspace, 'a.txt')
    await writeFile(file, 'TOOL\n', 'utf8')
    openWindow(file, 'ORIGINAL\n', 'TOOL\n')
    const { capture, fs } = harness()

    await writeFile(file, 'UNITY\n', 'utf8')
    capture.enqueue(workspace, file)
    await capture.flush()

    const stored = loadEntries(workspace).filter((item) => item.entry.id === file)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.entry).toMatchObject({ oldText: 'ORIGINAL\n', newText: 'UNITY\n', tracking: 'open' })
    expect(loadPage(workspace).items[0]!.source).toBe('write')

    const result = await applyDecide(fs as never, workspace, {
      sessionId: 's1', id: file, revision: stored[0]!.flags.revision, operationId: 'op-1', decision: 'rejected', scope: 'file',
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('ORIGINAL\n')
  })

  it('没被工具动过的文件：外部写盘不产生任何记录', async () => {
    const file = join(workspace, 'index.json')
    await writeFile(file, 'UNITY\n', 'utf8')
    const { capture } = harness()
    capture.enqueue(workspace, file)
    await capture.flush()
    expect(loadEntries(workspace)).toHaveLength(0)
    expect(loadPage(workspace).items).toHaveLength(0)
  })

  it('连续 5 次外部写入只折成一条，内容取最新', async () => {
    const file = join(workspace, 'b.txt')
    await writeFile(file, 'V0', 'utf8')
    openWindow(file, 'OLD', 'V0')
    const { capture } = harness()
    for (let index = 1; index <= 5; index++) {
      await writeFile(file, 'V' + index, 'utf8')
      capture.enqueue(workspace, file)
    }
    await capture.flush()
    const entries = loadEntries(workspace).filter((item) => item.entry.id === file)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.entry).toMatchObject({ oldText: 'OLD', newText: 'V5', tracking: 'open' })
  })

  it('文件中途删除：窗口折成缺失，撤销恢复基线', async () => {
    const file = join(workspace, 'del.txt')
    await writeFile(file, 'KEEP ME\n', 'utf8')
    openWindow(file, 'KEEP ME\n', 'TOOL\n')
    const { capture, fs } = harness()
    await unlink(file)
    capture.enqueue(workspace, file)
    await capture.flush()

    const entry = loadEntries(workspace).find((item) => item.entry.id === file)!
    expect(entry.entry.newText).toBe('')
    expect(entry.flags.missing).toBe(true)
    const result = await applyDecide(fs as never, workspace, {
      sessionId: 's1', id: file, revision: entry.flags.revision, operationId: 'op-del', decision: 'rejected', scope: 'file',
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('KEEP ME\n')
  })

  it('Keep 关窗后外部再改不冒记录；AI 再写按新基线重开', async () => {
    const file = join(workspace, 'c.txt')
    await writeFile(file, 'B', 'utf8')
    openWindow(file, 'A', 'B')
    const { capture, fs } = harness()
    const item = loadPage(workspace).items[0]!
    await applyDecide(fs as never, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-keep', decision: 'accepted', scope: 'file',
    })
    expect(loadPage(workspace).items).toHaveLength(0)

    // 关窗后 Unity 改写：不产生记录
    await writeFile(file, 'UNITY', 'utf8')
    capture.enqueue(workspace, file)
    await capture.flush()
    expect(loadPage(workspace).items).toHaveLength(0)

    // AI 再写：以这次写前内容（UNITY）为新基线重新开窗
    openWindow(file, 'UNITY', 'AI2')
    await writeFile(file, 'AI2', 'utf8')
    const reopened = loadPage(workspace).items[0]!
    expect(reopened.tracking).toBe('open')
    expect(loadEntries(workspace).find((entry) => entry.entry.id === file)!.entry)
      .toMatchObject({ oldText: 'UNITY', newText: 'AI2', tracking: 'open' })
  })

  it('CRLF + BOM 文件分析后字节不变，记录内容逐字符保真', async () => {
    const file = join(workspace, 'd.txt')
    const original = Buffer.from('\uFEFFline1\r\nline2\r\n', 'utf8')
    await writeFile(file, original)
    openWindow(file, 'OLD', 'OLD2')
    const { capture } = harness()
    await writeFile(file, Buffer.from('\uFEFFline1\r\nline2 changed\r\n', 'utf8'))
    capture.enqueue(workspace, file)
    await capture.flush()

    const after = await readFile(file)
    expect(Buffer.from('\uFEFFline1\r\nline2 changed\r\n', 'utf8').equals(after)).toBe(true)
    const entry = loadEntries(workspace).find((item) => item.entry.id === file)!
    expect(entry.entry.newText.startsWith('\uFEFF')).toBe(true)
    expect(entry.entry.newText).toContain('\r\n')
  })

  it('非 UTF-8 内容不落记录也不改写磁盘，只进缺口', async () => {
    const file = join(workspace, 'gbk.txt')
    await writeFile(file, 'OLD', 'utf8')
    openWindow(file, 'OLD', 'OLD2')
    const gbk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0x0a]) // GBK「测试」
    await writeFile(file, gbk)
    const { capture } = harness()
    capture.enqueue(workspace, file)
    await capture.flush()
    expect((await readFile(file)).equals(gbk)).toBe(true)
    expect(pendingGaps(workspace).some((line) => line.includes('gbk.txt'))).toBe(true)
  })
})
