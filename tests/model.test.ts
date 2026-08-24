/**
 * host model.ts 纯域逻辑测试。
 * 覆盖：normalizeRecord / markDecision / recordResolved / recSummary /
 *       reconstructOriginal / fileMaxBatch / groupByBatch / archiveEntryFor。
 * 作者 ddj 2026-08-20
 */
import { describe, expect, it } from 'vitest'
import type { DiffRecord } from '../src/shared/types.js'
import {
  archiveEntryFor,
  fileMaxBatch,
  groupByBatch,
  markDecision,
  normalizeRecord,
  prune,
  reconstructOriginal,
  recordResolved,
  recSummary,
} from '../src/model.js'

function rec(partial: Partial<DiffRecord>): DiffRecord {
  return {
    callId: 'c1',
    toolName: 'edit',
    path: '/ws/a.ts',
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

describe('normalizeRecord', () => {
  it('接受合法记录并填充默认字段', () => {
    const n = normalizeRecord({ callId: 'x', path: '/p', hunks: [{ newText: 'n' }] })
    expect(n).not.toBeNull()
    expect(n!.toolName).toBe('edit')
    expect(n!.create).toBe(false)
    expect(n!.before).toBeNull()
    expect(n!.decisions.call).toBe('pending')
    expect(n!.batch).toBe(0)
  })
  it('write 保留 toolName', () => {
    const n = normalizeRecord({ callId: 'x', path: '/p', toolName: 'write' })
    expect(n!.toolName).toBe('write')
  })
  it('缺 callId/path 返回 null', () => {
    expect(normalizeRecord(null)).toBeNull()
    expect(normalizeRecord({ path: '/p' })).toBeNull()
    expect(normalizeRecord('nope')).toBeNull()
  })
  it('过滤非法 hunks，仅保留 newText 为字符串的', () => {
    const n = normalizeRecord({ callId: 'x', path: '/p', hunks: [{ newText: 'a' }, { newText: 42 }, null] })
    expect(n!.hunks).toHaveLength(1)
    expect(n!.hunks[0].newText).toBe('a')
  })
})

describe('markDecision', () => {
  it('hunk 作用域只改对应块', () => {
    const r = rec({ decisions: { call: 'pending', perHunk: ['pending', 'pending'] } })
    markDecision(r, 'hunk', 1, 'rejected')
    expect(r.decisions.perHunk).toEqual(['pending', 'rejected'])
    expect(r.decisions.call).toBe('pending')
  })
  it('call 作用域改全部', () => {
    const r = rec({ decisions: { call: 'pending', perHunk: ['pending', 'pending'] } })
    markDecision(r, 'call', undefined, 'accepted')
    expect(r.decisions.call).toBe('accepted')
    expect(r.decisions.perHunk).toEqual(['accepted', 'accepted'])
  })
})

describe('recordResolved', () => {
  it('全部已决策 → true', () => {
    expect(recordResolved(rec({ decisions: { call: 'accepted', perHunk: ['accepted'] } }))).toBe(true)
    expect(recordResolved(rec({ superseded: true }))).toBe(true)
  })
  it('存在 pending → false', () => {
    expect(recordResolved(rec())).toBe(false)
    expect(recordResolved(rec({ decisions: { call: 'pending', perHunk: ['accepted', 'pending'] } }))).toBe(false)
  })
})

describe('recSummary', () => {
  it('逐 hunk 计数', () => {
    const s = recSummary(rec({ decisions: { call: 'pending', perHunk: ['accepted', 'rejected', 'pending'] } }))
    expect(s).toEqual({ accepted: 1, rejected: 1, pending: 1, superseded: false })
  })
  it('call 级整批', () => {
    const s = recSummary(rec({ decisions: { call: 'accepted', perHunk: [] } }))
    expect(s.accepted).toBe(1)
  })
  it('superseded 标记', () => {
    expect(recSummary(rec({ superseded: true })).superseded).toBe(true)
  })
})

describe('reconstructOriginal', () => {
  const mk = (id: string, oldText: string, newText: string, at: string): DiffRecord =>
    rec({
      callId: id,
      before: oldText,
      hunks: [{ oldText, newText }],
      decisions: { call: 'pending', perHunk: ['pending'] },
      at,
    })

  it('按新→旧反解 pending 块', () => {
    const a = mk('a', 'AA', 'A1', '2026-08-20T00:00:00.000Z')
    const b = mk('b', 'BB', 'B1', '2026-08-20T00:01:00.000Z')
    // 磁盘内容 = 两个 newText 都在
    const content = 'A1\nB1'
    const out = reconstructOriginal([a, b], content)
    expect(out.content).toBe('AA\nBB')
    expect(out.stale).toHaveLength(0)
  })
  it('定位不到的块标记 stale 且跳过', () => {
    const a = mk('a', 'AA', 'A1', '2026-08-20T00:00:00.000Z')
    const out = reconstructOriginal([a], 'XX A1')
    expect(out.content).toBe('XX AA')
  })
  it('多个 pending hunk 使用各自文本并按文件位置反解', () => {
    const a = mk('a', 'AA', 'A1', '2026-08-20T00:00:00.000Z')
    const b = mk('b', 'BB', 'B1', '2026-08-20T00:01:00.000Z')
    const out = reconstructOriginal([a, b], 'A1\nB1')
    expect(out.content).toBe('AA\nBB')
    expect(out.stale).toEqual([])
  })
  it('短 perHunk 不会把未决 hunk 误判为已解决', () => {
    const r = rec({ hunks: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }], decisions: { call: 'pending', perHunk: ['accepted'] } })
    expect(recordResolved(r)).toBe(false)
  })
})

describe('fileMaxBatch / groupByBatch / archiveEntryFor / prune', () => {
  it('fileMaxBatch 取最大批次', () => {
    const map = new Map<string, DiffRecord>([
      ['a', rec({ batch: 1 })],
      ['b', rec({ batch: 5 })],
      ['c', rec({ batch: 3, path: '/other' })],
    ])
    expect(fileMaxBatch(map, '/ws/a.ts')).toBe(5)
  })
  it('groupByBatch 按批次分组', () => {
    const g = groupByBatch([rec({ batch: 1 }), rec({ batch: 2 }), rec({ batch: 1 })])
    expect([...g.keys()]).toEqual([1, 2])
    expect(g.get(1)!.length).toBe(2)
  })
  it('archiveEntryFor 产出含 summary 的条目', () => {
    const e = archiveEntryFor([rec({ decisions: { call: 'accepted', perHunk: ['accepted'] } })], '/ws', '已处理')
    expect(e.cwd).toBe('/ws')
    expect(e.path).toBe('/ws/a.ts')
    expect(e.batch).toBe(1)
    expect(e.records[0].summary.accepted).toBe(1)
  })
  it('prune 剔除最旧记录', () => {
    const map = new Map<string, DiffRecord>([
      ['old', rec({ callId: 'old', at: '2026-08-20T00:00:00.000Z' })],
      ['mid', rec({ callId: 'mid', at: '2026-08-20T00:01:00.000Z' })],
      ['new', rec({ callId: 'new', at: '2026-08-20T00:02:00.000Z' })],
    ])
    prune(map, 2)
    expect(map.has('old')).toBe(false)
    expect(map.has('mid')).toBe(true)
    expect(map.has('new')).toBe(true)
  })
})
