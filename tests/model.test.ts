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
  findCanceledPairs,
  findInversePrior,
  fullyPending,
  groupByBatch,
  hunksInverse,
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
  it('remote_ssh_write 保留 toolName（issue #7）', () => {
    const n = normalizeRecord({ callId: 'x', path: '/p', toolName: 'remote_ssh_write' })
    expect(n!.toolName).toBe('remote_ssh_write')
  })
  it('未知 toolName 回退 edit（旧记录语义不变）', () => {
    const n = normalizeRecord({ callId: 'x', path: '/p', toolName: 'weird' })
    expect(n!.toolName).toBe('edit')
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

describe('过程抵消 · 整记录逆反', () => {
  /**
   * @private
   * @author ddj 2026年10月10号
   * 构造同一文件的往返快照，复用已有记录 fixture。
   * @param partial 后记录覆盖字段
   * @returns 新增与移除两条未决记录
   */
  function cancelPair(partial: Partial<DiffRecord> = {}): [DiffRecord, DiffRecord] {
    const added = rec({ callId: 'add', before: 'base\n', after: 'base\ndebug\n',
      hunks: [{ oldText: '', newText: 'debug\n' }], batch: 1 })
    const removed = rec({ callId: 'remove', before: added.after!, after: added.before,
      hunks: [{ oldText: 'debug\n', newText: '' }], batch: 2, ...partial })
    return [added, removed]
  }

  it('整组逐块逆反成立；数量不等、非逆反、空组、新建和纯 noop 不匹配', () => {
    const a = [{ oldText: 'a', newText: 'b' }, { oldText: '', newText: 'debug' }]
    const b = [{ oldText: 'b', newText: 'a' }, { oldText: 'debug', newText: '' }]
    expect(hunksInverse(a, b)).toBe(true)
    expect(hunksInverse(a, b.slice(0, 1))).toBe(false)
    expect(hunksInverse(a, a)).toBe(false)
    expect(hunksInverse([], [])).toBe(false)
    expect(hunksInverse([{ oldText: null, newText: 'x' }], [{ oldText: 'x', newText: '' }])).toBe(false)
    expect(hunksInverse([{ oldText: 'x', newText: 'x' }], [{ oldText: 'x', newText: 'x' }])).toBe(false)
  })

  it('BOM/CRLF 采用既有比较口径归一化，归一化 noop 不配对', () => {
    expect(hunksInverse([{ oldText: '\uFEFFa\r\n', newText: 'b\r\n' }],
      [{ oldText: 'b\n', newText: 'a\n' }])).toBe(true)
    expect(hunksInverse([{ oldText: 'a\r\n', newText: 'a\n' }],
      [{ oldText: 'a\n', newText: 'a\r\n' }])).toBe(false)
    const [a, b] = cancelPair({ before: '\uFEFFbase\r\ndebug\r\n', after: 'base\r\n' })
    expect(findInversePrior([a], b)).toBe(a)
  })

  it('全部 pending 才允许抵消，缺少 perHunk 沿用 call 状态', () => {
    expect(fullyPending(rec({}))).toBe(true)
    expect(fullyPending(rec({ decisions: { call: 'pending', perHunk: [] } }))).toBe(true)
    expect(fullyPending(rec({ archived: true }))).toBe(false)
    expect(fullyPending(rec({ superseded: true }))).toBe(false)
    expect(fullyPending(rec({ decisions: { call: 'accepted', perHunk: ['pending'] } }))).toBe(false)
    expect(fullyPending(rec({ decisions: { call: 'pending', perHunk: ['rejected'] } }))).toBe(false)
  })

  it('相同时间仍可由不同捕获批次确认先后，不改变输入记录', () => {
    const [a, b] = cancelPair()
    const records = [b, a]
    const snapshot = JSON.stringify(records)
    expect(findInversePrior(records, b)).toBe(a)
    expect(findCanceledPairs(records)).toEqual([[a, b]])
    expect(JSON.stringify(records)).toBe(snapshot)
  })

  it('文本互换但在不同位置修改时不抵消', () => {
    const a = rec({ callId: 'a', before: 'one a / two b', after: 'one b / two b', batch: 1 })
    const b = rec({ callId: 'b', before: a.after!, after: 'one b / two a',
      hunks: [{ oldText: 'b', newText: 'a' }], batch: 2 })
    expect(hunksInverse(a.hunks, b.hunks)).toBe(true)
    expect(findInversePrior([a], b)).toBeNull()
  })

  it('不隐藏不同路径、部分撤销或移除时夹带真实修改的记录', () => {
    const [a, b] = cancelPair()
    expect(findInversePrior([a], { ...b, path: '/other' })).toBeNull()
    expect(findInversePrior([a], { ...b, hunks: [{ oldText: 'debug', newText: '' }] })).toBeNull()
    expect(findInversePrior([a], { ...b, after: 'base changed\n' })).toBeNull()
    expect(findInversePrior([a], { ...b, hunks: [...b.hunks, { oldText: 'base', newText: 'new' }] })).toBeNull()
  })

  it('缺失快照、新建后清空和 noop 都保留审查', () => {
    const [a, b] = cancelPair()
    expect(findInversePrior([{ ...a, after: undefined }], b)).toBeNull()
    expect(findInversePrior([a], { ...b, before: null })).toBeNull()
    expect(findInversePrior([{ ...a, before: null, create: true }], b)).toBeNull()
    expect(findInversePrior([{ ...a, create: true }], b)).toBeNull()
    const noop = rec({ before: 'x', after: 'x', hunks: [{ oldText: 'x', newText: 'x' }] })
    expect(findCanceledPairs([noop, { ...noop, callId: 'n2', batch: 2 }])).toEqual([])
  })

  it.each(['accepted', 'rejected'] as const)('任一方已有 %s 决策时不抵消', (value) => {
    const [a, b] = cancelPair()
    expect(findInversePrior([{ ...a, decisions: { call: value, perHunk: [] } }], b)).toBeNull()
    expect(findInversePrior([a], { ...b, decisions: { call: 'pending', perHunk: [value] } })).toBeNull()
  })

  it('已归档或已覆盖任一方不再配对', () => {
    const [a, b] = cancelPair()
    expect(findCanceledPairs([{ ...a, archived: true }, b])).toEqual([])
    expect(findCanceledPairs([a, { ...b, superseded: true }])).toEqual([])
  })

  it('优先批次顺序；批次不能证明先后时须有严格有效时间，不能靠 callId', () => {
    const [a, b] = cancelPair()
    expect(findInversePrior([a], { ...b, batch: 0 })).toBeNull()
    expect(findInversePrior([a], { ...b, batch: 1, at: 'invalid' })).toBeNull()
    expect(findInversePrior([a], { ...b, batch: 0, at: '2026-08-20T00:01:00.000Z' })).toBe(a)
    expect(findInversePrior([a], { ...b, batch: 0, at: '2026-08-19T00:00:00.000Z' })).toBeNull()
    expect(findInversePrior([a], { ...b, batch: 2, at: '2026-08-19T00:00:00.000Z' })).toBe(a)
  })

  it('挑选最近候选；多对和奇数次往返每条最多配一次', () => {
    const [a, b] = cancelPair()
    const newer = { ...a, callId: 'newer', batch: 2 }
    expect(findInversePrior([a, newer], { ...b, batch: 3 })).toBe(newer)
    const c = { ...a, callId: 'add-again', batch: 3 }
    const d = { ...b, callId: 'remove-again', batch: 4 }
    expect(findCanceledPairs([d, b, c, a])).toEqual([[a, b], [c, d]])
    expect(findCanceledPairs([a, b, c])).toEqual([[a, b]])
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
  it('prune 不淘汰未决记录，只清除已归档且已解决的记录', () => {
    const map = new Map<string, DiffRecord>([
      ['old', rec({ callId: 'old', at: '2026-08-20T00:00:00.000Z' })],
      ['mid', rec({ callId: 'mid', at: '2026-08-20T00:01:00.000Z' })],
      ['new', rec({ callId: 'new', at: '2026-08-20T00:02:00.000Z' })],
    ])
    prune(map, 2)
    expect(map.size).toBe(3)
    map.set('done', rec({ callId: 'done', archived: true, decisions: { call: 'accepted', perHunk: ['accepted'] } }))
    prune(map, 2)
    expect(map.has('done')).toBe(false)
    expect(map.has('old')).toBe(true)
    expect(map.has('mid')).toBe(true)
    expect(map.has('new')).toBe(true)
  })
})
