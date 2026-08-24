/**
 * host rpc.ts 批量决策（edrv.decideBatch）与单条 accept/reject 委托测试。
 * 用内存 fake fs/ctx 验证：一次批量 = 一次归档写 + 一次 sidecar 写；逐项错误传播；
 * rejected 顺序回滚；edrv.list skipStale 跳过 stale 清理。
 * 作者 ddj 2026-08-25
 */
import { describe, expect, it, vi } from 'vitest'
import { buildHandlers } from '../src/rpc.js'
import type { DiffRecord } from '../src/shared/types.js'

const SIDECAR = '.dsh-edit-review.json'
const ARCHIVE = '.dsh-edit-review-archive.json'
const CWD = '/ws'

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
    at: '2026-08-20T00:00:00.000Z',
    ...partial,
  }
}

/** 内存 fake fs：files 为 target 路径 → 内容。 */
function fakeFs(files: Record<string, string>): any {
  const store = new Map(Object.entries(files))
  const fs = {
    resolve: vi.fn(async (p: string, opts?: { cwd?: string }) => {
      const cwd = opts?.cwd ?? ''
      if (p === SIDECAR || p === ARCHIVE) return cwd + '/' + p
      if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return p
      return cwd + '/' + p
    }),
    readText: vi.fn(async (target: string) => {
      if (!store.has(target)) throw new Error('not found: ' + target)
      return store.get(target)!
    }),
    writeText: vi.fn(async (target: string, content: string) => { store.set(target, content) }),
    stat: vi.fn(async (target: string) => (store.has(target) ? { type: 'file', size: store.get(target)!.length } : undefined)),
  }
  return fs
}

function fakeCtx(fs: any): any {
  const sessions = {
    get: (id: string) => (id === 's1' ? { id: 's1', header: { cwd: CWD } } : undefined),
    list: () => [{ id: 's1', header: { cwd: CWD } }],
  }
  return { get: (name: string) => (name === 'fs' ? fs : name === 'sessions' ? sessions : name === 'sandboxPolicy' ? undefined : undefined) }
}

function bucketOf(records: DiffRecord[]): Map<string, DiffRecord> {
  return new Map(records.map((r) => [r.callId, r]))
}

