/** client 兼容层测试：设置桥优先序 / slot 安全注册 / openPath 链式补丁 / accessor 感知补丁。作者 ddj 2026年08月24号 */
import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_NAME, SIDEBAR_PLUGIN, patchAccessor, patchMethod, pickSettingsBinder, registerSlotSafely, settingsBridge } from '../src/client/compat.js'

describe('pickSettingsBinder', () => {
  const binderOf = (scope) => ({ bind: vi.fn(() => scope) })
  const ctxOf = (services) => ({ get: (name) => services[name] })
  /** 造 DSH 0.1.7 ConfigForm 替身（getSnapshot/subscribe/set 最小面）。 */
  const formOf = (overrides = {}) => ({
    getSnapshot: vi.fn(() => ({ status: 'ready', value: { fileOpenTool: 'auto' }, writable: true, revision: 3, mode: 'host' })),
    subscribe: vi.fn((listener) => { listener(); return () => {} }),
    set: vi.fn(async () => true),
    ...overrides,
  })

  it('webUiSettings 兼容桥优先于官方 settingsScope', () => {
    const webUi = binderOf({ getSnapshot: () => ({}) })
    const official = binderOf({ getSnapshot: () => ({}) })
    const out = pickSettingsBinder(ctxOf({ webUiSettings: webUi, settingsScope: official }))
    expect(out.service).toBe('webUiSettings')
    expect(out.scope).toBeDefined()
    expect(webUi.bind).toHaveBeenCalledWith({ namespace: PLUGIN_NAME })
    expect(official.bind).not.toHaveBeenCalled()
  })

  it('无兼容桥时回退官方 settingsScope', () => {
    const official = binderOf({ getSnapshot: () => ({}) })
    const out = pickSettingsBinder(ctxOf({ settingsScope: official }))
    expect(out.service).toBe('settingsScope')
  })

  it('两者皆无时安全返回 none', () => {
    const out = pickSettingsBinder(ctxOf({}))
    expect(out.service).toBe('none')
    expect(out.scope).toBeUndefined()
  })

  it('bind 抛错时降级到下一级', () => {
    const webUi = { bind: vi.fn(() => { throw new Error('bridge broken') }) }
    const official = binderOf({ getSnapshot: () => ({}) })
    const out = pickSettingsBinder(ctxOf({ webUiSettings: webUi, settingsScope: official }))
    expect(out.service).toBe('settingsScope')
  })

  it('configForms（0.1.7 官方新桥）优先命中，旧两级不被触碰', () => {
    const forms = { get: vi.fn(() => formOf()) }
    const webUi = binderOf({ getSnapshot: () => ({}) })
    const official = binderOf({ getSnapshot: () => ({}) })
    const out = pickSettingsBinder(ctxOf({ configForms: forms, webUiSettings: webUi, settingsScope: official }))
    expect(out.service).toBe('configForms')
    expect(out.scope).toBeDefined()
    expect(forms.get).toHaveBeenCalledWith(PLUGIN_NAME)
    expect(webUi.bind).not.toHaveBeenCalled()
    expect(official.bind).not.toHaveBeenCalled()
  })

  it('configForms 适配器透传 status/value/writable，subscribe 直通，set 丢弃 boolean', async () => {
    const form = formOf({ set: vi.fn(async () => false) })
    const out = pickSettingsBinder(ctxOf({ configForms: { get: () => form } }))
    const snap = out.scope.getSnapshot()
    expect(snap.status).toBe('ready')
    expect(snap.value).toEqual({ fileOpenTool: 'auto' })
    expect(snap.writable).toBe(true)
    let notified = 0
    const off = out.scope.subscribe(() => { notified += 1 })
    expect(notified).toBe(1)
    off()
    // set 返回 false（未生效）也不 reject：boolean 被丢弃，错误通道保持 form.set 自身 reject 的既有语义
    await expect(out.scope.set('fileOpenTool', 'vscode')).resolves.toBeUndefined()
    expect(form.set).toHaveBeenCalledWith('fileOpenTool', 'vscode')
  })

  it('configForms 服务缺失（0.1.6）时落回原两级，行为不变', () => {
    const official = binderOf({ getSnapshot: () => ({}) })
    const out = pickSettingsBinder(ctxOf({ configForms: undefined, settingsScope: official }))
    expect(out.service).toBe('settingsScope')
    expect(official.bind).toHaveBeenCalledWith({ namespace: PLUGIN_NAME })
  })

  it('ctx.get 探测 configForms 抛错时降级到下一级', () => {
    const webUi = binderOf({ getSnapshot: () => ({}) })
    const services = { webUiSettings: webUi }
    const ctx = { get: (name) => { if (name === 'configForms') throw new Error('no such service'); return services[name] } }
    const out = pickSettingsBinder(ctx)
    expect(out.service).toBe('webUiSettings')
  })

  it('configForms.get 抛错或形状不符时降级到下一级', () => {
    const official = binderOf({ getSnapshot: () => ({}) })
    const thrown = pickSettingsBinder(ctxOf({ configForms: { get: () => { throw new Error('boom') } }, settingsScope: official }))
    expect(thrown.service).toBe('settingsScope')
    const malformed = pickSettingsBinder(ctxOf({ configForms: { get: () => ({}) }, settingsScope: official }))
    expect(malformed.service).toBe('settingsScope')
  })

  it('form.set 自身 reject 仍向调用方传导', async () => {
    const form = formOf({ set: vi.fn(async () => { throw new Error('write refused') }) })
    const out = pickSettingsBinder(ctxOf({ configForms: { get: () => form } }))
    await expect(out.scope.set('keybindings', {})).rejects.toThrow('write refused')
  })
})

