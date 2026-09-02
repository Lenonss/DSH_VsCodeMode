/**
 * dsh-vscode-mode tests — LSP 引擎纯函数：坐标换算 / JSON-RPC 帧 / URI 转换 /
 * provider 解析 / manager 引用计数 / parseLua 注解大纲。
 * 作者 ddj 2026-08-27
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monoToLsp, lspToMono, fileUriToPath as sharedFileUriToPath, decodeSemanticTokens, isNavigableTokenType } from '../src/shared/lsp.js'
import { encodeMessage, parseFrame, createFrameParser } from '../src/lsp/jsonrpc.js'
import { pathToFileUri, fileUriToPath, isInside } from '../src/lsp/uri.js'
import { platformServerDir, exeSuffix, listMatchingDirs, candidateEmmyLua, resolveLuaProvider, resolveCSharpProvider, findInPath, clearProviderCache } from '../src/lsp/providers.js'
import { createLspManager } from '../src/lsp/manager.js'
import { createLspClient, type LspClientTransport } from '../src/lsp/client.js'
import { parseFrame } from '../src/lsp/jsonrpc.js'
import { toEdrvUri, targetOpenPath } from '../src/client/monaco/lsp/lspClient.js'
import { installLspSettingsSection } from '../src/lsp/settings.js'
import { LSP_SETTINGS_NS } from '../src/lsp/config.js'
import { parseOutline, SK } from '../src/client/outline/parse.js'
import { deriveDefinitionFromLocations } from '../src/lsp/derive.js'

describe('shared/lsp 坐标换算', () => {
  it('mono→lsp 0-based', () => {
    expect(monoToLsp(1, 1)).toEqual({ line: 0, character: 0 })
    expect(monoToLsp(3, 5)).toEqual({ line: 2, character: 4 })
    expect(monoToLsp(0, 0)).toEqual({ line: 0, character: 0 })
  })
  it('lsp→mono 1-based', () => {
    expect(lspToMono({ line: 0, character: 0 })).toEqual({ lineNumber: 1, column: 1 })
    expect(lspToMono({ line: 9, character: 7 })).toEqual({ lineNumber: 10, column: 8 })
  })
  it('fileUriToPath 兼容', () => {
    expect(sharedFileUriToPath('file:///D:/a/b.lua')).toBe('D:/a/b.lua')
    expect(sharedFileUriToPath('')).toBe('')
  })
})

describe('lsp/jsonrpc 帧编解码', () => {
  it('encode + parse 往返', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x' })
    const frame = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x' })
    const head = frame.toString('utf8').slice(0, frame.toString('utf8').indexOf('\r\n\r\n') + 4)
    expect(head).toBe('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n')
    const parsed = parseFrame(frame)
    expect(parsed).not.toBeNull()
    expect(JSON.parse(parsed!.body)).toEqual({ jsonrpc: '2.0', id: 1, method: 'x' })
    expect(parsed!.rest.length).toBe(0)
  })

  it('UTF-8 中文按字节计数', () => {
    const msg = { jsonrpc: '2.0', result: '中文内容' }
    const frame = encodeMessage(msg)
    const text = frame.toString('utf8')
    const m = /Content-Length: (\d+)/.exec(text)!
    const bodyStart = text.indexOf('\r\n\r\n') + 4
    expect(Number(m[1])).toBe(Buffer.byteLength(JSON.stringify(msg)))
    expect(frame.subarray(bodyStart).toString('utf8')).toBe(JSON.stringify(msg))
  })

  it('流式拆包：分段到达（头/体分离）', () => {
    const parser = createFrameParser()
    const frame = encodeMessage({ jsonrpc: '2.0', id: 2, method: 'a', params: { x: 1 } })
    const half = Math.floor(frame.length / 2)
    expect(parser.push(frame.subarray(0, half))).toEqual([])
    const rest = parser.push(frame.subarray(half))
    expect(rest.length).toBe(1)
    expect((rest[0] as { method: string }).method).toBe('a')
  })

  it('一包多帧', () => {
    const parser = createFrameParser()
    const a = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'a' })
    const b = encodeMessage({ jsonrpc: '2.0', id: 2, method: 'b' })
    const out = parser.push(Buffer.concat([a, b]))
    expect(out.length).toBe(2)
    expect((out[0] as { id: number }).id).toBe(1)
    expect((out[1] as { id: number }).id).toBe(2)
  })

  it('非法头自愈', () => {
    const parser = createFrameParser()
    const frame = encodeMessage({ jsonrpc: '2.0', id: 7, method: 'c' })
    const garbage = Buffer.from('NOT-A-VALID-HEADER\r\n\r\n{"broken":', 'utf8')
    const out = parser.push(Buffer.concat([garbage, frame]))
    expect(out.length).toBe(1)
    expect((out[0] as { id: number }).id).toBe(7)
  })
})

describe('lsp/uri 转换（Windows 风格）', () => {
  it('绝对路径 → file:// URI', () => {
    expect(pathToFileUri('D:/Work/a/b.lua')).toBe('file:///D:/Work/a/b.lua')
    expect(pathToFileUri('D:\\Work\\a\\b.lua')).toBe('file:///D:/Work/a/b.lua')
  })
  it('file:// URI → 路径', () => {
    expect(fileUriToPath('file:///D:/Work/a/b.lua')).toMatch(/[Dd]:/)
  })
  it('LSP 目标按 root 还原为工作区相对路径', () => {
    const root = 'D:/Work/PopIsland/IslandSplash_BugFix2'
    const uri = 'file:///D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/TeamModel.lua'
    expect(toEdrvUri(uri, root)).toBe('edrv:///Assets/Scripts/TeamModel.lua')
    expect(targetOpenPath({ uri, root })).toBe('Assets/Scripts/TeamModel.lua')
  })
  it('LSP 目标保留原始 root，避免 edrv scheme 泄漏', () => {
    const root = 'D:/Work/PopIsland/IslandSplash_BugFix2'
    const location = {
      uri: { scheme: 'edrv', path: '/Assets/Scripts/TeamModel.lua' },
      range: { startLineNumber: 1, startColumn: 2 },
      lspUri: 'file:///D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/TeamModel.lua',
      lspRoot: root,
      lspRange: { start: { line: 0, character: 1 }, end: { line: 0, character: 8 } },
    }
    expect(targetOpenPath(location)).toBe('Assets/Scripts/TeamModel.lua')
  })
  it('isInside 边界', () => {
    expect(isInside('D:/root', 'D:/root/a/b.ts')).toBe(true)
    expect(isInside('D:/root', 'D:/root2/a.ts')).toBe(false)
    expect(isInside('D:/root', 'D:/root')).toBe(true)
  })
})

describe('lsp/providers 解析', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-lsp-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('平台目录与 exe 后缀', () => {
    expect(platformServerDir('win32')).toBe('Windows')
    expect(platformServerDir('darwin')).toBe('macOS')
    expect(platformServerDir('linux')).toBe('Linux')
    expect(exeSuffix('win32')).toBe('.exe')
    expect(exeSuffix('linux')).toBe('')
  })

  it('listMatchingDirs 前缀匹配目录', () => {
    mkdirSync(join(dir, 'sumneko.lua-3.19.1'), { recursive: true })
    mkdirSync(join(dir, 'other.ext-1.0.0'), { recursive: true })
    expect(listMatchingDirs(dir, 'sumneko.lua-')).toEqual([join(dir, 'sumneko.lua-3.19.1')])
    expect(listMatchingDirs(join(dir, 'not-exists'), 'x')).toEqual([])
  })

  it('EmmyLua 扩展入口自动发现', () => {
    const ext = join(dir, 'dsh-vscode-mode', 'extensions', 'tangzx.emmylua-0.9.41')
    const exe = join(ext, 'server', 'emmylua_ls' + exeSuffix(process.platform))
    mkdirSync(join(ext, 'server'), { recursive: true })
    writeFileSync(exe, 'x')
    writeFileSync(join(ext, 'package.json'), JSON.stringify({ version: '0.9.41' }))
    const found = candidateEmmyLua(dir)
    expect(found).toEqual({ path: exe, version: '0.9.41' })
    clearProviderCache(dir)
  })

  it('lua 手动路径解析', () => {
    const exe = join(dir, 'lua-language-server.exe')
    writeFileSync(exe, 'x')
    const spec = resolveLuaProvider({ path: exe }, dir)
    expect(spec.ready).toBe(true)
    expect(spec.kind).toBe('manual')
    expect(spec.argv[0]).toBe(exe)
  })

  it('lua 未配置 → none + reason', () => {
    const spec = resolveLuaProvider({}, dir)
    expect(spec.ready).toBe(false)
    expect(spec.kind).toBe('none')
    expect(spec.reason).toMatch(/lua-language-server/)
  })

  it('csharp 手动路径解析', () => {
    const exe = join(dir, 'OmniSharp.exe')
    writeFileSync(exe, 'x')
    const spec = resolveCSharpProvider({ path: exe }, dir)
    expect(spec.ready).toBe(true)
    expect(spec.kind).toBe('manual')
  })

  it('csharp 未配置 → none + reason（缺 dotnet/扩展）', () => {
    const spec = resolveCSharpProvider({}, dir)
    expect(spec.ready).toBe(false)
    expect(spec.kind).toBe('none')
    expect(spec.reason).toMatch(/dotnet|扩展/)
  })

  it('findInPath 命中 PATH 中可执行', () => {
    // 用当前 node 可执行名验证 PATH 命中（node 一定在 PATH）
    const found = findInPath(process.platform === 'win32' ? 'node' : 'node')
    expect(found).not.toBeNull()
  })
})

describe('lsp/manager 引用计数', () => {
  it('acquire/release 平衡：refs 归零停止', async () => {
    const manager = createLspManager()
    const spec = { languageId: 'lua', kind: 'none', argv: [], ready: false } as const
    const server = manager.acquire('/root', 'lua', () => spec)
    expect(server.phase).toBe('idle')
    expect(manager.peek('/root', 'lua')).toBe(server)
    expect(manager.peek('/other', 'lua')).toBeUndefined()
    expect(manager.peek('/root', 'csharp')).toBeUndefined()
    manager.acquire('/root', 'lua', () => spec)
    manager.release('/root', 'lua')
    // 仍有 1 引用 → 未停止
    expect(manager.statusAll().length).toBe(1)
    manager.release('/root', 'lua')
    expect(manager.statusAll().length).toBe(0)
    await manager.disposeAll()
  })

  it('releaseRoot 清理整工作区', async () => {
    const manager = createLspManager()
    const spec = { languageId: 'lua', kind: 'none', argv: [], ready: false } as const
    manager.acquire('/root', 'lua', () => spec)
    manager.acquire('/root', 'csharp', () => ({ ...spec, languageId: 'csharp' }))
    manager.releaseRoot('/root')
    expect(manager.statusAll().length).toBe(0)
    await manager.disposeAll()
  })
})

describe('lsp/client 服务器请求分发', () => {
  /** 假传输：记录 write 帧，可手动推消息。 */
  function fakeTransport(): { t: LspClientTransport; written: Buffer[]; push: (m: unknown) => void } {
    const written: Buffer[] = []
    let onMsg: ((m: unknown) => void) | null = null
    const t: LspClientTransport = {
      write(chunk: Buffer) { written.push(chunk); return true },
      dispose() {},
      get alive() { return true },
      onMessage: null,
      onExit: null,
    }
    return { t, written, push: (m) => t.onMessage?.(m) }
  }

  it('带 id 的服务器请求（workspace/configuration）被响应且加帧', async () => {
    const { t, written, push } = fakeTransport()
    const client = createLspClient(t, {})
    expect(client.alive).toBe(true)
    push({ jsonrpc: '2.0', id: 5, method: 'workspace/configuration', params: { items: [{ section: 'Lua' }] } })
    expect(written.length).toBe(1)
    const parsed = parseFrame(written[0])!
    const resp = JSON.parse(parsed.body) as { id?: number; result?: unknown }
    expect(resp.id).toBe(5)
    expect(Array.isArray(resp.result)).toBe(true)
    expect(parsed.rest.length).toBe(0) // 已加 Content-Length 帧
  })

  it('我方请求的响应 resolve 对应 pending', async () => {
    const { t, push } = fakeTransport()
    const client = createLspClient(t, {})
    // 覆写 transport.write 拦截请求帧并模拟响应
    let respId: number | null = null
    const orig = t.write.bind(t)
    t.write = (chunk) => {
      const parsed = parseFrame(chunk)!
      const req = JSON.parse(parsed.body) as { id?: number }
      respId = req.id ?? null
      return orig(chunk)
    }
    const p = client.request<number>('textDocument/documentSymbol', {})
    expect(respId).not.toBeNull()
    push({ jsonrpc: '2.0', id: respId, result: [{ name: 'M' }] })
    await expect(p).resolves.toEqual([{ name: 'M' }])
  })
})

