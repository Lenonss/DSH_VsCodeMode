/**
 * client monaco loader 回归测试（issue #3：一次性失败后永久卡死）。
 * node 环境无真实 DOM，用最小 document/window mock；loadMonaco 的模块级
 * monacoPromise 缓存用 vi.resetModules + 动态 import 逐例隔离。
 * 作者 ddj 2026-09-22
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 模拟 script 元素（dataset/onload/onerror/parentNode，够 loader 使用即可）。 */
interface FakeScript {
  dataset: Record<string, string>
  src: string
  onload: (() => void) | null
  onerror: ((event?: { type?: string }) => void) | null
  parentNode: { removeChild: (el: FakeScript) => void } | null
}

/** 构造最小 document mock：querySelector 命中注入过的 loader 标签，removeChild 同步出队。 */
function makeDom() {
  const scripts: FakeScript[] = []
  const dom = {
    head: {
      appendChild: vi.fn((el: FakeScript) => {
        el.parentNode = dom.head
        scripts.push(el)
      }),
    },
    createElement: vi.fn((): FakeScript => ({
      dataset: {},
      src: '',
      onload: null,
      onerror: null,
      parentNode: null,
    })),
    querySelector: vi.fn((selector: string) =>
      scripts.find((s) => s.dataset.edrvMonacoLoader === '1' && selector.includes('data-edrv-monaco-loader')) ?? null,
    ),
  }
  // head 同时充当 parentNode：removeChild 把脚本移出队列
  ;(dom.head as unknown as { removeChild: (el: FakeScript) => void }).removeChild = vi.fn((el: FakeScript) => {
    const idx = scripts.indexOf(el)
    if (idx >= 0) scripts.splice(idx, 1)
    el.parentNode = null
  })
  return { dom, scripts }
}

/** 构造 window.require mock（AMD 风格：config + 数组依赖 + 成功/失败回调）。 */
function makeRequire(ready = true) {
  const requireFn = vi.fn((deps: string[], ok?: () => void, err?: (e: unknown) => void) => {
    if (ready) ok?.()
    else err?.(new Error('module load failed'))
  })
  ;(requireFn as unknown as { config: ReturnType<typeof vi.fn> }).config = vi.fn()
  return requireFn as unknown as ((deps: string[], ok?: () => void, err?: (e: unknown) => void) => void) & {
    config: ReturnType<typeof vi.fn>
  }
}

/** 在 globalThis 上临时设置 module/exports（还原原始状态，含「原本不存在」情形）。 */
function withNodeGlobals(fakeModule: unknown, fakeExports: unknown, run: () => Promise<void>): Promise<void> {
  const prevModule = (globalThis as Record<string, unknown>).module
  const prevExports = (globalThis as Record<string, unknown>).exports
  const hadModule = Object.prototype.hasOwnProperty.call(globalThis, 'module')
  const hadExports = Object.prototype.hasOwnProperty.call(globalThis, 'exports')
  if (fakeModule === undefined) delete (globalThis as Record<string, unknown>).module
  else (globalThis as Record<string, unknown>).module = fakeModule
  if (fakeExports === undefined) delete (globalThis as Record<string, unknown>).exports
  else (globalThis as Record<string, unknown>).exports = fakeExports
  return run().finally(() => {
    if (hadModule) (globalThis as Record<string, unknown>).module = prevModule
    else delete (globalThis as Record<string, unknown>).module
    if (hadExports) (globalThis as Record<string, unknown>).exports = prevExports
    else delete (globalThis as Record<string, unknown>).exports
  })
}