describe('edrv.decideBatch', () => {
  it('批量采纳多记录：决策落盘且只写一次归档 + 一次 sidecar', async () => {
    const fs = fakeFs({})
    const ctx = fakeCtx(fs)
    const registry = new Map<string, Map<string, DiffRecord>>([
      [CWD, bucketOf([rec({ callId: 'a' }), rec({ callId: 'b' })])],
    ])
    const handlers = buildHandlers(ctx, registry)
    const res = await handlers['edrv.decideBatch']({ sessionId: 's1', items: [
      { callId: 'a', scope: 'hunk', hunkIndex: 0, decision: 'accepted' },
      { callId: 'b', scope: 'hunk', hunkIndex: 0, decision: 'accepted' },
    ] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.results).toHaveLength(2)
    expect(res.results.every((item) => item.ok)).toBe(true)
    expect(res.results.map((item) => item.record?.decisions.perHunk)).toEqual([['accepted'], ['accepted']])
    // 全部解决 → 已归档；仅一次归档写 + 一次 sidecar 写
    const recs = registry.get(CWD)!
    expect(recs.get('a')!.archived).toBe(true)
    expect(recs.get('b')!.archived).toBe(true)
    expect(fs.writeText.mock.calls.length).toBe(2)
  })

  it('含不存在记录的项报错，其余项正常处理', async () => {
    const fs = fakeFs({})
    const ctx = fakeCtx(fs)
    const registry = new Map<string, Map<string, DiffRecord>>([
      [CWD, bucketOf([rec({ callId: 'a' })])],
    ])
    const handlers = buildHandlers(ctx, registry)
    const res = await handlers['edrv.decideBatch']({ sessionId: 's1', items: [
      { callId: 'ghost', scope: 'hunk', hunkIndex: 0, decision: 'accepted' },
      { callId: 'a', scope: 'hunk', hunkIndex: 0, decision: 'accepted' },
    ] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.results[0]).toMatchObject({ callId: 'ghost', ok: false, error: '记录不存在' })
    expect(res.results[1].ok).toBe(true)
    expect(registry.get(CWD)!.get('a')!.archived).toBe(true)
  })

  it('rejected 项按顺序回滚文件并归档', async () => {
    const fs = fakeFs({ [CWD + '/a.ts']: 'b' })
    const ctx = fakeCtx(fs)
    const registry = new Map<string, Map<string, DiffRecord>>([
      [CWD, bucketOf([rec({ callId: 'a', hunks: [{ oldText: 'a', newText: 'b' }] })])],
    ])
    const handlers = buildHandlers(ctx, registry)
    const res = await handlers['edrv.decideBatch']({ sessionId: 's1', items: [
      { callId: 'a', scope: 'hunk', hunkIndex: 0, decision: 'rejected' },
    ] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.results[0].ok).toBe(true)
    expect(res.results[0].record?.decisions.perHunk).toEqual(['rejected'])
    // 文件已被反替换回 oldText
    const fileContent = await fs.readText(CWD + '/a.ts')
    expect(fileContent).toBe('a')
    expect(registry.get(CWD)!.get('a')!.archived).toBe(true)
    // 回滚文件写 + 归档写 + sidecar 写 = 3 次
    expect(fs.writeText.mock.calls.length).toBe(3)
  })

  it('rejected 回滚失败：该项报错且不改决策', async () => {
    // 磁盘内容与 hunk newText 不匹配 → 定位失败 → 回滚失败
    const fs = fakeFs({ [CWD + '/a.ts']: 'xxx' })
    const ctx = fakeCtx(fs)
    const registry = new Map<string, Map<string, DiffRecord>>([
      [CWD, bucketOf([rec({ callId: 'a', hunks: [{ oldText: 'a', newText: 'b' }] })])],
    ])
    const handlers = buildHandlers(ctx, registry)
    const res = await handlers['edrv.decideBatch']({ sessionId: 's1', items: [
      { callId: 'a', scope: 'hunk', hunkIndex: 0, decision: 'rejected' },
    ] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.results[0].ok).toBe(false)
    expect(String(res.results[0].error)).toContain('回滚失败')
    // 未写任何决策，也未归档
    expect(registry.get(CWD)!.get('a')!.decisions.perHunk).toEqual(['pending'])
    expect(registry.get(CWD)!.get('a')!.archived).toBe(false)
  })
})

describe('edrv.accept / edrv.reject 单条委托', () => {
  it('accept 单条返回 record 并归档', async () => {
    const fs = fakeFs({})
    const ctx = fakeCtx(fs)
    const registry = new Map<string, Map<string, DiffRecord>>([
      [CWD, bucketOf([rec({ callId: 'a' })])],
    ])
    const handlers = buildHandlers(ctx, registry)
    const res = await handlers['edrv.accept']({ sessionId: 's1', callId: 'a', scope: 'hunk', hunkIndex: 0 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.record?.decisions.perHunk).toEqual(['accepted'])
    expect(registry.get(CWD)!.get('a')!.archived).toBe(true)
    expect(fs.writeText.mock.calls.length).toBe(2)
  })

  it('reject 单条（call 作用域）整记录回滚', async () => {
    const fs = fakeFs({ [CWD + '/a.ts']: 'old' })
    const ctx = fakeCtx(fs)
    const registry = new Map<string, Map<string, DiffRecord>>([
      [CWD, bucketOf([rec({ callId: 'a' })])],
    ])
    const handlers = buildHandlers(ctx, registry)
    const res = await handlers['edrv.reject']({ sessionId: 's1', callId: 'a', scope: 'call' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.record?.decisions.call).toBe('rejected')
    expect(await fs.readText(CWD + '/a.ts')).toBe('old')
  })

  it('accept 不存在的记录返回 记录不存在', async () => {
    const fs = fakeFs({})
    const ctx = fakeCtx(fs)
    const registry = new Map<string, Map<string, DiffRecord>>([[CWD, bucketOf([])]])
    const handlers = buildHandlers(ctx, registry)
    const res = await handlers['edrv.accept']({ sessionId: 's1', callId: 'nope', scope: 'call' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('记录不存在')
  })
})

describe('edrv.list skipStale', () => {
  it('skipStale:true 跳过 stale 清理（幽灵差异保留），默认全量会归档', async () => {
    // ghost.ts 磁盘不存在 → recordIsStale 命中 missing → 默认 list 会自动归档
    const stale = rec({ callId: 'ghost', path: CWD + '/ghost.ts' })
    const fs = fakeFs({})
    const ctx = fakeCtx(fs)
    const registry = new Map<string, Map<string, DiffRecord>>([[CWD, bucketOf([stale])]])
    const handlers = buildHandlers(ctx, registry)

    const skipped = await handlers['edrv.list']({ sessionId: 's1', skipStale: true })
    expect(skipped.ok).toBe(true)
    if (!skipped.ok) return
    // 未清理 → ghost 仍在返回列表（未归档）
    expect(skipped.records.map((r) => r.callId)).toContain('ghost')

    const full = await handlers['edrv.list']({ sessionId: 's1' })
    expect(full.ok).toBe(true)
    if (!full.ok) return
    // 全量轮询触发 autoArchiveStale → ghost 被归档，不再出现在列表
    expect(full.records.map((r) => r.callId)).not.toContain('ghost')
    expect(registry.get(CWD)!.get('ghost')!.superseded).toBe(true)
  })
})