describe('lsp/settings 设置 section 安装（schemastery 兼容回归）', () => {
  it('构造 schemastery schema 不抛错（无 .optional 依赖）并注册 section', async () => {
    const registered: string[] = []
    const mockCtx = {
      inject(_deps: string[], cb: (sctx: unknown) => void) {
        const sctx = {
          settings: {
            register(ns: string, _schema: unknown, opts: { base?: unknown }) {
              registered.push(ns)
              return { get: () => opts.base, watch: (_cb: unknown) => {} }
            },
          },
          effect: (_cb: unknown) => () => {},
        }
        cb(sctx)
      },
    }
    const ok = await installLspSettingsSection(mockCtx as never, {})
    expect(ok).toBe(true)
    expect(registered).toContain(LSP_SETTINGS_NS)
  })
})

describe('outline/parse parseLua 注解', () => {
  it('---@class + ---@field 进大纲（字段收为类子节点）', () => {
    const out = parseOutline('lua', [
      '---@class FriendProfile',
      'local FriendProfile = {}',
      '---@field id number',
      '---@field name string',
      'function FriendProfile:GetName() end',
    ].join('\n'))
    const cls = out.find((s) => s.name === 'FriendProfile')
    expect(cls).toBeDefined()
    expect(cls!.kind).toBe(SK.Class)
    expect(cls!.children!.map((c) => c.name)).toEqual(['id', 'name'])
    expect(cls!.children!.every((c) => c.kind === SK.Field)).toBe(true)
  })

  it('---@alias / ---@enum 进大纲', () => {
    const out = parseOutline('lua', [
      '---@alias Mood "happy"|"sad"',
      '---@enum Color',
      'local Color = {}',
      'local M = {}',
      'function M.foo() end',
    ].join('\n'))
    expect(out.find((s) => s.name === 'Mood')!.kind).toBe(SK.TypeParameter)
    expect(out.find((s) => s.name === 'Color')!.kind).toBe(SK.Enum)
    expect(out.find((s) => s.name === 'M.foo')).toBeDefined()
  })

  it('普通注释（--）不影响函数解析', () => {
    const out = parseOutline('lua', [
      '-- 普通注释',
      'function M.go() end',
    ].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['M.go'])
  })

  it('---@field 无类时忽略', () => {
    const out = parseOutline('lua', ['---@field orphan number', 'function M.a() end'].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['M.a'])
  })
})

