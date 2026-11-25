/** 采集判定闸门：真实改动 / 无效果 / 失败 / 未证实四种结局与降级开关。 @author ddj 2026年11月25号 */
import { describe, expect, it } from 'vitest'
import { gateModeOf, norm, verdictOf } from '../src/pending/verdict.js'
import type { EvidenceInput } from '../src/pending/verdict.js'
import type { ToolReceipt } from '../src/pending/receipt.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 构造一次带基线的判定输入。
 * @param patch 覆盖字段
 * @returns 判定输入
 */
function inputOf(patch: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    isError: false, hasBaseline: true, beforeRead: 'A', afterRead: 'B',
    hashBefore: HASH_A, hashAfter: HASH_B, ...patch,
  }
}

describe('采集判定闸门', () => {
  it('没有回执时沿用快照比较', () => {
    expect(verdictOf(inputOf()).verdict).toBe('changed')
    expect(verdictOf(inputOf()).evidence).toBe('snapshot')
    expect(verdictOf(inputOf({ afterRead: 'A' })).verdict).toBe('noop')
  })

  it('工具报错且没有回执效果时判失败，不建条目', () => {
    const judged = verdictOf(inputOf({ isError: true }))
    expect(judged.verdict).toBe('failed')
    expect(judged.evidence).toBe('none')
  })

  it('权威回执与磁盘一致时判真实改动', () => {
    const receipt: ToolReceipt = { path: 'a.ts', before: 'A', after: 'B', status: 'completed', strength: 'authoritative' }
    const judged = verdictOf(inputOf({ receipt }))
    expect(judged).toMatchObject({ verdict: 'changed', evidence: 'authoritative' })
  })

  it('回执说没变但磁盘变了，判未证实', () => {
    const receipt: ToolReceipt = { path: 'a.ts', before: 'A', after: 'A', status: 'completed', strength: 'authoritative' }
    expect(verdictOf(inputOf({ receipt })).verdict).toBe('unverified')
  })

  it('写后或写前内容与磁盘对不上，判未证实', () => {
    const after: ToolReceipt = { path: 'a.ts', before: 'A', after: 'X', status: 'completed', strength: 'authoritative' }
    const before: ToolReceipt = { path: 'a.ts', before: 'X', after: 'B', status: 'completed', strength: 'authoritative' }
    expect(verdictOf(inputOf({ receipt: after })).verdict).toBe('unverified')
    expect(verdictOf(inputOf({ receipt: before })).verdict).toBe('unverified')
  })

  it('行尾与 BOM 差异只做归一比较，不算冲突', () => {
    const receipt: ToolReceipt = { path: 'a.ts', before: 'A\r\n', after: 'B\r\n', status: 'completed', strength: 'authoritative' }
    const judged = verdictOf(inputOf({ receipt, beforeRead: '\uFEFFA\n', afterRead: 'B\n' }))
    expect(judged.verdict).toBe('changed')
  })

  it('写前是 null 的新建文件照常判真实改动', () => {
    const receipt: ToolReceipt = { path: 'c.ts', before: null, after: 'C', status: 'completed', strength: 'authoritative' }
    const judged = verdictOf(inputOf({ receipt, beforeRead: null, afterRead: 'C', hashBefore: null }))
    expect(judged.verdict).toBe('changed')
  })

  it('没有写前基线时用回执前像补，不判冲突', () => {
    const receipt: ToolReceipt = { path: 'a.ts', before: 'A', after: 'B', status: 'completed', strength: 'authoritative' }
    const judged = verdictOf(inputOf({ receipt, hasBaseline: false, beforeRead: null, hashBefore: null }))
    expect(judged.verdict).toBe('changed')
  })

  it('后端不给写前内容时用自有快照判变化，没有快照则拒绝', () => {
    const receipt: ToolReceipt = {
      path: 'a.ts', before: null, after: 'B', status: 'completed', noBasis: true, strength: 'authoritative',
    }
    expect(verdictOf(inputOf({ receipt, beforeRead: 'A', afterRead: 'B' })).verdict).toBe('changed')
    expect(verdictOf(inputOf({ receipt, hasBaseline: false, beforeRead: null, hashBefore: null })).verdict)
      .toBe('unverified')
  })

  it('哈希回执双向对上才算数', () => {
    const receipt: ToolReceipt = { path: 'a.ts', revisionBefore: HASH_A, revisionAfter: HASH_B, status: 'completed', strength: 'receipt' }
    expect(verdictOf(inputOf({ receipt })).verdict).toBe('changed')
    expect(verdictOf(inputOf({ receipt: { ...receipt, revisionAfter: HASH_A } })).verdict).toBe('unverified')
    expect(verdictOf(inputOf({ receipt, hashAfter: HASH_A })).verdict).toBe('unverified')
    expect(verdictOf(inputOf({ receipt, hasBaseline: false, hashBefore: null })).verdict).toBe('unverified')
  })

  it('哈希回执缺写前哈希时只接受新建', () => {
    const receipt: ToolReceipt = { path: 'c.ts', revisionAfter: HASH_B, status: 'completed', strength: 'receipt' }
    expect(verdictOf(inputOf({ receipt, beforeRead: null, hashBefore: null })).verdict).toBe('changed')
    expect(verdictOf(inputOf({ receipt })).verdict).toBe('unverified')
  })

  it('warn 模式把未证实降级为快照条目并带上原因', () => {
    const receipt: ToolReceipt = { path: 'a.ts', before: 'A', after: 'X', status: 'completed', strength: 'authoritative' }
    const judged = verdictOf(inputOf({ receipt }), 'warn')
    expect(judged.verdict).toBe('changed')
    expect(judged.evidence).toBe('snapshot')
    expect(judged.reason).toContain('写后内容与磁盘不一致')
  })

  it('off 模式完全退回旧行为', () => {
    const receipt: ToolReceipt = { path: 'a.ts', before: 'A', after: 'X', status: 'completed', strength: 'authoritative' }
    expect(verdictOf(inputOf({ receipt, isError: true }), 'off').verdict).toBe('changed')
  })

  it('闸门模式只认显式取值，写错按 strict', () => {
    expect(gateModeOf({ DSH_EDIT_REVIEW_RECEIPT_GATE: 'off' })).toBe('off')
    expect(gateModeOf({ DSH_EDIT_REVIEW_RECEIPT_GATE: 'WARN' })).toBe('warn')
    expect(gateModeOf({ DSH_EDIT_REVIEW_RECEIPT_GATE: 'nonsense' })).toBe('strict')
    expect(gateModeOf({})).toBe('strict')
  })

  it('归一函数只去 BOM 与 CRLF', () => {
    expect(norm('\uFEFFa\r\nb')).toBe('a\nb')
    expect(norm(null)).toBeNull()
  })
})
