/** 待审投影真实文件往返：采集→折叠→Keep 零写盘→Revert 写回/删除。 @author ddj 2026年10月29号 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import { saveSnapshot } from '../src/reviewDb.js'
import { pendingHandlers } from '../src/pendingRpc.js'
import { applyDecide, keepAll, loadDetail, loadPage, recordWrite, removeEntry, undoDecide, writerFor } from '../src/pending/store.js'
import { PENDING_PREFIX, mergedPage, pendingCoverOwner, pendingCovers, pendingDetailOf, pendingRawId, setPendingCovers, trackPendingCover } from '../src/pendingCompat.js'

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

  it('待审条目的相对 path 与官方绝对身份同指一个文件时，官方旧行仍让位', async () => {
    const file = join(workspace, 'compat-rel.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite({ ...write(file, 'A', 'B', 1), path: 'compat-rel.ts' })
    const pending = loadPage(workspace, 's1')
    expect(pending.items[0]!.path).toBe('compat-rel.ts')
    const official = {
      items: [{
        id: '8', sessionId: 's1', turn: 1, seq: 1, path: file, currentPath: file, display: file,
        added: 1, deleted: 1, kind: 'text' as const, decision: 'pending' as const, revision: 0, current: true,
      }],
      pending: 1, nextCursor: null, gaps: [],
    }
    const merged = mergedPage(official, pending)
    expect(merged.items).toHaveLength(1)
    expect(merged.items[0]!.id.startsWith(PENDING_PREFIX)).toBe(true)
  })

  it('新建文件按整文件新增渲染：基线置空后只剩一块全加差异', async () => {
    const file = join(workspace, 'fresh.ts')
    await writeFile(file, 'A\nB\nC\nD', 'utf8')
    // 首次采集时磁盘已有内容（会话自己的中间产物），累计基线因此不是空的
    recordWrite(write(file, 'A\nB\nC', 'A\nB\nC\nD', 1))
    const [item] = loadPage(workspace, 's1').items
    expect(item!.added).toBe(1)
    expect(item!.deleted).toBe(0)
    const detail = loadDetail(workspace, item!.id, true)
    expect(detail!.diff.hunks).toHaveLength(1)
    // 基线为空时整文件都是新增，块里不允许再出现删除行
    expect(detail!.diff.hunks[0]!.lines.some((line) => line.startsWith('-'))).toBe(false)
    expect(detail!.item.deleted).toBe(0)
    expect(detail!.item.added).toBe(4)
  })

  it('创建来源而非查看者决定全量新增，Keep 后不复活空基线', async () => {
    const file = join(workspace, 'source-created.ts')
    await writeFile(file, 'A\nB\nC')
    recordWrite(write(file, 'A\nB', 'A\nB\nC', 1))
    saveSnapshot(workspace, { sourceKind: 'official', sessionId: 's1', turn: 1, seq: 1,
      capturedAt: '2026-11-04T00:00:00Z',
      summary: { cwd: workspace, turn: 1, total: 1, added: 3, deleted: 0,
        files: [{ path: file, display: file, added: 3, deleted: 0 }] },
      files: [{ identity: file, diff: { kind: 'text', path: file, display: file, before: false, after: true, coarse: false,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+A', '+B', '+C'] }] } }] })
    expect(loadPage(workspace, 's2').items[0]?.added).toBe(3)
    expect(loadPage(workspace, 's2')).toEqual(loadPage(workspace, 's1'))
    expect(loadDetail(workspace, file)?.item.added).toBe(3)

    const item = loadPage(workspace, 's2').items[0]!
    await applyDecide(realFs(), workspace, { sessionId: 's2', id: file, revision: item.revision,
      operationId: 'source-keep', decision: 'accepted', scope: 'file' })
    await writeFile(file, 'A\nB\nC\nD')
    recordWrite({ ...write(file, 'A\nB\nC', 'A\nB\nC\nD', 2), sessionId: 's2' })
    expect(loadPage(workspace, 's1').items[0]?.added).toBe(1)
    expect(loadDetail(workspace, file)?.item.added).toBe(1)
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

  it('旧写入口守卫按工作区共享：登记给会话 A 也拦会话 B', () => {
    const cwd = join(workspace, 'w2')
    const covered = join(cwd, 'scope.ts')
    trackPendingCover(cwd, covered, true, 'sA')
    // 同工作区共享待审列表，任何对话的旧入口都不能绕过累计基线。
    expect(pendingCovers(cwd, covered, 'sA')).toBe(true)
    expect(pendingCovers(cwd, covered, 'sB')).toBe(true)
    expect(pendingCovers(join(cwd, 'other'), covered, 'sB')).toBe(false)
    // 不给会话时按全工作区并集判定，保持旧调用点语义
    expect(pendingCovers(cwd, covered)).toBe(true)
    trackPendingCover(cwd, covered, false, 'sA')
    expect(pendingCovers(cwd, covered, 'sA')).toBe(false)
  })

  it('整集重建清除工作区旧登记，不残留其他会话副本', () => {
    const cwd = join(workspace, 'w3')
    const keep = join(cwd, 'keep.ts')
    const drop = join(cwd, 'drop.ts')
    trackPendingCover(cwd, keep, true, 'sA')
    trackPendingCover(cwd, drop, true, 'sA')
    trackPendingCover(cwd, drop, true, 'sB')
    setPendingCovers(cwd, 'sA', [keep])
    expect(pendingCovers(cwd, keep, 'sA')).toBe(true)
    // 条目被移除/结案后登记必须自动失效，不能把旧入口永久封死
    expect(pendingCovers(cwd, drop, 'sA')).toBe(false)
    expect(pendingCovers(cwd, drop, 'sB')).toBe(false)
    expect(pendingCoverOwner(cwd, keep)).toBe('sA')
  })

  it('待审 RPC 通过查看者工作区共享列表和详情，不借用来源会话权限', async () => {
    const file = join(workspace, 'rpc-shared.ts')
    recordWrite(write(file, 'A', 'B', 1))
    const other = join(workspace, 'rpc-other')
    await migrateActive(other, null, async () => null)
    const sessions = new Map(['s1', 's2', 's3'].map((id) => [id, { id, header: { cwd: id === 's3' ? other : workspace } }]))
    const ctx = { get: (name: string) => name === 'sessions' ? sessions : undefined }
    const handlers = pendingHandlers(ctx, new Map([[workspace, new Map()], [other, new Map()]]))
    const first = await handlers['edrv.pending.list']!({ sessionId: 's1' })
    expect(await handlers['edrv.pending.list']!({ sessionId: 's2' })).toEqual(first)
    expect(await handlers['edrv.pending.list']!({ sessionId: 's3' })).toMatchObject({ ok: true, page: { items: [] } })
    sessions.delete('s1')
    expect(await handlers['edrv.pending.detail']!({ sessionId: 's2', id: file })).toMatchObject({ ok: true })
    expect(await handlers['edrv.pending.detail']!({ sessionId: 's3', id: file })).toMatchObject({ ok: false })
  })

  it('未参与修改的对话共享列表、决定与撤销，其他工作区隔离', async () => {
    const file = join(workspace, 'shared.ts')
    await writeFile(file, 'B', 'utf8')
    recordWrite(write(file, 'A', 'B', 1))
    const item = loadPage(workspace, 's2').items[0]!
    expect(item).toEqual(loadPage(workspace, 's1').items[0])
    const other = join(workspace, 'other')
    await migrateActive(other, null, async () => null)
    expect(loadPage(other, 's2').items).toEqual([])

    const fs = realFs()
    const request = { sessionId: 's2', id: item.id, revision: item.revision,
      operationId: 'shared-keep', decision: 'accepted' as const, scope: 'file' as const }
    expect(await applyDecide(fs, workspace, request)).toMatchObject({ ok: true })
    expect(loadPage(workspace, 's1').pending).toBe(0)
    expect(await applyDecide(fs, workspace, { ...request, operationId: 'shared-stale' })).toMatchObject({ ok: false })
    expect(await undoDecide(fs, workspace, { sessionId: 's1', direction: 'undo', operationId: 'shared-undo' })).toMatchObject({ ok: true })
    expect(loadPage(workspace, 's2').pending).toBe(1)
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

  it('批量 Keep 一次读完条目、零写盘推进基线，未知条目只跳过自己', async () => {
    const first = join(workspace, 'bulk-a.ts')
    const second = join(workspace, 'bulk-b.ts')
    await writeFile(first, 'after-a', 'utf8')
    await writeFile(second, 'after-b', 'utf8')
    recordWrite(write(first, 'before-a', 'after-a', 1))
    recordWrite(write(second, 'before-b', 'after-b', 2))
    const items = loadPage(workspace, 's1').items

    const outcome = await keepAll(workspace, [
      ...items.map((item) => ({ id: item.id, display: item.display, operationId: `bulk-${item.id}` })),
      { id: 'gone', display: 'gone.ts', operationId: 'bulk-gone' },
    ])
    expect(outcome.kept).toHaveLength(2)
    expect(outcome.skipped).toEqual([{ id: 'gone', display: 'gone.ts', reason: '待审条目不存在' }])
    // Keep 零写盘：磁盘仍是采集到的最新内容
    expect(await readFile(first, 'utf8')).toBe('after-a')
    expect(await readFile(second, 'utf8')).toBe('after-b')
    // 基线追平内容后条目结案：列表不再有待审，单条也没有 Keep 能力
    expect(loadPage(workspace, 's1').pending).toBe(0)
    expect(loadDetail(workspace, items[0]!.id)!.capability.keep).toBe(false)

    // 重跑是幂等无操作，不再产生新的历史记录
    const again = await keepAll(workspace, items.map((item) => ({ id: item.id, display: item.display, operationId: `bulk-again-${item.id}` })))
    expect(again.kept).toHaveLength(2)
    expect(again.skipped).toEqual([])
  })

  it('删除传递版本、signal 与 policy；权限拒绝不结案', async () => {
    const file = join(workspace, 'denied-delete.ts')
    await writeFile(file, 'B')
    recordWrite(write(file, null, 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const fs = realFs()
    const signal = new AbortController().signal
    const policy = { mode: 'read-only' }
    fs.deleteFile.mockRejectedValue(Object.assign(new Error('denied'), { code: 'FS_SANDBOX_DENIED' }))
    const outcome = await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'denied-del', decision: 'rejected', scope: 'file',
    }, signal, policy)
    expect(outcome.ok).toBe(false)
    expect(fs.deleteFile.mock.calls[0]).toEqual([file, { version: expect.any(String) }, signal, policy])
    expect(await readFile(file, 'utf8')).toBe('B')
    expect(loadPage(workspace, 's1').pending).toBe(1)
  })

  it('旧 provider 无删除能力时不回落宿主 unlink', async () => {
    const file = join(workspace, 'old-provider.ts')
    await writeFile(file, 'B')
    recordWrite(write(file, null, 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const fs: any = realFs()
    delete fs.deleteFile
    const outcome = await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'old-del', decision: 'rejected', scope: 'file',
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'delete-unavailable' })
    expect(await readFile(file, 'utf8')).toBe('B')
  })

  it('删除后 stat 失败不冒充删除成功，条目保留未决', async () => {
    const file = join(workspace, 'uncertain-delete.ts')
    await writeFile(file, 'B')
    recordWrite(write(file, null, 'B', 1))
    const item = loadPage(workspace, 's1').items[0]!
    const fs = realFs()
    fs.deleteFile.mockImplementationOnce(async () => {
      fs.stat = async () => { throw new Error('stat unavailable') }
    })
    const outcome = await applyDecide(fs, workspace, {
      sessionId: 's1', id: item.id, revision: item.revision, operationId: 'uncertain-del', decision: 'rejected', scope: 'file',
    })
    expect(outcome.ok).toBe(false)
    expect(loadPage(workspace, 's1').pending).toBe(1)
  })
})

describe('写回版本守卫', () => {
  it('stat-read-stat 版本变化时不写，缺少版本也不写', async () => {
    const fs = {
      resolve: async () => 'target',
      stat: vi.fn().mockResolvedValueOnce({ type: 'file', version: 'v1' }).mockResolvedValueOnce({ type: 'file', version: 'v2' }),
      readBytes: async () => Buffer.from('B'),
      writeText: vi.fn(),
    }
    expect(await writerFor(fs, workspace, 'a.ts', 'B')('A')).toMatchObject({ ok: false, reason: 'revision-mismatch' })
    fs.stat.mockResolvedValue({ type: 'file' })
    expect(await writerFor(fs, workspace, 'a.ts', 'B')('A')).toMatchObject({ ok: false, reason: 'unguarded-file' })
    expect(fs.writeText).not.toHaveBeenCalled()
  })

  it('空文本写回后目标缺失不冒充空文件成功', async () => {
    const fs = {
      resolve: async () => 'target', stat: async () => ({ type: 'file', version: 'v1' }),
      readBytes: vi.fn().mockResolvedValueOnce(Buffer.from('B')).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'FS_NOT_FOUND' })),
      writeText: vi.fn(),
    }
    expect(await writerFor(fs, workspace, 'a.ts', 'B')('')).toMatchObject({ ok: false, reason: 'read-back-mismatch' })
  })

  it('缺失重建必须用 createIfAbsent，抢占创建失败不报成功', async () => {
    const signal = new AbortController().signal
    const policy = { mode: 'workspace-write' }
    const fs = {
      resolve: async () => 'target', stat: async () => undefined,
      writeText: vi.fn().mockRejectedValue(Object.assign(new Error('exists'), { code: 'FS_ALREADY_EXISTS' })),
    }
    const outcome = await writerFor(fs, workspace, 'a.ts', '', signal, policy, true)('A')
    expect(outcome.ok).toBe(false)
    expect(fs.writeText).toHaveBeenCalledWith('target', 'A', { kind: 'createIfAbsent' }, signal, policy)
  })
})