describe('settingsBridge 晚到有界重试', () => {
  const binderOf = (scope) => ({ bind: vi.fn(() => scope) })
  /** 收集假调度器的待执行任务（测试手动驱动节拍）。 */
  function fakeSchedule() {
    const queue: Array<() => void> = []
    return { queue, schedule: (fn: () => void, _ms: number) => { queue.push(fn) } }
  }

  it('构造即命中：whenReady 立即回调，不排队重试', () => {
    const scope = { getSnapshot: () => ({}), subscribe: () => () => {}, set: async () => {} }
    const { queue, schedule } = fakeSchedule()
    const bridge = settingsBridge({ get: (name) => (name === 'settingsScope' ? binderOf(scope) : undefined) }, { schedule, attempts: 15 })
    expect(bridge.scope()).toBe(scope)
    expect(bridge.service()).toBe('settingsScope')
    const ready = vi.fn()
    bridge.whenReady(ready)
    expect(ready).toHaveBeenCalledTimes(1)
    expect(queue).toHaveLength(0)
  })

  it('晚到：重试节拍内命中后通知 whenReady 且 scope 可取', () => {
    let late: unknown
    const scope = { getSnapshot: () => ({}), subscribe: () => () => {}, set: async () => {} }
    const { queue, schedule } = fakeSchedule()
    const ctx = { get: (name) => (name === 'settingsScope' ? binderOf(late) : undefined) }
    const bridge = settingsBridge(ctx, { schedule, attempts: 15, intervalMs: 1 })
    expect(bridge.scope(), '构造时未就绪').toBeUndefined()
    const ready = vi.fn()
    bridge.whenReady(ready)
    expect(ready).not.toHaveBeenCalled()
    // 第 2 拍服务到位
    late = scope
    while (queue.length && !bridge.scope()) queue.shift()!()
    expect(bridge.scope()).toBe(scope)
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('重试用尽保持未就绪：不再排队、不通知（与旧行为一致，不无限轮询）', () => {
    const { queue, schedule } = fakeSchedule()
    const bridge = settingsBridge({ get: () => undefined }, { schedule, attempts: 2 })
    while (queue.length) queue.shift()!()
    expect(queue).toHaveLength(0)
    expect(bridge.scope()).toBeUndefined()
    const ready = vi.fn()
    const off = bridge.whenReady(ready)
    expect(ready).not.toHaveBeenCalled()
    off()
  })

  it('未提供 schedule 时不重试（等价旧行为）', () => {
    const bridge = settingsBridge({ get: () => undefined }, { attempts: 15 })
    expect(bridge.scope()).toBeUndefined()
    expect(bridge.service()).toBe('none')
  })
})

describe('registerSlotSafely', () => {
  it('经 slots.inject 等待声明注册', () => {
    const register = vi.fn(() => 'disposer')
    const inject = vi.fn()
    const ctx = { slots: { inject, register } }
    const spec = { name: 'conversation.view', id: 'edrv-editor', order: 5 }
    const render = vi.fn()
    registerSlotSafely(ctx, spec, render)
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0][0]).toBe('conversation.view')
    inject.mock.calls[0][1]()
    expect(register).toHaveBeenCalledWith(spec, render)
  })

  it('slots 服务缺失时降级不抛错', () => {
    expect(() => registerSlotSafely({}, { name: 'x', id: 'y' }, vi.fn())).not.toThrow()
  })

  it('inject 抛错时降级不抛错', () => {
    const ctx = { slots: { inject: vi.fn(() => { throw new Error('boom') }), register: vi.fn() } }
    expect(() => registerSlotSafely(ctx, { name: 'x', id: 'y' }, vi.fn())).not.toThrow()
  })

  it('保持服务方法 receiver（真实 slots 是依赖 this 的类方法，解构会静默失败）', () => {
    const calls = []
    const service = {
      calls,
      inject(name, cb) { this.calls.push('inject:' + name); return cb() },
      register(spec, render) { this.calls.push('register:' + spec.id); return () => {} },
    }
    const ctx = { slots: service }
    registerSlotSafely(ctx, { name: 'conversation.view', id: 'edrv-editor' }, vi.fn())
    expect(calls).toEqual(['inject:conversation.view', 'register:edrv-editor'])
  })
})

