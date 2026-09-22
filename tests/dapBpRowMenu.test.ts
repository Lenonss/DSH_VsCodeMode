/** 调试面板断点行右键菜单条目测试（对齐 CodeBuddy 断点视图行菜单）。作者 ddj 2026年09月21号 */
import { describe, expect, it } from 'vitest'
import { buildBpRowMenu } from '../src/client/dap/bpRowMenu.js'

describe('buildBpRowMenu', () => {
  it('启用态：编辑组四项 + 禁用断点 + 删除断点，编辑组后置分隔线', () => {
    const entries = buildBpRowMenu({ enabled: true })
    expect(entries.map((it) => it.id)).toEqual([
      'edit', 'edit-condition', 'edit-hit-count', 'edit-logpoint', 'disable', 'remove',
    ])
    expect(entries.map((it) => it.label)).toEqual([
      '编辑断点…', '编辑条件…', '编辑命中次数…', '编辑记录点…', '禁用断点', '删除断点',
    ])
    expect(entries.find((it) => it.id === 'disable')?.separator).toBe(true)
    expect(entries.find((it) => it.id === 'remove')?.separator).toBeUndefined()
  })

  it('禁用态：禁用项替换为启用断点', () => {
    const entries = buildBpRowMenu({ enabled: false })
    expect(entries.map((it) => it.id)).toEqual([
      'edit', 'edit-condition', 'edit-hit-count', 'edit-logpoint', 'enable', 'remove',
    ])
    expect(entries.find((it) => it.id === 'enable')?.label).toBe('启用断点')
  })

  it('enabled 缺省按启用处理', () => {
    expect(buildBpRowMenu({}).some((it) => it.id === 'disable')).toBe(true)
    expect(buildBpRowMenu({}).some((it) => it.id === 'enable')).toBe(false)
  })
})
