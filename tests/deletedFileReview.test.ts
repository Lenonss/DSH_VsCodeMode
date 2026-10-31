import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { saveSnapshot } from '../src/reviewDb.js'
import { reviewHandlers } from '../src/reviewRpc.js'
import { buildHandlers } from '../src/rpc.js'
import { goneStateOf } from '../src/client/missingReview.js'
import type { Ctx } from '../src/store.js'
import type { Registry } from '../src/registry.js'
import type { ReviewSnapshot } from '../src/shared/review.js'
vi.mock('../src/treeIndex.js', () => ({ invalidateIndex: vi.fn() }))
vi.mock('../src/debugLog.js', () => ({ debugRecord: vi.fn() }))

let testHome = ''
const previousHome = process.env.DSH_HOME
const cwd = '/review-deleted'
const path = cwd + '/a.ts'

afterEach(() => {
  closeArchiveDbs()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (testHome) rmSync(testHome, { recursive: true, force: true })
})

/** @private @author ddj 2026年10月31号 @description: 宿主 fs 接口只返回不透明 target（官方 provider 形态），磁盘上没有该文件。 */
function opaqueFs() {
  return {
    resolve: async () => ({ targetKey: 'opaque-fixture', displayPath: path }),
    processPath: () => path,
    stat: async () => null,
    readText: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    readBytes: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  }
}

/** @private @author ddj 2026年10月31号 @description: 已删除文件 + 一条官方待审记录的宿主环境。 */
async function deletedOfficialFixture() {
  testHome = mkdtempSync(join(tmpdir(), 'edrv-deleted-'))
  process.env.DSH_HOME = testHome
  await migrateActive(cwd, null, async () => null)
  const session = { id: 'fixture', header: { cwd } }
  const ctx = { get: (name: string) => name === 'sessions' ? { get: () => session, list: () => [session] } : name === 'fs' ? opaqueFs() : undefined } as unknown as Ctx
  const registry: Registry = new Map([[cwd, new Map()]])
  const snapshot: ReviewSnapshot = { sourceKind: 'official', sessionId: 'fixture', turn: 1, seq: 10,
    capturedAt: '2026-10-27T00:00:00Z', summary: { cwd, turn: 1, total: 1, added: 1, deleted: 1,
      files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 1 }] },
    files: [{ identity: path, diff: { kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true,
      coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A', '+B'] }] } }] }
  saveSnapshot(cwd, snapshot)
  return { handlers: buildHandlers(ctx, registry), review: reviewHandlers(ctx, registry) }
}

describe('deleted file with official review records', () => {
  it('refuses the whole-file preview with a stable code instead of a raw SQL error', async () => {
    const { handlers } = await deletedOfficialFixture()
    const result = await handlers['edrv.missingReview']({ sessionId: 'fixture', path }) as { ok: boolean; error?: string; code?: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('official-covered')
    expect(result.error).toContain('官方审查记录')
    expect(result.error).not.toContain('Unknown named parameter')
  })

  it('keeps Keep available and explains why Undo cannot run on a deleted file', async () => {
    const { review } = await deletedOfficialFixture()
    const list = await review['edrv.review.list']!({ sessionId: 'fixture' })
    const id = list.ok ? list.page.items[0].id : ''
    const detail = await review['edrv.review.detail']!({ sessionId: 'fixture', id })
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect(detail.detail.capability.keep).toBe(true)
    expect(detail.detail.capability.undo).toBe(false)
    expect(String(detail.detail.capability.reason)).toContain('删除')
  })

  it('switches to the closed-out state once every official record is decided', async () => {
    const { handlers, review } = await deletedOfficialFixture()
    const list = await review['edrv.review.list']!({ sessionId: 'fixture' })
    const id = list.ok ? list.page.items[0].id : ''
    const keep = await review['edrv.review.decide']!({ sessionId: 'fixture', id, seq: 10, revision: 0, operationId: 'o1', decision: 'accepted' })
    expect(keep.ok).toBe(true)
    const after = await handlers['edrv.missingReview']({ sessionId: 'fixture', path }) as { ok: boolean; error?: string; code?: string }
    expect(after.ok).toBe(false)
    expect(after.code).toBe('official-decided')
    expect(String(after.error)).toContain('关闭该标签页')
  })
})

describe('client deleted-file terminal state', () => {
  it('maps every confirmed deletion refusal to a terminal panel', () => {
    expect(goneStateOf({ code: 'official-covered', error: 'Error: 已有官方审查记录' })).toEqual({
      title: '文件已在磁盘删除 · 有官方待审改动', message: '已有官方审查记录', official: true,
    })
    for (const code of ['official-decided', 'no-records', 'no-evidence', 'too-large']) {
      expect(goneStateOf({ code, error: '文件已在磁盘删除' })?.official).toBe(false)
      expect(goneStateOf({ code, error: 'x' })?.title).toBe('文件已在磁盘删除')
    }
  })

  it('keeps retryable failures on the generic load-failure path', () => {
    expect(goneStateOf({ code: 'file-missing', error: '文件不存在' })).toBeNull()
    expect(goneStateOf({ error: '文件已重新出现，请刷新' })).toBeNull()
    expect(goneStateOf(null)).toBeNull()
  })
})