describe('patchMethod', () => {
  it('链式补丁按栈序恢复', () => {
    const owner = { open: (path) => 'orig:' + path }
    const calls = []
    const disposeA = patchMethod(owner, 'open', (original, path) => {
      calls.push('a')
      return original(path)
    })
    expect(owner.open('x')).toBe('orig:x')
    expect(calls).toEqual(['a'])
    const disposeB = patchMethod(owner, 'open', (original, path) => {
      calls.push('b')
      return original(path)
    })
    expect(owner.open('x')).toBe('orig:x')
    expect(calls).toEqual(['a', 'b', 'a'])
    disposeB()
    expect(owner.open('y')).toBe('orig:y')
    expect(calls).toEqual(['a', 'b', 'a', 'a'])
    disposeA()
    expect(owner.open('z')).toBe('orig:z')
    expect(calls).toEqual(['a', 'b', 'a', 'a'])
  })

  it('他人已替换实现时不还原（归属校验）', () => {
    const owner = { open: (path) => 'orig' }
    const disposeA = patchMethod(owner, 'open', (original, path) => 'a:' + String(original(path)))
    owner.open = (path) => 'external'
    disposeA()
    expect(owner.open('x')).toBe('external')
  })

  it('dispose 幂等', () => {
    const owner = { open: (path) => 'orig' }
    const dispose = patchMethod(owner, 'open', (original, path) => 'patched')
    dispose()
    dispose()
    expect(owner.open('x')).toBe('orig')
  })
})

describe('patchAccessor', () => {
  /** 复刻 DSH remote 命名空间方法形态：getter-only accessor，每次访问返回一次性函数。 */
  const makeAccessorOwner = () => {
    const owner = {}
    Object.defineProperty(owner, 'open', {
      configurable: true,
      enumerable: true,
      get: () => (path) => 'orig:' + path,
    })
    return owner
  }

  it('getter-only accessor 经描述符替换拦截，dispose 恢复原描述符', () => {
    const owner = makeAccessorOwner()
    const originalDescriptor = Object.getOwnPropertyDescriptor(owner, 'open')
    const calls = []
    const dispose = patchAccessor(owner, 'open', (original, path) => {
      calls.push('patched')
      return 'wrap(' + original(path) + ')'
    })
    expect(owner.open('x')).toBe('wrap(orig:x)')
    expect(calls).toEqual(['patched'])
    dispose()
    const restored = Object.getOwnPropertyDescriptor(owner, 'open')
    expect(restored.get).toBe(originalDescriptor.get)
    expect(owner.open('y')).toBe('orig:y')
  })

  it('original 实时取自原 getter（跟随内部实现变化）', () => {
    let impl = (path) => 'v1:' + path
    const owner = {}
    Object.defineProperty(owner, 'open', { configurable: true, get: () => impl })
    patchAccessor(owner, 'open', (original, path) => original(path))
    expect(owner.open('x')).toBe('v1:x')
    impl = (path) => 'v2:' + path
    expect(owner.open('y')).toBe('v2:y')
  })

  it('他人已替换 getter 时不还原（归属校验）', () => {
    const owner = makeAccessorOwner()
    const dispose = patchAccessor(owner, 'open', (original, path) => original(path))
    Object.defineProperty(owner, 'open', { configurable: true, get: () => () => 'external' })
    dispose()
    expect(owner.open('x')).toBe('external')
  })

  it('dispose 幂等', () => {
    const owner = makeAccessorOwner()
    const dispose = patchAccessor(owner, 'open', (original, path) => original(path))
    dispose()
    dispose()
    expect(owner.open('x')).toBe('orig:x')
  })

  it('data 属性降级 patchMethod 语义', () => {
    const owner = { open: (path) => 'orig:' + path }
    const dispose = patchAccessor(owner, 'open', (original, path) => 'wrap(' + original(path) + ')')
    expect(owner.open('x')).toBe('wrap(orig:x)')
    dispose()
    expect(owner.open('y')).toBe('orig:y')
  })

  it('属性缺失返回 null', () => {
    expect(patchAccessor({}, 'open', () => {})).toBeNull()
  })
})

describe('external plugin constants', () => {
  it('侧栏插件名与包身份稳定', () => {
    expect(SIDEBAR_PLUGIN).toBe('dsh-better-sidebar')
    expect(PLUGIN_NAME).toBe('dsh-vscode-mode')
  })
})
