/** 会话作用域取值链单测（G1：跨 DSH 版本解析当前会话）。作者 ddj 2026年09月18号 */
import { describe, expect, it } from 'vitest'
import { listSessionId, pickSessionScope, readSessionScope, subscribeScope, uiSessionIdOf } from '../src/client/sessionScope.js'

/** 构造只有 uiSession 的 ctx（新版 DSH 形态）。 */
const uiCtx = (snapshot: unknown) => ({
  get: (name: string) => (name === 'uiSession' ? { current: { getSnapshot: () => snapshot, subscribe: () => () => {} } } : undefined),
})

/** 构造只有 sessions.list 的 ctx（旧版 DSH 形态）。 */
const listCtx = (snapshot: unknown) => ({
  get: (name: string) => (name === 'sessions' ? { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } } : undefined),
})

describe('uiSessionIdOf', () => {
  it('直接绑定形态取 key', () => {
    expect(uiSessionIdOf({ key: 's1' })).toBe('s1')
  })

  it('包裹形态取 value.key', () => {
    expect(uiSessionIdOf({ value: { key: 's2' } })).toBe('s2')
  })

  it('缺 key / 非对象 / 空串一律 undefined', () => {
    expect(uiSessionIdOf({ key: undefined })).toBeUndefined()
    expect(uiSessionIdOf({ key: '' })).toBeUndefined()
    expect(uiSessionIdOf(null)).toBeUndefined()
    expect(uiSessionIdOf('s1')).toBeUndefined()
    expect(uiSessionIdOf({ value: {} })).toBeUndefined()
  })
})

describe('listSessionId', () => {
  it('旧版 current 优先', () => {
    expect(listSessionId({ current: 'old', byId: { newer: { retainedBy: { mainView: 1 } } } })).toBe('old')
  })

  it('新版无 current 时取 retainedBy.mainView > 0 的首行', () => {
    const snap = { ids: ['a', 'b'], byId: { a: { retainedBy: {} }, b: { retainedBy: { mainView: 1 } } } }
    expect(listSessionId(snap)).toBe('b')
  })

  it('无 mainView 保留 / 非对象返回 undefined', () => {
    expect(listSessionId({ byId: { a: { retainedBy: { mainView: 0 } } } })).toBeUndefined()
    expect(listSessionId({})).toBeUndefined()
    expect(listSessionId(undefined)).toBeUndefined()
  })
})

describe('pickSessionScope（三级链）', () => {
  it('① uiSession 命中：优先于 list', () => {
    const out = pickSessionScope({
      uiSession: { key: 'ui-1' },
      list: { current: 'list-1', byId: { 'ui-1': { cwd: 'D:/w' } } },
    })
    expect(out).toEqual({ sessionId: 'ui-1', cwd: 'D:/w' })
  })

  it('② 仅 list.current 命中（旧版 DSH）', () => {
    const out = pickSessionScope({ list: { current: 'list-1', byId: { 'list-1': { cwd: 'D:/w' } } } })
    expect(out).toEqual({ sessionId: 'list-1', cwd: 'D:/w' })
  })

  it('③ 仅 retainedBy 命中（新版无 current 且 uiSession 缺失）', () => {
    const list = { byId: { x: { retainedBy: { mainView: 2 }, cwd: 'D:/x' } } }
    expect(pickSessionScope({ list })).toEqual({ sessionId: 'x', cwd: 'D:/x' })
  })

  it('④ 全缺失时回退槽位 sessionId', () => {
    expect(pickSessionScope({ fallbackSessionId: 'slot-1' })).toEqual({ sessionId: 'slot-1' })
  })

  it('全缺失且无回退 → 空对象（不写 undefined 占位）', () => {
    expect(pickSessionScope({})).toEqual({})
    expect(pickSessionScope({ uiSession: null, list: null, fallbackSessionId: null })).toEqual({})
  })

  it('cwd 不可读时只回 sessionId', () => {
    expect(pickSessionScope({ uiSession: { key: 's1' } })).toEqual({ sessionId: 's1' })
  })
})

describe('readSessionScope（服务面取值）', () => {
  it('从 ctx 取 uiSession', () => {
    expect(readSessionScope(uiCtx({ key: 'ui-9' }))).toEqual({ sessionId: 'ui-9' })
  })

  it('从 ctx 取 sessions.list（旧版）', () => {
    const ctx = listCtx({ current: 'legacy', byId: { legacy: { cwd: 'D:/l' } } })
    expect(readSessionScope(ctx)).toEqual({ sessionId: 'legacy', cwd: 'D:/l' })
  })

  it('服务缺失 / get 抛错 / getSnapshot 抛错 一律安全降级', () => {
    expect(readSessionScope({ get: () => undefined })).toEqual({})
    expect(readSessionScope({ get: () => { throw new Error('boom') } })).toEqual({})
    const bad = { get: () => ({ list: { getSnapshot: () => { throw new Error('boom') } } }) }
    expect(readSessionScope(bad)).toEqual({})
    const badUi = { get: () => ({ current: { getSnapshot: () => { throw new Error('boom') } } }) }
    expect(readSessionScope(badUi)).toEqual({})
  })

  it('槽位回退参与取值（slot 传 sessionId 时可用）', () => {
    expect(readSessionScope({ get: () => undefined }, 'slot-9')).toEqual({ sessionId: 'slot-9' })
  })
})

describe('subscribeScope', () => {
  it('同时订阅 uiSession 与 sessions.list，卸载时两处都解绑', () => {
    const released: string[] = []
    const ctx = {
      get: (name: string) => {
        if (name === 'uiSession') return { current: { subscribe: () => () => released.push('ui') } }
        if (name === 'sessions') return { list: { subscribe: () => () => released.push('list') } }
        return undefined
      },
    }
    const dispose = subscribeScope(ctx, () => {})
    dispose()
    expect(released.sort()).toEqual(['list', 'ui'])
  })

  it('重复调用 dispose 幂等（不重复解绑）', () => {
    let count = 0
    const ctx = { get: () => ({ list: { subscribe: () => () => { count += 1 } } }) }
    const dispose = subscribeScope(ctx, () => {})
    dispose()
    dispose()
    expect(count).toBe(1)
  })

  it('无任何可订阅源时不抛错', () => {
    expect(() => subscribeScope({ get: () => undefined }, () => {})()).not.toThrow()
  })

  it('某源 subscribe 抛错不影响另一源', () => {
    const released: string[] = []
    const ctx = {
      get: (name: string) => {
        if (name === 'uiSession') return { current: { subscribe: () => { throw new Error('boom') } } }
        if (name === 'sessions') return { list: { subscribe: () => () => released.push('list') } }
        return undefined
      },
    }
    const dispose = subscribeScope(ctx, () => {})
    dispose()
    expect(released).toEqual(['list'])
  })
})
