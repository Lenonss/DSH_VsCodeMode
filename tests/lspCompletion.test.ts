/**
 * lsp 智能补全 + 签名帮助测试。
 *
 * 背景：插件的 LSP 原先只接了 definition/references/documentSymbol/workspaceSymbol/hover/
 * semanticTokens，`textDocument/completion` 完全没接 —— 于是 `obj.` 不弹属性菜单（EmmyLua 的
 * `---@class`/`---@field` 注释索引能力根本没被消费）。本文件锁定新增的三条链路：
 * ① LSP→Monaco 补全类型名称映射（两侧枚举编号不同，直传会全表图标错位）；
 * ② textEdit 单 range / insert+replace 双 range 两种形态的坐标换算；
 * ③ signatureHelp 越界索引裁剪；
 * ④ capability 声明与解析（snippetSupport / resolveSupport / resolveProvider）；
 * ⑤ edrv.lsp.completion RPC handler 的降级口径与截断。
 * 作者 ddj 2026年09月22号
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  LSP_COMPLETION_KIND_NAMES,
  LSP_INSERT_TEXT_FORMAT_SNIPPET,
} from '../src/shared/lsp.js'
import { createLspClient, type LspClientTransport } from '../src/lsp/client.js'
import { createLspRpc } from '../src/lsp/rpc.js'
import { normCompletion, normCompItem, toSignatureHelp, toLspCompItem } from '../src/lsp/server.js'
import { toLspContext } from '../src/client/monaco/lsp/providers.js'
import { parseFrame } from '../src/lsp/jsonrpc.js'
import type { LspServerStatus } from '../src/shared/lsp.js'

// --region host 归一化：补全项
describe('补全项归一化', () => {
  it('裸数组形态被接受（CompletionItem[] 是最常见响应形态）', () => {
    const list = normCompletion([{ label: 'id' }, { label: 'name', kind: 5 }])
    expect(list).not.toBeNull()
    expect(list!.items.map((i) => i.label)).toEqual(['id', 'name'])
    expect(list!.items[1]!.kind).toBe(5)
    expect(list!.incomplete).toBe(false)
  })

  it('CompletionList 形态被接受并透传 isIncomplete', () => {
    const list = normCompletion({ isIncomplete: true, items: [{ label: 'x' }] })
    expect(list!.incomplete).toBe(true)
    expect(list!.items.length).toBe(1)
  })

  it('无 label 的条目被丢弃；空/非法载荷返回 null', () => {
    expect(normCompletion([{ kind: 1 }, { label: 'ok' }])!.items.map((i) => i.label)).toEqual(['ok'])
    expect(normCompletion(null)).toBeNull()
    expect(normCompletion({})).toBeNull()
    expect(normCompletion(42)).toBeNull()
    expect(normCompItem('x')).toBeNull()
  })

  it('documentation 兼容 MarkupContent / MarkedString[] / 字符串', () => {
    expect(normCompItem({ label: 'a', documentation: 'plain' })!.documentation).toBe('plain')
    expect(normCompItem({ label: 'a', documentation: { kind: 'markdown', value: '# h' } })!.documentation).toBe('# h')
    expect(normCompItem({ label: 'a', documentation: [{ language: 'lua', value: 'code' }] })!.documentation).toBe('code')
  })

  it('deprecated 两处来源都被识别（顶层标记与 tags 含 1）', () => {
    expect(normCompItem({ label: 'a', deprecated: true })!.deprecated).toBe(true)
    expect(normCompItem({ label: 'a', tags: [1] })!.deprecated).toBe(true)
    expect(normCompItem({ label: 'a', tags: [2] })!.deprecated).toBeUndefined()
  })

  it('data 原样透传（resolve 阶段服务器靠它回认条目）', () => {
    const data = { uuid: 'abc', version: 3 }
    expect(normCompItem({ label: 'a', data })!.data).toEqual(data)
    expect(normCompItem({ label: 'a' })!.data).toBeUndefined()
  })

  it('additionalTextEdits 归一化；缺 range/newText 的条目被丢弃', () => {
    const item = normCompItem({
      label: 'a',
      additionalTextEdits: [
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'import' },
        { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } }, // 缺 newText
        { newText: 'x' }, // 缺 range
      ],
    })!
    expect(item.additionalTextEdits).toEqual([
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'import' },
    ])
  })

  it('textEdit 单 range 与 insert/replace 双 range 两种形态都归一化', () => {
    const single = normCompItem({
      label: 'a',
      textEdit: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'abc' },
    })!
    expect(single.textEdit!.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 3 } })
    expect(single.textEdit!.insert).toBeUndefined()

    const dual = normCompItem({
      label: 'b',
      textEdit: {
        insert: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
        replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        newText: 'print',
      },
    })!
    expect(dual.textEdit!.insert).toBeDefined()
    expect(dual.textEdit!.replace!.end.character).toBe(4)
  })

  it('textEdit 缺范围/缺文本时整体丢弃（不产出畸形范围）', () => {
    expect(normCompItem({ label: 'a', textEdit: { newText: 'x' } })!.textEdit).toBeUndefined()
    expect(normCompItem({ label: 'a', textEdit: { range: { start: { line: 0, character: 0 } }, newText: 'x' } })!.textEdit).toBeUndefined()
  })

  it('resolve 回传只带协议字段并保留 data', () => {
    const payload = toLspCompItem({
      label: 'a', kind: 2, detail: 'd', documentation: 'doc', insertText: 'it',
      insertTextFormat: 2, data: { id: 1 }, sortText: 's', filterText: 'f',
    })
    expect(payload).toMatchObject({ label: 'a', kind: 2, detail: 'd', data: { id: 1 }, insertTextFormat: 2 })
    // 我方衍生字段不得外泄
    expect('__edrvRaw' in payload).toBe(false)
  })
})
// --endregion

// --region host 归一化：签名帮助
describe('签名帮助归一化', () => {
  it('activeSignature/activeParameter 越界被裁剪（越界会让 Monaco 整个不渲染）', () => {
    const help = toSignatureHelp({
      signatures: [
        { label: 'f(a, b)', parameters: [{ label: 'a' }, { label: 'b' }] },
        { label: 'g(x)', parameters: [{ label: 'x' }] },
      ],
      activeSignature: 9,
      activeParameter: 9,
    })!
    expect(help.activeSignature).toBe(1)
    // 裁剪到该签名的末个参数
    expect(help.activeParameter).toBe(0)
  })

  it('负数与缺省索引回落到 0', () => {
    const help = toSignatureHelp({ signatures: [{ label: 'f(a)', parameters: [{ label: 'a' }] }] })!
    expect(help.activeSignature).toBe(0)
    expect(help.activeParameter).toBe(0)
  })

  it('参数 label 的 [start, end] 元组形态原样保留（字符串化会渲染成乱码）', () => {
    const help = toSignatureHelp({
      signatures: [{ label: 'f(a, b)', parameters: [{ label: [2, 3] }, { label: 'b' }] }],
      activeSignature: 0,
      activeParameter: 0,
    })!
    expect(help.signatures[0]!.parameters[0]!.label).toEqual([2, 3])
    expect(help.signatures[0]!.parameters[1]!.label).toBe('b')
  })

  it('无签名/非法载荷返回 null；缺 label 的签名被丢弃', () => {
    expect(toSignatureHelp(null)).toBeNull()
    expect(toSignatureHelp({})).toBeNull()
    expect(toSignatureHelp({ signatures: [] })).toBeNull()
    expect(toSignatureHelp({ signatures: [{ parameters: [] }] })).toBeNull()
  })
})
// --endregion

// --region LSP → Monaco 补全类型名称映射
describe('LSP 补全类型名称映射', () => {
  it('协议 1..25 全覆盖（索引即协议编号，0 占位）', () => {
    expect(LSP_COMPLETION_KIND_NAMES.length).toBe(26)
    expect(LSP_COMPLETION_KIND_NAMES[0]).toBe('')
    for (let kind = 1; kind <= 25; kind++) {
      expect(LSP_COMPLETION_KIND_NAMES[kind], 'kind ' + kind).toBeTruthy()
    }
  })

  it('关键项按协议编号落位（协议与 Monaco 编号不同，故必须走名称）', () => {
    // LSP 2=Method / 5=Field / 10=Property / 15=Snippet / 21=Constant
    expect(LSP_COMPLETION_KIND_NAMES[2]).toBe('Method')
    expect(LSP_COMPLETION_KIND_NAMES[5]).toBe('Field')
    expect(LSP_COMPLETION_KIND_NAMES[10]).toBe('Property')
    expect(LSP_COMPLETION_KIND_NAMES[15]).toBe('Snippet')
    expect(LSP_COMPLETION_KIND_NAMES[21]).toBe('Constant')
  })

  it('名称均为 Monaco CompletionItemKind 的合法枚举名（防拼写漂移）', () => {
    // Monaco（vendored 0.42）CompletionItemKind 枚举名全集
    const MONACO_KINDS = new Set([
      'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Struct',
      'Interface', 'Module', 'Property', 'Event', 'Operator', 'Unit', 'Value',
      'Constant', 'Enum', 'EnumMember', 'Keyword', 'Text', 'Color', 'File',
      'Reference', 'Customcolor', 'Folder', 'TypeParameter', 'User', 'Issue', 'Snippet',
    ])
    for (const name of LSP_COMPLETION_KIND_NAMES) {
      if (!name) continue
      expect(MONACO_KINDS.has(name), name + ' 不是 Monaco CompletionItemKind 枚举名').toBe(true)
    }
  })

  it('片段插入格式常量为协议值 2', () => {
    expect(LSP_INSERT_TEXT_FORMAT_SNIPPET).toBe(2)
  })
})
// --endregion

// --region initialize 能力协商
describe('initialize 补全/签名能力协商', () => {
  /** 假传输：捕获我方发出的 initialize 载荷，并可回灌服务器响应。 */
  function captureTransport() {
    const written: Buffer[] = []
    let onMsg: ((m: unknown) => void) | null = null
    const transport: LspClientTransport = {
      write(chunk: Buffer) { written.push(chunk); return true },
      dispose() {},
      get alive() { return true },
      onMessage: null,
      onExit: null,
    }
    return { transport, written, push: (m: unknown) => onMsg?.(m), wire: () => { onMsg = transport.onMessage } }
  }

  /** 取我方发出的 initialize 请求载荷。 */
  function initParams(written: Buffer[]): { capabilities: { textDocument: Record<string, any> } } {
    const frame = written.map((buf) => parseFrame(buf)).find((parsed) => {
      if (!parsed) return false
      const msg = JSON.parse(parsed.body) as { method?: string }
      return msg.method === 'initialize'
    })
    const msg = JSON.parse(frame!.body) as { params: { capabilities: { textDocument: Record<string, any> } } }
    return msg.params
  }

  it('声明 completion（snippetSupport + resolveSupport）与 signatureHelp', async () => {
    const { transport, written, push, wire } = captureTransport()
    const client = createLspClient(transport, {})
    wire()
    const pending = client.initialize('file:///ws', ['file:///ws'])
    const textDocument = initParams(written).capabilities.textDocument
    expect(textDocument.completion.completionItem.snippetSupport).toBe(true)
    expect(textDocument.completion.contextSupport).toBe(true)
    expect(textDocument.completion.completionItem.resolveSupport.properties).toContain('documentation')
    expect(textDocument.signatureHelp.signatureInformation.documentationFormat).toEqual(['markdown', 'plaintext'])
    // 补交响应，避免悬挂 promise
    push({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } })
    await pending
  })

  it('解析回包：completionProvider + resolveProvider → completion/completionResolve', async () => {
    const { transport, push, wire } = captureTransport()
    const client = createLspClient(transport, {})
    wire()
    const pending = client.initialize('file:///ws', ['file:///ws'])
    push({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capabilities: {
          completionProvider: { resolveProvider: true, triggerCharacters: ['.'] },
          signatureHelpProvider: { triggerCharacters: ['('] },
          hoverProvider: true,
        },
      },
    })
    const caps = await pending
    expect(caps.completion).toBe(true)
    expect(caps.completionResolve).toBe(true)
    expect(caps.signatureHelp).toBe(true)
  })

  it('服务器未声明 resolveProvider → completionResolve 为 false', async () => {
    const { transport, push, wire } = captureTransport()
    const client = createLspClient(transport, {})
    wire()
    const pending = client.initialize('file:///ws', [])
    push({ jsonrpc: '2.0', id: 1, result: { capabilities: { completionProvider: { triggerCharacters: ['.'] } } } })
    const caps = await pending
    expect(caps.completion).toBe(true)
    expect(caps.completionResolve).toBe(false)
    expect(caps.signatureHelp).toBe(false)
  })
})
// --endregion

