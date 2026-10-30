/** 待审投影真实文件往返：采集→折叠→Keep 零写盘→Revert 写回/删除。 @author ddj 2026年10月29号 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import { applyDecide, loadDetail, loadPage, recordWrite, removeEntry, undoDecide } from '../src/pending/store.js'
import { PENDING_PREFIX, mergedPage, pendingCovers, pendingDetailOf, pendingRawId, trackPendingCover } from '../src/pendingCompat.js'

let home = ''
let workspace = ''
let originalHome: string | undefined

beforeAll(() => {
  originalHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-pending-'))
  workspace = mkdtempSync(join(tmpdir(), 'edrv-pending-ws-'))
  process.env.DSH_HOME = home
})
beforeEach(async () => {
  closeArchiveDbs()
  // 每个用例清空活跃库，避免上一条用例的条目混进列表
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

/** @author ddj 2026年10月29号 @description 真实文件系统，带 replaceIfVersion 版本守卫。 */
function realFs() {
  const versionOf = async (path: string): Promise<string | undefined> => {
    const info = await stat(path).catch(() => undefined)
    return info ? `${info.size}:${info.mtimeMs}` : undefined
  }
  return {
    processPath: (path: string) => path,
    resolve: async (path: string) => path,
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
      await writeFile(path, text, 'utf8')
    }),
  }
}

/** @author ddj 2026年10月29号 @description 造一条采集写入。 */
function write(file: string, before: string | null, after: string | null, now: number) {
  return { cwd: workspace, sessionId: 's1', path: file, identity: file, before, after, now }
}