describe('lsp/derive 定义降级推导', () => {
  // 同 GameUtil.lua 场景（0-based 行号）：this 声明 2:6；IsNullByGameObject 声明 15:9-31；pTarget 声明 15:33
  const DOC = [
    '---@class GameUtil',
    'GameUtil = {}',
    'local this = GameUtil',
    '',
    'GameUtil.Vec = {',
    '    Up = CS.UnityEngine.Vector3(0, 0, 1),',
    '}',
    '',
    'function this.IsNull(pTarget)',
    '    if pTarget == false or pTarget == nil then',
    '        return true',
    '    end',
    '    return false',
    'end',
    '',
    'function this.IsNullByGameObject(pTarget)',
    '    if pTarget == nil or pTarget == false or LuaHelper.IsNullByGameObject(pTarget) then',
    '        return true',
    '    end',
    '    return false',
    'end',
  ].join('\n')

  const FILE = 'file:///D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/Lua/Utils/GameUtil.lua'
  const loc = (line: number, ch: number, endCh: number) =>
    ({ uri: FILE, range: { start: { line, character: ch }, end: { line, character: endCh } } })
  const locOther = (line: number, ch: number, endCh: number) =>
    ({ uri: 'file:///D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/Lua/Utils/LuaHelper.lua', range: { start: { line, character: ch }, end: { line, character: endCh } } })

  const THIS_REFS = [loc(2, 6, 10), loc(8, 9, 13), loc(15, 9, 13)]
  const PTARGET_REFS = [loc(15, 33, 40), loc(16, 7, 14), loc(16, 25, 32), loc(16, 74, 81)]
  const VEC_REFS = [loc(64, 62, 65), loc(70, 5, 8)]

  it('点击 this 使用处 → 推导回 local this 声明（2:6）', () => {
    const d = deriveDefinitionFromLocations({ line: 8, character: 9 }, THIS_REFS, DOC, 'D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/Lua/Utils/GameUtil.lua')
    expect(d?.range.start).toEqual({ line: 2, character: 6 })
  })

  it('点击 this 声明处 → 返回自身（不越跳）', () => {
    const d = deriveDefinitionFromLocations({ line: 2, character: 6 }, THIS_REFS, DOC, 'D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/Lua/Utils/GameUtil.lua')
    expect(d?.range.start).toEqual({ line: 2, character: 6 })
  })

  it('点击 pTarget 使用处 → 推导回参数声明（15:33）', () => {
    const d = deriveDefinitionFromLocations({ line: 16, character: 7 }, PTARGET_REFS, DOC, 'D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/Lua/Utils/GameUtil.lua')
    expect(d?.range.start).toEqual({ line: 15, character: 33 })
  })

  it('点击 pTarget 声明处 → 返回自身', () => {
    const d = deriveDefinitionFromLocations({ line: 15, character: 33 }, PTARGET_REFS, DOC, 'D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/Lua/Utils/GameUtil.lua')
    expect(d?.range.start).toEqual({ line: 15, character: 33 })
  })

  it('字段声明处（引用不含声明）→ 不猜测返回 null', () => {
    const d = deriveDefinitionFromLocations({ line: 4, character: 10 }, VEC_REFS, DOC, 'D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/Lua/Utils/GameUtil.lua')
    expect(d).toBeNull()
  })

  it('词文本不一致/异文件 → null', () => {
    const d1 = deriveDefinitionFromLocations({ line: 16, character: 7 }, [locOther(3, 7, 14)], DOC, 'D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/Lua/Utils/GameUtil.lua')
    expect(d1).toBeNull()
    const d2 = deriveDefinitionFromLocations({ line: 16, character: 7 }, [loc(16, 20, 27)], DOC, 'D:/Work/PopIsland/IslandSplash_BugFix2/Assets/Scripts/Lua/Utils/GameUtil.lua')
    expect(d2).toBeNull()
  })

  it('空列表 → null', () => {
    expect(deriveDefinitionFromLocations({ line: 0, character: 0 }, [], DOC, 'x/y.lua')).toBeNull()
  })
})

