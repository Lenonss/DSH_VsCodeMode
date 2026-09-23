/**
 * dsh-vscode-mode tests — 端到端（需 DSH_E2E=1 才执行；默认整组跳过）。
 * 验证：真实 LuaLS 自动发现（extmgr 安装的 sumneko.lua 扩展）→ 插件 transport+client+server
 * 启动真实 lua-language-server → initialize/didOpen → documentSymbol/hover/definition/references。
 * 运行：$env:DSH_E2E='1'; node node_modules/vitest/vitest.mjs run tests/e2e-lsp.test.ts
 * 作者 ddj 2026-08-27
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLuaProvider } from '../src/lsp/providers.js'
import { installFromMarket, listInstalled } from '../src/lsp/extmgr.js'
import { createLspServer, type LspServer } from '../src/lsp/server.js'

const ENABLED = process.env.DSH_E2E === '1'
const skip = ENABLED ? describe : describe.skip

const LUA_SRC = [
  '---@class FriendProfile',
  'local FriendProfile = {}',
  '---@field id number',
  '---@field name string',
  '',
  'local M = {}',
  '',
  '--- 求和',
  'function M.add(a, b)',
  '    return a + b',
  'end',
  '',
  'function M.getProfile()',
  '    return FriendProfile',
  'end',
  '',
  'function M.go()',
  '    local x = M.add(1, 2)',
  '    return x',
  'end',
  '',
  'return M',
  '',
].join('\n')

/**
 * 补全专用文档（独立于 LUA_SRC，避免扰动既有按行号定位的断言）。
 *
 * 构造要点：`---@class` + `---@field` 注解 + 带 `---@type` 实例化，
 * 使得在 `p.` 处请求补全时，EmmyLua 必须从**注释索引**里解析出 id/name 两个字段。
 * 第 9 行（0-based）= `    p.`，光标在第 6 列（`.` 之后）。
 */
const COMPLETION_SRC = [
  '---@class FriendProfile',   // 0
  '---@field id number',       // 1
  '---@field name string',     // 2
  '',                          // 3
  'local M = {}',              // 4
  '',                          // 5
  '---@return FriendProfile',  // 6
  'function M.get() end',      // 7
  '',                          // 8
  'function M.go()',           // 9
  '    ---@type FriendProfile',// 10
  '    local p = M.get()',     // 11
  '    p.',                    // 12
  'end',                       // 13
  '',                          // 14
  'return M',                  // 15
].join('\n')

/** COMPLETION_SRC 中 `    p.` 的 0-based 光标位置。 */
const COMPLETION_POS = { line: 12, character: 6 }


/** 等待条件成立（LuaLS 索引/就绪）。 */
async function waitFor(check: () => boolean | Promise<boolean>, ms = 15_000, step = 200): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, step))
  }
  throw new Error('等待超时（' + ms + 'ms）')
}

