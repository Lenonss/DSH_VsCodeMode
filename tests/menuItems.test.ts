/**
 * client sidebar/menuItems.ts 内置菜单项测试。
 * 覆盖：默认项结构与排序、新增「添加引用到对话」的文件/文件夹分派、
 * 忙态/不可用降级、visible 守卫（空路径/无会话/动作集缺失）。
 * 作者 ddj 2026-09-03
 */
import { describe, expect, it, vi } from 'vitest'
import { createDefaultFileMenuItems } from '../src/client/sidebar/menuItems.js'
import type { TreeMenuItem } from '../src/client/sidebar/contextMenu.js'
import type { SidebarCtx } from '../src/client/sidebar/types.js'

/** 按 id 索引内置菜单项。 */
const byId = (): Record<string, TreeMenuItem> =>
  Object.fromEntries(createDefaultFileMenuItems().map((item) => [item.id, item]))

/** 假「添加到对话」动作集：appendReference 记录调用并返回可配置结果。 */
const makeAdd = (outcome = 'ok') => ({
  appendReference: vi.fn(() => Promise.resolve(outcome)),
})

/** 构造假 ctx（缺省 sessionId=s1、带动作集与 notify spy）；传 null 表示动作集缺失。 */
const makeCtx = (add: ReturnType<typeof makeAdd> | null = makeAdd(), overrides = {}) =>
  Object.assign(
    { sessionId: 's1', addToConversation: add == null ? undefined : add, notify: vi.fn() },
    overrides,
  ) as unknown as SidebarCtx

describe('createDefaultFileMenuItems', () => {
  it('内置两项且按 order 排序：在文件浏览器中打开 → 添加引用到对话', () => {
    const items = createDefaultFileMenuItems()
    expect(items.map((item) => item.id)).toEqual(['reveal-in-explorer', 'add-to-conversation'])
    expect(items[1]).toMatchObject({ id: 'add-to-conversation', label: '添加引用到对话', order: 1 })
  })

  it('文件目标：以 file 外观追加引用并提示「已添加文件引用」', async () => {
    const add = makeAdd('ok')
    const notify = vi.fn()
    const ctx = makeCtx(add, { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(add.appendReference).toHaveBeenCalledWith('s1', 'src/index.ts', undefined, 'file')
    expect(notify).toHaveBeenCalledWith('已添加文件引用')
  })

  it('目录目标：以 folder 外观追加引用并提示「已添加文件夹引用」', async () => {
    const add = makeAdd('ok')
    const notify = vi.fn()
    const ctx = makeCtx(add, { notify })
    byId()['add-to-conversation'].run({ path: 'src/components', type: 'directory' }, ctx)
    await Promise.resolve()
    expect(add.appendReference).toHaveBeenCalledWith('s1', 'src/components', undefined, 'folder')
    expect(notify).toHaveBeenCalledWith('已添加文件夹引用')
  })

  it('忙态：提示已降级纯文本', async () => {
    const notify = vi.fn()
    const ctx = makeCtx(makeAdd('busy'), { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(notify).toHaveBeenCalledWith('已添加文件引用（输入框忙，已降级纯文本）')
  })

  it('不可用：提示无法添加到对话', async () => {
    const notify = vi.fn()
    const ctx = makeCtx(makeAdd('unavailable'), { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(notify).toHaveBeenCalledWith('无法添加到对话（无会话或输入框不可用）')
  })

  it('动作集缺失：notify 提示不可用且不调用 appendReference', () => {
    const ctx = makeCtx(null)
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    expect(ctx.notify).toHaveBeenCalledWith('添加到对话不可用')
  })

  it('visible 守卫：空路径/无会话/动作集缺失隐藏，正常目标显示', () => {
    const item = byId()['add-to-conversation']
    expect(item.visible({ path: '', type: 'directory' }, makeCtx())).toBe(false)
    expect(item.visible({ path: 'src', type: 'directory' }, makeCtx(null))).toBe(false)
    expect(item.visible({ path: 'src', type: 'directory' }, makeCtx(null, { sessionId: undefined }))).toBe(false)
    expect(item.visible({ path: 'src', type: 'directory' }, makeCtx())).toBe(true)
  })
})
