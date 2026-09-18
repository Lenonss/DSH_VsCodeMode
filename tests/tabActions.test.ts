/**
 * 文件页签操作纯函数测试：关闭族（补位规则 / 固定保护）、固定分区、插入位、
 * 持久化归一化，以及路径推导（绝对/相对/祖先目录/可定位判定）。
 * 全部为 node 可跑的纯逻辑断言，不触 React/DOM。
 * 作者 ddj 2026-09-11
 */
import { describe, expect, it } from 'vitest'
import {
  absoluteOf, ancestorDirsOf, applyClose, baseNameOf, closeAll, closeOthers, closeRight, closeSaved,
  evictPlan, insertTab, isAbsolutePath, isTreeRevealable, normalizeTabs, pickActive, relativeOf, tabPathOf, togglePin,
} from '../src/client/tabActions.js'
import type { TabLike } from '../src/client/tabActions.js'

/** 由路径数组造页签（`!` 前缀表示固定）。 */
function tabs(...specs: string[]): TabLike[] {
  return specs.map((spec) => (spec.startsWith('!') ? { path: spec.slice(1), pinned: true } : { path: spec }))
}

/** 路径数组（断言用，固定页签加 `!` 前缀）。 */
function paths(list: TabLike[]): string[] {
  return list.map((tab) => (tab.pinned ? '!' + tab.path : tab.path))
}

describe('applyClose 关闭与活动页签补位', () => {
  it('活动页签未被关：保持活动不变', () => {
    const out = applyClose(tabs('a', 'b', 'c'), new Set(['c']), 'a')
    expect(paths(out.tabs)).toEqual(['a', 'b'])
    expect(out.active).toBe('a')
  })

  it('活动页签被关：优先右邻', () => {
    const out = applyClose(tabs('a', 'b', 'c'), new Set(['b']), 'b')
    expect(paths(out.tabs)).toEqual(['a', 'c'])
    expect(out.active, '右邻 c').toBe('c')
  })

  it('活动页签是末位：回退左邻', () => {
    const out = applyClose(tabs('a', 'b', 'c'), new Set(['c']), 'c')
    expect(out.active, '左邻 b').toBe('b')
  })

  it('关闭最后一个页签：活动为 null', () => {
    const out = applyClose(tabs('a'), new Set(['a']), 'a')
    expect(out.tabs).toEqual([])
    expect(out.active).toBeNull()
  })

  it('无可关项时返回原引用（React 跳过重渲染）', () => {
    const before = tabs('a', 'b')
    const out = applyClose(before, new Set(['zzz']), 'a')
    expect(out.tabs).toBe(before)
    expect(out.active).toBe('a')
  })

  it('连续区域被关：跳过已关项取最近的存活右邻', () => {
    const out = applyClose(tabs('a', 'b', 'c', 'd'), new Set(['b', 'c']), 'b')
    expect(paths(out.tabs)).toEqual(['a', 'd'])
    expect(out.active, '跳过已关的 c 落到 d').toBe('d')
  })
})

describe('关闭族 —— 固定 = 保护', () => {
  it('关闭其他：保留目标与全部固定页签', () => {
    const out = closeOthers(tabs('!a', 'b', '!c', 'd'), 'd', 'd')
    expect(paths(out.tabs)).toEqual(['!a', '!c', 'd'])
    expect(out.active).toBe('d')
  })

  it('关闭其他：目标本身是固定页签时仍保留（不重复）', () => {
    const out = closeOthers(tabs('!a', 'b', 'c'), 'a', 'a')
    expect(paths(out.tabs)).toEqual(['!a'])
    expect(out.active).toBe('a')
  })

  it('关闭右侧：只关目标之后且未固定的页签', () => {
    const out = closeRight(tabs('a', 'b', '!c', 'd'), 'a', 'd')
    expect(paths(out.tabs), 'b 与 d 被关，固定页签 !c 保留').toEqual(['a', '!c'])
    expect(out.active, '活动 d 被关 → 右邻无、左邻 !c').toBe('c')
  })

  it('关闭右侧：目标是末位时无操作', () => {
    const before = tabs('a', 'b')
    const out = closeRight(before, 'b', 'b')
    expect(out.tabs).toBe(before)
  })

  it('关闭右侧：目标不存在（防御）时无操作', () => {
    const before = tabs('a', 'b')
    const out = closeRight(before, 'ghost', 'a')
    expect(out.tabs).toBe(before)
  })

  it('关闭已保存：脏页签与固定页签都保留', () => {
    const out = closeSaved(tabs('!a', 'b', 'c', 'd'), { b: true }, 'd')
    expect(paths(out.tabs)).toEqual(['!a', 'b'])
    expect(out.active, '活动 d 被关 → 右邻无、左邻 b').toBe('b')
  })

  it('关闭已保存：全部干净时等同全部关闭（固定页签仍在）', () => {
    const out = closeSaved(tabs('!a', 'b'), {}, 'b')
    expect(paths(out.tabs)).toEqual(['!a'])
  })

  it('全部关闭：仅关未固定页签', () => {
    const out = closeAll(tabs('!a', 'b', '!c', 'd'), 'b')
    expect(paths(out.tabs)).toEqual(['!a', '!c'])
    expect(out.active, '活动 b 被关 → 右邻 !c').toBe('c')
  })

  it('全部关闭：全部固定时无操作（固定页签永不被批量关闭）', () => {
    const before = tabs('!a', '!b')
    const out = closeAll(before, 'a')
    expect(out.tabs).toBe(before)
    expect(out.active).toBe('a')
  })

  it('批量关闭后若存活页签只剩固定项，活动页签落在固定项上', () => {
    const out = closeAll(tabs('a', '!b'), 'a')
    expect(paths(out.tabs)).toEqual(['!b'])
    expect(out.active).toBe('b')
  })
})

