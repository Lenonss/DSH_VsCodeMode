/**
 * 旧写入口守卫（legacyBlocked）按会话作用域拦截测试。
 * 待审可见性按会话过滤，守卫必须同口径：本会话看得见的接管要拦，别的会话的接管不能拦，
 * 否则会出现"在文件里点 Keep 被拒、面板里却看不到对应待审条目"的死锁。
 * @author ddj 2026年11月3号
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveDbFile } from '../src/paths.js'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { buildHandlers } from '../src/rpc.js'
import { setPendingCovers } from '../src/pendingCompat.js'
import type { DiffRecord } from '../src/shared/types.js'

const SIDECAR = '.dsh-edit-review.json'
const CWD = '/ws-guard'
let home = ''
let originalHome: string | undefined

beforeAll(() => {
  originalHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-guard-'))
  process.env.DSH_HOME = home
})
beforeEach(async () => {
  closeArchiveDbs()
  rmSync(archiveDbFile(CWD), { force: true })
  await migrateActive(CWD, null, async () => null)
})
afterAll(() => {
  closeArchiveDbs()
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

/** @author ddj 2026年11月3号 @param partial 覆盖字段 @returns 待审中的旧通道记录 */
function rec(partial: Partial<DiffRecord>): DiffRecord {
  return {
    callId: 'c1',
    toolName: 'edit',
    path: CWD + '/a.ts',
    before: 'old',
    create: false,
    callHunk: null,
    hunks: [{ oldText: 'a', newText: 'b' }],
    decisions: { call: 'pending', perHunk: ['pending'] },
    note: null,
    superseded: false,
    archived: false,
    batch: 1,
    at: '2026-11-03T00:00:00.000Z',
    ...partial,
  }
}

/** 内存 fake fs：只记录写调用，守卫命中的用例必须一次都不写。 */
function fakeFs(files: Record<string, string>): any {
  const store = new Map(Object.entries(files))
  return {
    resolve: vi.fn(async (target: string, opts?: { cwd?: string }) => {
      const cwd = opts?.cwd ?? ''
      if (target === SIDECAR) return cwd + '/' + target
      if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) return target
      return cwd + '/' + target
    }),
    readText: vi.fn(async (target: string) => {
      if (!store.has(target)) throw new Error('not found: ' + target)
      return store.get(target)!
    }),
    writeText: vi.fn(async (target: string, content: string) => { store.set(target, content) }),
    stat: vi.fn(async (target: string) => (store.has(target) ? { type: 'file', size: store.get(target)!.length } : undefined)),
  }
}

/** @author ddj 2026年11月3号 @param fs fake fs @returns 只为 s1 提供会话的最小上下文 */
function fakeCtx(fs: any): any {
  const sessions = {
    get: (id: string) => (id === 's1' ? { id: 's1', header: { cwd: CWD } } : undefined),
    list: () => [{ id: 's1', header: { cwd: CWD } }],
  }
  return { get: (name: string) => (name === 'fs' ? fs : name === 'sessions' ? sessions : undefined) }
}

function bucketOf(records: DiffRecord[]): Map<string, DiffRecord> {
  return new Map(records.map((record) => [record.callId, record]))
}

afterEach(() => {
  // 接管集合是进程级状态，用例之间必须清干净，避免串味
  setPendingCovers(CWD, 's1', [])
  setPendingCovers(CWD, 's2', [])
})

describe('旧写入口守卫', () => {
  it('本会话接管该文件时拒绝旧通道批量决策，并指向面板入口', async () => {
    const fs = fakeFs({ [CWD + '/a.ts']: 'b' })
    const registry = new Map([[CWD, bucketOf([rec({ callId: 'c1' })])]])
    const handlers = buildHandlers(fakeCtx(fs), registry)
    setPendingCovers(CWD, 's1', [CWD + '/a.ts'])

    const res = await handlers['edrv.decideBatch']({ sessionId: 's1', items: [{ callId: 'c1', decision: 'accepted' }] })

    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('待审累计基线') })
    expect(fs.writeText).not.toHaveBeenCalled()
    expect(registry.get(CWD)!.get('c1')!.decisions.call).toBe('pending')
  })

  it('单条旧入口（accept/reject）同样被接管守卫挡住', async () => {
    const fs = fakeFs({ [CWD + '/a.ts']: 'b' })
    const registry = new Map([[CWD, bucketOf([rec({ callId: 'c1' })])]])
    const handlers = buildHandlers(fakeCtx(fs), registry)
    setPendingCovers(CWD, 's1', [CWD + '/a.ts'])

    expect(await handlers['edrv.accept']({ sessionId: 's1', callId: 'c1' })).toMatchObject({
      ok: false, error: expect.stringContaining('待审累计基线'),
    })
    expect(await handlers['edrv.reject']({ sessionId: 's1', callId: 'c1' })).toMatchObject({ ok: false })
    expect(fs.writeText).not.toHaveBeenCalled()
  })

  it('接管只属于别的会话时放行：拦截口径与本会话可见性一致', async () => {
    const fs = fakeFs({ [CWD + '/a.ts']: 'b' })
    const registry = new Map([[CWD, bucketOf([rec({ callId: 'c1' })])]])
    const handlers = buildHandlers(fakeCtx(fs), registry)
    // 该文件由 s2 的待审条目接管；s1 的列表里看不到它，因此 s1 的旧入口不能拦
    setPendingCovers(CWD, 's2', [CWD + '/a.ts'])

    const res = await handlers['edrv.decideBatch']({ sessionId: 's1', items: [{ callId: 'c1', decision: 'accepted' }] })

    expect(res).toMatchObject({ ok: true })
    if (!res.ok) return
    expect(res.results[0]).toMatchObject({ ok: true })
    expect(registry.get(CWD)!.get('c1')!.decisions.call).toBe('accepted')
  })
})
