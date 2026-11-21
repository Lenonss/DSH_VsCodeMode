// @ts-nocheck
/**
 * 提交对话框纯投影单测（22-agent-tools-and-commit）。
 * 守护：未版本控制与 ignore-on-commit 默认不勾、种子只勾种子、信息校验与结果行。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import {
  IGNORE_ON_COMMIT,
  commitHintOf,
  commitMessageErrorOf,
  commitResultLinesOf,
  commitSectionsOf,
  commitSeedOf,
  commitStatsOf,
  defaultCheckedOf,
  groupTriStateOf,
} from '../src/client/ui/svnCommitModel.js'

const entries = [
  { path: 'a.txt', status: 'modified', versioned: true, changelist: 'core' },
  { path: 'b.txt', status: 'modified', versioned: true },
  { path: 'c.txt', status: 'unversioned', versioned: false },
  { path: 'd.txt', status: 'modified', versioned: true, changelist: IGNORE_ON_COMMIT },
  { path: 'e.txt', status: 'normal', versioned: true },
]

describe('commitSectionsOf', () => {
  it('按 changelist / 未分组 / 未版本控制分区，normal 不计入', () => {
    const sections = commitSectionsOf(entries)
    expect(sections.map((section) => section.key)).toEqual(['changelist:core', 'changelist:ignore-on-commit', 'ungrouped', 'unversioned'])
    expect(sections.find((section) => section.key === 'ungrouped').entries.map((entry) => entry.path)).toEqual(['b.txt'])
  })

  it('默认勾选：分组与未分组为是，未版本控制与 ignore-on-commit 为否', () => {
    const sections = commitSectionsOf(entries)
    const checked = defaultCheckedOf(sections)
    expect([...checked].sort()).toEqual(['a.txt', 'b.txt'])
    expect(checked.has('c.txt')).toBe(false)
    expect(checked.has('d.txt')).toBe(false)
  })

  it('种子存在时只勾种子内路径', () => {
    const sections = commitSectionsOf(entries)
    expect([...defaultCheckedOf(sections, ['c.txt'])]).toEqual(['c.txt'])
  })
})

describe('勾选统计与分组三态', () => {
  it('总数含未勾选条目；byTone 只统计已勾选条目的状态分级', () => {
    const sections = commitSectionsOf(entries)
    const stats = commitStatsOf(sections, defaultCheckedOf(sections))
    expect(stats.total).toBe(4)
    expect(stats.picked).toBe(2)
    expect(stats.byTone).toEqual({ modified: 2, added: 0, deleted: 0, conflict: 0, plain: 0 })
  })

  it('未勾选的未版本控制与 ignore-on-commit 不计入 byTone', () => {
    const sections = commitSectionsOf(entries)
    const checked = defaultCheckedOf(sections)
    checked.add('c.txt')
    const stats = commitStatsOf(sections, checked)
    expect(stats.picked).toBe(3)
    expect(stats.byTone.modified).toBe(2)
    expect(stats.byTone.plain).toBe(1)
  })

  it('空集合统计全 0，不因空分区抛错', () => {
    expect(commitStatsOf([], new Set())).toEqual({ total: 0, picked: 0, byTone: { modified: 0, added: 0, deleted: 0, conflict: 0, plain: 0 } })
  })

  it('分组三态：全选 / 部分 / 未选，空分区按未选', () => {
    const sections = commitSectionsOf(entries)
    const checked = defaultCheckedOf(sections)
    const ungrouped = sections.find((section) => section.key === 'ungrouped')
    expect(groupTriStateOf(sections[0], checked)).toBe('all')
    expect(groupTriStateOf(sections.find((section) => section.key === 'unversioned'), checked)).toBe('none')
    expect(groupTriStateOf({ ...ungrouped, entries: [...ungrouped.entries, { path: 'f.txt', status: 'modified', versioned: true }] }, checked)).toBe('part')
    expect(groupTriStateOf({ ...ungrouped, entries: [] }, checked)).toBe('none')
  })
})

describe('提交信息与结果', () => {
  it('空信息 / 首行超长 拒；正常通过', () => {
    expect(commitMessageErrorOf('')).toContain('请填写')
    expect(commitMessageErrorOf('x'.repeat(80))).toContain('首行最长')
    expect(commitMessageErrorOf('fix: ok\n\n正文')).toBeNull()
  })

  it('状态位提示首行字符数', () => {
    expect(commitHintOf('fix: abc')).toContain('8/72')
  })

  it('结果行含版本号 / 动作 / 跳过 / 冲突', () => {
    const lines = commitResultLinesOf({
      revision: 42,
      summary: '提交成功：r42',
      entries: [{ path: 'a.txt', action: 'M', label: '已修改' }],
      skipped: ['b.txt'],
      conflicts: ['c.txt'],
      output: '',
    })
    expect(lines[0]).toBe('提交成功：r42')
    expect(lines).toContain('M a.txt')
    expect(lines.some((line) => line.includes('跳过 b.txt'))).toBe(true)
    expect(lines.some((line) => line.includes('冲突 c.txt'))).toBe(true)
  })

  it('逐组种子携带信息草稿', () => {
    const seed = commitSeedOf({ name: 'core', paths: ['a.txt'], subject: 'fix: x', body: '正文' })
    expect(seed.paths).toEqual(['a.txt'])
    expect(seed.message).toBe('fix: x\n\n正文')
  })
})
