/**
 * 代码片段补全 provider 测试（mock Monaco + stub fetch，不打真实网络）：
 * ① 枚举缺失时不注册（精简 Montec 降级，避免候选项退化为纯文本插入）；
 * ② 枚举齐备时按 '*' 注册，provideCompletionItems 走 host snippets.entries 载荷、
 *    按语言过滤、以 InsertAsSnippet 规则产出候选；
 * ③ 产物形状（label/detail/documentation/filterText/range）与空载荷降级。
 * 作者 ddj 2026-09-10
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeSnippets, invalidateSnippets, registerSnippetProvider, setSnippetsSession } from '../src/client/snippets/provider.js'

/** 造一个最小 Monaco 替身，记录注册的 provider。 */
function fakeMonaco(opts: { enums?: boolean } = {}) {
  const withEnums = opts.enums !== false
  const providers = []
  const monaco = {
    languages: {
      registerCompletionItemProvider: (language, provider) => {
        providers.push({ language, provider })
        return { dispose: () => {} }
      },
    },
  }
  if (withEnums) {
    monaco.languages.CompletionItemKind = { Snippet: 27 }
    monaco.languages.CompletionItemInsertTextRule = { InsertAsSnippet: 4 }
  }
  return { monaco, providers }
}

/** 造一个最小 model 替身（provideCompletionItems 只用到这几项）。 */
function fakeModel(languageId) {
  return {
    uri: { scheme: 'edrv', path: '/a' },
    getLanguageId: () => languageId,
    getWordUntilPosition: () => ({ startColumn: 1, endColumn: 3 }),
  }
}

/** stub fetch 返回指定 RPC 载荷（snippets.entries）。 */
function stubEntries(entries) {
  const calls = []
  vi.stubGlobal('fetch', async (url, init) => {
    calls.push(JSON.parse(init.body))
    return { json: async () => ({ ok: true, entries }) }
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  // provider 的 registered 是模块级状态：逐例复位，否则第二例起不再注册（providers 为空）
  disposeSnippets()
  invalidateSnippets()
})

describe('registerSnippetProvider 注册守卫', () => {
  it('缺少片段枚举（精简 Monaco）时不注册', () => {
    const { monaco, providers } = fakeMonaco({ enums: false })
    registerSnippetProvider(monaco)
    expect(providers).toHaveLength(0)
  })

  it('枚举齐备时按 * 注册', () => {
    const { monaco, providers } = fakeMonaco()
    registerSnippetProvider(monaco)
    expect(providers).toHaveLength(1)
    expect(providers[0].language).toBe('*')
    expect(typeof providers[0].provider.provideCompletionItems).toBe('function')
  })

  it('重复注册幂等（只注册一次）', () => {
    const { monaco, providers } = fakeMonaco()
    registerSnippetProvider(monaco)
    registerSnippetProvider(monaco)
    expect(providers).toHaveLength(1)
  })
})

describe('provideCompletionItems 候选产出', () => {
  it('按语言过滤并以 InsertAsSnippet 产出候选（含 detail/documentation）', async () => {
    const entries = [
      { key: 'any', prefix: 'any', body: 'ANY', description: '全语言', scope: 'user', file: 'global.code-snippets', language: '' },
      { key: 'luaLog', prefix: 'lualog', body: 'print($1)', description: '打日志', scope: 'user', file: 'lua.code-snippets', language: 'lua' },
      { key: 'cssOnly', prefix: 'cssx', body: 'CSS', description: '', scope: 'user', file: 'css.code-snippets', language: 'css' },
    ]
    const calls = stubEntries(entries)
    const { monaco, providers } = fakeMonaco()
    registerSnippetProvider(monaco)
    const result = await providers[0].provider.provideCompletionItems(fakeModel('lua'), { lineNumber: 1, column: 3 })

    // 载荷来自 snippets.entries
    expect(calls[0].method).toBe('snippets.entries')
    // 只保留全语言 + lua
    expect(result.suggestions.map((s) => s.label)).toEqual(['any', 'lualog'])
    const log = result.suggestions[1]
    expect(log.insertText).toBe('print($1)')
    expect(log.kind).toBe(27)
    expect(log.insertTextRules).toBe(4)
    expect(log.filterText).toBe('lualog')
    expect(log.documentation).toBe('打日志')
    expect(log.detail).toContain('lua.code-snippets')
    expect(log.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 3 })
  })

  it('项目条目覆盖同 key 全局条目，detail 标注项目来源', async () => {
    const entries = [
      { key: 'same', prefix: 'same', body: 'GLOBAL', description: '', scope: 'user', file: 'global.code-snippets', language: '' },
      { key: 'same', prefix: 'same', body: 'PROJECT', description: '', scope: 'project', file: 'lua.code-snippets', language: 'lua' },
    ]
    stubEntries(entries)
    const { monaco, providers } = fakeMonaco()
    registerSnippetProvider(monaco)
    const result = await providers[0].provider.provideCompletionItems(fakeModel('lua'), { lineNumber: 1, column: 3 })
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0].insertText).toBe('PROJECT')
    expect(result.suggestions[0].detail).toContain('项目片段')
  })

  it('无匹配语言条目时返回空候选（不报错）', async () => {
    stubEntries([{ key: 'cssOnly', prefix: 'c', body: 'C', description: '', scope: 'user', file: 'css.code-snippets', language: 'css' }])
    const { monaco, providers } = fakeMonaco()
    registerSnippetProvider(monaco)
    const result = await providers[0].provider.provideCompletionItems(fakeModel('lua'), { lineNumber: 1, column: 1 })
    expect(result.suggestions).toEqual([])
  })

  it('载荷为空数组时返回空候选（补全静默降级）', async () => {
    stubEntries([])
    const { monaco, providers } = fakeMonaco()
    registerSnippetProvider(monaco)
    const result = await providers[0].provider.provideCompletionItems(fakeModel('lua'), { lineNumber: 1, column: 1 })
    expect(result.suggestions).toEqual([])
  })

  it('RPC 失败时返回空候选（不打断输入）', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const { monaco, providers } = fakeMonaco()
    registerSnippetProvider(monaco)
    const result = await providers[0].provider.provideCompletionItems(fakeModel('lua'), { lineNumber: 1, column: 1 })
    expect(result.suggestions).toEqual([])
  })

  it('会话设置后载荷带上 sessionId（用于叠加项目片段）', async () => {
    const calls = stubEntries([])
    setSnippetsSession('sess-1')
    invalidateSnippets()
    const { monaco, providers } = fakeMonaco()
    registerSnippetProvider(monaco)
    await providers[0].provider.provideCompletionItems(fakeModel('lua'), { lineNumber: 1, column: 1 })
    expect(calls[0].args.sessionId).toBe('sess-1')
    setSnippetsSession(null)
  })
})
