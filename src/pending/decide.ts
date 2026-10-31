/**
 * 待审判定内核：Keep 只推进投影，Revert 才写磁盘；写盘由注入的 writer 完成以便测试零写断言。
 * @author ddj 2026年10月29号
 */
import type { PendingDecide } from '../shared/pendingReview.js'
import type { ReviewBlock, ReviewBlockState } from '../shared/reviewRegions.js'
import { reviewBlocks } from '../shared/reviewRegions.js'
import type { OfficialDiff } from '../shared/review.js'
import { keepBlock, revertBlock, textDiff } from './hunks.js'
import type { PendingEntry } from './kernel.js'
import { applyUpdate, isSettled } from './kernel.js'
import type { PendingFlags } from './persist.js'

/** 写盘结果：`content` 是读回校验通过后的最终内容，null 表示删除。 */
export type WriteResult = { ok: true; content: string | null } | { ok: false; reason: string }

/** 写盘能力，由 host 侧实现；纯判定层只调用它一次。 */
export type WriteBack = (content: string | null) => Promise<WriteResult>

/** 一次判定的输入。 */
export interface DecideInput {
  request: PendingDecide
  entry: PendingEntry
  flags: PendingFlags
  blocks: ReviewBlockState[]
  now: number
  write: WriteBack
}

/** 一次判定的输出。 */
export interface DecideOutcome {
  ok: boolean
  reason: string
  entry: PendingEntry
  flags: PendingFlags
  blocks: ReviewBlockState[]
  /** 是否真正写过磁盘（Keep 恒为 false）。 */
  wrote: boolean
}

/**
 * @author ddj 2026年10月29号
 * @description: 执行一次 Keep/Revert；失败时返回原状态，调用方不得落库。
 * @param input 判定输入
 * @returns 判定结果
 */
export async function decide(input: DecideInput): Promise<DecideOutcome> {
  const failed = (reason: string): DecideOutcome => ({
    ok: false, reason, entry: input.entry, flags: input.flags, blocks: input.blocks, wrote: false,
  })
  if (input.request.revision !== input.flags.revision) return failed('revision-mismatch')
  if (input.flags.oversized) return failed('oversized')
  if (input.entry.oldText === input.entry.newText) return failed('settled')

  const diff = textDiff(input.entry.path, input.entry.path, input.entry.oldText, input.entry.newText)
  const targets = pickBlocks(reviewBlocks(diff), input)
  if (targets === null) return failed('unknown-block')
  if (input.request.scope !== 'file' && input.request.scope !== 'all' && targets.length === 0) {
    return failed('no-block')
  }
  const isKeep = input.request.decision === 'accepted'
  const whole = input.request.scope === 'file' || input.request.scope === 'all'
  return isKeep ? keep(input, targets, whole) : revert(input, targets, whole)
}

/**
 * @author ddj 2026年10月29号
 * @description: Keep：只把目标块或整文件的新内容并入基线，绝不写目标文件。
 * @param input 判定输入
 * @param targets 目标块（整文件时为空）
 * @param whole 是否整文件
 * @returns 判定结果
 */
