/**
 * client sidebar/contextMenu.ts 纯函数测试（注册表 + 菜单构建，不触 React/浏览器），
 * 以及 ui/ContextMenu.ts 的渲染行展开（separator 语义回归）。
 * 覆盖：register/get/list/unregister、缺 id/run/label 抛错、order 排序、visible 过滤、
 * separator 为前置分隔线（曾经把条目本身吞掉）。
 * 作者 ddj 2026-08-27 / 2026-09-11
 */
import { describe, expect, it } from 'vitest'
import { buildTreeMenu, createTreeMenuRegistry } from '../src/client/sidebar/contextMenu.js'
import { menuRows } from '../src/client/ui/ContextMenu.js'
import type { ContextMenuEntry } from '../src/client/ui/ContextMenu.js'
import type { SidebarCtx } from '../src/client/sidebar/types.js'

const ctx = {} as SidebarCtx

describe('createTreeMenuRegistry', () => {
  it('register/get/list/unregister 生命周期', () => {
    const reg = createTreeMenuRegistry()
    const item = { id: 'a', label: 'A', run: () => {} }
    const dispose = reg.register(item)
    expect(reg.get('a')).toBe(item)
    expect(reg.list()).toEqual([item])
    dispose()
    expect(reg.get('a')).toBeUndefined()
    expect(reg.list()).toEqual([])
  })

  it('缺少 id/run/label 抛 TypeError', () => {
    const reg = createTreeMenuRegistry()
    expect(() => reg.register({ id: 'x', label: 'X' } as never)).toThrow(TypeError)
    expect(() => reg.register({ id: 'x', run: () => {} } as never)).toThrow(TypeError)
  })

  it('list 按 order 升序（缺省 100）', () => {
    const reg = createTreeMenuRegistry()
    reg.register({ id: 'b', label: 'B', order: 20, run: () => {} })
    reg.register({ id: 'a', label: 'A', order: 10, run: () => {} })
    reg.register({ id: 'c', label: 'C', run: () => {} })
    expect(reg.list().map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('buildTreeMenu', () => {
  it('无注册表 → 空列表', () => {
    expect(buildTreeMenu(undefined, { path: 'a.ts', type: 'file' }, ctx)).toEqual([])
  })

  it('visible 过滤 + order 排序', () => {
    const reg = createTreeMenuRegistry()
    reg.register({
      id: 'dir-only', label: '仅目录', order: 1,
      visible: (target) => target.type === 'directory',
      run: () => {},
    })
    reg.register({ id: 'all', label: '通用', order: 2, run: () => {} })

    const file = buildTreeMenu(reg, { path: 'a.ts', type: 'file' }, ctx)
    expect(file.map((item) => item.id)).toEqual(['all'])

    const dir = buildTreeMenu(reg, { path: 'src', type: 'directory' }, ctx)
    expect(dir.map((item) => item.id)).toEqual(['dir-only', 'all'])
  })
})

describe('buildTreeMenu 分组分隔线与动态字段', () => {
  const target = { path: 'src', type: 'directory' } as const

  it('组切换出前置分隔线，同组内不出（首条除外）', () => {
    const reg = createTreeMenuRegistry()
    reg.register({ id: 'a', label: 'A', order: 1, group: 1, run: () => {} })
    reg.register({ id: 'b', label: 'B', order: 2, group: 1, run: () => {} })
    reg.register({ id: 'c', label: 'C', order: 3, group: 2, run: () => {} })
    const menu = buildTreeMenu(reg, target, ctx)
    expect(menu.map((item) => item.id + ':' + item.separator)).toEqual(['a:false', 'b:false', 'c:true'])
  })

  it('组首条被 visible 隐藏时下一条顶上分组头（不丢线不叠线）', () => {
    const reg = createTreeMenuRegistry()
    reg.register({ id: 'a', label: 'A', order: 1, group: 1, visible: () => false, run: () => {} })
    reg.register({ id: 'b', label: 'B', order: 2, group: 1, run: () => {} })
    reg.register({ id: 'c', label: 'C', order: 3, group: 2, visible: () => false, run: () => {} })
    reg.register({ id: 'd', label: 'D', order: 4, group: 2, run: () => {} })
    const menu = buildTreeMenu(reg, target, ctx)
    expect(menu.map((item) => item.id + ':' + item.separator)).toEqual(['b:false', 'd:true'])
  })

  it('动态组头与静态 separator 相邻时合并为一条（不叠双线）', () => {
    const reg = createTreeMenuRegistry()
    reg.register({ id: 'a', label: 'A', order: 1, group: 1, run: () => {} })
    reg.register({ id: 'b', label: 'B', order: 2, group: 2, run: () => {} })
    reg.register({ id: 'c', label: 'C', order: 3, separator: true, run: () => {} })
    const menu = buildTreeMenu(reg, target, ctx)
    expect(menu.map((item) => item.id + ':' + item.separator)).toEqual(['a:false', 'b:true', 'c:false'])
  })

  it('无 group 的存量条目沿用静态 separator（兼容第三方注册）', () => {
    const reg = createTreeMenuRegistry()
    reg.register({ id: 'a', label: 'A', order: 1, run: () => {} })
    reg.register({ id: 'b', label: 'B', order: 2, separator: true, run: () => {} })
    const menu = buildTreeMenu(reg, target, ctx)
    expect(menu.map((item) => item.id + ':' + item.separator)).toEqual(['a:false', 'b:true'])
  })

  it('动态 label / disabled 按目标解析为定值', () => {
    const reg = createTreeMenuRegistry()
    reg.register({
      id: 'dyn',
      label: (t) => (t.type === 'directory' ? '目录文案' : '文件文案'),
      order: 1,
      disabled: (t) => t.path === '',
      run: () => {},
    })
    const menu = buildTreeMenu(reg, target, ctx)
    expect(menu[0].label).toBe('目录文案')
    expect(menu[0].disabled).toBe(false)
    const rootMenu = buildTreeMenu(reg, { path: '', type: 'directory' }, ctx)
    expect(rootMenu[0].label).toBe('目录文案')
    expect(rootMenu[0].disabled).toBe(true)
  })
})

describe('menuRows 渲染行展开（separator 语义回归）', () => {
  /** 造条目（separator 表示「本条带前置分隔线」）。 */
  const item = (id: string, separator = false): ContextMenuEntry => ({ id, label: id, separator })

  it('separator 为前置分隔线：条目本身仍渲染（回归：曾被整条吞掉）', () => {
    const rows = menuRows([item('a'), item('b', true), item('c')])
    expect(rows.map((r) => r.kind + ':' + r.entry.id)).toEqual(['item:a', 'sep:b', 'item:b', 'item:c'])
  })

  it('首个条目带 separator 时不渲染顶部分隔线', () => {
    expect(menuRows([item('a', true)]).map((r) => r.kind)).toEqual(['item'])
  })

  it('通常条目不产生分隔线', () => {
    expect(menuRows([item('a'), item('b')]).map((r) => r.kind)).toEqual(['item', 'item'])
  })

  it('空表返回空行（不抛错）', () => {
    expect(menuRows([])).toEqual([])
  })
})
