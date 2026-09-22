/** DAP source path 归一化与候选排序测试。作者 ddj 2026年09月29号 */
import { describe, expect, it } from 'vitest'
import { normalizeSourcePath, rankSourceCandidates, sourcePathOf } from '../src/dap/sourcePath.js'

describe('DAP source path mapping', () => {
  const root = 'D:/Work/PopIsland/IslandSplash_BugFix2'

  it('处理 Windows 绝对路径与 file URI', () => {
    expect(normalizeSourcePath('D:\\Work\\PopIsland\\IslandSplash_BugFix2\\Assets\\A.lua'))
      .toBe('D:/Work/PopIsland/IslandSplash_BugFix2/Assets/A.lua')
    expect(normalizeSourcePath('file:///D:/Work/PopIsland/IslandSplash_BugFix2/Assets/A.lua'))
      .toBe('D:/Work/PopIsland/IslandSplash_BugFix2/Assets/A.lua')
  })

  it('工作区内转相对路径，工作区外保留绝对路径', () => {
    expect(sourcePathOf('d:/work/popisland/islandsplash_bugfix2/Assets/A.lua', root)).toBe('Assets/A.lua')
    expect(sourcePathOf('D:/Other/A.lua', root)).toBe('D:/Other/A.lua')
    expect(sourcePathOf('@Assets/A.lua', root)).toBe('Assets/A.lua')
  })

  it('完整 chunk path 优先于同名 basename', () => {
    const files = [
      'D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Other/GuideSystemMgr.lua',
      'D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/Lua/Module/GuideSystem/GuideSystemMgr.lua',
    ]
    const ranked = rankSourceCandidates('Assets/Scripts/Lua/Module/GuideSystem/GuideSystemMgr.lua', files, root)
    expect(ranked[0]).toContain('Module/GuideSystem/GuideSystemMgr.lua')
  })

  it('无扩展名 chunk 仍能匹配 Lua 文件', () => {
    const files = [root + '/Assets/Scripts/Lua/Module/GuideSystem/GuideSystemMgr.lua']
    expect(rankSourceCandidates('GuideSystemMgr', files, root)).toEqual(files)
  })
})
