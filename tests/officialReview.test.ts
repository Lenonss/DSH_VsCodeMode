/** 官方审阅扩展位测试：注册降级 / React 组件渲染 / 注解源接线。作者 ddj 2026年11月23号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installOfficialReview } from '../src/client/officialReview.js'
import type { ReviewDeps, ReviewHost } from '../src/client/officialReview.js'

/** 契约固定的 slot 名。 */
const TOOLBAR_SLOT = 'forge.changes.toolbar'
const FILE_MENU_SLOT = 'forge.changes.file.menu'
const ANNOTATION_SLOT = 'forge.diff.line.annotation'
const COMMENT_SLOT = 'forge.diff.comment.actions'

/**
 * 造注入依赖：文案齐全，打开/加待审默认是 vi.fn，可按用例覆盖。
 * @author ddj 2026年11月23号
 * @param overrides 需要覆盖的字段
 * @returns 依赖替身
 */
function depsOf(overrides: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    openInEditor: vi.fn(),
    addPending: vi.fn(),
    labels: { toolbar: '在 VSCodeMode 打开', openFile: '在编辑器打开', addPending: '插入对话草稿', annotation: '处待审', comment: '插入对话草稿' },
    ...overrides,
  }
}

/**
 * 造官方宿主替身：记录 inject 名、register 收到的 spec 与组件，可按 slot 名注入失败。
 * @author ddj 2026年11月23号
 * @param options failRegisterOn 让该 slot 的 register 抛错；failDisposeOn 让该 slot 的 disposer 抛错；
 *                failAnnotations 让注解源注册抛错；withoutForge 不提供 forgeChanges 服务
 * @returns 宿主与调用记录
 */
function hostOf(options: { failRegisterOn?: string; failDisposeOn?: string; failAnnotations?: boolean; withoutForge?: boolean } = {}) {
  const injectedNames: string[] = []
  const specs: Array<Record<string, unknown>> = []
  const renders: Array<(props: unknown) => unknown> = []
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const sources: unknown[] = []
  const forgeChanges = {
    registerAnnotations: (source: unknown) => {
      if (options.failAnnotations) throw new Error('官方拒收注解源')
      sources.push(source)
      const dispose = vi.fn()
      disposers.push(dispose)
      return dispose
    },
  }
  const host: ReviewHost = {
    slots: {
      inject: (name: string, register: () => unknown) => {
        injectedNames.push(name)
        register()
        const dispose = vi.fn(() => {
          if (name === options.failDisposeOn) throw new Error('宿主注销失败：' + name)
        })
        disposers.push(dispose)
        return dispose
      },
      register: (spec: unknown, render: unknown) => {
        const specName = (spec as { name?: string }).name
        if (specName === options.failRegisterOn) throw new Error('官方 slot 拒绝注册：' + specName)
        specs.push(spec as Record<string, unknown>)
        renders.push(render as (props: unknown) => unknown)
        return undefined
      },
    },
    get: (name: string) => (name === 'forgeChanges' && !options.withoutForge ? forgeChanges : undefined),
  }
  return { host, injectedNames, specs, renders, disposers, sources, forgeChanges }
}

/** 渲染结果按 React 元素读回来。 */
interface Element {
  type: string
  props: { children?: unknown; onClick?: () => void; type?: string; className?: string }
}

/**
 * 把渲染结果当 React 元素断言；不是元素就失败。
 * @author ddj 2026年11月23号
 * @param value 渲染返回值
 * @returns 元素
 */
