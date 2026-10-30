/**
 * 待审内核的行为测试：累计基线、归零、块级 granularity、零写入与写失败不变。
 * @author ddj 2026年10月29号
 */
import { describe, expect, it } from 'vitest'
import type { PendingDecide } from '../src/shared/pendingReview.js'
import { reviewBlocks } from '../src/shared/reviewRegions.js'
import { decide, capabilityOf, diffOf } from '../src/pending/decide.js'
import { textDiff, revertBlock } from '../src/pending/hunks.js'
import type { PendingEntry } from '../src/pending/kernel.js'
import {
  applyUpdate, byUpdatedAt, ContentVersions, entryFromNew, isSettled, mergeEntries, touchSeen, withUnseen,
} from '../src/pending/kernel.js'
import type { PendingFlags } from '../src/pending/persist.js'
import { foldWrite, itemOf, refreshed } from '../src/pending/store.js'

/** 未配置标记的默认值。 */
const FLAGS: PendingFlags = { missing: false, diverged: false, oversized: false, revision: 3 }

/**
 * @author ddj 2026年10月29号
 * @description: 构造条目，避免每个用例重复字段。
 * @param oldText 基线
 * @param newText 当前
 * @param earlierVersion 基线形态
 * @returns 条目
 */
function entryOf(oldText: string, newText: string, earlierVersion: 'file' | 'none' = 'file'): PendingEntry {
  return entryFromNew({ id: 'f.ts', path: 'src/f.ts', sessionId: 's1', earlierVersion, oldText, newText, updatedAt: 1 })
}

/**
 * @author ddj 2026年10月29号
 * @description: 构造判定请求。
 * @param scope 粒度
 * @param decision 决定
 * @param extra 额外字段
 * @returns 请求
 */
function requestOf(
  scope: PendingDecide['scope'],
  decision: PendingDecide['decision'],
  extra: Partial<PendingDecide> = {},
): PendingDecide {
  return { sessionId: 's1', id: 'f.ts', revision: 3, operationId: 'op1', scope, decision, ...extra }
}

describe('pending kernel', () => {
  it('同一文件的多次改动折叠成一条，基线留最早、内容取最新', () => {
    const first = entryOf('A', 'B')
    const second = entryFromNew({ ...first, oldText: 'B', newText: 'C', updatedAt: 5 })
    const merged = mergeEntries(first, second)
    expect(merged.oldText).toBe('A')
    expect(merged.newText).toBe('C')
    expect(merged.sessionIds).toEqual(['s1'])
  })

  it('A→B→C 展示为 A→C，A→B→A 归零', () => {
    const merged = mergeEntries(entryOf('A', 'B'), entryFromNew({ ...entryOf('B', 'C'), updatedAt: 9 }))
    expect(diffOf(merged).hunks.length).toBe(1)
    const back = mergeEntries(entryOf('A', 'B'), entryFromNew({ ...entryOf('B', 'A'), updatedAt: 9 }))
    expect(isSettled(back)).toBe(true)
  })

  it('创建后被再次修改，基线改为文件而非删除', () => {
    const created = entryOf('', 'x', 'none')
    const edited = entryFromNew({ ...created, earlierVersion: 'file', oldText: 'x', newText: 'y', updatedAt: 7 })
    const merged = mergeEntries(created, edited)
    expect(merged.earlierVersion).toBe('file')
    expect(merged.oldText).toBe('x')
  })

  it('未读标记只由读写行为驱动，撤销重放保留实时值', () => {
    const live = touchSeen(entryOf('a', 'b'), false)
    expect(live.unseen).toBe(true)
    expect(withUnseen(entryOf('a', 'b'), live).unseen).toBe(true)
    expect(withUnseen(entryOf('a', 'b'), touchSeen(live, true)).unseen).toBeUndefined()
  })

  it('推进基线即结束创建身份并清未读', () => {
    const next = applyUpdate(touchSeen(entryOf('', 'x', 'none'), false), { oldText: 'x' }, 10)
    expect(next.earlierVersion).toBe('file')
    expect(next.unseen).toBeUndefined()
    expect(next.updatedAt).toBe(10)
  })

  it('内容版本只在内容变化时递增，删除后编号不复用', () => {
    const versions = new ContentVersions()
    expect(versions.note('f.ts', 'a')).toBe(1)
    expect(versions.note('f.ts', 'a')).toBe(1)
    expect(versions.note('f.ts', 'b')).toBe(2)
    versions.drop('f.ts')
    expect(versions.versionOf('f.ts')).toBeUndefined()
    expect(versions.note('f.ts', 'c')).toBe(3)
  })

  it('列表按更新时间升序', () => {
    const items = [{ ...entryOf('a', 'b'), updatedAt: 9 }, { ...entryOf('a', 'b'), updatedAt: 2 }]
    expect(items.sort(byUpdatedAt).map((item) => item.updatedAt)).toEqual([2, 9])
  })
})