skip('lsp 端到端（真实 LuaLS）', () => {
  let dir: string
  let root: string
  let luaPath: string
  let spec: ReturnType<typeof resolveLuaProvider>
  let server: LspServer
  const logs: string[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-lua-'))
    root = join(dir, 'workspace')
    mkdirSync(root, { recursive: true })
    luaPath = 'main.lua'
    writeFileSync(join(root, luaPath), LUA_SRC)
    // 1) 自动发现：无则从 Open VSX 安装 sumneko.lua（extmgr 链路）
    spec = resolveLuaProvider({})
    if (!spec.ready) {
      await installFromMarket('sumneko', 'lua')
      spec = resolveLuaProvider({})
    }
    if (!spec.ready) throw new Error('LuaLS 仍不可用：' + (spec.reason ?? ''))
    // 2) 用插件 server 启动真实 lua-language-server
    server = createLspServer(spec, root, 'lua', (line) => logs.push(line))
    const ok = await server.start()
    if (!ok) throw new Error('LuaLS 启动失败：\n' + logs.slice(-20).join('\n'))
  }, 120_000)

  afterAll(async () => {
    if (server) await server.dispose().catch(() => {})
    // 等 LuaLS 子进程释放目录句柄后再清理
    await new Promise((r) => setTimeout(r, 2000))
    rmSync(dir, { recursive: true, force: true })
  }, 15_000)

  it('自动发现命中已装扩展（kind=discover + 二进制存在）', () => {
    expect(spec.ready).toBe(true)
    expect(spec.kind).toBe('discover')
    expect(existsSync(spec.argv[0])).toBe(true)
    const installed = listInstalled().filter((e) => e.id === 'sumneko.lua')
    expect(installed.length).toBe(1)
  })

  it('启动后进入 ready（initialize 握手成功）', async () => {
    await waitFor(() => server.phase === 'ready')
    expect(server.phase).toBe('ready')
    expect(server.capabilities.documentSymbol).toBe(true)
    expect(server.capabilities.definition).toBe(true)
  })

  it('documentSymbol 返回真实大纲（类/函数）', async () => {
    server.sync(luaPath, LUA_SRC, 1)
    await waitFor(() => server.phase === 'ready')
    let symbols: Awaited<ReturnType<typeof server.documentSymbol>> = []
    await waitFor(async () => {
      symbols = await server.documentSymbol(luaPath)
      return symbols.some((s) => s.name === 'M.add')
    }, 20_000)
    const names = symbols.map((s) => s.name)
    expect(names).toContain('M.add')
    expect(names).toContain('M.go')
    expect(names).toContain('M.getProfile')
  })

  it('definition 从调用点跳转到定义（文件内定位）', async () => {
    // M.go 内第 17 行调用 M.add(1,2) → 定位到 main.lua 内定义（LuaLS 可能指向外层表 M 声明或函数体）
    const line = LUA_SRC.split('\n').findIndex((l) => l.includes('M.add(1, 2)')) + 1
    const col = LUA_SRC.split('\n')[line - 1].indexOf('M.add') + 1
    const locations = await server.definition(luaPath, line - 1, col - 1)
    expect(locations.length).toBeGreaterThan(0)
    const target = locations[0]
    expect(target.uri).toContain('main.lua')
    expect(target.range.start.line + 1).toBeGreaterThanOrEqual(1)
    expect(target.range.start.line + 1).toBeLessThanOrEqual(LUA_SRC.split('\n').length)
  })

  it('hover 返回类型标注', async () => {
    const lines = LUA_SRC.split('\n')
    const line = lines.findIndex((l) => l.includes('function M.add')) + 1
    const col = lines[line - 1].indexOf('M.add') + 5
    // LuaLS 索引期 hover 会返回 "Workspace loading…"，轮询到真实类型标注
    let contents: string[] = []
    await waitFor(async () => {
      const hover = await server.hover(luaPath, line - 1, col - 1)
      contents = hover?.contents ?? []
      return contents.length > 0 && !/Workspace loading/.test(contents.join('\n'))
    }, 25_000)
    expect(contents.join('\n')).toMatch(/add/)
  }, 30_000)

  it('references 在 M.go 中找到调用', async () => {
    const lines = LUA_SRC.split('\n')
    const line = lines.findIndex((l) => l.includes('function M.add')) + 1
    const col = lines[line - 1].indexOf('M.add') + 5
    let locations: Awaited<ReturnType<typeof server.references>> = []
    await waitFor(async () => {
      locations = await server.references(luaPath, line - 1, col - 1, true)
      return locations.length >= 2
    }, 25_000)
    // 定义 + M.go 内调用
    expect(locations.length).toBeGreaterThanOrEqual(2)
  }, 30_000)

  it('capabilities 声明了 completion / signatureHelp（能力协商成功）', () => {
    expect(server.capabilities.completion).toBe(true)
    expect(server.capabilities.signatureHelp).toBe(true)
  })

  it('completion 在 `p.` 处返回注解索引出的成员（含 ---@field 字段）', async () => {
    // 补全用独立文档：同一 server 可开多文档，按 path 区分
    const completionPath = 'completion.lua'
    server.sync(completionPath, COMPLETION_SRC, 1)
    let labels: string[] = []
    // EmmyLua 首次索引该文档后才有成员，故轮询
    await waitFor(async () => {
      const list = await server.completion(
        completionPath,
        COMPLETION_POS.line,
        COMPLETION_POS.character,
        { triggerKind: 2, triggerCharacter: '.' },
      )
      labels = (list?.items ?? []).map((item) => item.label)
      return labels.includes('id') && labels.includes('name')
    }, 30_000)
    // 两个 ---@field 字段必须出现（注释辅助索引的核心诉求）
    expect(labels).toContain('id')
    expect(labels).toContain('name')
  }, 40_000)

  it('completion 条目带 LSP kind（供 client 映射图标）', async () => {
    const list = await server.completion('completion.lua', COMPLETION_POS.line, COMPLETION_POS.character, { triggerKind: 2 })
    const field = (list?.items ?? []).find((item) => item.label === 'id')
    expect(field).toBeDefined()
    // 实测 EmmyLua 0.25.1：`---@field id number` 注解成员归类为 Variable(6) 而非 Field(5)
    // （EmmyLua 把表字段建模为变量）。断言取实测值 —— client 侧经 LSP_COMPLETION_KIND_NAMES
    // 名称表映射，任一协议编号都能落到正确的 Monaco 枚举，故此处只锁「有合法 kind」。
    expect(field!.kind).toBe(6)
    expect(field!.kind).toBeGreaterThan(0)
  }, 30_000)

  it('signatureHelp 在函数实参处返回签名与参数', async () => {
    const doc = ['local M = {}', '', '--- 求和', 'function M.add(a, b)', '    return a + b', 'end', '', 'M.add(', ''].join('\n')
    const docPath = 'signature.lua'
    server.sync(docPath, doc, 1)
    // `M.add(` 之后（第 7 行，0-based；列在 '(' 之后）
    const pos = { line: 7, character: 6 }
    let signatures: number = 0
    await waitFor(async () => {
      const help = await server.signatureHelp(docPath, pos.line, pos.character)
      signatures = help?.signatures.length ?? 0
      return signatures > 0
    }, 30_000)
    expect(signatures).toBeGreaterThan(0)
  }, 40_000)
})
