/**
 * 文件页签右键菜单模型测试：条目顺序与分组、各禁用规则、固定态标签切换、
 * 键位提示只在真实绑定时出现、「不可实现条目」的排除守约，
 * 以及 P2 SVN 组能力守卫与 CLI 三项状态矩阵。
 * 作者 ddj 2026-09-11 / 2026-09-16
 */
import { describe, expect, it } from 'vitest'
import { CLOSE_MENU_IDS, UNSUPPORTED_MENU_IDS, buildTabMenu } from '../src/client/tabMenu.js'
import type { TabMenuState } from '../src/client/tabMenu.js'

/** 构造菜单状态（缺省：两个页签、有会话与 cwd、无脏）。 */
function state(over: Partial<TabMenuState> = {}): TabMenuState {
  const tabs = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]
  return {
    path: 'src/a.ts',
    tabs,
    active: 'src/a.ts',
    dirty: {},
    cwd: 'D:/work/app',
    hasSession: true,
    canAddToConversation: true,
    closeChord: 'Ctrl+F4',
    ...over,
  }
}

/** 条目 id 列表。 */
function ids(entries: ReturnType<typeof buildTabMenu>): string[] {
  return entries.map((entry) => entry.id)
}

/** 取某条目（不存在则抛错，避免断言静默通过）。 */
function entry(over: Partial<TabMenuState>, id: string) {
  const found = buildTabMenu(state(over)).find((item) => item.id === id)
  if (!found) throw new Error('菜单缺条目：' + id)
  return found
}

describe('buildTabMenu 顺序与分组', () => {
  it('条目顺序对齐参考图分组（对话 / 关闭族 / 路径 / 定位 / 固定）', () => {
    expect(ids(buildTabMenu(state()))).toEqual([
      'add-to-conversation',
      'close', 'close-others', 'close-right', 'close-saved', 'close-all',
      'copy-path', 'copy-relative-path',
      'reveal-in-os', 'reveal-in-view',
      'toggle-pinned',
    ])
  })

  it('分隔线出现在每个分组的首条（除首组）', () => {
    const entries = buildTabMenu(state())
    expect(entries.filter((item) => item.separator).map((item) => item.id))
      .toEqual(['close', 'copy-path', 'reveal-in-os', 'toggle-pinned'])
  })

  it('关闭族恰为 5 条且 id 与导出的常量一致', () => {
    const entries = buildTabMenu(state())
    const closeIds = entries.filter((item) => (CLOSE_MENU_IDS as readonly string[]).includes(item.id)).map((item) => item.id)
    expect(closeIds).toEqual([...CLOSE_MENU_IDS])
  })

  it('不含本架构无法实现的条目（拆分 / 新窗口）', () => {
    const all = ids(buildTabMenu(state()))
    for (const unsupported of UNSUPPORTED_MENU_IDS) expect(all).not.toContain(unsupported)
  })

  it('每条都有非空 label（ContextMenu 渲染契约）', () => {
    for (const item of buildTabMenu(state())) expect(item.label.length).toBeGreaterThan(0)
  })
})

describe('buildTabMenu 键位提示', () => {
  it('有关闭键位时「关闭」带提示', () => {
    expect(entry({}, 'close').hint).toBe('Ctrl+F4')
  })

  it('未绑定关闭键位时不显示提示（不伪造键位）', () => {
    expect(entry({ closeChord: null }, 'close').hint).toBeUndefined()
    expect(entry({ closeChord: '' }, 'close').hint).toBeUndefined()
  })

  it('其余条目不带键位提示（引擎不支持两步弦，故只显示真实绑定）', () => {
    const entries = buildTabMenu(state())
    const hinted = entries.filter((item) => item.hint).map((item) => item.id)
    expect(hinted).toEqual(['close'])
  })
})

