/** DAP hover：表达式提取 + 暂停态 provider 契约测试。作者 ddj 2026年09月21号 */
import { describe, expect, it, vi } from 'vitest'

/**
 * store 桩状态。vi.mock 工厂会被提升到文件顶部，工厂内引用的状态必须经 vi.hoisted 提前建立。
 * @author ddj 2026年09月21号
 */
const stub = vi.hoisted(() => ({
  phase: 'paused' as string,
  selectedFrameId: 7,
  result: { result: '42', type: 'number', ref: 0 } as { result: string; type?: string; ref: number },
  children: [] as Array<{ name: string; value: string; ref?: number }>,
  evalCalls: 0,
}))

vi.mock('../src/client/dap/store.js', () => ({
  dapStore: {
    getSnapshot: () => ({ phase: stub.phase, selectedFrameId: stub.selectedFrameId }),
    evaluate: async () => {
      stub.evalCalls += 1
      return stub.result
    },
    variables: async () => stub.children,
  },
}))

import { blockHtml, expressionAt, registerDapHover } from '../src/client/dap/hover.js'
import { setAltHeld } from '../src/client/dap/hoverMode.js'

/**
 * 真实 Monaco 的 Range 是 ES class（createMonacoBaseAPI 导出类本体），无 new 调用必抛
 * TypeError。桩必须保持 class 形态，否则「provider 里漏写 new」这类缺陷照旧测不出来。
 * @author ddj 2026年09月21号
 */
class RangeStub {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number

  constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) {
    this.startLineNumber = startLineNumber
    this.startColumn = startColumn
    this.endLineNumber = endLineNumber
    this.endColumn = endColumn
  }
}

/** 构造 edrv 模型桩（provider 需 uri.scheme === 'edrv' 才能解析出路径；word 默认 model、语言默认 lua）。 */
const edrvModel = (line: string, word = 'model', lang = 'lua') => ({
  uri: { scheme: 'edrv', path: '/Assets/Scripts/Lua/TeamLogic.lua' },
  getLanguageId: () => lang,
  getLineContent: () => line,
  getWordAtPosition: () => ({ word, startColumn: line.indexOf(word) + 1, endColumn: line.indexOf(word) + word.length + 1 }),
})

/**
 * 用最小 monaco 桩注册 DAP hover 并取回 provider。
 * @author ddj 2026年09月21号
 * @returns 最近一次注册进 monaco 桩的 hover provider
 */
function captureDapHover(): { provideHover: (model: unknown, position: unknown, token?: unknown) => Promise<{ contents?: Array<{ value: string }>; range?: unknown } | null> } {
  let captured: { provideHover: (model: unknown, position: unknown, token?: unknown) => Promise<{ contents?: Array<{ value: string }>; range?: unknown } | null> } | null = null
  registerDapHover({
    Range: RangeStub,
    languages: {
      registerHoverProvider: (_langs: unknown, provider: typeof captured) => {
        captured = provider
        return { dispose: () => {} }
      },
    },
  })
  if (!captured) throw new Error('DAP hover provider 未注册')
  return captured
}

describe('expressionAt', () => {
  const model = (line: string, word = 'model') => ({
    getLineContent: () => line,
    getWordAtPosition: () => ({ word, startColumn: line.indexOf(word) + 1, endColumn: line.indexOf(word) + word.length + 1 }),
  })

  it('成员段求整条链', () => {
    const result = expressionAt(model('local value = this.model'), { lineNumber: 1, column: 23 })
    expect(result?.expression).toBe('this.model')
    expect(result?.startColumn).toBe(15)
  })

  it('链首段只求该段（悬停 this 不再吃成 this.canUpdate）', () => {
    const result = expressionAt(model('this.canUpdate = true', 'this'), { lineNumber: 1, column: 2 })
    expect(result?.expression).toBe('this')
    expect(result?.startColumn).toBe(1)
    expect(result?.endColumn).toBe(5)
  })

  it('普通局部变量取自身', () => {
    const result = expressionAt(model('local detailData = nil', 'detailData'), { lineNumber: 1, column: 8 })
    expect(result?.expression).toBe('detailData')
  })

  it('无单词时返回 null', () => {
    const result = expressionAt({ getWordAtPosition: () => null }, { lineNumber: 1, column: 1 })
    expect(result).toBeNull()
  })
})

