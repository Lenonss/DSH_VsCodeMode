/**
 * G4 卸载洁净度测试：Monaco provider 的注销与跨重载守卫。
 *
 * 背景：DSH 0.1.6-alpha.2 起支持插件运行时卸载/重载，而 `window.monaco` 由 loader
 * 注入后跨重载存活，模块级 `registered`/`disposables` 随 bundle 重新求值复位。
 * 若只判模块级状态，每次重载都会重复注册一整套 provider（补全/跳转/hover 翻倍）。
 * 故注销器与注册标记都落 window，本测试用假 monaco 驱动验证：
 *   1. 首次注册后标记落 window；
 *   2. 模块状态被模拟复位后（跨重载），再次注册命中 window 标记即跳过；
 *   3. dispose 注销真实 provider、清 window 标记，之后可重新注册。
 * 作者 ddj 2026年09月18号
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 最小 window 桩：被测模块在注册期会读写 window（事件监听与跨重载标记）。
 * vitest 环境为 node，无 window，故显式提供。
 *
 * 关键：浏览器里 `window === globalThis`，被测代码的跨重载标记就直接读写全局，
 * 故桩也令 `window` 指向 globalThis 本身（而非另造对象），使断言与真实语义一致。
 * 所需的 DOM 方法直接挂到 globalThis 上，afterEach 还原。
 */
function installWindowStub(): void {
  const host = globalThis as Record<string, unknown>
  if (host.window) return
  host.addEventListener = () => {}
  host.removeEventListener = () => {}
  host.dispatchEvent = () => true
  host.window = host
}

/** 构造记录注册/注销的假 monaco（provider 面 + editor 面）。 */
function fakeMonaco() {
  const disposed: string[] = []
  const registeredProviders: string[] = []
  const make = (kind: string) => (..._args: unknown[]) => {
    registeredProviders.push(kind)
    return { dispose: () => disposed.push(kind) }
  }
  return {
    disposed,
    registeredProviders,
    monaco: {
      languages: {
        CompletionItemKind: { Snippet: 1 },
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        registerCompletionItemProvider: make('completion'),
        registerSignatureHelpProvider: make('signature'),
        registerInlineCompletionsProvider: make('inline'),
        registerDefinitionProvider: make('definition'),
        registerReferenceProvider: make('reference'),
        registerDocumentSymbolProvider: make('symbol'),
        registerHoverProvider: make('hover'),
        registerDocumentSemanticTokensProvider: make('semantic'),
      },
      editor: {
        registerEditorOpener: make('opener'),
        onDidCreateModel: make('createModel'),
        getModels: () => [],
      },
      Range: class {},
      Uri: { parse: (u: string) => ({ toString: () => u }) },
    },
  }
}

/** 清掉本组测试用的 window 挂点（测试间隔离）。 */
function clearGlobals() {
  const host = globalThis as Record<string, unknown>
  for (const key of ['__edrvAiInlineDisposer__', '__edrvSnippetsDisposer__', '__edrvLspProvidersRegistered__', '__edrvLspSessionUnbind__']) {
    delete host[key]
  }
}

afterEach(() => {
  clearGlobals()
  const host = globalThis as Record<string, unknown>
  delete host.window
  delete host.addEventListener
  delete host.removeEventListener
  delete host.dispatchEvent
  vi.restoreAllMocks()
})

describe('AI 内联补全卸载（G4）', () => {
  beforeEach(() => { installWindowStub() })
  it('注册后注销器落 window，重载后再次注册被跳过（不重复）', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/ai/inlineProvider.js')
    const a = fakeMonaco()
    mod.registerAiInline(a.monaco)
    expect(a.registeredProviders).toEqual(['inline'])
    expect((globalThis as Record<string, unknown>)['__edrvAiInlineDisposer__']).toBeTruthy()

    // 模拟跨重载：模块状态复位但 window.monaco 与 window 标记仍在
    vi.resetModules()
    const mod2 = await import('../src/client/ai/inlineProvider.js')
    const b = fakeMonaco()
    mod2.registerAiInline(b.monaco)
    expect(b.registeredProviders).toEqual([]) // 命中 window 标记 → 不重复注册
  })

  it('dispose 注销 provider、清 window 标记，之后可重新注册', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/ai/inlineProvider.js')
    const a = fakeMonaco()
    mod.registerAiInline(a.monaco)
    mod.disposeAiInline()
    expect(a.disposed).toEqual(['inline'])
    expect((globalThis as Record<string, unknown>)['__edrvAiInlineDisposer__']).toBeUndefined()

    const b = fakeMonaco()
    mod.registerAiInline(b.monaco)
    expect(b.registeredProviders).toEqual(['inline'])
  })

  it('重复 dispose 幂等，不抛错', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/ai/inlineProvider.js')
    const a = fakeMonaco()
    mod.registerAiInline(a.monaco)
    mod.disposeAiInline()
    expect(() => mod.disposeAiInline()).not.toThrow()
  })
})

