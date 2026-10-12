/** DAP 栈帧裸 chunkname 回退测试。作者 ddj 2026年09月29号 */
import { describe, expect, it, vi } from 'vitest'
import { DapSession } from '../src/dap/manager.js'
import type { DapDebugConfig, DapFrameView } from '../src/shared/dap.js'
import type { DapMessage } from '../src/dap/protocol.js'

interface SessionProbe {
  workspacePath: string
  extId: string
  exts: string[]
  config: DapDebugConfig | null
  sourceFiles: Map<string, string>
  frameViewOf(item: unknown, index: number): Promise<DapFrameView>
  respondFindFile(body: Record<string, unknown>): Promise<void>
  send(message: DapMessage): void
}

const root = 'D:/Work/PopIsland/IslandSplash_BugFix2'
const luaFile = root + '/Assets/Scripts/Lua/Module/Build/Logic/BuildLogic.lua'
const csFile = root + '/Assets/Editor/Build/Logic/BuildLogic.cs'

/**
 * 创建不启动子进程的源码解析探针，捕获实际 findFileRsp 协议消息。
 * @private
 * @author ddj 2026年10月09号
 * @param files 文件搜索返回的原始候选
 * @param extId 适配器扩展标识
 * @param exts 适配器声明的源码后缀
 * @returns 会话内部探针与搜索、发送调用记录
 */
function probeSession(files: string[], extId = 'tangzx.emmylua', exts = ['.lua']) {
  const findFiles = vi.fn(async () => files)
  const session = new DapSession({ findFiles })
  const probe = session as unknown as SessionProbe
  probe.workspacePath = root
  probe.extId = extId
  probe.exts = exts
  const send = vi.fn<(message: DapMessage) => void>()
  probe.send = send
  return { probe, findFiles, send }
}

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

