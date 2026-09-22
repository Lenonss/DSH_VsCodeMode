/** edrv.dap 契约纯函数测试：chunkname ↔ 工作区文件匹配。作者 ddj 2026年09月29号 */
import { describe, expect, it } from 'vitest'
import { chunkMatchesFile } from '../src/shared/dap.js'

describe('chunkMatchesFile', () => {
  it('剥 @ 前缀后按 basename 相等命中', () => {
    expect(chunkMatchesFile('@GameHallView', 'Assets/Scripts/Lua/Module/GameHall/View/GameHallView.lua')).toBe(true)
  })

  it('完整相对路径相等命中', () => {
    expect(chunkMatchesFile('Assets/Scripts/Lua/Data/BuildData.lua', 'Assets/Scripts/Lua/Data/BuildData.lua')).toBe(true)
  })

  it('反斜杠 chunkname 归一后命中', () => {
    expect(chunkMatchesFile('Module\\Team\\TeamModel.lua', 'Assets/Lua/Module/Team/TeamModel.lua')).toBe(true)
  })

  it('无扩展名 chunkname 按 stem 命中（xLua 惯例）', () => {
    expect(chunkMatchesFile('gameroom', 'Assets/Lua/GameRoom.lua')).toBe(true)
  })

  it('不同名不命中', () => {
    expect(chunkMatchesFile('@Other', 'Assets/Lua/GameHall.lua')).toBe(false)
  })

  it('空输入不命中', () => {
    expect(chunkMatchesFile('', 'a.lua')).toBe(false)
    expect(chunkMatchesFile('@a', '')).toBe(false)
  })
})
