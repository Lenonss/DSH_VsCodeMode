/**
 * 文件页签右键菜单模型测试：条目顺序与分组、各禁用规则、固定态标签切换、
 * 键位提示只在真实绑定时出现，以及「不可实现条目」的排除守约。
 * 作者 ddj 2026-09-11
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