describe('togglePin 固定分区', () => {
  it('固定把页签前移到固定区末位（保持各自相对顺序）', () => {
    expect(paths(togglePin(tabs('a', 'b', 'c'), 'c'))).toEqual(['!c', 'a', 'b'])
  })

  it('取消固定把页签放回普通区（保持相对顺序）', () => {
    expect(paths(togglePin(tabs('!a', '!b', 'c'), 'a'))).toEqual(['!b', 'a', 'c'])
  })

  it('重复切换回到未固定态（取消固定不回跳原位，与 VS Code 语义一致）', () => {
    const once = togglePin(tabs('a', 'b'), 'b')
    expect(paths(once), '固定后前移').toEqual(['!b', 'a'])
    const twice = togglePin(once, 'b')
    expect(paths(twice), '取消固定后保持在固定区末位落入的位置').toEqual(['b', 'a'])
  })

  it('目标不存在时返回原引用', () => {
    const before = tabs('a')
    expect(togglePin(before, 'ghost')).toBe(before)
  })
})

describe('insertTab 插入位', () => {
  it('新页签插到最后一个固定页签之后', () => {
    expect(paths(insertTab(tabs('!a', '!b', 'c'), 'd'))).toEqual(['!a', '!b', 'd', 'c'])
  })

  it('无固定页签时追加到末尾', () => {
    expect(paths(insertTab(tabs('a', 'b'), 'c'))).toEqual(['a', 'b', 'c'])
  })

  it('已存在的页签不重复插入（返回原引用）', () => {
    const before = tabs('a', 'b')
    expect(insertTab(before, 'b')).toBe(before)
  })
})