describe('shared/lsp 语义 token 解码', () => {
  it('delta 流 → 绝对范围（跨行/同行）', () => {
    const ranges = decodeSemanticTokens([0, 5, 4, 0, 0, 1, 3, 2, 1, 0])
    expect(ranges).toEqual([
      { start: { line: 0, character: 5 }, end: { line: 0, character: 9 }, type: 'namespace', modifiers: 0 },
      { start: { line: 1, character: 3 }, end: { line: 1, character: 5 }, type: 'type', modifiers: 0 },
    ])
  })

  it('同行相邻 token 位置连续累计', () => {
    const ranges = decodeSemanticTokens([0, 0, 3, 19, 0, 0, 3, 6, 7, 0])
    expect(ranges[0]).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, type: 'number', modifiers: 0 })
    expect(ranges[1]).toEqual({ start: { line: 0, character: 3 }, end: { line: 0, character: 9 }, type: 'parameter', modifiers: 0 })
  })

  it('可导航类型判定', () => {
    expect(isNavigableTokenType('parameter')).toBe(true)
    expect(isNavigableTokenType('property')).toBe(true)
    expect(isNavigableTokenType('method')).toBe(true)
    expect(isNavigableTokenType('comment')).toBe(false)
    expect(isNavigableTokenType('keyword')).toBe(false)
    expect(isNavigableTokenType('string')).toBe(false)
  })
})
