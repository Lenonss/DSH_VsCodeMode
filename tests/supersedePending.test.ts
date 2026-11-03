/**
 * 待审累计基线接管后旧通道记录自动结案（store.retireCovered）测试。
 * 断言：命中接管的记录被 superseded+归档并写明原因、其他文件不受影响、
 * 相对写法也能匹配同一文件、没有接管或已结案时不动手。
 * @author ddj 2026年11月3号
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs, listArchives, migrateActive } from '../src/archiveDb.js'
import { archiveDbFile } from '../src/paths.js'
import { recordWrite } from '../src/pending/store.js'
import { retireCovered } from '../src/store.js'
import type { DiffRecord } from '../src/shared/types.js'

const SIDECAR = '.dsh-edit-review.json'
const REASON = '已由待审累计基线接管，旧工具记录不再单独决策'
let home = ''
let workspace = ''
let originalHome: string | undefined

beforeAll(() => {
  originalHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-retire-'))
  workspace = mkdtempSync(join(tmpdir(), 'edrv-retire-ws-'))
  process.env.DSH_HOME = home
})
beforeEach(async () => {
  closeArchiveDbs()
  // 活跃库同时承载旧通道记录与待审条目，每个用例都从空库开始
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

/** @author ddj 2026年11月3号 @param partial 覆盖字段 @returns 待审中的旧通道记录 */
function rec(partial: Partial<DiffRecord>): DiffRecord {
  return {
    callId: 'c1',
    toolName: 'write',
    path: join(workspace, 'a.ts'),
    before: '',
    create: false,
    callHunk: null,
    hunks: [{ oldText: '', newText: 'x' }],
    decisions: { call: 'pending', perHunk: ['pending'] },
    note: null,
    superseded: false,
    archived: false,
    batch: 1,
    at: '2026-11-03T00:00:00.000Z',
    ...partial,
  }
}

/** 最小上下文：归档只用到 fs（读 sidecar 兜底），写调用一律记下来供断言。 */
function fakeCtx(): any {
  const fs = {
    resolve: vi.fn(async (target: string, opts?: { cwd?: string }) => {
      const cwd = opts?.cwd ?? ''
      if (target === SIDECAR) return cwd + '/' + target
      if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) return target
      return cwd + '/' + target
    }),
    readText: vi.fn(async (target: string) => { throw new Error('not found: ' + target) }),
    writeText: vi.fn(async () => undefined),
    stat: vi.fn(async () => undefined),
  }
  const sessions = { get: (id: string) => (id === 's1' ? { id: 's1', header: { cwd: workspace } } : undefined) }
  return { get: (name: string) => (name === 'fs' ? fs : name === 'sessions' ? sessions : undefined) }
}

/** @author ddj 2026年11月3号 @param file 文件路径 @param before 写入前内容 @param after 写入后内容 @returns 一条采集写入 */
function write(file: string, before: string | null, after: string | null) {
  return { cwd: workspace, sessionId: 's1', path: file, identity: file, before, after, now: Date.now() }
}

const session = () => ({ id: 's1', header: { cwd: workspace } })

describe('retireCovered', () => {
  it('接管路径的旧记录被结案归档，其他文件不受影响', async () => {
    const covered = join(workspace, 'a.ts')
    recordWrite(write(covered, '', 'x'))
    const hit = rec({ callId: 'hit', path: covered })
    const other = rec({ callId: 'other', path: join(workspace, 'b.ts') })
    const bucket = new Map([[hit.callId, hit], [other.callId, other]])

    const retired = await retireCovered(fakeCtx(), session(), workspace, bucket)

    expect(retired).toBe(1)
    expect(hit.superseded).toBe(true)
    expect(hit.archived).toBe(true)
    expect(other.superseded).toBe(false)
    expect(other.archived).toBe(false)
    // 结案必须写明原因，归档页才能解释这些记录为什么不再需要决策
    expect(listArchives(workspace).map((entry) => entry.reason)).toContain(REASON)
  })

  it('待审条目是工作区相对写法时仍匹配同一文件', async () => {
    // 真实数据里 agent 常用相对路径写入，旧记录存的是绝对路径：只比字符串会漏掉
    const relative = 'Temp/necheck/mcp_call.sh'
    recordWrite(write(relative, '', 'echo hi'))
    const hit = rec({ callId: 'hit', path: join(workspace, relative) })
    const bucket = new Map([[hit.callId, hit]])

    const retired = await retireCovered(fakeCtx(), session(), workspace, bucket)

    expect(retired).toBe(1)
    expect(hit.superseded).toBe(true)
  })

  it('没有接管条目时不动手', async () => {
    const bucket = new Map([['c1', rec({ callId: 'c1' })]])

    expect(await retireCovered(fakeCtx(), session(), workspace, bucket)).toBe(0)
    expect(bucket.get('c1')!.superseded).toBe(false)
    expect(listArchives(workspace)).toEqual([])
  })

  it('已结案记录不重复处理，重复调用幂等', async () => {
    const covered = join(workspace, 'a.ts')
    recordWrite(write(covered, '', 'x'))
    const hit = rec({ callId: 'hit', path: covered })
    const bucket = new Map([[hit.callId, hit]])

    expect(await retireCovered(fakeCtx(), session(), workspace, bucket)).toBe(1)
    expect(await retireCovered(fakeCtx(), session(), workspace, bucket)).toBe(0)
  })
})
