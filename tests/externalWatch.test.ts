/** 外部改动端到端：真实 SQLite + 真实文件，显式 flush 驱动（对应任务书验收 1/2/3/5/6）。 @author ddj 2026年11月24号 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import { loadEntries } from '../src/pending/persist.js'
import { applyDecide, recordWrite } from '../src/pending/store.js'
import { installExternalCapture } from '../src/pending/externalCapture.js'
import { pathKeyOf, windows } from '../src/pending/provenance.js'
import { rawReviewFile, rawText } from '../src/reviewEvidence.js'
import type { VcsStatus } from '../src/pending/vcs.js'
import type { PendingWrite } from '../src/pending/capture.js'
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
 * @description: 端到端夹具：真读盘（严格 UTF-8 往返）、真待审库、可控版本库状态与基线。
 * @returns 采集器、fs 与状态控制器
 */
function harness() {
  const fs = realFs()
  const state: { status: VcsStatus | null; baseline: Record<string, string> } = { status: null, baseline: {} }
  const writes: PendingWrite[] = []
  // 版本库基线走假 shell：只回答 `git show HEAD:"<relative>"`
  const shell = {
    resolve: (request: unknown) => request,
    execute: async (spec: unknown) => {
      const command = String((spec as { command: string }).command)
      const match = /git show HEAD:"([^"]+)"/.exec(command)
      const text = match ? state.baseline[match[1]!.replace(/\\/g, '/')] : undefined
      return {
        result: async () => ({
          exitCode: text === undefined ? 1 : 0, timedOut: false, aborted: false,
          stdout: { text: text ?? '' }, stderr: { text: text === undefined ? 'not found' : '' },
        }),
      }
    },
  }
  const ctx = {
    get: (name: string) => (name === 'shell' ? shell : name === 'sessions' ? { get: () => undefined, list: () => [] } : undefined),
  }
  const capture = installExternalCapture({
    ctx: ctx as never,
    settings: () => ({ watch: true, scan: false }),
    record: (write) => { writes.push(write); recordWrite(write) },
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
    entries: () => new Map(loadEntries(workspace).map((stored) => [pathKeyOf(stored.entry.id), stored])),
    status: async () => state.status,
  })
  return { capture, fs, writes, state }
}

/** 造一份版本库状态。 */
function statusOf(entries: Array<[string, 'modified' | 'added' | 'deleted']>): VcsStatus {
  return { kind: 'git', root: workspace, entries: new Map(entries.map(([path, status]) => [pathKeyOf(path), { path, status }])) }
}

/** 用工具链路先记一条（模拟 edit/write 已经采过）。 */
function seedToolWrite(path: string, before: string, after: string): void {
  recordWrite({ cwd: workspace, sessionId: 's1', path, identity: path, before, after, now: Date.now(), tool: 'write' })
}

describe('外部改动端到端', () => {
  it('验收 1：bash 写盘后出现记录，撤销恢复原内容', async () => {
    const file = join(workspace, 'a.txt')
    await writeFile(file, 'ORIGINAL\n', 'utf8')
    // 现场没被工具采过：修改前内容来自版本库基线
    const { capture, fs, state } = harness()
    state.status = statusOf([[file, 'modified']])
    state.baseline['a.txt'] = 'ORIGINAL\n'

    // agent 在工具调用窗口里用 node -e 覆写
    windows.enterTool()
    await writeFile(file, 'x', 'utf8')
    capture.enqueue(workspace, file)
    windows.exitTool()
    await capture.flush()

    const stored = loadEntries(workspace).filter((item) => item.entry.id === file)
    expect(stored).toHaveLength(1)
    const entry = stored[0]!
    expect({ ...entry.entry, ...entry.flags }).toMatchObject({
      newText: 'x', oldText: 'ORIGINAL\n', source: 'watch', origin: 'agent', baseKind: 'vcs',
    })

    const result = await applyDecide(fs as never, workspace, {
      sessionId: 's1', id: file, revision: entry.flags.revision, operationId: 'op-1', decision: 'rejected', scope: 'file',
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('ORIGINAL\n')
  })

  it('验收 2：连续 5 次写入只产生 1 条记录', async () => {
    const file = join(workspace, 'b.txt')
    await writeFile(file, 'V0', 'utf8')
    seedToolWrite(file, 'V0', 'V0')
    const { capture } = harness()
    for (let index = 1; index <= 5; index++) {
      await writeFile(file, 'V' + index, 'utf8')
      capture.enqueue(workspace, file)
    }
    await capture.flush()
    const entries = loadEntries(workspace).filter((item) => item.entry.id === file)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.entry.newText).toBe('V5')
  })

  it('验收 3：新建文件按"基线不存在"记录，撤销即删除', async () => {
    const file = join(workspace, 'new.cs.meta')
    const { capture, fs, state } = harness()
    state.status = statusOf([[file, 'added']])
    await writeFile(file, 'guid: abc\n', 'utf8')
    capture.enqueue(workspace, file)
    await capture.flush()

    const entry = loadEntries(workspace).find((item) => item.entry.id === file)!
    expect(entry.entry).toMatchObject({ earlierVersion: 'none', source: 'watch', baseKind: 'absent' })
    const result = await applyDecide(fs as never, workspace, {
      sessionId: 's1', id: file, revision: entry.flags.revision, operationId: 'op-new', decision: 'rejected', scope: 'file',
    })
    expect(result.ok).toBe(true)
    await expect(stat(file)).rejects.toBeTruthy()
  })

  it('验收 3：删除文件后可撤销恢复', async () => {
    const file = join(workspace, 'del.txt')
    await writeFile(file, 'KEEP ME\n', 'utf8')
    // 文件此前已被采集过，已知内容就是 KEEP ME（累计基线语义：撤销恢复的是基线内容）
    seedToolWrite(file, 'KEEP ME\n', 'KEEP ME\n')
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

  it('验收 5：工具写盘之后 watch 不产生第二条记录', async () => {
    const file = join(workspace, 'c.txt')
    await writeFile(file, 'A', 'utf8')
    seedToolWrite(file, 'A', 'B')
    await writeFile(file, 'B', 'utf8')
    const { capture, writes } = harness()
    capture.enqueue(workspace, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
    const entries = loadEntries(workspace).filter((item) => item.entry.id === file)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.entry.source).toBe('write')
  })

  it('验收 6：CRLF + BOM 文件分析后字节不变，记录内容逐字符保真', async () => {
    const file = join(workspace, 'd.txt')
    const original = Buffer.from('\uFEFFline1\r\nline2\r\n', 'utf8')
    await writeFile(file, original)
    seedToolWrite(file, 'OLD', 'OLD')
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
    const gbk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0x0a]) // GBK「测试」
    await writeFile(file, gbk)
    const { capture, writes } = harness()
    capture.enqueue(workspace, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
    expect((await readFile(file)).equals(gbk)).toBe(true)
  })
})
