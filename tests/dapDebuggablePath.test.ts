/** 调试目标文件判定测试。作者 ddj 2026年09月29号 */
import { describe, expect, it } from 'vitest'
import { isDebuggablePath } from '../src/client/dap/breakpoints.js'

describe('isDebuggablePath', () => {
  it('默认仅 .lua', () => {
    expect(isDebuggablePath('Assets/Lua/GameHall.lua')).toBe(true)
    expect(isDebuggablePath('Assets/Lua/GameHall.LUA')).toBe(true)
    expect(isDebuggablePath('Assets/Docs/plan.md')).toBe(false)
    expect(isDebuggablePath('Assets/Scripts/Foo.cs')).toBe(false)
  })

  it('支持带尾缀的扩展名（Unity .lua.bytes）', () => {
    expect(isDebuggablePath('Assets/Lua/GameHall.lua.bytes', ['.lua', '.lua.bytes'])).toBe(true)
    expect(isDebuggablePath('Assets/Lua/GameHall.lua', ['.lua', '.lua.bytes'])).toBe(true)
    expect(isDebuggablePath('Assets/Lua/GameHall.bytes', ['.lua', '.lua.bytes'])).toBe(false)
  })

  it('空路径不命中', () => {
    expect(isDebuggablePath('')).toBe(false)
  })
})
