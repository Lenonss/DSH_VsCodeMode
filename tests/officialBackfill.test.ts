import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { reviewPage } from '../src/reviewDb.js'
import { installCapture } from '../src/officialCapture.js'
import type { Ctx } from '../src/store.js'
import type { OfficialDiff, OfficialSummary } from '../src/shared/review.js'
vi.mock('../src/treeIndex.js', () => ({ invalidateIndex: vi.fn() }))
vi.mock('../src/debugLog.js', () => ({ debugRecord: vi.fn() }))

let testHome = ''
const previousHome = process.env.DSH_HOME
const cwd = '/review-backfill'
const session = { id: 'source', header: { cwd } }
const diff: OfficialDiff = { kind: 'text', path: 'a.ts', display: 'a.ts', before: false, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hello'] }] }

afterEach(() => {
  closeArchiveDbs()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (testHome) rmSync(testHome, { recursive: true, force: true })
})

/** @private @author ddj 2026年10月31号 @description: 官方 summary 只认识 seq 358；352 是宿主重启后内存已清空的历史事件。 */
function summaryAt(turn: number): OfficialSummary {
  return { turn, cwd, files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 }
}

/** @private @author ddj 2026年10月31号 @description: 只暴露安装期用到的能力点：事件列表、事件读取、官方 summary、路径解析。 */
function fakeHost(events: { type: string; seq: number; data: { turn: number } }[]) {
  const hooks = new Map<string, (payload: unknown) => unknown>()
  const live = { summary: (_sessionId: string, seq: number) => seq === 358 ? summaryAt(357) : undefined, diff: async () => diff }
  const ctx = {
    on: (type: string, handler: (payload: unknown) => unknown) => { hooks.set(type, handler) },
    get: (name: string) => {
      if (name === 'sessions') return { list: () => [], get: () => session }
      if (name === 'sessionQuery') return {
        listEvents: async () => events,
        readEvent: async ({ seq }: { seq: number }) => ({ target: { type: 'workspace/changes', seq, data: { turn: seq - 1 } } }),
      }
      if (name === 'workspaceChanges') return live
      if (name === 'fs') return {
        resolve: async (path: string) => ({ targetKey: path, displayPath: cwd + '/' + path }),
        processPath: (target: { displayPath?: string }) => target.displayPath ?? '',
        stat: async () => null,
        readText: async () => '+hello\n',
        readBytes: async () => Buffer.from('+hello\n'),
      }
      return undefined
    },
  } as unknown as Ctx
  return { ctx, hooks }
}

describe('official history backfill', () => {
  it('skips events whose summary did not survive the restart instead of recording gaps', async () => {
    testHome = mkdtempSync(join(tmpdir(), 'edrv-backfill-'))
    process.env.DSH_HOME = testHome
    await migrateActive(cwd, null, async () => null)
    const { ctx, hooks } = fakeHost([
      { type: 'workspace/changes', seq: 352, data: { turn: 351 } },
      { type: 'workspace/changes', seq: 358, data: { turn: 357 } },
    ])
    const dispose = installCapture(ctx)
    await hooks.get('session/created')!(session)
    await dispose()

    const page = reviewPage(cwd)
    expect(page.gaps).toEqual([])
    expect(page.items.map((item) => item.seq)).toEqual([358])
    expect(page.pending).toBe(1)
  })

  it('keeps collecting when the official service is missing', async () => {
    testHome = mkdtempSync(join(tmpdir(), 'edrv-backfill-off-'))
    process.env.DSH_HOME = testHome
    await migrateActive(cwd, null, async () => null)
    const { ctx, hooks } = fakeHost([{ type: 'workspace/changes', seq: 352, data: { turn: 351 } }])
    const realGet = ctx.get.bind(ctx)
    ;(ctx as unknown as { get: (name: string) => unknown }).get = (name: string) => name === 'workspaceChanges' ? undefined : realGet(name)
    const dispose = installCapture(ctx)
    await hooks.get('session/created')!(session)
    await dispose()
    expect(reviewPage(cwd).gaps).toEqual([])
    expect(reviewPage(cwd).items).toEqual([])
  })
})