describe('pending diff', () => {
  it('行级差异保留上下文并生成可定位块', () => {
    const diff = textDiff('f.ts', 'f.ts', 'a\nb\nc\n', 'a\nB\nc\nd\n')
    expect(diff.kind).toBe('text')
    expect(reviewBlocks(diff).length).toBe(2)
    expect(diff.hunks[0].lines.every((line) => /^[ +-]/.test(line))).toBe(true)
  })

  it('两侧相同不产出 hunk', () => {
    expect(textDiff('f.ts', 'f.ts', 'x\n', 'x\n').hunks.length).toBe(0)
  })

  it('纯删除也能产出块', () => {
    const blocks = reviewBlocks(textDiff('f.ts', 'f.ts', 'a\nb\nc\n', 'a\nc\n'))
    expect(blocks.length).toBe(1)
    expect(blocks[0].oldLines).toEqual(['b'])
  })
})

describe('pending decide', () => {
  it('文件级 Keep 只推进投影，绝不写目标文件', async () => {
    const entry = entryOf('a\nb\n', 'a\nc\n')
    let wrote = 0
    const outcome = await decide({
      request: requestOf('file', 'accepted'), entry, flags: FLAGS, blocks: [], now: 20,
      write: async () => { wrote++; return { ok: true, content: null } },
    })
    expect(outcome.ok).toBe(true)
    expect(wrote).toBe(0)
    expect(outcome.wrote).toBe(false)
    expect(isSettled(outcome.entry)).toBe(true)
    expect(outcome.flags.revision).toBe(FLAGS.revision + 1)
  })

  it('块级 Keep 只并入目标块', async () => {
    const entry = entryOf('a\nb\nc\n', 'a\nB\nc\nd\n')
    const diff = textDiff(entry.path, entry.path, entry.oldText, entry.newText)
    const block = reviewBlocks(diff)[0]
    const outcome = await decide({
      request: requestOf('block', 'accepted', { blockId: block.id }), entry, flags: FLAGS, blocks: [], now: 21,
      write: async () => { throw new Error('Keep 不允许写盘') },
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.entry.oldText).toBe('a\nB\nc\n')
    expect(outcome.entry.newText).toBe('a\nB\nc\nd\n')
    expect(outcome.blocks).toEqual([{ id: block.id, decision: 'accepted' }])
  })

  it('文件级 Revert 写回基线内容并读回', async () => {
    const entry = entryOf('a\nb\n', 'a\nc\n')
    let written: string | null | undefined
    const outcome = await decide({
      request: requestOf('file', 'rejected'), entry, flags: FLAGS, blocks: [], now: 22,
      write: async (content) => { written = content; return { ok: true, content } },
    })
    expect(written).toBe('a\nb\n')
    expect(outcome.ok).toBe(true)
    expect(isSettled(outcome.entry)).toBe(true)
    expect(outcome.flags.missing).toBe(false)
  })

  it('新建文件 Revert 等于删除', async () => {
    const entry = entryOf('', 'x\n', 'none')
    let written: string | null | undefined
    const outcome = await decide({
      request: requestOf('file', 'rejected'), entry, flags: FLAGS, blocks: [], now: 23,
      write: async (content) => { written = content; return { ok: true, content } },
    })
    expect(written).toBeNull()
    expect(outcome.ok).toBe(true)
    expect(outcome.entry.newText).toBe('')
    expect(outcome.flags.missing).toBe(true)
    expect(isSettled(outcome.entry)).toBe(true)
  })

  it('写盘失败时状态完全不变', async () => {
    const entry = entryOf('a\nb\n', 'a\nc\n')
    const outcome = await decide({
      request: requestOf('file', 'rejected'), entry, flags: FLAGS, blocks: [], now: 24,
      write: async () => ({ ok: false, reason: 'conflict' }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('conflict')
    expect(outcome.entry).toBe(entry)
    expect(outcome.flags.revision).toBe(FLAGS.revision)
    expect(outcome.wrote).toBe(false)
  })

  it('块级 Revert 只回退目标块并保留其它改动', async () => {
    const entry = entryOf('a\nb\nc\n', 'a\nB\nc\nd\n')
    const blocks = reviewBlocks(textDiff(entry.path, entry.path, entry.oldText, entry.newText))
    const outcome = await decide({
      request: requestOf('block', 'rejected', { blockId: blocks[0].id }), entry, flags: FLAGS, blocks: [], now: 25,
      write: async (content) => ({ ok: true, content }),
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.entry.newText).toBe('a\nb\nc\nd\n')
    expect(outcome.entry.oldText).toBe('a\nb\nc\n')
    expect(outcome.blocks).toEqual([{ id: blocks[0].id, decision: 'rejected' }])
  })

  it('块定位不唯一时拒绝回退', () => {
    const duplicate = {
      id: 'b', hunkIndex: 0, oldStart: 1, newStart: 1,
      oldLines: ['z'], newLines: ['dup'], contextBefore: [], contextAfter: [],
    }
    expect(revertBlock('dup\ndup\n', duplicate)).toBeNull()
    expect(revertBlock('head\ndup\ntail\n', duplicate)).toBe('head\nz\ntail\n')
  })

  it('revision 不匹配时拒绝，避免覆盖并发决定', async () => {
    const outcome = await decide({
      request: requestOf('file', 'accepted', { revision: 2 }), entry: entryOf('a', 'b'), flags: FLAGS, blocks: [], now: 26,
      write: async () => ({ ok: true, content: null }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('revision-mismatch')
  })

  it('未知块 ID 拒绝而不是退化成整文件', async () => {
    const outcome = await decide({
      request: requestOf('block', 'accepted', { blockId: '0:99:99' }), entry: entryOf('a\nb\n', 'a\nc\n'),
      flags: FLAGS, blocks: [], now: 27,
      write: async () => ({ ok: true, content: null }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('unknown-block')
  })

  it('能力口径：已解决与超大不可决定', () => {
    expect(capabilityOf(entryOf('a', 'a'), FLAGS)).toEqual({ keep: false, revert: false, reason: 'settled' })
    expect(capabilityOf(entryOf('a', 'b'), { ...FLAGS, oversized: true }).reason).toBe('oversized')
    expect(capabilityOf(entryOf('', 'x', 'none'), FLAGS).revert).toBe(true)
  })
})

describe('pending store projection', () => {
  /** 构造一次写入。 */
  const write = (before: string | null, after: string | null, now: number) => ({
    cwd: 'cwd', sessionId: 's1', path: 'src/f.ts', identity: 'C:/repo/src/f.ts', before, after, now,
  })

  it('同一文件多次写入只折叠成一条，基线保留最早内容', () => {
    const first = foldWrite(undefined, write('A', 'B', 1))
    expect(first.entry.oldText).toBe('A')
    expect(first.entry.newText).toBe('B')
    const second = foldWrite(first, write('B', 'C', 2))
    expect(second.entry.oldText).toBe('A')
    expect(second.entry.newText).toBe('C')
    expect(second.flags.revision).toBe(1)
  })

  it('新建文件的条目带创建身份，写入后仍是同一条', () => {
    const created = foldWrite(undefined, write(null, 'x', 1))
    expect(created.entry.earlierVersion).toBe('none')
    expect(created.flags.missing).toBe(false)
    const edited = foldWrite(created, write('x', 'y', 2))
    expect(edited.entry.earlierVersion).toBe('file')
    expect(edited.entry.oldText).toBe('x')
  })

  it('外部改动被吸收并标分歧，基线不动', () => {
    const stored = foldWrite(undefined, write('A', 'B', 1))
    const next = refreshed(stored, 'EXT', 5)
    expect(next?.entry.newText).toBe('EXT')
    expect(next?.entry.oldText).toBe('A')
    expect(next?.flags.diverged).toBe(true)
    expect(next?.entry.unseen).toBe(true)
  })

  it('内容一致不产生新状态，缺失只打标记不删条目', () => {
    const stored = foldWrite(undefined, write('A', 'B', 1))
    expect(refreshed(stored, 'B', 5)).toBeNull()
    const missing = refreshed(stored, null, 6)
    expect(missing?.flags.missing).toBe(true)
    expect(missing?.entry.newText).toBe('B')
  })

  it('列表项暴露已解决与增删统计', () => {
    const settled = itemOf(foldWrite(undefined, write('A', 'A', 1)))
    expect(settled.settled).toBe(true)
    const changed = itemOf(foldWrite(undefined, write('a\nb\n', 'a\nc\nd\n', 2)))
    expect(changed.added).toBe(2)
    expect(changed.deleted).toBe(1)
    expect(changed.settled).toBe(false)
  })
})
