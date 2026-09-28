/**
 * Lua 保留字补全：候选范围、成员抑制与 LSP 合并行为。
 * 作者 ddj 2026年09月24号
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LUA_RESERVED_WORDS, LUA_RESERVED_WORD_SET } from '../src/client/luaReservedWords.js'
import { isLuaTypeSlot, luaKeywordsAt, luaTypesAt, mergeKeywords } from '../src/client/monaco/lsp/keywords.js'
import { fetchCompletions } from '../src/client/monaco/lsp/lspClient.js'
import { registerLspProviders, disposeLspProviders } from '../src/client/monaco/lsp/providers.js'

vi.mock('../src/client/monaco/lsp/lspClient.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/client/monaco/lsp/lspClient.js')>(),
  fetchCompletions: vi.fn(),
}))

const monaco = { languages: { CompletionItemKind: { Keyword: 17 } } }

describe('Lua 关键字补全', () => {
  it('保留字完整且与调试悬停使用同一集合', () => {
    expect(LUA_RESERVED_WORDS).toHaveLength(22)
    expect(new Set(LUA_RESERVED_WORDS).size).toBe(22)
    expect(LUA_RESERVED_WORD_SET.has('local')).toBe(true)
    expect(LUA_RESERVED_WORD_SET.has('function')).toBe(true)
    expect(LUA_RESERVED_WORD_SET.has('string')).toBe(false)
  })

  it('输入 loc 提供 local 候选，替换当前单词', () => {
    const range = { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 4 }
    const items = luaKeywordsAt(monaco, { getLineContent: () => 'loc' }, { lineNumber: 1 }, range)
    expect(items.find((item) => item.label === 'local')).toEqual({
      label: 'local', kind: 17, insertText: 'local', range, detail: 'Lua 关键字',
    })
  })

  it('行中普通语句仍提供关键字', () => {
    const range = { startLineNumber: 3, endLineNumber: 3, startColumn: 3, endColumn: 6 }
    const items = luaKeywordsAt(monaco, { getLineContent: () => '  loc' }, { lineNumber: 3 }, range)
    expect(items.some((item) => item.label === 'local')).toBe(true)
  })

  it('成员访问位置不提供关键字', () => {
    for (const line of ['obj.loc', 'obj:loc', 'obj.', 'obj:']) {
      const range = {
        startLineNumber: 1, endLineNumber: 1,
        startColumn: 5, endColumn: line.length + 1,
      }
      expect(luaKeywordsAt(monaco, { getLineContent: () => line }, { lineNumber: 1 }, range)).toEqual([])
    }
  })

  it('注解类型槽提示基础类型，不混入语句关键字', () => {
    const cases = [
      { line: '---@type nu', word: 'nu', label: 'number' },
      { line: '---@param p str', word: 'str', label: 'string' },
      { line: '---@return tab', word: 'tab', label: 'table' },
      { line: '---@field private name boo', word: 'boo', label: 'boolean' },
      { line: '---@type Foo | str', word: 'str', label: 'string' },
    ]
    for (const { line, word, label } of cases) {
      const startColumn = line.lastIndexOf(word) + 1
      const range = { startLineNumber: 1, endLineNumber: 1, startColumn, endColumn: startColumn + word.length }
      const model = { getLineContent: () => line }
      expect(isLuaTypeSlot(model, { lineNumber: 1 }, range), line).toBe(true)
      expect(luaTypesAt(monaco, model, { lineNumber: 1 }, range).find((item) => item.label === label))
        .toMatchObject({ insertText: label, range, detail: 'Lua 基础类型' })
      expect(luaKeywordsAt(monaco, model, { lineNumber: 1 }, range)).toEqual([])
    }
  })

  it('普通注释、描述文字和限定类型成员不注入基础类型', () => {
    for (const line of ['-- note str', 'local str', 'obj.str', '---@param p number desc', '---@type Foo.Bar']) {
      const word = line.split(/[ .]/).pop()!
      const range = { startLineNumber: 1, endLineNumber: 1, startColumn: line.lastIndexOf(word) + 1, endColumn: line.length + 1 }
      const model = { getLineContent: () => line }
      expect(isLuaTypeSlot(model, { lineNumber: 1 }, range), line).toBe(false)
      expect(luaTypesAt(monaco, model, { lineNumber: 1 }, range)).toEqual([])
    }
  })

  it('服务器已有同名项则优先保留原始项及顺序', () => {
    const local = { label: 'local', detail: 'LSP', textEdit: { newText: 'local ' } }
    const server = [local, { label: 'log' }]
    const keywords = [{ label: 'local', detail: 'Lua 关键字' }, { label: 'return', detail: 'Lua 关键字' }]
    const merged = mergeKeywords(server, keywords)
    expect(merged.map((item) => item.label)).toEqual(['local', 'log', 'return'])
    expect(merged[0]).toBe(local)
    expect(mergeKeywords(server, [])).toBe(server)
    expect(mergeKeywords([], keywords)).toEqual(keywords)
  })
})

describe('Lua provider 集成', () => {
  type Provider = { provideCompletionItems: (...args: any[]) => Promise<{ suggestions: Array<{ label: string; detail?: string }> }> }

  /**
   * 捕获按语言注册的真实补全 provider，避免复制注册桩。
   * @author ddj 2026年09月24号
   * @returns Lua / C# provider
   */
  function captureProvs(): Record<string, Provider> {
    const providers: Record<string, Provider> = {}
    const disposer = () => ({ dispose() {} })
    const monaco = {
      editor: { onDidCreateModel: disposer, getModels: () => [], registerEditorOpener: disposer },
      languages: {
        CompletionItemKind: { Keyword: 17, Text: 18 },
        registerCompletionItemProvider: (lang: string, provider: Provider) => {
          providers[lang] = provider
          return disposer()
        },
        registerDefinitionProvider: disposer,
        registerReferenceProvider: disposer,
        registerDocumentSymbolProvider: disposer,
        registerHoverProvider: disposer,
        registerDocumentSemanticTokensProvider: disposer,
        registerSignatureHelpProvider: disposer,
      },
    }
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
    registerLspProviders(monaco)
    return providers
  }

  afterEach(() => {
    disposeLspProviders()
    vi.unstubAllGlobals()
    vi.mocked(fetchCompletions).mockReset()
  })

  it('LSP 缺候选仍补 local，服务器同名项优先，C# 保持原样', async () => {
    const providers = captureProvs()
    const model = {
      uri: { scheme: 'edrv', path: '/a.lua' },
      getValue: () => 'loc',
      getWordUntilPosition: () => ({ word: 'loc', startColumn: 1, endColumn: 4 }),
      getLineContent: () => 'loc',
    }
    const position = { lineNumber: 1, column: 4 }
    const context = { triggerKind: 0 }
    const token = { isCancellationRequested: false }
    vi.mocked(fetchCompletions).mockResolvedValue(null)
    const fallback = await providers.lua!.provideCompletionItems(model, position, context, token)
    expect(fallback.suggestions.find((item) => item.label === 'local')).toBeDefined()
    expect(await providers.csharp!.provideCompletionItems(model, position, context, token)).toEqual({ suggestions: [] })

    vi.mocked(fetchCompletions).mockResolvedValue({
      items: [{ label: 'local', kind: 14, detail: 'LSP keyword' }], incomplete: false,
    })
    const merged = await providers.lua!.provideCompletionItems(model, position, context, token)
    expect(merged.suggestions.filter((item) => item.label === 'local')).toHaveLength(1)
    expect(merged.suggestions.find((item) => item.label === 'local')?.detail).toBe('LSP keyword')
    expect(await providers.lua!.provideCompletionItems(model, position, context, { isCancellationRequested: true }))
      .toEqual({ suggestions: [] })
  })

  it('注解类型服务器优先；C# 原样呈现 Roslyn 内建类型', async () => {
    const providers = captureProvs()
    const model = {
      uri: { scheme: 'edrv', path: '/a.lua' },
      getValue: () => '---@type nu',
      getWordUntilPosition: () => ({ word: 'nu', startColumn: 10, endColumn: 12 }),
      getLineContent: () => '---@type nu',
    }
    const position = { lineNumber: 1, column: 12 }
    vi.mocked(fetchCompletions).mockResolvedValue(null)
    const fallback = await providers.lua!.provideCompletionItems(model, position, { triggerKind: 0 }, {})
    expect(fallback.suggestions.some((item) => item.label === 'number')).toBe(true)
    expect(fallback.suggestions.some((item) => item.label === 'local')).toBe(false)

    vi.mocked(fetchCompletions).mockResolvedValue({
      items: [{ label: 'number', kind: 14, detail: 'EmmyLua type' }], incomplete: false,
    })
    const merged = await providers.lua!.provideCompletionItems(model, position, { triggerKind: 0 }, {})
    expect(merged.suggestions.filter((item) => item.label === 'number')).toHaveLength(1)
    expect(merged.suggestions.find((item) => item.label === 'number')?.detail).toBe('EmmyLua type')

    vi.mocked(fetchCompletions).mockResolvedValue({
      items: [{ label: 'int', kind: 14, detail: 'Roslyn' }], incomplete: false,
    })
    const csModel = {
      ...model, uri: { scheme: 'edrv', path: '/a.cs' }, getValue: () => 'in',
      getWordUntilPosition: () => ({ word: 'in', startColumn: 1, endColumn: 3 }),
      getLineContent: () => 'in',
    }
    const csharp = await providers.csharp!.provideCompletionItems(csModel, { lineNumber: 1, column: 3 }, { triggerKind: 0 }, {})
    expect(csharp.suggestions).toHaveLength(1)
    expect(csharp.suggestions[0]).toMatchObject({ label: 'int', detail: 'Roslyn' })
  })
})
