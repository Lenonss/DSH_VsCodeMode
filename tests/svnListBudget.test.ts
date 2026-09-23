/**
 * SVN 变更列表渐进渲染预算切分（svnListBudget.budgetGroupsOf）测试。
 * 覆盖：预算内全量透传 / 跨组依序分配 / 组截断带 full 计数 / 组边界对齐 / 零预算与空分组安全。
 * 作者 ddj 2026年09月23号
 */
import { describe, expect, it } from 'vitest'
import { budgetGroupsOf } from '../src/client/sidebar/panels/svnListBudget.js'
import type { SvnChangeEntry } from '../src/shared/svn.js'

/** 一条变更条目（缺省 modified + 受版本控制）。 */
const entry = (path: string): SvnChangeEntry => ({ path, status: 'modified', versioned: true })

/** 构造 n 条路径的分组。 */
const groupOf = (name: string, n: number) => ({
  name,
  entries: Array.from({ length: n }, (_, i) => entry(name + '/' + i + '.txt')),
})

describe('budgetGroupsOf', () => {
  it('预算内：全量透传原分组（对象引用不变），无截断', () => {
    const groups = [groupOf('a', 2), groupOf('（未分组）', 3)]
    const out = budgetGroupsOf(groups, 100)
    expect(out.hasMore).toBe(false)
    expect(out.total).toBe(5)
    expect(out.shown).toBe(5)
    expect(out.groups).toEqual(groups)
    expect(out.groups[0]).toBe(groups[0])
    expect(out.groups[1]).toBe(groups[1])
  })

  it('预算跨组依序分配：前面的组整组保留，触及预算的组被截断并带 full 全量计数', () => {
    const groups = [groupOf('a', 3), groupOf('b', 4), groupOf('c', 5)]
    const out = budgetGroupsOf(groups, 5)
    expect(out.hasMore).toBe(true)
    expect(out.total).toBe(12)
    expect(out.shown).toBe(5)
    expect(out.groups.length).toBe(2)
    expect(out.groups[0]).toBe(groups[0])
    expect(out.groups[1]!.entries.length).toBe(2)
    expect(out.groups[1]!.full).toBe(4)
  })

  it('预算与组边界对齐：整组耗尽预算后不再产出后续组', () => {
    const groups = [groupOf('a', 2), groupOf('b', 2)]
    const out = budgetGroupsOf(groups, 2)
    expect(out.groups.length).toBe(1)
    expect(out.groups[0]).toBe(groups[0])
    expect(out.shown).toBe(2)
    expect(out.hasMore).toBe(true)
  })

  it('空分组与零/负预算安全：零预算无行、hasMore 如实', () => {
    expect(budgetGroupsOf([], 10)).toEqual({ groups: [], shown: 0, total: 0, hasMore: false })
    const out = budgetGroupsOf([groupOf('a', 3)], 0)
    expect(out.groups.length).toBe(0)
    expect(out.shown).toBe(0)
    expect(out.total).toBe(3)
    expect(out.hasMore).toBe(true)
    expect(budgetGroupsOf([groupOf('a', 1)], -5).groups.length).toBe(0)
  })

  it('折叠映射（空 entries 组）透传且不占预算：计数只统计展开组', () => {
    const groups = [
      { name: 'a', entries: [entry('a/1.txt'), entry('a/2.txt')] },
      { name: '（未分组）', entries: [], full: 400, folded: true },
      { name: 'b', entries: [entry('b/1.txt')] },
    ]
    const out = budgetGroupsOf(groups, 100)
    expect(out.hasMore).toBe(false)
    expect(out.total).toBe(3)
    expect(out.shown).toBe(3)
    const folded = out.groups.find((g) => g.name === '（未分组）')
    expect(folded!.entries.length).toBe(0)
    expect(folded!.full).toBe(400)
    expect(folded!.folded).toBe(true)
    // 预算紧张时折叠组不挤占展开组行数，且折叠组头仍在输出里
    const tight = budgetGroupsOf(groups, 2)
    expect(tight.shown).toBe(2)
    expect(tight.hasMore).toBe(true)
    expect(tight.groups.some((g) => g.name === '（未分组）')).toBe(true)
  })
})