describe('DapSession language-aware source mapping', () => {
  it('findFileRsp 排除同名 C# 和 meta，并按完整 Lua 路径排序', async () => {
    const otherLua = root + '/Assets/Other/BuildLogic.lua'
    const { probe, send } = probeSession([csFile, otherLua, luaFile + '.meta', luaFile])
    await probe.respondFindFile({ seq: 6, file: 'Assets/Scripts/Lua/Module/Build/Logic/BuildLogic.lua' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      command: 'findFileRsp', arguments: { seq: 6, files: [luaFile, otherLua] },
    }))
    expect(probe.sourceFiles.get('buildlogic.lua')).toBe(luaFile)
  })

  it('真实裸 BuildLogic findFileReq 返回 Lua，停帧保留第 173 行', async () => {
    const { probe, send } = probeSession([csFile, luaFile + '.meta', luaFile])
    await probe.respondFindFile({ seq: 7, file: 'BuildLogic' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ arguments: { seq: 7, files: [luaFile] } }))
    const frame = await probe.frameViewOf({ id: 77, source: { name: 'BuildLogic' }, line: 173 }, 0)
    expect(frame).toMatchObject({ id: 0, file: 'Assets/Scripts/Lua/Module/Build/Logic/BuildLogic.lua', line: 173 })
  })

  it('失效 C# 缓存不能阻止重新解析适配器误报的 .cs 路径', async () => {
    const { probe, findFiles } = probeSession([csFile, luaFile])
    probe.sourceFiles.set('buildlogic', csFile)
    const frame = await probe.frameViewOf({ source: { path: csFile, name: 'BuildLogic' }, line: 173 }, 0)
    expect(findFiles).toHaveBeenCalledWith(root, 'BuildLogic')
    expect(frame.file).toBe('Assets/Scripts/Lua/Module/Build/Logic/BuildLogic.lua')
    expect(probe.sourceFiles.get('buildlogic')).toBe(luaFile)
  })

  it('没有合法 Lua 候选时不跳到 C#，并移除错误缓存', async () => {
    const { probe } = probeSession([csFile, luaFile + '.meta'])
    probe.sourceFiles.set('buildlogic', csFile)
    const frame = await probe.frameViewOf({ source: { path: csFile, name: 'BuildLogic' }, line: 173 }, 0)
    expect(frame).toMatchObject({ file: '', rawFile: 'BuildLogic', line: 173 })
    expect(probe.sourceFiles.has('buildlogic')).toBe(false)
  })

  it('findFileReq 无合法候选时返回空列表，不保留旧缓存', async () => {
    const { probe, send } = probeSession([csFile])
    probe.sourceFiles.set('buildlogic', csFile)
    await probe.respondFindFile({ seq: 8, file: 'BuildLogic' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ arguments: { seq: 8, files: [] } }))
    expect(probe.sourceFiles.has('buildlogic')).toBe(false)
  })

  it('完整合法 source.path 优先于同名 Lua 缓存', async () => {
    const { probe, findFiles } = probeSession([])
    probe.sourceFiles.set('buildlogic', root + '/Assets/Other/BuildLogic.lua')
    const frame = await probe.frameViewOf({ source: { path: luaFile, name: 'BuildLogic' }, line: 173 }, 0)
    expect(frame.file).toBe('Assets/Scripts/Lua/Module/Build/Logic/BuildLogic.lua')
    expect(findFiles).not.toHaveBeenCalled()
  })

  it('合法完整路径不会给另一份同名源码写入错误缓存', async () => {
    const { probe } = probeSession([luaFile])
    const otherLua = root + '/Assets/Other/BuildLogic.lua'
    await probe.frameViewOf({ source: { path: otherLua, name: 'BuildLogic' }, line: 2 }, 0)
    const frame = await probe.frameViewOf({ source: { name: 'BuildLogic' }, line: 173 }, 0)
    expect(frame.file).toBe('Assets/Scripts/Lua/Module/Build/Logic/BuildLogic.lua')
  })

  it('支持大小写、Windows 路径、.lua.bytes 与配置 ext', async () => {
    const bytes = (luaFile + '.bytes').replace(/\//g, '\\').replace('.lua.bytes', '.LUA.BYTES')
    const custom = root + '/Assets/Scripts/BuildLogic.luac'
    const { probe, send } = probeSession([csFile, custom, bytes])
    probe.config = { type: 'emmylua_attach', name: 'lua', ext: ['.luac'] }
    await probe.respondFindFile({ seq: 9, file: 'BuildLogic' })
    const message = send.mock.calls[0][0]
    expect(message).toMatchObject({ arguments: { files: expect.arrayContaining([custom, bytes]) } })
    expect((message as { arguments: { files: string[] } }).arguments.files).toHaveLength(2)
  })

  it('C# 调试保留 .cs 与原生 frameId，不施加 Lua 限制', async () => {
    const { probe, send } = probeSession([luaFile, csFile], 'x.csharp', ['.cs'])
    await probe.respondFindFile({ seq: 10, file: 'BuildLogic' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ arguments: { seq: 10, files: [csFile] } }))
    const frame = await probe.frameViewOf({ id: 77, source: { path: csFile, name: 'BuildLogic' }, line: 3 }, 0)
    expect(frame).toMatchObject({ id: 77, file: 'Assets/Editor/Build/Logic/BuildLogic.cs', line: 3 })
  })

  it('未知语言没有声明后缀时保留完整路径及搜索兼容', async () => {
    const { probe, send, findFiles } = probeSession([csFile], 'x.unknown', [])
    await probe.respondFindFile({ seq: 11, file: 'BuildLogic' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ arguments: { seq: 11, files: [csFile] } }))
    findFiles.mockClear()
    const frame = await probe.frameViewOf({ source: { path: root + '/Assets/Other/Script.custom' }, line: 4 }, 0)
    expect(frame.file).toBe('Assets/Other/Script.custom')
    expect(findFiles).not.toHaveBeenCalled()
  })
})
