// @ts-nocheck
/**
 * 提交对话框纯投影单测（22-agent-tools-and-commit）。
 * 守护：未版本控制与 ignore-on-commit 默认不勾、种子只勾种子、信息校验与结果行。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import {
  IGNORE_ON_COMMIT,
  batchCheckValueOf,
  commitActs,
  commitHintOf,
  commitMessageErrorOf,
  commitResultLinesOf,
  commitSectionsOf,
  commitSeedOf,
  commitStatsOf,
  defaultCheckedOf,
  groupTriStateOf,
  moveRowPick,
  nextRowPick,
  pruneRowPick,
  rangeCheckValueOf,
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

describe('右键菜单动作可用性', () => {
  it('受版本控制的改动行：比较 / 日志 / 打开 / 勾选 / 还原可用，加入不可用', () => {
    const acts = commitActs({ path: 'a.cs', status: 'modified', versioned: true }, false)
    expect(acts).toEqual({ compare: true, log: true, open: true, openParent: true, copyPath: true, toggle: true, revert: true, add: false })
  })

  it('未版本控制行：加入可用、还原与日志不可用', () => {
    const acts = commitActs({ path: 'c.txt', status: 'unversioned', versioned: false }, false)
    expect(acts.add).toBe(true)
    expect(acts.revert).toBe(false)
    expect(acts.log).toBe(false)
  })

  it('不可文本比较的文件（二进制）不给比较', () => {
    expect(commitActs({ path: 'icon.png', status: 'modified', versioned: true }, false).compare).toBe(false)
  })

  it('提交进行中一律不可用，且无目标时不抛错', () => {
    const idle = commitActs({ path: 'a.cs', status: 'modified', versioned: true }, true)
    expect(Object.values(idle).every((value) => value === false)).toBe(true)
    expect(Object.values(commitActs(null, false)).every((value) => value === false)).toBe(true)
  })
})

describe('行选中', () => {
  const order = ['a', 'b', 'c', 'd']
  const none = { selected: [], anchor: null }

  it('单击只选一行，并更新锚点', () => {
    expect(nextRowPick({ selected: ['a', 'b'], anchor: 'a' }, order, 'c', 'single')).toEqual({ selected: ['c'], anchor: 'c' })
    expect(nextRowPick(none, order, 'zzz', 'single')).toEqual({ selected: [], anchor: 'zzz' })
  })

  it('Ctrl 点击切换单行，结果恒按显示顺序', () => {
    let pick = nextRowPick({ selected: ['c'], anchor: 'c' }, order, 'a', 'toggle')
    expect(pick).toEqual({ selected: ['a', 'c'], anchor: 'a' })
    pick = nextRowPick(pick, order, 'c', 'toggle')
    expect(pick).toEqual({ selected: ['a'], anchor: 'c' })
  })

  it('Shift 从锚点取连续范围，反向同样成立', () => {
    expect(nextRowPick({ selected: ['a'], anchor: 'a' }, order, 'c', 'range').selected).toEqual(['a', 'b', 'c'])
    expect(nextRowPick({ selected: ['d'], anchor: 'd' }, order, 'b', 'range').selected).toEqual(['b', 'c', 'd'])
    // 目标不在显示顺序里（不存在该行）时退化为单击，不留过期选中
    expect(nextRowPick({ selected: ['b'], anchor: 'b' }, order, 'zzz', 'range')).toEqual({ selected: [], anchor: 'zzz' })
    expect(nextRowPick({ selected: ['b'], anchor: null }, order, 'c', 'range')).toEqual({ selected: ['c'], anchor: 'c' })
  })
})

describe('空分区（仅登记过 changelist）', () => {
  it('计划里的组名即使没有可提交条目也出空分区，并按名字排在未分组之前', () => {
    const sections = commitSectionsOf([{ path: 'a.txt', status: 'modified', versioned: true, changelist: 'core' }], ['ui', 'core', 'zeta'])
    expect(sections.map((section) => section.key)).toEqual(['changelist:core', 'changelist:ui', 'changelist:zeta'])
    expect(sections.find((section) => section.key === 'changelist:ui').entries).toEqual([])
  })

  it('空分区不产生勾选、不参与统计，分组三态为未选', () => {
    const sections = commitSectionsOf([{ path: 'a.txt', status: 'modified', versioned: true }], ['ui'])
    const checked = defaultCheckedOf(sections)
    expect([...checked]).toEqual(['a.txt'])
    expect(commitStatsOf(sections, checked).total).toBe(1)
    expect(groupTriStateOf(sections.find((section) => section.key === 'changelist:ui'), new Set())).toBe('none')
  })

  it('已有可提交条目的分区不会重复出空分区', () => {
    const sections = commitSectionsOf([{ path: 'a.txt', status: 'modified', versioned: true, changelist: 'core' }], ['core'])
    expect(sections.filter((section) => section.key === 'changelist:core')).toHaveLength(1)
    expect(sections[0].entries).toHaveLength(1)
  })
})

describe('批量勾选取值', () => {
  it('Shift 整段翻面只看目标行：未勾则整段勾上，已勾则整段取消', () => {
    expect(rangeCheckValueOf(new Set(), 'a.txt')).toBe(true)
    expect(rangeCheckValueOf(new Set(['a.txt', 'b.txt']), 'a.txt')).toBe(false)
  })

  it('批量勾选：全已勾则取消，否则勾上；空范围按勾上处理', () => {
    expect(batchCheckValueOf(new Set(['a', 'b']), ['a', 'b'])).toBe(false)
    expect(batchCheckValueOf(new Set(['a']), ['a', 'b'])).toBe(true)
    expect(batchCheckValueOf(new Set(), ['a'])).toBe(true)
    expect(batchCheckValueOf(new Set(), [])).toBe(true)
  })
})

describe('方向键移动与清单清理', () => {
  const order = ['a', 'b', 'c', 'd']

  it('上下移动单选，越界停在首尾', () => {
    expect(moveRowPick({ selected: ['b'], anchor: 'b' }, order, 1, false)).toEqual({ selected: ['c'], anchor: 'c' })
    expect(moveRowPick({ selected: ['b'], anchor: 'b' }, order, -1, false)).toEqual({ selected: ['a'], anchor: 'a' })
    expect(moveRowPick({ selected: ['d'], anchor: 'd' }, order, 1, false)).toEqual({ selected: ['d'], anchor: 'd' })
    expect(moveRowPick({ selected: ['a'], anchor: 'a' }, order, -1, false)).toEqual({ selected: ['a'], anchor: 'a' })
  })

  it('没有选中时向下取首行、向上取末行', () => {
    expect(moveRowPick({ selected: [], anchor: null }, order, 1, false)).toEqual({ selected: ['a'], anchor: 'a' })
    expect(moveRowPick({ selected: [], anchor: null }, order, -1, false)).toEqual({ selected: ['d'], anchor: 'd' })
    expect(moveRowPick({ selected: [], anchor: null }, [], 1, false)).toEqual({ selected: [], anchor: null })
  })

  it('Shift 扩选从锚点取范围，锚点保持不变', () => {
    expect(moveRowPick({ selected: ['a', 'b'], anchor: 'a' }, order, 1, true)).toEqual({ selected: ['a', 'b', 'c'], anchor: 'a' })
    expect(moveRowPick({ selected: ['b'], anchor: null }, order, 1, true)).toEqual({ selected: ['b', 'c'], anchor: 'b' })
  })

  it('清单重载后丢掉消失的路径，锚点失效时清空，无变化时返回原对象', () => {
    const stale = { selected: ['a', 'zzz'], anchor: 'zzz' }
    expect(pruneRowPick(stale, order)).toEqual({ selected: ['a'], anchor: null })

    const live = { selected: ['a', 'b'], anchor: 'a' }
    expect(pruneRowPick(live, order)).toBe(live)
  })
})
