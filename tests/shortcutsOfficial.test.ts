/**
 * tests — 官方 shortcuts 桥接层纯逻辑（探测/安全注册/命令构建/旧设置迁移）。
 * 服务与 scope 全部鸭子类型 mock，不依赖浏览器与官方包。
 * 作者 ddj 2026年10月
 */
import { describe, expect, it, vi } from 'vitest'
import {
  awaitShortcutsService,
  installLegacyKeys,
  migrateLegacyKeybindings,
  officialCommandOf,
  registerOfficialShortcuts,
  resetPluginKeys,
  safeRegister,
  type LegacySettingsScope,
  type ShortcutCatalogRow,
  type ShortcutsServiceLike,
} from '../src/client/shortcutsOfficial.js'
import { SHORTCUT_PROFILES } from '../src/shared/keybindings.js'

/** 构造鸭子类型官方服务 mock。 */
function mockService(overrides: Partial<ShortcutsServiceLike> = {}): ShortcutsServiceLike {
  const service = {
    register: vi.fn(() => () => {}),
    describeBinding: vi.fn(() => ({ binding: null, keys: [], issue: null, conflicts: [] })),
    edit: vi.fn(async () => ({ status: 'saved' })),
    recording: vi.fn(async () => {}),
    catalog: { getSnapshot: () => [] as ShortcutCatalogRow[], subscribe: () => () => {} },
    config: {
      getSnapshot: () => ({ revision: 'r1', sequence: 1, status: 'ready' as const, error: null, usingDefaults: true }),
      subscribe: () => () => {},
    },
    fixedCatalog: { getSnapshot: () => [], subscribe: () => () => {} },
    platform: 'windows',
    runtime: 'desktop',
    ...overrides,
  }
  return service as unknown as ShortcutsServiceLike
}

/** 构造旧设置 scope mock（记录 set 调用）。 */
function mockScope(value: unknown, status = 'ready'): { scope: LegacySettingsScope; setCalls: Array<[string, unknown]> } {
  const setCalls: Array<[string, unknown]> = []
  return {
    scope: {
      getSnapshot: () => ({ status, value: value as Record<string, unknown> }),
      set: async (key: string, val: unknown) => {
        setCalls.push([key, val])
      },
    },
    setCalls,
  }
}

describe('awaitShortcutsService 探测', () => {
  it('立即命中', () => {
    const service = mockService()
    let ready: ShortcutsServiceLike | null = null
    awaitShortcutsService({ get: () => service }, { schedule: () => {}, attempts: 3, onReady: (s) => { ready = s } })
    expect(ready).toBe(service)
  })

  it('未命中按节奏重试，命中即回调', () => {
    let calls = 0
    const ctx = {
      get: () => {
        calls += 1
        return calls >= 3 ? mockService() : undefined
      },
    }
    const scheduled: Array<() => void> = []
    let ready: ShortcutsServiceLike | null = null
    const cancel = awaitShortcutsService(ctx, {
      schedule: (fn) => { scheduled.push(fn) },
      attempts: 5,
      onReady: (s) => { ready = s },
    })
    expect(ready).toBeNull()
    expect(scheduled.length).toBe(1)
    scheduled[0]()
    expect(ready).toBeNull()
    expect(scheduled.length).toBe(2)
    scheduled[1]()
    expect(ready).not.toBeNull()
    cancel()
  })

  it('重试用尽回调 null', () => {
    const scheduled: Array<() => void> = []
    let ready: ShortcutsServiceLike | undefined | null = undefined
    awaitShortcutsService({ get: () => undefined }, {
      schedule: (fn) => { scheduled.push(fn) },
      attempts: 2,
      onReady: (s) => { ready = s },
    })
    scheduled[0]()
    scheduled[1]()
    expect(ready).toBeNull()
    expect(scheduled.length).toBe(2)
  })
})