function elementOf(value: unknown): Element {
  expect(value).toMatchObject({ $$typeof: Symbol.for('react.element') })
  return value as Element
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installOfficialReview 注册链路', () => {
  it('(a) 无 slots：零注册、返回可调用的 disposer 且不抛', () => {
    const withoutSlots = installOfficialReview({}, depsOf())
    const withEmptySlots = installOfficialReview({ slots: {} }, depsOf())

    expect(typeof withoutSlots).toBe('function')
    expect(() => withoutSlots()).not.toThrow()
    expect(() => withEmptySlots()).not.toThrow()
    expect(() => withoutSlots()).not.toThrow()
  })

  it('(b) 四条 slot 各注册一次，注解槽是 keyed 且 key 等于源 id', () => {
    const deps = depsOf()
    const { host, injectedNames, specs, renders, sources } = hostOf()

    installOfficialReview(host, deps)

    expect(injectedNames).toEqual([TOOLBAR_SLOT, FILE_MENU_SLOT, COMMENT_SLOT, ANNOTATION_SLOT])
    expect(specs).toHaveLength(4)
    expect(specs[0]).toMatchObject({ name: TOOLBAR_SLOT, id: 'dsh-vscode-mode:open', label: deps.labels.toolbar })
    expect(specs[1]).toMatchObject({ name: FILE_MENU_SLOT, id: 'dsh-vscode-mode:add' })
    expect(specs[2]).toMatchObject({ name: COMMENT_SLOT, id: 'dsh-vscode-mode:comment', label: deps.labels.comment })
    expect(specs[3]).toMatchObject({ name: ANNOTATION_SLOT, key: 'dsh-vscode-mode' })
    // keyed 槽用 key，不带 list 的 id/label。
    expect(specs[3].id).toBeUndefined()
    expect(renders).toHaveLength(4)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ id: 'dsh-vscode-mode' })
  })

  it('(c) 没有 forgeChanges：注解源与注解槽都不注册，其余照旧', () => {
    const logged: string[] = []
    const { host, injectedNames, specs, sources } = hostOf({ withoutForge: true })

    installOfficialReview(host, depsOf({ logger: (message) => logged.push(message) }))

    expect(injectedNames).toEqual([TOOLBAR_SLOT, FILE_MENU_SLOT, COMMENT_SLOT])
    expect(specs).toHaveLength(3)
    expect(sources).toHaveLength(0)
    expect(logged.some((message) => message.includes('forgeChanges'))).toBe(true)
  })

  it('(d) 注解源注册抛错：不注册注解槽，其余 slot 照常', () => {
    const logged: string[] = []
    const { host, specs, sources } = hostOf({ failAnnotations: true })

    const dispose = installOfficialReview(host, depsOf({ logger: (message) => logged.push(message) }))

    expect(sources).toHaveLength(0)
    expect(specs.map((spec) => spec.name)).toEqual([TOOLBAR_SLOT, FILE_MENU_SLOT, COMMENT_SLOT])
    expect(logged.some((message) => message.includes('注解源注册失败'))).toBe(true)
    expect(() => dispose()).not.toThrow()
  })

  it('(e) 某个 slot 注册抛错：其余照常注册，disposer 不抛且只撤成功的注册', () => {
    const logged: string[] = []
    const { host, specs, disposers } = hostOf({ failRegisterOn: TOOLBAR_SLOT })

    const dispose = installOfficialReview(host, depsOf({ logger: (message) => logged.push(message) }))

    expect(specs.map((spec) => spec.name)).toEqual([FILE_MENU_SLOT, COMMENT_SLOT, ANNOTATION_SLOT])
    expect(logged.some((message) => message.includes(TOOLBAR_SLOT))).toBe(true)

    expect(() => dispose()).not.toThrow()
    for (const disposer of disposers) expect(disposer).toHaveBeenCalledTimes(1)
    expect(() => dispose()).not.toThrow()
  })

  it('(f) 注销函数自身抛错时不影响其余卸载，也不向外抛', () => {
    const logged: string[] = []
    const { host, disposers } = hostOf({ failDisposeOn: TOOLBAR_SLOT })

    const dispose = installOfficialReview(host, depsOf({ logger: (message) => logged.push(message) }))

    expect(() => dispose()).not.toThrow()
    for (const disposer of disposers) expect(disposer).toHaveBeenCalledTimes(1)
    expect(logged.some((message) => message.includes('卸载失败'))).toBe(true)
  })
})

