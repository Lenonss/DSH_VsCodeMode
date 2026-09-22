/** DAP 栈帧裸 chunkname 回退测试。作者 ddj 2026年09月29号 */
import { describe, expect, it } from 'vitest'
import { DapSession } from '../src/dap/manager.js'

describe('DapSession frame source fallback', () => {
  it('source 只有无扩展名 name 时从 workspace index 解析 Lua 文件', async () => {
    const root = 'D:/Work/PopIsland/IslandSplash_BugFix2'
    const file = root + '/Assets/Scripts/Lua/Module/GuideSystem/GuideSystemMgr.lua'
    const session = new DapSession({ findFiles: async () => [file] })
    const current = session as unknown as { workspacePath: string; frameViewOf: (item: unknown, index: number) => Promise<unknown> }
    current.workspacePath = root
    const frame = await current.frameViewOf({ source: { name: 'GuideSystemMgr' }, line: 199, name: 'OnUpdate' }, 0) as { file: string; rawFile: string; line: number }
    expect(frame).toMatchObject({ file: 'Assets/Scripts/Lua/Module/GuideSystem/GuideSystemMgr.lua', rawFile: 'GuideSystemMgr', line: 199 })
  })

  it('source.path 为绝对但无扩展名时仍解析真实 Lua 文件', async () => {
    const root = 'D:/Work/PopIsland/IslandSplash_BugFix2'
    const file = root + '/Assets/Scripts/Lua/Module/GuideSystem/GuideSystemMgr.lua'
    const session = new DapSession({ findFiles: async () => [file] })
    const current = session as unknown as { workspacePath: string; frameViewOf: (item: unknown, index: number) => Promise<unknown> }
    current.workspacePath = root
    const frame = await current.frameViewOf({ source: { path: root + '/GuideSystemMgr', name: 'GuideSystemMgr' }, line: 199 }, 0) as { file: string }
    expect(frame.file).toBe('Assets/Scripts/Lua/Module/GuideSystem/GuideSystemMgr.lua')
  })
})