describe('buildTabMenu 禁用规则', () => {
  it('无会话或缺动作集时「添加到对话」禁用', () => {
    expect(entry({ hasSession: false }, 'add-to-conversation').disabled).toBe(true)
    expect(entry({ canAddToConversation: false }, 'add-to-conversation').disabled).toBe(true)
    expect(entry({}, 'add-to-conversation').disabled).toBe(false)
  })

  it('「关闭」恒可用（含固定页签：单项关闭允许显式关掉它）', () => {
    expect(entry({}, 'close').disabled).toBeUndefined()
    expect(entry({ tabs: [{ path: 'src/a.ts', pinned: true }], active: 'src/a.ts' }, 'close').disabled).toBeUndefined()
  })

  it('无其他可关页签（单页签）时「关闭其他」禁用', () => {
    expect(entry({ tabs: [{ path: 'src/a.ts' }] }, 'close-others').disabled).toBe(true)
    expect(entry({}, 'close-others').disabled).toBe(false)
  })

  it('已全固定时「关闭其他」禁用（固定 = 保护，无对象可关）', () => {
    const tabs = [{ path: 'src/a.ts', pinned: true }, { path: 'src/b.ts', pinned: true }]
    expect(entry({ tabs, active: 'src/a.ts' }, 'close-others').disabled).toBe(true)
  })

  it('目标右侧只有固定页签时「关闭右侧标签页」禁用', () => {
    const tabs = [{ path: 'src/a.ts' }, { path: 'src/b.ts', pinned: true }]
    expect(entry({ tabs, path: 'src/a.ts', active: 'src/a.ts' }, 'close-right').disabled).toBe(true)
    // 换成未固定的右邻则可用
    expect(entry({}, 'close-right').disabled).toBe(false)
  })

  it('目标为末位时「关闭右侧标签页」禁用', () => {
    expect(entry({ path: 'src/b.ts', active: 'src/b.ts' }, 'close-right').disabled).toBe(true)
  })

  it('全部页签都脏或固定时「关闭已保存」禁用，存在干净页签时可用', () => {
    const tabs = [{ path: 'src/a.ts' }, { path: 'src/b.ts', pinned: true }]
    expect(entry({ tabs, dirty: { 'src/a.ts': true }, active: 'src/a.ts' }, 'close-saved').disabled).toBe(true)
    expect(entry({ tabs, dirty: {}, active: 'src/a.ts' }, 'close-saved').disabled).toBe(false)
  })

  it('全部页签固定时「全部关闭」禁用', () => {
    const tabs = [{ path: 'src/a.ts', pinned: true }]
    expect(entry({ tabs, active: 'src/a.ts' }, 'close-all').disabled).toBe(true)
    expect(entry({}, 'close-all').disabled).toBe(false)
  })

  it('无 cwd 时「复制相对路径」禁用，「复制路径」仍可用', () => {
    expect(entry({ cwd: null }, 'copy-relative-path').disabled).toBe(true)
    expect(entry({ cwd: '   ' }, 'copy-relative-path').disabled).toBe(true)
    expect(entry({ cwd: null }, 'copy-path').disabled).toBeUndefined()
  })

  it('无会话时「在文件资源管理器中显示」禁用', () => {
    expect(entry({ hasSession: false }, 'reveal-in-os').disabled).toBe(true)
    expect(entry({}, 'reveal-in-os').disabled).toBe(false)
  })

  it('工作区外文件（绝对路径 / 含 ..）「在资源管理器视图中显示」禁用', () => {
    // 片段与全局规则文件在工作区外，无法在文件树中定位
    expect(entry({ path: 'C:/Users/1/.dsh/snippets/lua.code-snippets' }, 'reveal-in-view').disabled).toBe(true)
    expect(entry({ path: '../outside.ts' }, 'reveal-in-view').disabled).toBe(true)
    expect(entry({}, 'reveal-in-view').disabled).toBe(false)
  })
})

describe('buildTabMenu 固定态标签', () => {
  it('未固定时显示「固定」，固定后显示「取消固定」', () => {
    expect(entry({}, 'toggle-pinned').label).toBe('固定')
    const tabs = [{ path: 'src/a.ts', pinned: true }, { path: 'src/b.ts' }]
    expect(entry({ tabs, active: 'src/a.ts' }, 'toggle-pinned').label).toBe('取消固定')
  })

  it('右键目标不存在于页签表（竞态）时按未固定处理，不抛错', () => {
    expect(entry({ path: 'ghost.ts' }, 'toggle-pinned').label).toBe('固定')
  })
})

