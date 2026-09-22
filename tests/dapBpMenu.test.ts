/**
 * 断点 gutter 右键菜单条目测试。
 * 期望值逐字对齐 CodeBuddy（VS Code 内核）官方中文语言包译文。
 * 作者 ddj 2026年09月29号
 */
import { describe, expect, it } from 'vitest'
import { buildBpMenu } from '../src/client/dap/bpMenu.js'

describe('buildBpMenu · 无断点（CodeBuddy 四项添加类）', () => {
  it('四项文案与顺序逐字一致', () => {
    const menu = buildBpMenu({ hasBreakpoint: false })
    expect(menu.map((m) => m.label)).toEqual([
      '添加断点',
      '添加条件断点...',
      '添加记录点...',
      '添加触发的断点...',
    ])
    expect(menu.map((m) => m.id)).toEqual(['add', 'add-conditional', 'add-logpoint', 'add-triggered'])
  })

  it('调试器不支持触发的断点时标记 unsupported（仍显示，点击给提示）', () => {
    const menu = buildBpMenu({ hasBreakpoint: false, canTriggered: false })
    expect(menu[3].unsupported).toBe(true)
    const ok = buildBpMenu({ hasBreakpoint: false, canTriggered: true })
    expect(ok[3].unsupported).toBe(false)
  })
})

describe('buildBpMenu · 已有普通断点', () => {
  it('启用态：删除 断点（带 Delete 提示）/ 编辑 断点… / 禁用断点', () => {
    const menu = buildBpMenu({ hasBreakpoint: true, enabled: true })
    expect(menu.map((m) => m.label)).toEqual(['删除 断点', '编辑 断点…', '禁用断点'])
    expect(menu[0].hint).toBe('Delete')
  })

  it('禁用态：第三项为「启用 断点」（注意 CodeBuddy 该条带空格）', () => {
    const menu = buildBpMenu({ hasBreakpoint: true, enabled: false })
    expect(menu[2]).toEqual({ id: 'enable', label: '启用 断点' })
  })
})

describe('buildBpMenu · 记录点（有日志消息）名词随类型切换', () => {
  it('三项均为「记录点」名词', () => {
    const menu = buildBpMenu({ hasBreakpoint: true, enabled: true, isLogpoint: true })
    expect(menu.map((m) => m.label)).toEqual(['删除 记录点', '编辑 记录点…', '禁用记录点'])
  })

  it('记录点禁用态 → 启用 记录点', () => {
    expect(buildBpMenu({ hasBreakpoint: true, enabled: false, isLogpoint: true })[2].label).toBe('启用 记录点')
  })
})

describe('buildBpMenu · 运行到行', () => {
  it('暂停中且可运行到行 → 末尾追加分隔线 + 运行到行', () => {
    const menu = buildBpMenu({ hasBreakpoint: true, enabled: true, paused: true, canRunTo: true })
    expect(menu).toHaveLength(4)
    expect(menu[3]).toEqual({ id: 'run-to-line', label: '运行到行', separator: true })
  })

  it('非暂停 → 不出现运行到行', () => {
    const menu = buildBpMenu({ hasBreakpoint: true, enabled: true, paused: false, canRunTo: true })
    expect(menu.map((m) => m.id)).not.toContain('run-to-line')
  })

  it('空行也支持运行到行（CodeBuddy 在 e.length===0 时同样追加）', () => {
    const menu = buildBpMenu({ hasBreakpoint: false, paused: true, canRunTo: true })
    expect(menu.map((m) => m.label)).toEqual([
      '添加断点', '添加条件断点...', '添加记录点...', '添加触发的断点...', '运行到行',
    ])
  })
})