describe('installLegacyKeys 旧版 DSH 键位回退', () => {
  it('命中可用命令才吞键、执行，并在注销后不再监听', () => {
    let listener: EventListener | undefined
    const target = {
      addEventListener: vi.fn((_name: string, callback: EventListener) => { listener = callback }),
      removeEventListener: vi.fn(),
    }
    const runner = { isAvailable: vi.fn(() => false), run: vi.fn(() => true) }
    const chords = () => ({ 'edrv.save': 'Ctrl+S' })
    const dispose = installLegacyKeys([{ id: 'edrv.save' }], runner, chords, target)
    const event = { key: 's', ctrlKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    listener!(event as unknown as Event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    runner.isAvailable.mockReturnValue(true)
    listener!(event as unknown as Event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(runner.run).toHaveBeenCalledWith('edrv.save')
    dispose()
    expect(target.removeEventListener).toHaveBeenCalledWith('keydown', listener, true)
  })
})

describe('safeRegister 冲突降级', () => {
  it('注册成功原样透传', () => {
    const service = mockService()
    const disposer = safeRegister(service, { id: 'edrv.save', label: () => '保存文件', defaults: SHORTCUT_PROFILES['edrv.save'], regions: ['page'], modals: [], resolve: () => ({ status: 'pass' }) })
    expect(service.register).toHaveBeenCalledTimes(1)
    expect(typeof disposer).toBe('function')
  })

  it('默认键位被拒时去掉 defaults 重试一次', () => {
    const register = vi.fn()
      .mockImplementationOnce(() => { throw new Error('Conflicting shortcut defaults: a and b (desktop:windows)') })
      .mockImplementationOnce(() => () => {})
    const service = mockService({ register: register as unknown as ShortcutsServiceLike['register'] })
    const command = { id: 'edrv.save', label: () => '保存文件', defaults: SHORTCUT_PROFILES['edrv.save'], regions: ['page'], modals: [], resolve: () => ({ status: 'pass' }) }
    safeRegister(service, command)
    expect(register).toHaveBeenCalledTimes(2)
    expect(register.mock.calls[1][0].defaults).toEqual({})
  })

  it('无默认键位注册失败仅告警，不抛错', () => {
    const register = vi.fn(() => { throw new Error('Duplicate shortcut command: x') })
    const service = mockService({ register: register as unknown as ShortcutsServiceLike['register'] })
    expect(() => safeRegister(service, { id: 'x', label: () => 'x', regions: ['page'], modals: [], resolve: () => ({ status: 'pass' }) })).not.toThrow()
  })
})

describe('officialCommandOf / registerOfficialShortcuts', () => {
  it('可用时 resolve handled 并执行注册表 run；不可用返回 pass', () => {
    const runner = { isAvailable: vi.fn(() => true), run: vi.fn(() => true) }
    const command = officialCommandOf({ id: 'edrv.save', label: '保存文件' }, runner)
    expect(command.id).toBe('edrv.save')
    // 回归：aliases 必须为数组——官方弹窗 `...row.aliases` 展开遇到 undefined 会崩
    expect(command.aliases).toEqual([])
    const handled = command.resolve({ region: 'page', modal: null })
    expect(handled.status).toBe('handled')
    if (handled.status === 'handled') handled.run()
    expect(runner.run).toHaveBeenCalledWith('edrv.save')
    const blocked = officialCommandOf({ id: 'edrv.save', label: '保存文件' }, { isAvailable: () => false, run: () => false })
    expect(blocked.resolve({ region: 'page', modal: null }).status).toBe('pass')
  })

  it('批量注册注入 SHORTCUT_PROFILES 且聚合注销', () => {
    const service = mockService()
    const runner = { isAvailable: () => true, run: () => true }
    const defs = [{ id: 'edrv.save', label: '保存文件' }, { id: 'edrv.toggleSidebar', label: '切换侧边栏' }]
    const dispose = registerOfficialShortcuts(service, defs, runner, SHORTCUT_PROFILES)
    const first = (service.register as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(first.defaults).toEqual(SHORTCUT_PROFILES['edrv.save'])
    const second = (service.register as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(second.defaults).toEqual({})
    dispose()
    expect((service.register as ReturnType<typeof vi.fn>).mock.results[0].value).toBeTypeOf('function')
  })
})

describe('resetPluginKeys 仅插件命令', () => {
  /**
   * 构造用于恢复默认测试的官方目录行。
   * @author ddj 2026年09月28号
   * @param id 命令 id
   * @param modified 是否已自定义
   * @returns 官方目录行
   */
  const row = (id: string, modified: boolean): ShortcutCatalogRow => ({
    id, modified, label: id, binding: null, issue: null, conflicts: [], keys: [],
  })

  it('只恢复已修改的 edrv 命令，不调用全局 reset-all', async () => {
    const edit = vi.fn(async () => ({ status: 'saved' }))
    const service = mockService({
      edit,
      catalog: {
        getSnapshot: () => [row('sidebar.left.toggle', true), row('edrv.save', true), row('edrv.quickOpen', false), row('edrv.showCommands', true)],
        subscribe: () => () => {},
      },
    })
    expect(await resetPluginKeys(service)).toEqual({ reset: 2 })
    expect(edit.mock.calls.map(([operation]) => operation)).toEqual([
      { type: 'reset', id: 'edrv.save' }, { type: 'reset', id: 'edrv.showCommands' },
    ])
  })

  it('写入失败立即停止并报告进度', async () => {
    const edit = vi.fn().mockResolvedValueOnce({ status: 'saved' }).mockResolvedValueOnce({ status: 'not-ready' })
    const service = mockService({
      edit,
      catalog: {
        getSnapshot: () => [row('edrv.save', true), row('edrv.quickOpen', true), row('edrv.showCommands', true)],
        subscribe: () => () => {},
      },
    })
    expect(await resetPluginKeys(service)).toEqual({ reset: 1, failed: 'edrv.quickOpen' })
    expect(edit).toHaveBeenCalledTimes(2)
  })
})

describe('migrateLegacyKeybindings 旧设置迁移', () => {
  const DEFAULTS_ID = 'edrv.save'

  it('无差异 → done 且不写官方存储', async () => {
    const service = mockService()
    const { scope, setCalls } = mockScope({ keybindings: { [DEFAULTS_ID]: 'Ctrl+S' } })
    const result = await migrateLegacyKeybindings(service, scope)
    expect(result.done).toBe(true)
    expect(service.edit).not.toHaveBeenCalled()
    expect(setCalls.length).toBe(0)
  })

  it('scope 或官方配置未就绪 → done:false', async () => {
    const service = mockService()
    const { scope } = mockScope({ keybindings: { [DEFAULTS_ID]: 'Ctrl+Alt+S' } }, 'loading')
    expect((await migrateLegacyKeybindings(service, scope)).done).toBe(false)
    const loadingConfig = mockService({
      config: { getSnapshot: () => ({ revision: 'r1', sequence: 0, status: 'loading' as const, error: null, usingDefaults: true }), subscribe: () => () => {} },
    })
    const ready = mockScope({ keybindings: { [DEFAULTS_ID]: 'Ctrl+Alt+S' } })
    expect((await migrateLegacyKeybindings(loadingConfig, ready.scope)).done).toBe(false)
  })

  it('单候选自定义键位导入当前平台，旧字段仍原样保留', async () => {
    const service = mockService()
    const original = { [DEFAULTS_ID]: 'Ctrl+Alt+S', 'edrv.quickOpen': 'Ctrl+P' }
    const { scope, setCalls } = mockScope({ keybindings: original })
    const result = await migrateLegacyKeybindings(service, scope)
    expect(result).toEqual({ imported: 1, skipped: 0, done: true })
    expect(service.edit).toHaveBeenCalledWith({ type: 'set', id: DEFAULTS_ID, binding: { code: 'KeyS', modifiers: ['primary', 'alt'] } }, 'r1')
    expect(setCalls).toHaveLength(0)
    expect(scope.getSnapshot().value?.keybindings).toEqual(original)
  })

  it('冲突旧值跳过不阻断，官方不可表示弦跳过', async () => {
    const service = mockService({
      describeBinding: vi.fn(() => ({ binding: null, keys: [], issue: null, conflicts: ['sidebar.left.toggle'] })),
    })
    // 旧覆盖须与默认值有差异才进迁移：Ctrl+B 对 quickOpen（默认 Ctrl+P）是真实覆盖，且与官方 Mod+B 冲突
    const { scope, setCalls } = mockScope({ keybindings: { 'edrv.quickOpen': 'Ctrl+B', 'edrv.save': 'Ctrl+PageDown' } })
    const result = await migrateLegacyKeybindings(service, scope)
    expect(result).toEqual({ imported: 0, skipped: 2, done: true })
    expect(service.edit).not.toHaveBeenCalled()
    expect(setCalls.length).toBe(0)
  })

  it('导入单候选但完整保留冲突与空键位的旧设置', async () => {
    const service = mockService({
      describeBinding: vi.fn((binding) => ({ binding, keys: [], issue: null,
        conflicts: binding.code === 'KeyB' ? ['sidebar.left.toggle'] : [] })),
    })
    const original = { 'edrv.save': 'Ctrl+Alt+S', 'edrv.quickOpen': 'Ctrl+B', 'edrv.searchInFiles': '' }
    const { scope, setCalls } = mockScope({ keybindings: original })
    expect(await migrateLegacyKeybindings(service, scope)).toEqual({ imported: 1, skipped: 2, done: true })
    expect(setCalls).toHaveLength(0)
    expect(scope.getSnapshot().value?.keybindings).toEqual(original)
  })

  it('官方已有自定义值时不以旧配置覆盖', async () => {
    const service = mockService({
      catalog: { getSnapshot: () => [{ id: 'edrv.save', modified: true } as ShortcutCatalogRow], subscribe: () => () => {} },
    })
    const { scope, setCalls } = mockScope({ keybindings: { 'edrv.save': 'Ctrl+Alt+S' } })
    expect(await migrateLegacyKeybindings(service, scope)).toEqual({ imported: 0, skipped: 1, done: true })
    expect(service.edit).not.toHaveBeenCalled()
    expect(setCalls).toHaveLength(0)
    expect(scope.getSnapshot().value?.keybindings).toEqual({ 'edrv.save': 'Ctrl+Alt+S' })
  })

  it('官方写入失败中止并保留旧值（下次重试）', async () => {
    const service = mockService({
      edit: vi.fn(async () => ({ status: 'not-ready' })),
    })
    const { scope, setCalls } = mockScope({ keybindings: { [DEFAULTS_ID]: 'Ctrl+Alt+S' } })
    const result = await migrateLegacyKeybindings(service, scope)
    expect(result).toEqual({ imported: 0, skipped: 0, done: false })
    expect(setCalls.length).toBe(0)
  })

  it('官方存储写入抛错时不中断会话，旧配置保留重试', async () => {
    const service = mockService({ edit: vi.fn(async () => { throw new Error('storage unavailable') }) })
    const { scope, setCalls } = mockScope({ keybindings: { [DEFAULTS_ID]: 'Ctrl+Alt+S' } })
    expect(await migrateLegacyKeybindings(service, scope)).toEqual({ imported: 0, skipped: 0, done: false })
    expect(setCalls).toHaveLength(0)
  })

  it('多候选旧键位不做部分迁移，完整原值保留', async () => {
    const service = mockService()
    const original = { [DEFAULTS_ID]: 'Ctrl+Alt+S|Ctrl+Shift+S' }
    const { scope, setCalls } = mockScope({ keybindings: original })
    expect(await migrateLegacyKeybindings(service, scope)).toEqual({ imported: 0, skipped: 1, done: true })
    expect(service.edit).not.toHaveBeenCalled()
    expect(setCalls).toHaveLength(0)
    expect(scope.getSnapshot().value?.keybindings).toEqual(original)
  })

  it('迁移标记隔离 runtime/platform，同平台重启不重新覆盖', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    try {
      const desktop = mockService()
      const web = mockService({ runtime: 'web' })
      const { scope } = mockScope({ keybindings: { [DEFAULTS_ID]: 'Ctrl+Alt+S' } })
      expect((await migrateLegacyKeybindings(desktop, scope)).imported).toBe(1)
      expect((await migrateLegacyKeybindings(desktop, scope)).imported).toBe(0)
      expect(desktop.edit).toHaveBeenCalledTimes(1)
      expect((await migrateLegacyKeybindings(web, scope)).imported).toBe(1)
      expect(values.size).toBe(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('stale 冲突仅尝试一次且旧配置不变', async () => {
    let revision = 'r1'
    const service = mockService({
      edit: vi.fn(async () => {
        revision = 'r2'
        return { status: 'stale' }
      }),
      config: {
        getSnapshot: () => ({ revision, sequence: 1, status: 'ready' as const, error: null, usingDefaults: true }),
        subscribe: () => () => {},
      },
    })
    const { scope, setCalls } = mockScope({ keybindings: { [DEFAULTS_ID]: 'Ctrl+Alt+S' } })
    expect(await migrateLegacyKeybindings(service, scope)).toEqual({ imported: 0, skipped: 0, done: false })
    expect(service.edit).toHaveBeenCalledTimes(1)
    expect(setCalls).toHaveLength(0)
  })
})
