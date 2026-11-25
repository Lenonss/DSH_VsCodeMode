/**
 * 采集判定闸门：工具回执、磁盘快照、调用成败三者对账，决定这次调用算不算真实改动。
 * 对不上就不建条目（strict），只记缺口；warn 降级为快照条目，off 完全退回旧行为。
 * @author ddj 2026年11月25号
 */
import type { PendingEvidence, PendingVerdict } from '../shared/pendingReview.js'
import type { ToolReceipt } from './receipt.js'

/** 闸门开关的环境变量名：strict（默认）/ warn / off。 */
export const GATE_ENV = 'DSH_EDIT_REVIEW_RECEIPT_GATE'

/** 闸门模式。 */
export type GateMode = 'strict' | 'warn' | 'off'

/** 一次判定的输入：回执 + 自己的快照 + 成败。 */
export interface EvidenceInput {
  receipt?: ToolReceipt
  isError: boolean
  /** 写前是否取到了原始快照；取不到（并发占用）时用回执文本补基线。 */
  hasBaseline: boolean
  beforeRead: string | null
  afterRead: string | null
  hashBefore: string | null
  hashAfter: string | null
}

/** 判定结果。 */
export interface VerdictOutcome {
  verdict: PendingVerdict
  evidence: PendingEvidence
  /** 拒绝或降级的原因，写进缺口。 */
  reason: string
}

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 读闸门模式；未知值按 strict 处理，避免配置写错就静默放行。
 * @param env 环境变量表
 * @returns 闸门模式
 */
export function gateModeOf(env: Record<string, string | undefined> = process.env): GateMode {
  const raw = String(env[GATE_ENV] ?? '').trim().toLowerCase()
  if (raw === 'off') return 'off'
  if (raw === 'warn') return 'warn'
  return 'strict'
}

/**
 * @author ddj 2026年11月25号
 * @description: 只用于比对的归一：去掉 BOM、统一行尾；绝不用于写回。
 * @param text 一侧文本
 * @returns 归一后的文本
 */
export function norm(text: string | null): string | null {
  return text === null ? null : text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 结论构造。
 * @param verdict 结局
 * @param evidence 证据强度
 * @param reason 原因
 * @returns 判定结果
 */
function outcomeOf(verdict: PendingVerdict, evidence: PendingEvidence, reason: string): VerdictOutcome {
  return { verdict, evidence, reason }
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 没有回执时的兜底：沿用今天的快照比较。
 * @param input 判定输入
 * @returns 判定结果
 */
function snapshotOf(input: EvidenceInput): VerdictOutcome {
  return input.beforeRead === input.afterRead
    ? outcomeOf('noop', 'snapshot', '前后内容相同')
    : outcomeOf('changed', 'snapshot', '')
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 权威回执：用回执的前后全文核对磁盘，写前写后都对得上才算数。
 * @param receipt 工具回执
 * @param input 判定输入
 * @returns 判定结果
 */
function textOutcome(receipt: ToolReceipt, input: EvidenceInput): VerdictOutcome {
  if (receipt.after === undefined) return outcomeOf('unverified', 'authoritative', '回执没有写后内容')
  if (norm(receipt.after) !== norm(input.afterRead)) {
    return outcomeOf('unverified', 'authoritative', '写后内容与磁盘不一致')
  }
  // 后端明确说不给写前内容（超大/二进制）：写前用我们自己的快照，写后已由回执核对。
  if (receipt.noBasis === true) {
    if (!input.hasBaseline) return outcomeOf('unverified', 'authoritative', '回执没有写前内容，无法补基线')
    return norm(input.beforeRead) === norm(input.afterRead)
      ? outcomeOf('noop', 'authoritative', '前后内容相同')
      : outcomeOf('changed', 'authoritative', '')
  }
  if (input.hasBaseline) {
    if (norm(receipt.before ?? null) !== norm(input.beforeRead)) {
      return outcomeOf('unverified', 'authoritative', '写前内容与磁盘不一致')
    }
  } else if (receipt.before === undefined) {
    return outcomeOf('unverified', 'authoritative', '回执没有写前内容，无法补基线')
  }
  return norm(receipt.before ?? null) === norm(receipt.after)
    ? outcomeOf('noop', 'authoritative', '回执前后相同')
    : outcomeOf('changed', 'authoritative', '')
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 哈希回执：写后哈希必须等于磁盘，写前哈希（若有）必须等于快照。
 * @param receipt 工具回执
 * @param input 判定输入
 * @returns 判定结果
 */
function hashOutcome(receipt: ToolReceipt, input: EvidenceInput): VerdictOutcome {
  if (!receipt.revisionAfter) return outcomeOf('unverified', 'receipt', '回执没有写后哈希')
  if (input.hashAfter !== receipt.revisionAfter) return outcomeOf('unverified', 'receipt', '写后哈希与磁盘不一致')
  if (!input.hasBaseline) return outcomeOf('unverified', 'receipt', '没有写前快照，无法对账哈希')
  if (!receipt.revisionBefore) {
    return input.hashBefore === null
      ? outcomeOf('changed', 'receipt', '')
      : outcomeOf('unverified', 'receipt', '回执没有写前哈希')
  }
  if (input.hashBefore !== receipt.revisionBefore) return outcomeOf('unverified', 'receipt', '写前哈希与磁盘不一致')
  return receipt.revisionBefore === receipt.revisionAfter
    ? outcomeOf('noop', 'receipt', '回执前后哈希相同')
    : outcomeOf('changed', 'receipt', '')
}

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 按回执强度选核对口径。
 * @param receipt 工具回执
 * @param input 判定输入
 * @returns 判定结果
 */
function receiptOutcome(receipt: ToolReceipt, input: EvidenceInput): VerdictOutcome {
  return receipt.strength === 'authoritative' ? textOutcome(receipt, input) : hashOutcome(receipt, input)
}

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 一次写入的结局判定；只有 changed 值得建待审条目。
 * @param input 回执、快照与成败
 * @param mode 闸门模式（缺省读环境变量）
 * @returns 结局、证据强度与原因
 */
export function verdictOf(input: EvidenceInput, mode: GateMode = gateModeOf()): VerdictOutcome {
  const snapshot = snapshotOf(input)
  if (mode === 'off') return snapshot
  if (input.isError && !input.receipt) {
    return outcomeOf('failed', 'none', '工具报错，没有可采信的效果')
  }
  if (!input.receipt) return snapshot
  const judged = receiptOutcome(input.receipt, input)
  if (judged.verdict !== 'unverified') return judged
  return mode === 'warn' ? { ...snapshot, reason: judged.reason } : judged
}