describe('normalizeTabs / pickActive 持久化归一化', () => {
  it('旧版 string[] 形状可解释为页签', () => {
    expect(paths(normalizeTabs(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('对象形状带 pinned，并做固定分区', () => {
    expect(paths(normalizeTabs([{ path: 'a' }, { path: 'b', pinned: true }]))).toEqual(['!b', 'a'])
  })

  it('丢弃损坏项与重复路径', () => {
    expect(paths(normalizeTabs(['a', '', 42, null, { nope: 1 }, 'a']))).toEqual(['a'])
  })

  it('非数组（损坏 JSON）返回空', () => {
    expect(normalizeTabs(undefined)).toEqual([])
    expect(normalizeTabs({ tabs: ['a'] })).toEqual([])
  })

  it('pickActive：恢复值存在则用它，否则回退首个；空表为 null', () => {
    expect(pickActive(tabs('a', 'b'), 'b')).toBe('b')
    expect(pickActive(tabs('a', 'b'), 'ghost')).toBe('a')
    expect(pickActive(tabs('a'), null)).toBe('a')
    expect(pickActive([], 'a')).toBeNull()
  })
})

describe('路径推导', () => {
  it('isAbsolutePath 识别盘符 / UNC / POSIX 根', () => {
    expect(isAbsolutePath('D:\\work\\a.ts')).toBe(true)
    expect(isAbsolutePath('d:/work/a.ts')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share\\a.ts')).toBe(true)
    expect(isAbsolutePath('/home/u/a.ts')).toBe(true)
    expect(isAbsolutePath('src/a.ts')).toBe(false)
  })

  it('isTreeRevealable：工作区外的绝对路径与含 .. 的路径都不可定位', () => {
    expect(isTreeRevealable('src/a.ts')).toBe(true)
    expect(isTreeRevealable('D:/work/a.ts')).toBe(false)
    expect(isTreeRevealable('../outside.ts')).toBe(false)
    expect(isTreeRevealable('')).toBe(false)
  })

  it('relativeOf：cwd 内去前缀（大小写不敏感），工作区外回退原路径', () => {
    expect(relativeOf('D:\\work\\app\\src\\a.ts', 'D:/work/app')).toBe('src/a.ts')
    expect(relativeOf('d:/WORK/app/src/a.ts', 'D:/work/app')).toBe('src/a.ts')
    expect(relativeOf('D:/other/a.ts', 'D:/work/app')).toBe('D:/other/a.ts')
    expect(relativeOf('src/a.ts', null)).toBe('src/a.ts')
  })

  it('absoluteOf：相对路径按 cwd 拼接，已绝对或无 cwd 时回退原路径', () => {
    expect(absoluteOf('src/a.ts', 'D:/work/app')).toBe('D:/work/app/src/a.ts')
    expect(absoluteOf('D:/other/a.ts', 'D:/work/app')).toBe('D:/other/a.ts')
    expect(absoluteOf('src/a.ts', null)).toBe('src/a.ts')
    expect(absoluteOf('src/a.ts', 'D:/work/app/')).toBe('D:/work/app/src/a.ts')
  })

  it('ancestorDirsOf：由浅到深列出祖先目录；根级/绝对/含 .. 返回空', () => {
    expect(ancestorDirsOf('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(ancestorDirsOf('c.ts')).toEqual([])
    expect(ancestorDirsOf('D:/work/a.ts')).toEqual([])
    expect(ancestorDirsOf('../a.ts')).toEqual([])
  })

  it('baseNameOf：取末段文件名（兼容反斜杠）', () => {
    expect(baseNameOf('a/b/c.ts')).toBe('c.ts')
    expect(baseNameOf('D:\\work\\c.ts')).toBe('c.ts')
    expect(baseNameOf('')).toBe('')
  })
})

describe('G9 页签路径形态统一（tabPathOf / normalizeTabs 迁移）', () => {
  it('tabPathOf：工作区内绝对路径收敛为相对（反斜杠也归一）', () => {
    expect(tabPathOf('D:\\work\\app\\src\\a.ts', 'D:/work/app')).toBe('src/a.ts')
    expect(tabPathOf('D:/work/app/src/a.ts', 'D:/work/app')).toBe('src/a.ts')
  })

  it('tabPathOf：已是相对路径保持相对（幂等）', () => {
    expect(tabPathOf('src/a.ts', 'D:/work/app')).toBe('src/a.ts')
    expect(tabPathOf(tabPathOf('D:/work/app/src/a.ts', 'D:/work/app'), 'D:/work/app')).toBe('src/a.ts')
  })

  it('tabPathOf：工作区外文件回退绝对路径（不回归）', () => {
    expect(tabPathOf('D:/other/a.ts', 'D:/work/app')).toBe('D:/other/a.ts')
    expect(tabPathOf('D:/work/app/a.ts', null)).toBe('D:/work/app/a.ts')
  })

  it('normalizeTabs 带 cwd：迁移历史绝对路径页签为相对形态', () => {
    const raw = [{ path: 'D:/work/app/src/a.ts' }, { path: 'D:/work/app/b.ts', pinned: true }]
    expect(paths(normalizeTabs(raw, 'D:/work/app'))).toEqual(['!b.ts', 'src/a.ts'])
  })

  it('normalizeTabs 带 cwd：绝对与相对指向同一文件时合并为一个页签（G9 去重）', () => {
    const raw = ['src/a.ts', 'D:/work/app/src/a.ts']
    expect(paths(normalizeTabs(raw, 'D:/work/app'))).toEqual(['src/a.ts'])
  })

  it('normalizeTabs 不带 cwd：保持历史行为（仅原样去重）', () => {
    expect(paths(normalizeTabs(['src/a.ts', 'D:/work/app/src/a.ts']))).toEqual(['src/a.ts', 'D:/work/app/src/a.ts'])
  })

  it('迁移后再迁移幂等（刷新两次不会产生重复页签）', () => {
    const once = normalizeTabs([{ path: 'D:/work/app/src/a.ts' }], 'D:/work/app')
    const twice = normalizeTabs(once, 'D:/work/app')
    expect(paths(twice)).toEqual(['src/a.ts'])
  })

  it('迁移后 isTreeRevealable 成立（差异入口的「在资源管理器视图中显示」恢复可用）', () => {
    const migrated = normalizeTabs([{ path: 'D:/work/app/src/a.ts' }], 'D:/work/app')
    expect(isTreeRevealable(migrated[0].path)).toBe(true)
    // 对照：未迁移的绝对路径不可定位
    expect(isTreeRevealable('D:/work/app/src/a.ts')).toBe(false)
  })
})

describe('evictPlan 页签上限淘汰', () => {
  /** 使用序表：数值越大越「新」。 */
  const used = (map: Record<string, number>) => map

  it('未超限：返回空数组（不做任何关闭）', () => {
    expect(evictPlan(tabs('a', 'b'), 5, { active: 'a', used: used({}) })).toEqual([])
    expect(evictPlan(tabs('a', 'b'), 2, { active: 'a', used: used({}) })).toEqual([])
  })

  it('limit = 0 表示不限制：永不淘汰', () => {
    expect(evictPlan(tabs('a', 'b', 'c', 'd'), 0, { active: 'a', used: used({}) })).toEqual([])
    expect(evictPlan(tabs('a', 'b', 'c', 'd'), -3, { active: 'a', used: used({}) })).toEqual([])
  })

  it('超限：按使用序淘汰最久未用者，恰好收敛到上限', () => {
    const list = tabs('a', 'b', 'c', 'd')
    // 使用序：a 最久(1) < b(2) < c(3) < d 最新(4)；活动 d 受保护
    const plan = evictPlan(list, 2, { active: 'd', used: used({ a: 1, b: 2, c: 3, d: 4 }) })
    // 需淘汰 4-2 = 2 个：a、b（最久未用两个）
    expect(plan).toEqual(['a', 'b'])
  })

  it('固定页签不是候选（保护规则：用户显式固定过的不被上限夺走）', () => {
    const list = tabs('!a', 'b', 'c', '!d')
    // 活动 c；固定项 a/d 受保护，故只可能淘汰 b
    expect(evictPlan(list, 2, { active: 'c', used: used({ a: 1, b: 2, c: 3, d: 4 }) })).toEqual(['b'])
  })

  it('活动页签不是候选（绝不关闭正在查看的文件）', () => {
    const list = tabs('a', 'b', 'c')
    const plan = evictPlan(list, 1, { active: 'a', used: used({ a: 1, b: 2, c: 3 }) })
    // a 虽是最久未用，但它是活动页签 → 淘汰 b、c
    expect(plan).toEqual(['b', 'c'])
  })

  it('无使用序记录者视为最久未用（历史恢复出来的页签优先被淘汰）', () => {
    const list = tabs('a', 'b', 'c')
    // b 有记录，a/c 无记录 → a、c 视为最久
    const plan = evictPlan(list, 1, { active: 'b', used: used({ b: 9 }) })
    expect(plan).toEqual(['a', 'c'])
  })

  it('同序（含全部无记录）按页签原顺序，保证确定性', () => {
    expect(evictPlan(tabs('a', 'b', 'c', 'd'), 2, { active: 'd', used: used({}) })).toEqual(['a', 'b'])
  })

  it('候选不足时只返回可淘汰部分（允许溢出，不强关固定/活动页签）', () => {
    // 3 个固定 + 1 个活动，上限 1 → 无任何候选可淘汰
    expect(evictPlan(tabs('!a', '!b', '!c', 'd'), 1, { active: 'd', used: used({}) })).toEqual([])
    // 2 固定 + 2 普通，上限 1，活动 d → 只有 c 可淘汰（虽需淘汰 3 个）
    expect(evictPlan(tabs('!a', '!b', 'c', 'd'), 1, { active: 'd', used: used({}) })).toEqual(['c'])
  })

  it('keep 命中者不受淘汰（调用方按需保护）', () => {
    const plan = evictPlan(tabs('a', 'b', 'c'), 1, { active: 'c', used: used({}), keep: new Set(['a']) })
    expect(plan).toEqual(['b'])
  })

  it('非数组/非法 limit 不抛错', () => {
    expect(evictPlan(null as unknown as TabLike[], 3, { active: 'a', used: {} })).toEqual([])
    expect(evictPlan(tabs('a', 'b'), Number.NaN, { active: 'a', used: {} })).toEqual([])
  })
})
