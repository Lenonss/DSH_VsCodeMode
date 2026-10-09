/** 行内差异渲染契约（最小 DOM/Monaco 替身，不代替真实浏览器验收）。 @author ddj 2026年10月09号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiffRenderer } from '../src/client/monaco/diffRender.js'
import { officialThemeOf } from '../src/client/monaco/theme.js'

class FakeNode {
  className = ''
  textContent = ''
  innerHTML = ''
  title = ''
  dataset: Record<string, string> = {}
  children: FakeNode[] = []
  style = { setProperty: vi.fn(), tabSize: '' }
  /** @public @author ddj 2026年10月09号 @param child 子节点 @returns 子节点 */
  appendChild(child: FakeNode) { this.children.push(child); return child }
  /** @public @author ddj 2026年10月09号 @returns 首个子节点 */
  get firstChild() { return this.children[0] }
}

/** @private @author ddj 2026年10月09号 @param patch 区域覆盖值 @returns 默认替换区域 */
function region(patch = {}) {
  return { callId: 'c1', idx: 0, start: 3, end: 4, oldStart: 7, oldLines: ['old'], newLines: ['new'], create: false, ...patch }
}

/** @private @author ddj 2026年10月09号 @param colorize 异步着色实现 @returns 可观察的编辑器与 API */
function fixture(colorize = vi.fn().mockResolvedValue('<span class="mtk1">old</span><br/>')) {
  vi.stubGlobal('document', { createElement: () => new FakeNode() })
  const zones = new Map<number, any>()
  const callbacks: Record<string, Function> = {}
  const listeners: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
  const model = { getLanguageId: vi.fn(() => 'csharp'), getOptions: () => ({ tabSize: 4 }) }
  const root = new FakeNode()
  let nextId = 0
  const editor = {
    getModel: vi.fn(() => model), getDomNode: () => root,
    getLayoutInfo: vi.fn(() => ({ lineNumbersLeft: 3, lineNumbersWidth: 35, decorationsLeft: 38, decorationsWidth: 22 })),
    getOption: vi.fn((option) => option === 'lineHeight' ? 24 : { typicalHalfwidthCharacterWidth: 9 }),
    applyFontInfo: vi.fn(), deltaDecorations: vi.fn((_, next) => next.map((_, index) => 'd' + index)),
    changeViewZones: vi.fn((callback) => callback({
      addZone: (zone) => { const id = ++nextId; zones.set(id, zone); return id },
      removeZone: (id) => zones.delete(id),
    })),
  }
  for (const event of ['onDidChangeConfiguration', 'onDidChangeModelLanguage', 'onDidChangeModelOptions', 'onDidLayoutChange', 'onDidChangeModel', 'onDidDispose']) {
    editor[event] = (callback) => {
      callbacks[event] = callback
      const listener = { dispose: vi.fn() }
      listeners.push(listener)
      return listener
    }
  }
  const monaco = { Range: class { constructor(public startLineNumber, public startColumn, public endLineNumber, public endColumn) {} },
    editor: { colorize, EditorOption: { fontInfo: 'fontInfo', lineHeight: 'lineHeight' } } }
  return { editor, monaco, zones, callbacks, listeners, root, model, colorize }
}

/** @private @author ddj 2026年10月09号 @returns 当前唯一删除区域 */
function zoneOf(f: ReturnType<typeof fixture>) { return [...f.zones.values()][0] }

/** @private @author ddj 2026年10月09号 @returns 可手动完成的着色请求 */
function deferred() {
  let resolve!: (html: string) => void
  /** @private @author ddj 2026年10月09号 @param done 保存 Promise 完成函数 */
  function executor(done: (html: string) => void) { resolve = done }
  const promise = new Promise<string>(executor)
  return { promise, resolve: (html: string) => resolve(html) }
}

afterEach(() => vi.unstubAllGlobals())