describe('buildTabMenu SVN 组（动态能力守卫）', () => {
  const svnState = { svnReady: true, tortoiseReady: true }

  it('能力未就绪（缺省）时菜单不含 SVN 条目（非 SVN 工作区零变化）', () => {
    const all = ids(buildTabMenu(state()))
    expect(all).not.toContain('svn-update')
    expect(all).not.toContain('svn-tortoise-commit')
  })

  it('svnReady 时追加「SVN 更新」，Tortoise 未就绪时不含 Tortoise 组', () => {
    const all = ids(buildTabMenu(state({ svnReady: true })))
    expect(all).toContain('svn-update')
    expect(all).not.toContain('svn-tortoise-commit')
    expect(all).not.toContain('svn-tortoise-revert')
  })

  it('svnReady + tortoiseReady 时追加完整 SVN 组（更新 + 比较 + 查看日志 + Tortoise 五项）', () => {
    // 目标不在变更清单（干净文件）→ 无「加入版本控制」「SVN 还原」（状态门禁），仅比较与日志
    expect(ids(buildTabMenu(state(svnState)))).toEqual([
      'add-to-conversation',
      'close', 'close-others', 'close-right', 'close-saved', 'close-all',
      'copy-path', 'copy-relative-path',
      'reveal-in-os', 'reveal-in-view',
      'toggle-pinned',
      'svn-update',
      'svn-diff-base',
      'svn-log',
      'svn-tortoise-commit', 'svn-tortoise-log', 'svn-tortoise-diff', 'svn-tortoise-blame', 'svn-tortoise-revert',
    ])
  })

  it('SVN 组以分隔线开头（挂在固定组之后），还原条目带 danger', () => {
    const entries = buildTabMenu(state(svnState))
    // 页签菜单的 SVN 组只有首条带分隔线（与 P2 外观一致；Tortoise 组不再另起分隔线）
    expect(entries.filter((item) => item.separator).map((item) => item.id))
      .toEqual(['close', 'copy-path', 'reveal-in-os', 'toggle-pinned', 'svn-update'])
    const torRevert = entries.find((item) => item.id === 'svn-tortoise-revert')
    expect(torRevert?.danger).toBe(true)
    // 目标为已改动文件时 CLI 还原项出现且带 danger（干净文件不出还原项，故另取状态断言）
    const withChange = buildTabMenu(state({ svnReady: true, tortoiseReady: true, svnStatusOfTarget: 'modified' }))
    expect(withChange.find((item) => item.id === 'svn-revert-cli')?.danger).toBe(true)
  })
})

describe('buildTabMenu SVN CLI 三项状态矩阵', () => {
  /** 带目标状态的菜单状态（默认两个页签、CLI+Tortoise 就绪）。 */
  const withStatus = (svnStatusOfTarget: TabMenuState['svnStatusOfTarget']) =>
    state({ svnReady: true, tortoiseReady: true, svnStatusOfTarget })

  it('目标为已修改：出现「与基线比较」+「SVN 还原」，无「加入版本控制」', () => {
    const all = ids(buildTabMenu(withStatus('modified')))
    expect(all).toContain('svn-diff-base')
    expect(all).toContain('svn-revert-cli')
    expect(all).not.toContain('svn-add')
  })

  it('目标为未版本控制：出现「加入版本控制」，无比较/还原', () => {
    const all = ids(buildTabMenu(withStatus('unversioned')))
    expect(all).toContain('svn-add')
    expect(all).not.toContain('svn-diff-base')
    expect(all).not.toContain('svn-revert-cli')
  })

  it('目标不在变更清单（干净文件）：只有「与基线比较」，无加入/还原', () => {
    const all = ids(buildTabMenu(withStatus(undefined)))
    expect(all).toContain('svn-diff-base')
    expect(all).not.toContain('svn-add')
    expect(all).not.toContain('svn-revert-cli')
  })

  it('二进制文件（图片）不出「与基线比较」，但已改动的仍可还原', () => {
    const png = state({ svnReady: true, svnStatusOfTarget: 'modified', path: 'img/logo.png', tabs: [{ path: 'img/logo.png' }] })
    const all = ids(buildTabMenu(png))
    expect(all).not.toContain('svn-diff-base')
    expect(all).toContain('svn-revert-cli')
  })

  it('冲突条目：可比较且可还原（danger 标记）', () => {
    const entries = buildTabMenu(withStatus('conflicted'))
    expect(ids(entries)).toContain('svn-diff-base')
    expect(entries.find((item) => item.id === 'svn-revert-cli')?.danger).toBe(true)
  })

  it('缺少 svnReady 时不出任何 CLI 三项（能力守卫优先）', () => {
    const all = ids(buildTabMenu(state({ svnStatusOfTarget: 'modified' })))
    expect(all).not.toContain('svn-diff-base')
    expect(all).not.toContain('svn-revert-cli')
    expect(all).not.toContain('svn-add')
  })
})
