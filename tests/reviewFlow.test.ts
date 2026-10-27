import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { saveSnapshot } from '../src/reviewDb.js'
import { reviewHandlers } from '../src/reviewRpc.js'
import { buildHandlers } from '../src/rpc.js'
import { diffSummary } from '../src/client/state/diffSummary.js'
import type { Ctx } from '../src/store.js'
import type { Registry } from '../src/registry.js'
import type { ReviewSnapshot } from '../src/shared/review.js'
vi.mock('../src/treeIndex.js', () => ({ invalidateIndex: vi.fn() }))
vi.mock('../src/debugLog.js', () => ({ debugRecord: vi.fn() }))

let testHome = ''
const previousHome = process.env.DSH_HOME

afterEach(() => {
  closeArchiveDbs()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (testHome) rmSync(testHome, { recursive: true, force: true })
})

describe('isolated official review operation flow', () => {
  it('save preserves pending; keep updates list and badge; database reopen retains the decision', async () => {
    testHome = mkdtempSync(join(tmpdir(), 'edrv-review-flow-'))
    process.env.DSH_HOME = testHome
    const cwd = '/review-flow-fixture', path = cwd + '/a.ts'
    await migrateActive(cwd, null, async () => null)
    let diskText = 'B'
    const fs = {
      resolve: async () => ({ targetKey: 'opaque-fixture', displayPath: path }),
      processPath: () => path,
      writeText: vi.fn(async (_target: unknown, content: string) => { diskText = content; return { version: 'v2' } }),
    }
    const session = { id: 'fixture', header: { cwd } }
    const ctx = { get: (name: string) => name === 'sessions' ? { get: () => session } : name === 'fs' ? fs : undefined } as unknown as Ctx
    const registry: Registry = new Map([[cwd, new Map()]])
    const snapshot: ReviewSnapshot = { sourceKind: 'official', sessionId: 'fixture', turn: 1, seq: 10,
      capturedAt: '2026-10-27T00:00:00Z', summary: { cwd, turn: 1, total: 1, added: 1, deleted: 1,
        files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 1 }] },
      files: [{ identity: path, diff: { kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true,
        coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-A', '+B'] }] } }] }
    saveSnapshot(cwd, snapshot)
    const review = reviewHandlers(ctx, registry)
    const before = await review['edrv.review.list']!({ sessionId: 'fixture' })
    expect(before.ok).toBe(true)
    if (!before.ok) throw new Error('fixture list failed')
    expect(diffSummary([], before.page).totalFiles).toBe(1)
    const item = before.page.items[0]

    const saved = await buildHandlers(ctx, registry)['edrv.save']({ sessionId: 'fixture', path, content: 'manual edit' })
    expect(saved.ok).toBe(true)
    expect(diskText).toBe('manual edit')
    const afterSave = await review['edrv.review.detail']!({ sessionId: 'fixture', id: item.id })
    expect(afterSave.ok && afterSave.detail.item.decision).toBe('pending')
    expect(afterSave.ok && afterSave.detail.diff).toEqual(snapshot.files[0].diff)

    const kept = await review['edrv.review.decide']!({ sessionId: 'fixture', id: item.id, seq: 10,
      revision: 0, operationId: 'fixture-keep', decision: 'accepted' })
    expect(kept).toEqual({ ok: true, revision: 1 })
    closeArchiveDbs()
    const reopened = reviewHandlers(ctx, new Map([[cwd, new Map()]]))
    const pending = await reopened['edrv.review.list']!({ sessionId: 'fixture' })
    expect(pending.ok && pending.page.pending).toBe(0)
    expect(pending.ok && pending.page.items).toEqual([])
    expect(pending.ok && diffSummary([], pending.page).totalFiles).toBe(0)
    const history = await reopened['edrv.review.detail']!({ sessionId: 'fixture', id: item.id })
    expect(history.ok && history.detail.item).toMatchObject({ decision: 'accepted', revision: 1, id: item.id })
    expect(fs.writeText).toHaveBeenCalledTimes(1) // Keep never writes a file.
    expect(diskText).toBe('manual edit')
  })
})
