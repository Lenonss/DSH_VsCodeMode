/**
 * 测试验收模式：`items.json` 定义校验（重复/非法 ID、标题、files 围栏、retired）。
 * @author ddj 2026年11月25号
 */
import { describe, expect, it } from 'vitest'
import { checkDefinition } from '../src/shared/testCheck.js'

/** 造一条最小合法条目。 */
function item(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: '能验的句子', ...overrides }
}

describe('items.json 定义校验', () => {
  it('最小定义通过，缺省字段补齐', () => {
    const checked = checkDefinition({ items: [item('settings.ui.001')] }, 'settings-ui')
    expect(checked.errors).toEqual([])
    expect(checked.definition?.version).toBe(1)
    expect(checked.definition?.id).toBe('settings-ui')
    expect(checked.definition?.items[0]).toEqual({ id: 'settings.ui.001', title: '能验的句子' })
  })

  it('重复 ID 报错，并指出是第几条', () => {
    const checked = checkDefinition({ items: [item('a.b.001'), item('a.b.001')] })
    expect(checked.definition).toBeUndefined()
    expect(checked.errors.join('\n')).toContain('第 2 条：重复 ID a.b.001')
  })

  it('非法 ID 报错，附上原文便于定位', () => {
    const checked = checkDefinition({ items: [item('settings.Claude.004')] })
    expect(checked.errors.join('\n')).toContain('settings.Claude.004')
  })

  it('空标题报错', () => {
    const checked = checkDefinition({ items: [{ id: 'a.b.001', title: '   ' }] })
    expect(checked.errors.join('\n')).toContain('title 不能为空')
  })

  it('files 拒绝绝对路径与越界路径', () => {
    const checked = checkDefinition({
      items: [item('a.b.001', { files: ['C:/secret.txt', '../outside.ts', 'src/ok.ts'] })],
    })
    const text = checked.errors.join('\n')
    expect(text).toContain('不是相对项目根的路径')
    expect(text).toContain('outside.ts')
    expect(text).not.toContain('src/ok.ts 不是')
  })

  it('retired 保留但标记；group 去空白后保留', () => {
    const checked = checkDefinition({
      items: [item('a.b.001', { retired: true }), item('a.b.002', { group: '  设置  ' })],
    })
    expect(checked.errors).toEqual([])
    expect(checked.definition?.items[0].retired).toBe(true)
    expect(checked.definition?.items[1].group).toBe('设置')
  })

  it('version 只接受 1；items 必须是数组；顶层必须是对象', () => {
    expect(checkDefinition({ version: 2, items: [] }).errors.join()).toContain('version')
    expect(checkDefinition({ items: 'nope' }).errors.join()).toContain('items 必须是数组')
    expect(checkDefinition([]).errors.join()).toContain('顶层必须是对象')
  })

  it('一条坏条目不妨碍其余条目的错误一起报告', () => {
    const checked = checkDefinition({
      items: [item('bad'), item('a.b.002', { files: ['/abs.ts'] })],
    })
    expect(checked.errors.length).toBeGreaterThanOrEqual(2)
  })
})