describe('待审投影真实往返', () => {
  it('两次写入折叠成一条，基线保留最早内容', async () => {
    const file = join(workspace, 'fold.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    await writeFile(file, 'C', 'utf8')
    recordWrite(write(file, 'B', 'C', 2))
    const page = loadPage(workspace, 's1')
    expect(page.items).toHaveLength(1)
    expect(page.pending).toBe(1)
    const detail = loadDetail(workspace, page.items[0]!.id)
    expect(detail?.item.path).toBe(file)
    expect(detail?.diff).toMatchObject({ kind: 'text' })
  })

  it('内核按原始 id 存取：列表 id 必须剥掉待审前缀才取得到详情', async () => {
    const file = join(workspace, 'prefix.ts')
    await writeFile(file, 'x\n', 'utf8')
    recordWrite(write(file, null, 'x\n', 1))
    const item = loadPage(workspace, 's1').items[0]!
    // 面板列表给出的 id 带前缀（用于和官方条目区分）；直接喂给内核会查不到，这是上一版「待审条目不存在」的成因。
    expect(loadDetail(workspace, PENDING_PREFIX + item.id)).toBeNull()
    expect(loadDetail(workspace, pendingRawId(PENDING_PREFIX + item.id))?.item.path).toBe(file)
  })

  it('块身份由差异现场推导：有差异即有块，归零后无块', async () => {    const file = join(workspace, 'blocks.ts')
    await writeFile(file, 'line1\nline2\n', 'utf8')
    recordWrite(write(file, 'line1\n', 'line1\nline2\n', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const detail = loadDetail(workspace, item.id)!
    expect(detail.blocks).toHaveLength(1)
    expect(detail.blocks[0]!.id).toMatch(/^0:\d+:\d+$/)

    const outcome = await applyDecide(realFs(), workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-blocks', decision: 'accepted', scope: 'file',
    })
    expect(outcome.ok).toBe(true)
    expect(loadDetail(workspace, item.id)?.blocks).toHaveLength(0)
  })

  it('Keep 零写盘：磁盘内容不变且条目转为已解决', async () => {
    const file = join(workspace, 'keep.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const fs = realFs()
    const outcome = await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-keep', decision: 'accepted', scope: 'file',
    })
    expect(outcome.ok).toBe(true)
    expect(fs.writeText).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe('B')
    expect(loadPage(workspace, 's1').items[0]?.settled).toBe(true)
  })

  it('Revert 写回基线并通过读回校验', async () => {
    const file = join(workspace, 'revert.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const fs = realFs()
    const outcome = await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-revert', decision: 'rejected', scope: 'file',
    })
    expect(outcome.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('A')
    expect(loadPage(workspace, 's1').items[0]?.settled).toBe(true)
  })

  it('新建文件 Revert 等于删除该文件', async () => {
    const file = join(workspace, 'created.ts')
    await writeFile(file, 'hello', 'utf8')
    recordWrite(write(file, null, 'hello', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const outcome = await applyDecide(realFs(), workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-del', decision: 'rejected', scope: 'file',
    })
    expect(outcome.ok).toBe(true)
    await expect(stat(file)).rejects.toThrow()
  })

  it('磁盘已被外部改动时 Revert 拒绝且不改文件', async () => {
    const file = join(workspace, 'conflict.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    await writeFile(file, 'EXTERNAL', 'utf8')
    const fs = realFs()
    const outcome = await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-conflict', decision: 'rejected', scope: 'file',
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'diverged' })
    expect(fs.writeText).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe('EXTERNAL')
  })

  it('已解决条目可移除，未解决条目拒绝移除', async () => {
    const file = join(workspace, 'remove.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    expect(removeEntry(workspace, item.id, item.revision)).toBe(false)
    await applyDecide(realFs(), workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-keep2', decision: 'accepted', scope: 'file',
    })
    const settled = loadPage(workspace, 's1').items[0]!
    expect(removeEntry(workspace, settled.id, settled.revision)).toBe(true)
    expect(loadPage(workspace, 's1').items).toHaveLength(0)
  })

  it('面板投影：待审条目接管同路径，官方旧行让位且 id 带前缀', async () => {
    const file = join(workspace, 'compat.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const pending = loadPage(workspace, 's1')
    const official = {
      items: [{
        id: '7', sessionId: 's1', turn: 1, seq: 1, path: file, currentPath: file, display: file,
        added: 1, deleted: 1, kind: 'text' as const, decision: 'pending' as const, revision: 0, current: true,
      }],
      pending: 1, nextCursor: null, gaps: [],
    }
    const merged = mergedPage(official, pending)
    expect(merged.items).toHaveLength(1)
    expect(merged.items[0]!.id.startsWith(PENDING_PREFIX)).toBe(true)
    expect(merged.pending).toBe(1)
  })

  it('旧写入口守卫：登记后拒绝、注销后放行，且不读数据库', () => {
    const cwd = join(workspace, 'w')
    const covered = join(cwd, 'guard.ts')
    expect(pendingCovers(cwd, covered)).toBe(false)
    trackPendingCover(cwd, covered, true)
    expect(pendingCovers(cwd, covered)).toBe(true)
    expect(pendingCovers(cwd, join(cwd, 'other.ts'))).toBe(false)
    trackPendingCover(cwd, covered, false)
    expect(pendingCovers(cwd, covered)).toBe(false)
  })

  it('撤销 Keep：条目回到未决且不写盘', async () => {
    const file = join(workspace, 'undo-keep.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const fs = realFs()
    await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-k1', decision: 'accepted', scope: 'file',
    })
    const move = await undoDecide(fs, workspace, { sessionId: 's1', direction: 'undo', operationId: 'op-u1' })
    expect(move.ok).toBe(true)
    expect(fs.writeText).not.toHaveBeenCalled()
    expect(loadPage(workspace, 's1').items[0]?.settled).toBe(false)
    expect(await readFile(file, 'utf8')).toBe('B')
  })

  it('撤销 Revert：文件恢复为 Revert 前内容', async () => {
    const file = join(workspace, 'undo-revert.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const fs = realFs()
    await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-r1', decision: 'rejected', scope: 'file',
    })
    expect(await readFile(file, 'utf8')).toBe('A')
    const move = await undoDecide(fs, workspace, { sessionId: 's1', direction: 'undo', operationId: 'op-ru1' })
    expect(move.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('B')
    expect(loadPage(workspace, 's1').items[0]?.settled).toBe(false)
  })

  it('撤销「新建文件 Revert 删除」会把文件按快照重建回来', async () => {
    const file = join(workspace, 'undo-new-create.ts')
    await writeFile(file, 'X', 'utf8')
    recordWrite(write(file, null, 'X', 0))
    const item = loadPage(workspace, 's1').items[0]!
    const fs = realFs()
    await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-n1', decision: 'rejected', scope: 'file',
    })
    expect(await stat(file).catch(() => undefined)).toBeUndefined()
    const move = await undoDecide(fs, workspace, { sessionId: 's1', direction: 'undo', operationId: 'op-nu1' })
    expect(move.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('X')
    expect(loadPage(workspace, 's1').items[0]?.settled).toBe(false)
  })

  it('重做：撤销后再重做回到已解决且文件再次写回', async () => {
    const file = join(workspace, 'redo.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const fs = realFs()
    await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-d1', decision: 'rejected', scope: 'file',
    })
    await undoDecide(fs, workspace, { sessionId: 's1', direction: 'undo', operationId: 'op-du' })
    const redo = await undoDecide(fs, workspace, { sessionId: 's1', direction: 'redo', operationId: 'op-dr' })
    expect(redo.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('A')
    expect(loadPage(workspace, 's1').items[0]?.settled).toBe(true)
  })

  it('方向不合法与空历史都被拒绝', async () => {
    const fs = realFs()
    expect(await undoDecide(fs, workspace, { sessionId: 's1', direction: 'undo', operationId: 'op-none' }))
      .toMatchObject({ ok: false, reason: 'no-undo' })
    const file = join(workspace, 'redo-guard.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-g1', decision: 'accepted', scope: 'file',
    })
    expect(await undoDecide(fs, workspace, { sessionId: 's1', direction: 'redo', operationId: 'op-g2' }))
      .toMatchObject({ ok: false, reason: 'no-redo' })
  })

  it('同一 operationId 重复请求返回同一结果（幂等）', async () => {
    const file = join(workspace, 'idem.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const fs = realFs()
    await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'op-i1', decision: 'rejected', scope: 'file',
    })
    const first = await undoDecide(fs, workspace, { sessionId: 's1', direction: 'undo', operationId: 'op-i2' })
    const second = await undoDecide(fs, workspace, { sessionId: 's1', direction: 'undo', operationId: 'op-i2' })
    expect(first).toEqual(second)
    expect(await readFile(file, 'utf8')).toBe('B')
  })

  it('面板投影：详情映射把 Revert 能力位接到 Undo', async () => {
    const file = join(workspace, 'cap.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const detail = loadDetail(workspace, item.id)!
    const mapped = pendingDetailOf(detail, '2026-10-29T00:00:00.000Z')
    expect(mapped.item.id).toBe(PENDING_PREFIX + item.id)
    expect(mapped.capability.keep).toBe(true)
    expect(mapped.capability.undo).toBe(true)
    expect(mapped.diff).toMatchObject({ kind: 'text' })
  })
})