describe('monaco loader（issue #3 回归）', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('首次注入成功：appendChild → onload → boot → resolve', async () => {
    const { dom, scripts } = makeDom()
    vi.stubGlobal('document', dom)
    const requireFn = makeRequire(true)
    vi.stubGlobal('window', { require: requireFn, monaco: { editor: {} } })
    const { loadMonaco } = await import('../src/client/monaco/loader.js')
    const promise = loadMonaco(() => {})
    expect(dom.createElement).toHaveBeenCalledTimes(1)
    expect(dom.head.appendChild).toHaveBeenCalledTimes(1)
    const script = scripts[0]
    expect(script.dataset.edrvMonacoLoader).toBe('1')
    expect(script.src).toMatch(/\/loader\.js$/)
    script.onload?.()
    await expect(promise).resolves.toBeDefined()
    expect(requireFn.config).toHaveBeenCalledWith({ paths: { vs: '/edrv/vendor/monaco/vs' } })
  })

  it('onerror：移除残留标签并 reject 真实原因', async () => {
    const { dom, scripts } = makeDom()
    vi.stubGlobal('document', dom)
    vi.stubGlobal('window', { require: undefined })
    const { loadMonaco } = await import('../src/client/monaco/loader.js')
    const promise = loadMonaco(() => {})
    const script = scripts[0]
    script.onerror?.({ type: 'error' })
    await expect(promise).rejects.toThrow('Monaco loader 加载失败')
    // 标签已从 DOM 移除：下次挂载不会命中残留分支
    expect(scripts).toHaveLength(0)
  })

  it('残留标签但 require 缺失：移除旧标签并重新注入（原 bug：同步 boot 二次踩坑）', async () => {
    const { dom, scripts } = makeDom()
    // 预置残留标签：上次注入失败但标签没清掉（issue #3 原症状）
    const stale: FakeScript = {
      dataset: { edrvMonacoLoader: '1' },
      src: '/edrv/vendor/monaco/vs/loader.js',
      onload: null,
      onerror: null,
      parentNode: null,
    }
    scripts.push(stale)
    stale.parentNode = dom.head
    vi.stubGlobal('document', dom)
    // 初始 require 缺失（残留场景：上次失败未挂载）
    vi.stubGlobal('window', { require: undefined })
    const { loadMonaco } = await import('../src/client/monaco/loader.js')
    const promise = loadMonaco(() => {})
    // 旧标签被移除 + 新标签注入（而非同步 boot 抛 TypeError）
    expect(scripts).not.toContain(stale)
    expect(dom.createElement).toHaveBeenCalledTimes(1)
    // 模拟 loader.js 执行成功挂上 require，再触发 onload → boot 成功
    const requireFn = makeRequire(true)
    vi.stubGlobal('window', { require: requireFn, monaco: { editor: {} } })
    const script = scripts[0]
    script.onload?.()
    await expect(promise).resolves.toBeDefined()
    expect(requireFn.config).toHaveBeenCalledTimes(1)
  })

  it('残留标签且 require 已就绪：直接 boot，不重复注入', async () => {
    const { dom, scripts } = makeDom()
    const stale: FakeScript = {
      dataset: { edrvMonacoLoader: '1' },
      src: '/edrv/vendor/monaco/vs/loader.js',
      onload: null,
      onerror: null,
      parentNode: null,
    }
    scripts.push(stale)
    stale.parentNode = dom.head
    vi.stubGlobal('document', dom)
    const requireFn = makeRequire(true)
    vi.stubGlobal('window', { require: requireFn, monaco: { editor: {} } })
    const { loadMonaco } = await import('../src/client/monaco/loader.js')
    const promise = loadMonaco(() => {})
    expect(dom.createElement).not.toHaveBeenCalled()
    await expect(promise).resolves.toBeDefined()
  })

  it('onload 后 require 仍未挂载：报真实原因且不无限重试', async () => {
    const { dom, scripts } = makeDom()
    vi.stubGlobal('document', dom)
    vi.stubGlobal('window', { require: undefined })
    const { loadMonaco } = await import('../src/client/monaco/loader.js')
    const promise = loadMonaco(() => {})
    scripts[0].onload?.()
    await expect(promise).rejects.toThrow('未挂载 window.require')
    // 没有无限重注入：只创建过一次 script
    expect(dom.createElement).toHaveBeenCalledTimes(1)
  })

  it('注入期间屏蔽全局 module/exports，onload 后还原（dsh-backup 冲突根因）', async () => {
    const fakeModule = { exports: {} }
    const fakeExports = {}
    await withNodeGlobals(fakeModule, fakeExports, async () => {
      const { dom, scripts } = makeDom()
      vi.stubGlobal('document', dom)
      const requireFn = makeRequire(true)
      vi.stubGlobal('window', { require: requireFn, monaco: { editor: {} } })
      const { loadMonaco } = await import('../src/client/monaco/loader.js')
      const promise = loadMonaco(() => {})
      // 注入期间（appendChild 之后、onload 之前）module/exports 已被屏蔽，
      // Monaco loader 不会误判 Node 环境
      expect((globalThis as Record<string, unknown>).module).toBeUndefined()
      expect((globalThis as Record<string, unknown>).exports).toBeUndefined()
      scripts[0].onload?.()
      await expect(promise).resolves.toBeDefined()
      // onload 后还原用户原有全局
      expect((globalThis as Record<string, unknown>).module).toBe(fakeModule)
      expect((globalThis as Record<string, unknown>).exports).toBe(fakeExports)
    })
  })

  it('失败后再次挂载可重试成功（monacoPromise 复位 + 标签已清）', async () => {
    const { dom, scripts } = makeDom()
    vi.stubGlobal('document', dom)
    const { loadMonaco } = await import('../src/client/monaco/loader.js')
    // 第一次：onerror 失败
    vi.stubGlobal('window', { require: undefined })
    const first = loadMonaco(() => {})
    scripts[0].onerror?.({ type: 'error' })
    await expect(first).rejects.toThrow('Monaco loader 加载失败')
    expect(scripts).toHaveLength(0)
    // 第二次：require 就绪 → 全新注入成功（不再残留阻塞）
    const requireFn = makeRequire(true)
    vi.stubGlobal('window', { require: requireFn, monaco: { editor: {} } })
    const second = loadMonaco(() => {})
    expect(dom.createElement).toHaveBeenCalledTimes(2)
    scripts[0].onload?.()
    await expect(second).resolves.toBeDefined()
  })
})