// --region 客户端 provider 源码契约（@ts-nocheck 文件，靠源码断言兜底）
describe('client providers 源码契约', () => {
  const SRC = readFileSync(join(process.cwd(), 'src', 'client', 'monaco', 'lsp', 'providers.ts'), 'utf8')

  it('注册了补全与签名帮助 provider', () => {
    expect(SRC.includes('registerCompletionItemProvider')).toBe(true)
    expect(SRC.includes('registerSignatureHelpProvider')).toBe(true)
  })

  it('resolve 阶段经 __edrvPath 取文档路径（Monaco 调 resolve 时不给 model）', () => {
    // 实测 vendored 0.42：provider.resolveCompletionItem(this.completion, token) —— 无 model 参数
    expect(SRC.includes('__edrvPath')).toBe(true)
    expect(SRC.includes('__edrvRaw')).toBe(true)
  })

  it('复用既有跨重载守卫（不引入新的 window 标记，避免重复注册）', () => {
    expect(SRC.includes("LSP_PROVIDERS_GLOBAL")).toBe(true)
    // 不得新增 window 全局标记（新增会让重载清理链失配）
    expect(SRC.includes('__edrvLspCompletionDisposer__')).toBe(false)
  })

  it('triggerKind 做 Monaco→LSP 编号换算（两侧恒差 1，直传会谎报触发原因）', () => {
    // Monaco: 0=Invoke, 1=TriggerCharacter, 2=TriggerForIncomplete
    // LSP  : 1=Invoked, 2=TriggerCharacter, 3=TriggerForIncomplete
    expect(toLspContext({ triggerKind: 0 })).toEqual({ triggerKind: 1 })
    expect(toLspContext({ triggerKind: 1, triggerCharacter: '.' })).toEqual({ triggerKind: 2, triggerCharacter: '.' })
    expect(toLspContext({ triggerKind: 2 })).toEqual({ triggerKind: 3 })
  })

  it('triggerKind 夹在 LSP 合法区间 [1,3]；无触发信息时不占载荷', () => {
    expect(toLspContext({ triggerKind: 99 })!.triggerKind).toBe(3)
    expect(toLspContext({ triggerKind: -5 })!.triggerKind).toBe(1)
    expect(toLspContext(undefined)).toBeUndefined()
    expect(toLspContext({})).toBeUndefined()
    // 只有触发字符也要能构造出合法 kind
    expect(toLspContext({ triggerCharacter: ':' })).toEqual({ triggerKind: 1, triggerCharacter: ':' })
  })
})
// --endregion

