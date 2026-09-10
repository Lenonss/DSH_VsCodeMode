/**
 * client/commandRegistry.ts 纯逻辑测试（注册表生命周期 + 执行语义，不触 React/DOM）。
 * 覆盖：register/unregister（含身份校验）、缺字段抛错、未知 id 覆盖告警、list 排序、
 * available 过滤与判定异常降级、run 的可用性/未注册/异常三分支、subscribe 通知。
 * 作者 ddj 2026-09-10
 */
import { describe, expect, it, vi } from 'vitest'
import { createCommandRegistry } from '../src/client/commandRegistry.js'
import type { CommandDef } from '../src/client/ui/commandCatalog.js'

/** 造一条最小可用命令。 */
function cmd(id: string, extra: Partial<CommandDef> = {}): CommandDef {
  return { id, label: id, category: '测试', run: () => {}, ...extra }
}

describe('createCommandRegistry 注册生命周期', () => {
  it('register/get/has/list + 注销后移除', () => {
    const registry = createCommandRegistry()
    const command = cmd('t.a')
    const dispose = registry.register(command)
    expect(registry.has('t.a')).toBe(true)
    expect(registry.get('t.a')).toBe(command)
    expect(registry.list()).toEqual([command])
    dispose()
    expect(registry.has('t.a')).toBe(false)
    expect(registry.list()).toEqual([])
  })

  it('注销函数幂等且不误删后来者', () => {
    const registry = createCommandRegistry()
    const first = cmd('t.dup', { label: '一' })
    const second = cmd('t.dup', { label: '二' })
    const disposeFirst = registry.register(first)
    registry.register(second)
    disposeFirst()
    expect(registry.get('t.dup')).toBe(second) // 旧注销器不得删掉新定义
    disposeFirst()
    expect(registry.get('t.dup')).toBe(second)
  })

  it('缺 id/label/run 抛 TypeError', () => {
    const registry = createCommandRegistry()
    expect(() => registry.register({ id: '', label: 'x', category: 'c', run: () => {} })).toThrow(TypeError)
    expect(() => registry.register({ id: 't.x', label: '', category: 'c', run: () => {} })).toThrow(TypeError)
    expect(() => registry.register({ id: 't.x', label: 'x', category: 'c' } as never)).toThrow(TypeError)
  })

  it('list 按 order 升序（缺省 100）', () => {
    const registry = createCommandRegistry()
    registry.register(cmd('t.third', { order: 30 }))
    registry.register(cmd('t.first', { order: 1 }))
    registry.register(cmd('t.default'))
    expect(registry.list().map((item) => item.id)).toEqual(['t.first', 't.third', 't.default'])
  })

  it('subscribe 通知注册与注销，退订后不再通知', () => {
    const registry = createCommandRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    const dispose = registry.register(cmd('t.a'))
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    registry.register(cmd('t.b'))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('createCommandRegistry 可用性', () => {
  it('available 过滤不可用命令，判定异常按不可用降级', () => {
    const registry = createCommandRegistry()
    registry.register(cmd('t.on'))
    registry.register(cmd('t.off', { available: () => false }))
    registry.register(cmd('t.bad', { available: () => { throw new Error('判定炸了') } }))
    expect(registry.available().map((item) => item.id)).toEqual(['t.on'])
  })

  it('run 拒绝不可用命令（不调用运行体）', () => {
    const registry = createCommandRegistry()
    const run = vi.fn()
    registry.register(cmd('t.off', { run, available: () => false }))
    expect(registry.run('t.off')).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('createCommandRegistry.run', () => {
  it('执行已注册命令并回传 true', () => {
    const registry = createCommandRegistry()
    const run = vi.fn()
    registry.register(cmd('t.a', { run }))
    expect(registry.run('t.a')).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('未注册命令返回 false 且不抛出', () => {
    const registry = createCommandRegistry()
    expect(registry.run('t.missing')).toBe(false)
  })

  it('运行体抛异常被吞掉并返回 false', () => {
    const registry = createCommandRegistry()
    registry.register(cmd('t.boom', { run: () => { throw new Error('命令炸了') } }))
    expect(registry.run('t.boom')).toBe(false)
  })

  it('match 先过滤可用性再按查询筛选', () => {
    const registry = createCommandRegistry()
    registry.register(cmd('t.save', { label: '保存文件', category: '文件' }))
    registry.register(cmd('t.hidden', { label: '保存文件（隐藏）', category: '文件', available: () => false }))
    expect(registry.match('保存').map((item) => item.id)).toEqual(['t.save'])
    expect(registry.match('').map((item) => item.id)).toEqual(['t.save'])
  })
})
