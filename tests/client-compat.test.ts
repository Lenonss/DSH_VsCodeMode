/** client 兼容层测试：设置桥优先序 / slot 安全注册 / openPath 链式补丁。作者 ddj 2026年08月24号 */
import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_NAME, SIDEBAR_PLUGIN, patchMethod, pickSettingsBinder, registerSlotSafely } from '../src/client/compat.js'

describe('pickSettingsBinder', () => {
  const binderOf = (scope) => ({ bind: vi.fn(() => scope) })
  const ctxOf = (services) => ({ get: (name) => services[name] })

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

describe('external plugin constants', () => {
  it('侧栏插件名与包身份稳定', () => {
    expect(SIDEBAR_PLUGIN).toBe('dsh-better-sidebar')
    expect(PLUGIN_NAME).toBe('dsh-vscode-mode')
  })
})
