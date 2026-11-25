/** 工具回执适配：官方三件套与 dsh-ops 回执的形状、强度与畸形降级。 @author ddj 2026年11月25号 */
import { describe, expect, it } from 'vitest'
import { receiptsOf } from '../src/pending/receipt.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('工具回执适配', () => {
  it('edit 结果里的前后全文直接成为权威回执', () => {
    const receipts = receiptsOf('edit', { value: { path: 'a.ts', before: 'A', after: 'B' } }, false)
    expect(receipts).toEqual([
      { path: 'a.ts', before: 'A', after: 'B', status: 'completed', strength: 'authoritative' },
    ])
  })

  it('write 新建把 null 当写前内容；缺少字段不猜', () => {
    expect(receiptsOf('write', { value: { path: 'c.ts', operation: 'create', before: null, after: 'C' } }, false))
      .toEqual([{ path: 'c.ts', before: null, after: 'C', status: 'completed', strength: 'authoritative' }])
    expect(receiptsOf('write', { value: { path: 'c.ts', after: 'C' } }, false)).toEqual([])
  })

  it('write 覆盖且后端不给写前内容时标 noBasis，不当成新建', () => {
    expect(receiptsOf('write', { value: { path: 'a.ts', operation: 'update', before: null, after: 'B' } }, false))
      .toEqual([{ path: 'a.ts', before: null, after: 'B', status: 'completed', noBasis: true, strength: 'authoritative' }])
  })

  it('edit 报错或没有 path 时不产出回执', () => {
    expect(receiptsOf('edit', { isError: true, value: { before: 'A', after: 'B' } }, true)).toEqual([])
    expect(receiptsOf('edit', { value: { before: 'A', after: 'B' } }, false)).toEqual([])
  })

  it('apply_patch 以每个操作的 changes 为准，失败操作里已写出的目标也算', () => {
    const receipts = receiptsOf('apply_patch', {
      value: {
        phase: 'commit',
        operations: [
          { status: 'completed', changes: [{ path: 'a.ts', before: 'A', after: 'B' }] },
          { status: 'failed', changes: [{ path: 'b.ts', before: null, after: 'B2' }] },
          { status: 'skipped' },
        ],
      },
    }, false)
    expect(receipts).toEqual([
      { path: 'a.ts', before: 'A', after: 'B', status: 'completed', strength: 'authoritative' },
      { path: 'b.ts', before: null, after: 'B2', status: 'failed', strength: 'authoritative' },
    ])
  })

  it('apply_patch 的预检拒绝没有 changes，不产出回执', () => {
    expect(receiptsOf('apply_patch', { value: { phase: 'preflight', operations: [] } }, true)).toEqual([])
  })

  it('ops_edit_file 的写前后哈希成为对账回执', () => {
    const receipts = receiptsOf('ops_edit_file', { value: { path: 'a.ts', revision: HASH_B, revisionBefore: HASH_A } }, false)
    expect(receipts).toEqual([
      { path: 'a.ts', revisionBefore: HASH_A, revisionAfter: HASH_B, status: 'completed', strength: 'receipt' },
    ])
  })

  it('ops 的 revisionBefore 不是哈希（如 absent）时不冒充写前值', () => {
    const receipts = receiptsOf('ops_write_file', { value: { path: 'c.ts', revision: HASH_B, revisionBefore: 'absent' } }, false)
    expect(receipts).toEqual([
      { path: 'c.ts', revisionBefore: undefined, revisionAfter: HASH_B, status: 'completed', strength: 'receipt' },
    ])
  })

  it('ops_move 只为目标产出回执；ops_remove 没有写后哈希，交给快照', () => {
    expect(receiptsOf('ops_move', { value: { path: 'a.ts', to: 'b.ts', revision: HASH_B } }, false))
      .toEqual([{ path: 'b.ts', revisionBefore: undefined, revisionAfter: HASH_B, status: 'completed', strength: 'receipt' }])
    expect(receiptsOf('ops_remove', { value: { path: 'a.ts', revision: HASH_A, removed: true } }, false)).toEqual([])
  })

  it('ops_replace 只认执行完成且带写后计划的条目', () => {
    const receipts = receiptsOf('ops_replace', {
      value: {
        items: [
          { path: 'a.ts', status: 'completed', revision: HASH_A, revisionAfter: HASH_B },
          { path: 'b.ts', status: 'pending', revision: HASH_A, revisionAfter: HASH_B },
          { path: 'c.ts', status: 'completed', revision: HASH_A },
        ],
      },
    }, false)
    expect(receipts).toEqual([
      { path: 'a.ts', revisionBefore: HASH_A, revisionAfter: HASH_B, status: 'completed', strength: 'receipt' },
    ])
  })

  it('未声明的工具与畸形结果一律为空', () => {
    expect(receiptsOf('ops_bash', { value: { revision: HASH_B } }, false)).toEqual([])
    expect(receiptsOf('edit', 'plain-string' as unknown, false)).toEqual([])
    expect(receiptsOf('edit', null, false)).toEqual([])
  })
})