function keep(input: DecideInput, targets: ReviewBlock[], whole: boolean): DecideOutcome {
  if (whole) {
    const entry = applyUpdate(input.entry, { oldText: input.entry.newText }, input.now)
    return {
      ok: true, reason: '', entry, wrote: false,
      flags: { ...input.flags, revision: input.flags.revision + 1 },
      blocks: markAll(input.blocks, targets, 'accepted'),
    }
  }
  let oldText = input.entry.oldText
  for (const block of targets) {
    const next = keepBlock(oldText, block)
    if (next === null) {
      return { ok: false, reason: 'ambiguous-block', entry: input.entry, flags: input.flags, blocks: input.blocks, wrote: false }
    }
    oldText = next
  }
  const entry = applyUpdate(input.entry, { oldText }, input.now)
  return {
    ok: true, reason: '', entry, wrote: false,
    flags: { ...input.flags, revision: input.flags.revision + 1 },
    blocks: markAll(input.blocks, targets, 'accepted'),
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: Revert：合成回退内容后交给 writer 写盘并读回，写失败则状态不变。
 * @param input 判定输入
 * @param targets 目标块（整文件时为空）
 * @param whole 是否整文件
 * @returns 判定结果
 */
async function revert(input: DecideInput, targets: ReviewBlock[], whole: boolean): Promise<DecideOutcome> {
  const failed = (reason: string): DecideOutcome => ({
    ok: false, reason, entry: input.entry, flags: input.flags, blocks: input.blocks, wrote: false,
  })
  const next = whole ? wholeRevert(input.entry) : blockRevert(input.entry, targets)
  if (next === undefined) return failed('ambiguous-block')

  const written = await input.write(next)
  if (!written.ok) return failed(written.reason)

  const entry = applyUpdate(input.entry, { newText: written.content ?? '' }, input.now)
  return {
    ok: true, reason: '', entry, wrote: true,
    flags: { ...input.flags, revision: input.flags.revision + 1, missing: written.content === null },
    blocks: markAll(input.blocks, targets, 'rejected'),
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 整文件回退目标：基线为"文件不存在"时删除，否则写回基线全文。
 * @param entry 待审条目
 * @returns 目标内容，null 表示删除
 */
function wholeRevert(entry: PendingEntry): string | null {
  return entry.earlierVersion === 'none' ? null : entry.oldText
}

/**
 * @author ddj 2026年10月29号
 * @description: 块级回退：在最新内容里依次换回目标块，任一不可定位即整体放弃。
 * @param entry 待审条目
 * @param targets 目标块
 * @returns 新内容或 undefined
 */
function blockRevert(entry: PendingEntry, targets: ReviewBlock[]): string | null | undefined {
  let newText = entry.newText
  for (const block of targets) {
    const next = revertBlock(newText, block)
    if (next === null) return undefined
    newText = next
  }
  return newText
}

/**
 * @author ddj 2026年10月29号
 * @description: 按请求粒度挑出目标块；块不存在时返回 null 以区分"没有块"。
 * @param blocks 当前差异块
 * @param input 判定输入
 * @returns 目标块，未知块 ID 时为 null
 */
function pickBlocks(blocks: ReviewBlock[], input: DecideInput): ReviewBlock[] | null {
  const scope = input.request.scope
  if (scope === 'file' || scope === 'all') return []
  if (scope === 'block') {
    const block = blocks.find((item) => item.id === input.request.blockId)
    return block ? [block] : null
  }
  const start = input.request.startLine ?? 0
  const end = input.request.endLine ?? start
  return blocks.filter((block) => block.newStart <= end && block.newStart + Math.max(block.newLines.length, 1) >= start)
}

/**
 * @author ddj 2026年10月29号
 * @description: 把目标块标记为已决定；整文件时把全部块一起标记。
 * @param states 已存块决定
 * @param targets 目标块
 * @param decision 决定
 * @returns 新的块决定列表
 */
function markAll(states: ReviewBlockState[], targets: ReviewBlock[], decision: 'accepted' | 'rejected'): ReviewBlockState[] {
  const next = states.slice()
  for (const block of targets) {
    const at = next.findIndex((state) => state.id === block.id)
    if (at >= 0) next[at] = { id: block.id, decision }
    else next.push({ id: block.id, decision })
  }
  return next
}

/**
 * @author ddj 2026年10月29号
 * @description: 能力口径：Keep 恒可；Revert 受超大/缺失/已解决限制，拒绝原因要能展示。
 * @param entry 待审条目
 * @param flags 持久标记
 * @returns 能力与原因
 */
export function capabilityOf(entry: PendingEntry, flags: PendingFlags): { keep: boolean; revert: boolean; reason: string } {
  if (isSettled(entry)) return { keep: false, revert: false, reason: 'settled' }
  if (flags.oversized) return { keep: false, revert: false, reason: 'oversized' }
  if (entry.earlierVersion === 'none' && entry.newText.length === 0) {
    return { keep: true, revert: false, reason: 'empty-create' }
  }
  return { keep: true, revert: true, reason: '' }
}

/**
 * @author ddj 2026年10月29号
 * @description: 供详情接口复用的差异构造。
 * @param entry 待审条目
 * @param baselineEmpty 基线置空：文件由本次会话新建，旧基线只是会话自己的中间产物
 * @returns 官方差异
 */
export function diffOf(entry: PendingEntry, baselineEmpty = false): OfficialDiff {
  if (!baselineEmpty) return textDiff(entry.path, entry.path, entry.oldText, entry.newText)
  // 空基线在按行切分时会留下一个空行，差异里会多出一条「删空行」；新增文件应当只有新增行，
  // 与官方整文件新增块（oldLines=0、全是 + 行）保持同一形状。
  if (entry.newText === '') return textDiff(entry.path, entry.path, '', '')
  const diff = textDiff(entry.path, entry.path, '', entry.newText)
  if (diff.kind !== 'text') return diff
  return { ...diff, hunks: diff.hunks.map((hunk) => ({ ...hunk, oldLines: 0, lines: hunk.lines.filter((line) => line !== '-') })) }
}