describe('暂停态 DAP hover provider', () => {
  it('返回单块 HTML（头行 + 类型）与范围（Range 必须 new 调用；漏 new 时本用例因 TypeError 失败）', async () => {
    stub.phase = 'paused'
    stub.result = { result: '42', type: 'number', ref: 0 }
    stub.children = []
    const hover = await captureDapHover().provideHover(edrvModel('local value = this.model'), { lineNumber: 1, column: 23 }, { isCancellationRequested: false })
    expect(hover?.contents).toHaveLength(1)
    const block = hover?.contents?.[0] as { value: string; supportHtml?: boolean }
    expect(block.supportHtml).toBe(true)
    expect(block.value).toContain('data-edrv-dap="1"')
    expect(block.value).toContain('data-edrv-head')
    expect(block.value).toContain('>this.model<')
    expect(block.value).toContain('>42<')
    expect(block.value).toContain('type: <code>number</code>')
    expect(hover?.range).toBeInstanceOf(RangeStub)
  })

  it('table 值在同一块内渲染可展开树且成员全量直显', async () => {
    stub.phase = 'paused'
    stub.result = { result: 'table: 0x0f', type: 'table', ref: 20 }
    stub.children = Array.from({ length: 21 }, (_item, index) => ({ name: 'field' + index, value: String(index), ref: 0 }))
    const hover = await captureDapHover().provideHover(edrvModel('local value = this.model'), { lineNumber: 1, column: 23 }, { isCancellationRequested: false })
    expect(hover?.contents).toHaveLength(1)
    const block = hover?.contents?.[0] as { value: string; supportHtml?: boolean }
    expect(block.supportHtml).toBe(true)
    expect(block.value).toContain('data-edrv-tree="1"')
    // 每个成员一行（21 行，无上限提示行）
    expect(block.value.match(/data-edrv-line="1"/g) ?? []).toHaveLength(21)
    expect(block.value).not.toContain('data-edrv-note')
    // 贴底提示层不在内容里（由 hoverTree 注入到 .monaco-hover，滚动区之外）
    expect(block.value).not.toContain('edrv-dap-hint')
  })

  it('按住 Alt 仍返回调试内容（切换交由 hover 层行级显隐，不重算）', async () => {
    stub.phase = 'paused'
    stub.result = { result: '42', type: 'number', ref: 0 }
    setAltHeld(true)
    const hover = await captureDapHover().provideHover(edrvModel('local value = this.model'), { lineNumber: 1, column: 23 }, { isCancellationRequested: false })
    expect(hover?.contents?.[0]?.value).toContain('data-edrv-dap="1"')
    setAltHeld(false)
  })

  it('非暂停态不产出悬停内容', async () => {
    stub.phase = 'running'
    const hover = await captureDapHover().provideHover(edrvModel('local value = this.model'), { lineNumber: 1, column: 23 }, { isCancellationRequested: false })
    expect(hover).toBeNull()
    stub.phase = 'paused'
  })

  it('关键字不触发求值也不出调试行', async () => {
    stub.phase = 'paused'
    stub.evalCalls = 0
    const hover = await captureDapHover().provideHover(edrvModel('if not this.canUpdate then', 'not'), { lineNumber: 1, column: 4 }, { isCancellationRequested: false })
    expect(hover).toBeNull()
    expect(stub.evalCalls).toBe(0)
  })

  it('注释里的中文文本不出调试行', async () => {
    stub.phase = 'paused'
    stub.evalCalls = 0
    const hover = await captureDapHover().provideHover(edrvModel('-- 成员类型变化后的角色', '成员类型变化后的角色'), { lineNumber: 1, column: 5 }, { isCancellationRequested: false })
    expect(hover).toBeNull()
    expect(stub.evalCalls).toBe(0)
  })

  it('adapter 语法错误结果不出调试行', async () => {
    stub.phase = 'paused'
    stub.result = { result: 'syntax err: 1 +', ref: 0 }
    const hover = await captureDapHover().provideHover(edrvModel('local value = this.model'), { lineNumber: 1, column: 23 }, { isCancellationRequested: false })
    expect(hover).toBeNull()
  })
})

describe('blockHtml（单块渲染与转义）', () => {
  it('名称/值/类型全部转义，空类型不输出类型行', () => {
    const html = blockHtml('<b>a', '<script>x</script>', 'table', '')
    expect(html).toContain('&lt;b&gt;a')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('type: <code>table</code>')
    expect(blockHtml('a', '1', '', '')).not.toContain('data-edrv-type')
  })

  it('包住传入的变量树片段（钩子用 data-*，不用 class）', () => {
    const html = blockHtml('this', 'table: 0x1', 'table', '<ul data-edrv-tree="1"></ul>')
    expect(html.startsWith('<div data-edrv-dap="1">')).toBe(true)
    expect(html).toContain('<ul data-edrv-tree="1"></ul>')
    expect(html).not.toContain('class=')
    expect(html.endsWith('</div>')).toBe(true)
  })
})
