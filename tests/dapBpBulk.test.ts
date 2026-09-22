/** 断点批量操作（全量启停/清空）纯函数测试。作者 ddj 2026年09月21号 */
import { describe, expect, it } from 'vitest'
import { removeAll, setAllEnabled, type BpMap } from '../src/client/dap/breakpoints.js'

describe('setAllEnabled', () => {
  const base: BpMap = {
    'a/one.lua': [
      { line: 10, enabled: true },
      { line: 20, enabled: false, condition: 'x > 1' },
    ],
    'b/two.lua': [{ line: 5, enabled: true, logMessage: 'hit' }],
  }

  it('全量禁用：enabled 置 false 且保留编辑字段', () => {
    const next = setAllEnabled(base, false)
    expect(next['a/one.lua'][0]).toMatchObject({ line: 10, enabled: false })
    expect(next['a/one.lua'][1]).toMatchObject({ line: 20, enabled: false, condition: 'x > 1' })
    expect(next['b/two.lua'][0]).toMatchObject({ line: 5, enabled: false, logMessage: 'hit' })
  })

  it('全量启用：禁用条目恢复为 true', () => {
    const disabled = setAllEnabled(base, false)
    const enabled = setAllEnabled(disabled, true)
    expect(enabled['a/one.lua'].every((it) => it.enabled === true)).toBe(true)
    expect(enabled['b/two.lua'][0].enabled).toBe(true)
  })

  it('已处于目标态的条目原样保留（同引用）', () => {
    const next = setAllEnabled(base, false)
    expect(next['a/one.lua'][1]).toBe(base['a/one.lua'][1])
    expect(next['a/one.lua'][0]).not.toBe(base['a/one.lua'][0])
  })

  it('空表返回空表且不改原表', () => {
    const next = setAllEnabled({}, true)
    expect(next).toEqual({})
    expect(Object.keys(base)).toEqual(['a/one.lua', 'b/two.lua'])
  })
})

describe('removeAll', () => {
  it('清空为空表并列出曾有条目的文件', () => {
    const map: BpMap = {
      'a/one.lua': [{ line: 10, enabled: true }],
      'b/two.lua': [{ line: 5, enabled: true }],
    }
    const cleared = removeAll(map)
    expect(cleared.map).toEqual({})
    expect(cleared.files.sort()).toEqual(['a/one.lua', 'b/two.lua'])
  })

  it('空列表文件不进 files；原表不被修改', () => {
    const map: BpMap = { 'a/one.lua': [{ line: 10, enabled: true }], 'b/empty.lua': [] }
    const cleared = removeAll(map)
    expect(cleared.files).toEqual(['a/one.lua'])
    expect(Object.keys(map)).toEqual(['a/one.lua', 'b/empty.lua'])
  })

  it('空表返回空 files', () => {
    expect(removeAll({})).toEqual({ map: {}, files: [] })
  })
})