describe('installOfficialReview 组件渲染', () => {
  it('(g) 工具条按钮点击调用 openInEditor', () => {
    const deps = depsOf()
    const { host, renders } = hostOf()
    installOfficialReview(host, deps)

    const button = elementOf(renders[0]({ path: 'src/a.ts' }))
    expect(button.type).toBe('button')
    expect(button.props.type).toBe('button')
    expect(button.props.children).toBe(deps.labels.toolbar)
    button.props.onClick!()
    expect(deps.openInEditor).toHaveBeenCalledWith('src/a.ts')
    expect(deps.addPending).not.toHaveBeenCalled()
  })

  it('(h) 文件菜单两行分别调用 openInEditor 与 addPending', () => {
    const deps = depsOf()
    const { host, renders } = hostOf()
    installOfficialReview(host, deps)

    const menu = elementOf(renders[1]({ path: 'src/b.ts' }))
    const rows = menu.props.children as Element[]
    expect(rows.map((row) => row.props.children)).toEqual([deps.labels.openFile, deps.labels.addPending])

    rows[0].props.onClick!()
    rows[1].props.onClick!()
    expect(deps.openInEditor).toHaveBeenCalledWith('src/b.ts')
    expect(deps.addPending).toHaveBeenCalledWith('src/b.ts')
  })

  it('(i) 路径按 path → file.path → file.name 回落', () => {
    const deps = depsOf()
    const { host, renders } = hostOf()
    installOfficialReview(host, deps)

    elementOf(renders[0]({ file: { name: 'fallback.ts' } })).props.onClick!()
    expect(deps.openInEditor).toHaveBeenCalledWith('fallback.ts')

    const rows = elementOf(renders[1]({ file: { path: 'file-path.ts' } })).props.children as Element[]
    rows[1].props.onClick!()
    expect(deps.addPending).toHaveBeenCalledWith('file-path.ts')
  })

  it('(j) 取不到路径时返回 null 并记日志，不调任何 deps', () => {
    const logged: string[] = []
    const deps = depsOf({ logger: (message) => logged.push(message) })
    const { host, renders } = hostOf()
    installOfficialReview(host, deps)

    expect(renders[0]({})).toBeNull()
    expect(renders[1]({ path: '   ' })).toBeNull()
    expect(deps.openInEditor).not.toHaveBeenCalled()
    expect(deps.addPending).not.toHaveBeenCalled()
    expect(logged.filter((message) => message.includes('取不到文件路径'))).toHaveLength(2)
  })

  it('(k) 行注解条挂在待审块上，提示含侧与行号，点击打开该文件', () => {
    const deps = depsOf()
    const { host, renders } = hostOf()
    installOfficialReview(host, deps)

    const button = elementOf(renders[3]({
      path: 'src/c.ts',
      annotation: { key: 'vsm-pending:i1:0:11:11', place: { side: 'R', startLine: 11, endLine: 12 }, version: '3:R:11-12' },
    }))
    expect(button.props.children).toBe(deps.labels.annotation)
    expect(button.props.title).toContain('新侧 11–12')
    button.props.onClick!()
    expect(deps.openInEditor).toHaveBeenCalledWith('src/c.ts')
  })

  it('(l) 注解缺路径或缺注解对象时返回 null 并记日志', () => {
    const logged: string[] = []
    const deps = depsOf({ logger: (message) => logged.push(message) })
    const { host, renders } = hostOf()
    installOfficialReview(host, deps)

    expect(renders[3]({ path: 'src/c.ts' })).toBeNull()
    expect(renders[3]({ path: '', annotation: { place: { side: 'R', startLine: 1, endLine: 1 } } })).toBeNull()
    expect(logged.filter((message) => message.includes('注解 slot'))).toHaveLength(2)
  })

  it('(m) 评论按钮把选中文件加入待审列表', () => {
    const deps = depsOf()
    const { host, renders } = hostOf()
    installOfficialReview(host, deps)

    const button = elementOf(renders[2]({ selection: { path: 'src/d.ts', side: 'R', startLine: 3, endLine: 4 } }))
    button.props.onClick!()
    expect(deps.addPending).toHaveBeenCalledWith('src/d.ts')
    expect(renders[2]({ selection: {} })).toBeNull()
  })
})