describe('片段补全卸载（G4）', () => {
  beforeEach(() => { installWindowStub() })
  it('注册 → dispose 注销并复位，且 dispose 可清理上一代遗留的 window 注销器', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/snippets/provider.js')
    const a = fakeMonaco()
    mod.setupSnippets(a.monaco)
    expect(a.registeredProviders).toEqual(['completion'])

    // 模拟跨重载：新实例（模块状态为空）仍能凭 window 注销器清理上一代
    vi.resetModules()
    const mod2 = await import('../src/client/snippets/provider.js')
    const b = fakeMonaco()
    mod2.setupSnippets(b.monaco)
    expect(b.registeredProviders).toEqual([]) // 跨重载跳过重复注册
    mod2.disposeSnippets()
    expect(a.disposed).toEqual(['completion']) // 清掉的是上一代那个真实 provider
  })

  it('dispose 后重新装配可再次注册', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/snippets/provider.js')
    const a = fakeMonaco()
    mod.setupSnippets(a.monaco)
    mod.disposeSnippets()
    const b = fakeMonaco()
    mod.setupSnippets(b.monaco)
    expect(b.registeredProviders).toEqual(['completion'])
  })
})

describe('LSP provider 卸载（G4）', () => {
  beforeEach(() => { installWindowStub() })
  it('注册整套 provider，dispose 全部注销并清标记', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/monaco/lsp/providers.js')
    const a = fakeMonaco()
    mod.registerLspProviders(a.monaco)
    expect(a.registeredProviders.length).toBeGreaterThan(0)
    expect((globalThis as Record<string, unknown>)['__edrvLspProvidersRegistered__']).toBe(true)

    mod.disposeLspProviders()
    expect(a.disposed.length).toBe(a.registeredProviders.length)
    expect((globalThis as Record<string, unknown>)['__edrvLspProvidersRegistered__']).toBeUndefined()
  })

  it('逐语言补全 provider 的注销器被逐个处置（数组不得整体压入）', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/monaco/lsp/providers.js')
    const a = fakeMonaco()
    mod.registerLspProviders(a.monaco)
    // 补全按语言注册（lua + csharp）→ 两个注销器都必须可被 dispose 处理；
    // 若实现把注册结果数组整体压入，会静默漏注销 → 重载后补全叠加
    const completions = a.registeredProviders.filter((k) => k === 'completion').length
    expect(completions).toBe(2)
    mod.disposeLspProviders()
    expect(a.disposed.filter((k) => k === 'completion').length).toBe(completions)
  })

  it('注销器列表无 undefined 占位（withCapability 不得写在 push 参数里）', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/monaco/lsp/providers.js')
    const a = fakeMonaco()
    mod.registerLspProviders(a.monaco)
    // 注册项数与注销数必须严格相等：若有 undefined 占位（把 withCapability 放进
    // disposables.push(...) 参数列表会压入 undefined），dispose 会少注销
    mod.disposeLspProviders()
    expect(a.disposed.length).toBe(a.registeredProviders.length)
  })

  it('跨重载再次注册被跳过（不重复叠加 provider）', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/monaco/lsp/providers.js')
    mod.registerLspProviders(fakeMonaco().monaco)

    vi.resetModules()
    const mod2 = await import('../src/client/monaco/lsp/providers.js')
    const b = fakeMonaco()
    mod2.registerLspProviders(b.monaco)
    expect(b.registeredProviders).toEqual([])
  })

  it('单个注销器抛错不影响其余清理', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/monaco/lsp/providers.js')
    const disposed: string[] = []
    let first = true
    const monaco = fakeMonaco().monaco
    monaco.languages.registerDefinitionProvider = () => ({
      dispose: () => {
        if (first) { first = false; throw new Error('boom') }
        disposed.push('definition')
      },
    })
    monaco.languages.registerHoverProvider = () => ({ dispose: () => disposed.push('hover') })
    mod.registerLspProviders(monaco)
    expect(() => mod.disposeLspProviders()).not.toThrow()
    // hover 的注销仍在（异常被隔离）
    expect(disposed).toContain('hover')
  })

  it('dispose 后重新注册可生效（插件重装场景）', async () => {
    clearGlobals()
    vi.resetModules()
    const mod = await import('../src/client/monaco/lsp/providers.js')
    mod.registerLspProviders(fakeMonaco().monaco)
    mod.disposeLspProviders()
    const b = fakeMonaco()
    mod.registerLspProviders(b.monaco)
    expect(b.registeredProviders.length).toBeGreaterThan(0)
  })
})