// --region edrv.lsp.completion RPC handler
describe('edrv.lsp.completion handler', () => {
  const CWD = 'D:/ws'
  const ROOT = 'proc:.'
  const LUA_DOC = 'a.lua'

  /** 假服务器：记录 inquiry 调用，返回可控补全列表。 */
  function fakeServer(root: string, languageId: string, result: unknown = { items: [], incomplete: false }) {
    const calls: Array<{ path: string; line: number; character: number }> = []
    return {
      languageId,
      root,
      calls,
      capabilities: { completion: true, completionResolve: false, signatureHelp: false },
      get phase() { return 'ready' },
      onStateChange: null,
      status(): LspServerStatus {
        return { languageId, source: 'extension', phase: 'ready', root }
      },
      async start() { return true },
      sync() {},
      close() {},
      async completion(path: string, line: number, character: number) {
        calls.push({ path, line, character })
        return result as never
      },
      async resolveCompletion(_path: string, item: unknown) { return item as never },
      async signatureHelp() { return null },
      dispose: async () => {},
    }
  }

  function fakeManager(server: ReturnType<typeof fakeServer>) {
    return {
      statusAll: () => [server.status()],
      peek: (root: string, lang: string) => (root === server.root && lang === server.languageId ? server : undefined),
      acquire: () => server,
      release() {},
      releaseRoot() {},
      reset() {},
      resetLanguage() {},
      disposeAll: async () => {},
      onStatusChange: null,
    }
  }

  function fakeCtx() {
    const sessions = {
      get: (id: string) => (id === 's1' ? { id: 's1', header: { cwd: CWD } } : undefined),
      list: () => [{ id: 's1', header: { cwd: CWD } }],
    }
    return {
      get: (name: string) => {
        if (name === 'sessions') return sessions
        if (name === 'fs') return { resolve: async (p: string) => ({ targetKey: p }), processPath: () => ROOT }
        if (name === 'sandboxPolicy') return { resolve: () => ({ workspaceRoot: '.' }) }
        return undefined
      },
    }
  }

  let home = ''
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-lsp-completion-'))
    process.env.DSH_HOME = home
    process.env.DSH_LSP_EXT_DIRS = join(home, 'dsh-vscode-mode', 'extensions')
  })
  afterAll(() => {
    delete process.env.DSH_HOME
    delete process.env.DSH_LSP_EXT_DIRS
    rmSync(home, { recursive: true, force: true })
  })

  it('未知语言 → ok:true + 空载荷（不报错，保持与 definition 同口径）', async () => {
    const server = fakeServer(ROOT, 'lua')
    const rpc = createLspRpc({ ctx: fakeCtx() as never, pluginConfig: {}, manager: fakeManager(server) as never })
    const res = await rpc.handlers['edrv.lsp.completion']!({ sessionId: 's1', path: 'a.txt', position: { line: 0, character: 0 } })
    expect(res.ok).toBe(true)
    expect((res as { completions?: unknown }).completions).toBeUndefined()
  })

  it('该语言无运行实例 → ok:true + 空载荷（懒启动语义，不代起服务器）', async () => {
    const server = fakeServer(ROOT, 'csharp') // 与请求的 lua 不匹配
    const rpc = createLspRpc({ ctx: fakeCtx() as never, pluginConfig: {}, manager: fakeManager(server) as never })
    const res = await rpc.handlers['edrv.lsp.completion']!({ sessionId: 's1', path: LUA_DOC, position: { line: 11, character: 6 } })
    expect(res.ok).toBe(true)
    expect((res as { completions?: unknown }).completions).toBeUndefined()
  })

  it('命中实例 → 以工作区相对路径与 0-based 位置调用', async () => {
    const server = fakeServer(ROOT, 'lua', { items: [{ label: 'id' }, { label: 'name' }], incomplete: false })
    const rpc = createLspRpc({ ctx: fakeCtx() as never, pluginConfig: {}, manager: fakeManager(server) as never })
    const res = await rpc.handlers['edrv.lsp.completion']!({ sessionId: 's1', path: LUA_DOC, position: { line: 11, character: 6 } })
    expect(res.ok).toBe(true)
    const completions = (res as { completions: { items: Array<{ label: string }> } }).completions
    expect(completions.items.map((i) => i.label)).toEqual(['id', 'name'])
    expect(server.calls).toEqual([{ path: LUA_DOC, line: 11, character: 6 }])
  })

  it('超过 500 条截断并标记 truncated（与 references 同上限）', async () => {
    const items = Array.from({ length: 620 }, (_, i) => ({ label: 'm' + i }))
    const server = fakeServer(ROOT, 'lua', { items, incomplete: false })
    const rpc = createLspRpc({ ctx: fakeCtx() as never, pluginConfig: {}, manager: fakeManager(server) as never })
    const res = await rpc.handlers['edrv.lsp.completion']!({ sessionId: 's1', path: LUA_DOC, position: { line: 0, character: 0 } })
    const completions = (res as { completions: { items: unknown[]; truncated?: boolean } }).completions
    expect(completions.items.length).toBe(500)
    expect(completions.truncated).toBe(true)
  })

  it('会话不存在 → ok:false + 可见错误（不静默吞掉）', async () => {
    const server = fakeServer(ROOT, 'lua')
    const rpc = createLspRpc({ ctx: fakeCtx() as never, pluginConfig: {}, manager: fakeManager(server) as never })
    const res = await rpc.handlers['edrv.lsp.completion']!({ sessionId: 'nope', path: LUA_DOC, position: { line: 0, character: 0 } })
    expect(res.ok).toBe(false)
    expect(String((res as { error: string }).error)).toContain('会话')
  })
})
// --endregion
