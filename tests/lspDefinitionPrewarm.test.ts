/**
 * 定义 provider 的目标预热契约（tests/lspDefinitionPrewarm.test.ts）。
 *
 * 背景：Monaco 的 Ctrl+hover 定义链接预览对目标 uri 调 createModelReference 时只挂 then、
 * 没有 catch；目标 edrv:// 文件未打开必抛未捕获「Model not found」。修复把预热前置到
 * provideDefinition 返回之前，本文件锁定三条不可回退的契约：
 * ① 单一定义才预热（多定义走列表不读盘）；② 预热在返回结果之前完成；③ 预热任何失败
 * 都不得影响定义结果（F12 / Ctrl+点击不依赖模型是否已建）。
 * 作者 ddj 2026年10月20号
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findDefinition } from '../src/client/monaco/lsp/lspClient.js'
import { disposeLspProviders, registerLspProviders } from '../src/client/monaco/lsp/providers.js'
import { warmModelFor } from '../src/client/state/modelWarmer.js'

vi.mock('../src/client/monaco/lsp/lspClient.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/client/monaco/lsp/lspClient.js')>(),
  findDefinition: vi.fn(),
}))

vi.mock('../src/client/state/modelWarmer.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/client/state/modelWarmer.js')>(),
  warmModelFor: vi.fn(),
}))

type DefinitionProvider = {
  provideDefinition: (
    model: unknown, position: unknown, token: unknown,
  ) => Promise<Array<{ uri?: unknown; range?: unknown }>>
}

/** 去掉注释，避免文档注释里的字面量干扰源码契约断言。 */
function stripComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 造一个只够 provider 用的 Monaco 桩，并捕获按语言注册的 definition provider。 */
function captureDefinitionProvider(): DefinitionProvider {
  let captured: DefinitionProvider | null = null
  const disposer = () => ({ dispose() {} })
  const monaco = {
    editor: { onDidCreateModel: disposer, getModels: () => [], registerEditorOpener: disposer },
    languages: {
      CompletionItemKind: { Keyword: 17, Text: 18 },
      registerCompletionItemProvider: disposer,
      registerDefinitionProvider: (_langs: string[], provider: DefinitionProvider) => {
        captured = provider
        return disposer()
      },
      registerReferenceProvider: disposer,
      registerDocumentSymbolProvider: disposer,
      registerHoverProvider: disposer,
      registerDocumentSemanticTokensProvider: disposer,
      registerSignatureHelpProvider: disposer,
    },
  }
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} })
  registerLspProviders(monaco)
  if (!captured) throw new Error('definition provider 未注册')
  return captured
}

/** 一个 edrv:// 模型的 LSP 输入（pathOfModel 走真实实现）。 */
function edrvModel(path: string) {
  return { uri: { scheme: 'edrv', path }, getValue: () => 'local x = 1' }
}

/** findDefinition 的客户端产物（uri 是 Monaco Uri 形态，由 lspUriToAbs 归一）。 */
function edrvLocation(path: string) {
  return { uri: { scheme: 'edrv', path }, range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 } }
}

const position = { lineNumber: 1, column: 7 }
const token = { isCancellationRequested: false }

describe('单一定义才预热', () => {
  beforeEach(() => {
    vi.mocked(warmModelFor).mockReset()
    vi.mocked(findDefinition).mockReset()
  })

  afterEach(() => {
    disposeLspProviders()
    vi.unstubAllGlobals()
  })

  it('单定义预热目标文件，路径已剥离 edrv:// 前导斜杠', async () => {
    const provider = captureDefinitionProvider()
    const locations = [edrvLocation('/src/a.lua')]
    vi.mocked(findDefinition).mockResolvedValue(locations as never)
    vi.mocked(warmModelFor).mockResolvedValue(true)

    await expect(provider.provideDefinition(edrvModel('/src/b.lua'), position, token)).resolves.toBe(locations)
    expect(warmModelFor).toHaveBeenCalledTimes(1)
    expect(warmModelFor).toHaveBeenCalledWith('src/a.lua')
  })

  it('多定义不预热（Monaco 走列表，不调 createModelReference）', async () => {
    const provider = captureDefinitionProvider()
    const locations = [edrvLocation('/src/a.lua'), edrvLocation('/src/c.lua')]
    vi.mocked(findDefinition).mockResolvedValue(locations as never)

    await expect(provider.provideDefinition(edrvModel('/src/b.lua'), position, token)).resolves.toBe(locations)
    expect(warmModelFor).not.toHaveBeenCalled()
  })

  it('零结果不预热', async () => {
    const provider = captureDefinitionProvider()
    vi.mocked(findDefinition).mockResolvedValue([] as never)

    await expect(provider.provideDefinition(edrvModel('/src/b.lua'), position, token)).resolves.toEqual([])
    expect(warmModelFor).not.toHaveBeenCalled()
  })
})

describe('预热时序与失败降级', () => {
  beforeEach(() => {
    vi.mocked(warmModelFor).mockReset()
    vi.mocked(findDefinition).mockReset()
  })

  afterEach(() => {
    disposeLspProviders()
    vi.unstubAllGlobals()
  })

  it('预热未完成前不返回定义结果（保证 Monaco 渲染预览时模型已就绪）', async () => {
    const provider = captureDefinitionProvider()
    const locations = [edrvLocation('/src/a.lua')]
    vi.mocked(findDefinition).mockResolvedValue(locations as never)

    let releaseWarm: (value: boolean) => void = () => {}
    vi.mocked(warmModelFor).mockReturnValue(new Promise<boolean>((resolve) => { releaseWarm = resolve }))

    let settled = false
    const pending = provider.provideDefinition(edrvModel('/src/b.lua'), position, token)
    void pending.then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseWarm(true)
    await expect(pending).resolves.toBe(locations)
  })

  it('预热抛错仍返回定义结果（跳转不受影响）', async () => {
    const provider = captureDefinitionProvider()
    const locations = [edrvLocation('/src/a.lua')]
    vi.mocked(findDefinition).mockResolvedValue(locations as never)
    vi.mocked(warmModelFor).mockRejectedValue(new Error('read failed'))

    await expect(provider.provideDefinition(edrvModel('/src/b.lua'), position, token)).resolves.toBe(locations)
    expect(warmModelFor).toHaveBeenCalledTimes(1)
  })

  it('非 edrv 模型不查定义也不预热', async () => {
    const provider = captureDefinitionProvider()

    const result = await provider.provideDefinition(
      { uri: { scheme: 'file', path: '/tmp/a.lua' }, getValue: () => '' }, position, token,
    )
    expect(result).toEqual([])
    expect(findDefinition).not.toHaveBeenCalled()
    expect(warmModelFor).not.toHaveBeenCalled()
  })
})

describe('源码契约', () => {
  it('provideDefinition 是 async 且返回前调用了预热', () => {
    const source = stripComments(readFileSync(join(process.cwd(), 'src/client/monaco/lsp/providers.ts'), 'utf8'))

    expect(source).toContain('provideDefinition: async (model, position, token) => {')
    expect(source).toContain('await prewarmDefinitionTarget(locations)')
    expect(source).toContain('if (!Array.isArray(locations) || locations.length !== 1) return')
    expect(source).toContain('await warmModelFor(target)')
    // 预热失败必须被吞掉，不能冒泡成 provider 异常
    expect(source).toContain('} catch (error) {')
  })
})