describe('行内差异渲染', () => {
  it('新增行用整行和边栏装饰，删除行拥有旧号/减号且遵循实际字体布局', async () => {
    const f = fixture()
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region()], 's1')
    const zone = zoneOf(f)
    expect(zone.afterLineNumber).toBe(2)
    expect(zone.heightInLines).toBe(1)
    expect(zone.minWidthInPx).toBe(51)
    expect(zone.marginDomNode.children[0].children.map((node) => node.textContent)).toEqual(['7', '−'])
    expect(zone.domNode.style.setProperty).toHaveBeenCalledWith('--edrv-line-height', '24px')
    expect(zone.marginDomNode.style.setProperty).toHaveBeenCalledWith('--edrv-number-width', '35px')
    expect(f.editor.applyFontInfo).toHaveBeenCalledWith(zone.domNode)
    expect(f.editor.deltaDecorations.mock.calls.at(-1)![1][0].options).toMatchObject({ isWholeLine: true, marginClassName: 'edrv-mn-add-line' })
    await Promise.resolve()
    expect(zone.domNode.firstChild.firstChild.innerHTML).toContain('mtk1')
    renderer.dispose()
  })

  it('共享主题色盘且不订阅手写滚动覆盖层', () => {
    const f = fixture()
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region()], 's1')
    expect(f.root.style.setProperty).toHaveBeenCalledWith('--edrv-diff-add', officialThemeOf('dark').colors['diffEditor.insertedLineBackground'])
    expect(Object.keys(f.callbacks)).not.toContain('onDidScrollChange')
    renderer.dispose()
  })

  it('每个多行删除块只着色一次，原行号递增', async () => {
    const f = fixture(vi.fn().mockResolvedValue('<span>a</span><br><span>b</span><br>'))
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region({ oldLines: ['a', 'b'] })], 's1')
    expect(f.colorize).toHaveBeenCalledOnce()
    expect(f.colorize).toHaveBeenCalledWith('a\nb', 'csharp', { tabSize: 4 })
    await Promise.resolve()
    expect(zoneOf(f).domNode.children[1].firstChild.innerHTML).toBe('<span>b</span>')
    expect(zoneOf(f).marginDomNode.children[1].firstChild.textContent).toBe('8')
    renderer.dispose()
  })

  it('同长度不同内容触发重绘，完全相同区域不重复着色/订阅', () => {
    const f = fixture()
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region()], 's1')
    renderer.render(f.monaco, f.editor, [region()], 's1')
    expect(f.colorize).toHaveBeenCalledOnce()
    renderer.render(f.monaco, f.editor, [region({ oldLines: ['xyz'] })], 's1')
    expect(f.colorize).toHaveBeenCalledTimes(2)
    expect(f.listeners).toHaveLength(6)
    expect(f.zones.size).toBe(1)
    renderer.dispose()
  })

  it('刷新主题/字体/语言重绘，布局变化不重新着色', () => {
    const f = fixture()
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region()], 's1')
    renderer.refresh('edrv-official-2')
    f.callbacks.onDidChangeConfiguration({})
    f.model.getLanguageId.mockReturnValue('lua')
    f.callbacks.onDidChangeModelLanguage({})
    expect(f.colorize).toHaveBeenCalledTimes(4)
    expect(f.colorize.mock.calls.at(-1)![1]).toBe('lua')
    f.callbacks.onDidLayoutChange({})
    expect(f.colorize).toHaveBeenCalledTimes(4)
    renderer.dispose()
  })

  it('空区域清理所有标记，dispose 释放全部监听且可重复调用', () => {
    const f = fixture()
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region()], 's1')
    renderer.render(f.monaco, f.editor, [], 's1')
    expect(f.zones.size).toBe(0)
    expect(f.editor.deltaDecorations.mock.calls.at(-1)![1]).toEqual([])
    renderer.dispose()
    renderer.dispose()
    for (const listener of f.listeners) expect(listener.dispose).toHaveBeenCalledOnce()
  })

  it('主题代次更新后拒绝旧着色 Promise 写入', async () => {
    const first = deferred()
    const f = fixture(vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue('new<br/>'))
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region()], 's1')
    const previous = zoneOf(f).domNode.firstChild.firstChild
    renderer.refresh('edrv-official-3')
    first.resolve('STALE<br/>')
    await Promise.resolve()
    expect(previous.innerHTML).toBe('')
    expect(zoneOf(f).domNode.firstChild.firstChild.innerHTML).toBe('new')
    renderer.dispose()
  })

  it('切换模型立即清理并拒绝旧 Promise，不把旧区域画进新文件', async () => {
    const first = deferred()
    const f = fixture(vi.fn().mockReturnValue(first.promise))
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region()], 's1')
    const previous = zoneOf(f).domNode.firstChild.firstChild
    f.editor.getModel.mockReturnValue({ ...f.model })
    f.callbacks.onDidChangeModel()
    renderer.refresh()
    first.resolve('STALE<br/>')
    await Promise.resolve()
    expect(f.zones.size).toBe(0)
    expect(previous.innerHTML).toBe('')
    renderer.dispose()
  })

  it('dispose 后拒绝未完成请求；编辑器切换不遗留旧区域/监听', async () => {
    const first = deferred()
    const f = fixture(vi.fn().mockReturnValue(first.promise))
    const other = fixture()
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region()], 's1')
    const previous = zoneOf(f).domNode.firstChild.firstChild
    renderer.render(other.monaco, other.editor, [region()], 's2')
    renderer.dispose()
    first.resolve('STALE<br/>')
    await Promise.resolve()
    expect(previous.innerHTML).toBe('')
    expect(f.zones.size).toBe(0)
    expect(other.zones.size).toBe(0)
    for (const listener of [...f.listeners, ...other.listeners]) expect(listener.dispose).toHaveBeenCalledOnce()
  })

  it('缺旧号显示占位，纯删除没有新增装饰', () => {
    const f = fixture()
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region({ oldStart: undefined, newLines: [], end: 3 })], 's1')
    expect(zoneOf(f).marginDomNode.firstChild.firstChild.textContent).toBe('·')
    expect(f.editor.deltaDecorations.mock.calls.at(-1)![1]).toEqual([])
    renderer.dispose()
  })

  it('着色失败/行数不符保留转义前纯文本，不解释源码 HTML', async () => {
    const f = fixture(vi.fn().mockRejectedValue(new Error('tokenizer unavailable')))
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region({ oldLines: ['<img src=x onerror=alert(1)>'] })], 's1')
    await Promise.resolve()
    expect(zoneOf(f).domNode.firstChild.firstChild.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(zoneOf(f).domNode.firstChild.firstChild.innerHTML).toBe('')
    f.colorize.mockResolvedValue('wrong<br>row<br>count')
    renderer.refresh()
    await Promise.resolve()
    expect(zoneOf(f).domNode.firstChild.firstChild.innerHTML).toBe('')
    renderer.dispose()
  })

  it('create 和 stale 不生成删除区域', () => {
    const f = fixture()
    const renderer = createDiffRenderer(vi.fn())
    renderer.render(f.monaco, f.editor, [region({ create: true }), region({ start: undefined })], 's1')
    expect(f.zones.size).toBe(0)
    renderer.dispose()
  })
})
