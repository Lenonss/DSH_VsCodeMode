/**
 * 导航历史存档（client state/navStateCache.ts + navHistory.ts 快照接口）测试。
 * 纯函数为主；load/save 用内存版 localStorage 桩验证去重写与空存档删键。
 * 作者 ddj 2026-09-28
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNavHistory, cleanNavEntries, NAV_PERSIST_CAP, type NavState } from '../src/client/navHistory.js'
import {
  NAV_STATE_VERSION,
  navStateLoad,
  navStateSave,
  parseNavState,
  serializeNavState,
} from '../src/client/state/navStateCache.js'
import { CACHE_KEY } from '../src/client/paths.js'

describe('cleanNavEntries', () => {
  it('丢弃无路径项，剥掉 viewState，只保留正整数的行/列', () => {
    expect(cleanNavEntries([
      { path: '/a.ts', line: 3, column: 2, viewState: { big: true } },
      { path: '', line: 1 },
      null,
      { line: 5 },
      { path: '/b.ts', line: 0, column: -1 },
    ])).toEqual([
      { path: '/a.ts', line: 3, column: 2 },
      { path: '/b.ts' },
    ])
  })

  it('非数组 → 空表；超限保留末尾（最近）', () => {
    expect(cleanNavEntries('nope')).toEqual([])
    const many = Array.from({ length: NAV_PERSIST_CAP + 5 }, (_, i) => ({ path: '/f' + i + '.ts' }))
    const out = cleanNavEntries(many)
    expect(out).toHaveLength(NAV_PERSIST_CAP)
    expect(out[out.length - 1].path).toBe('/f' + (NAV_PERSIST_CAP + 4) + '.ts')
  })
})

describe('serializeNavState / parseNavState', () => {
  it('往返一致', () => {
    const state: NavState = { past: [{ path: '/a.ts', line: 1 }, { path: '/b.ts', line: 9, column: 4 }], future: [{ path: '/c.ts' }] }
    const text = serializeNavState(state)
    expect(JSON.parse(text).v).toBe(NAV_STATE_VERSION)
    expect(parseNavState(text)).toEqual(state)
  })

  it('空栈 → 空串且解析回 null', () => {
    expect(serializeNavState({ past: [], future: [] })).toBe('')
    expect(serializeNavState(null)).toBe('')
    expect(parseNavState('')).toBeNull()
  })

  it('损坏/版本不符/条目全非法 → null', () => {
    expect(parseNavState('not json')).toBeNull()
    expect(parseNavState(JSON.stringify({ v: 99, past: [{ path: '/a.ts' }] }))).toBeNull()
    expect(parseNavState(JSON.stringify({ v: NAV_STATE_VERSION, past: [{ nope: 1 }], future: [] }))).toBeNull()
  })

  it('序列化时也做归一化（坏条目不入档）', () => {
    const text = serializeNavState({ past: [{ path: '/a.ts', line: 2, viewState: { x: 1 } } as never, { path: '' }], future: [] })
    expect(parseNavState(text)).toEqual({ past: [{ path: '/a.ts', line: 2 }], future: [] })
  })
})

describe('createNavHistory 快照与恢复', () => {
  it('快照导出双栈，恢复后前进/后退行为一致', () => {
    const first = createNavHistory()
    first.record({ path: '/a.ts', line: 1 })
    first.record({ path: '/b.ts', line: 20 })
    const saved = first.snapshot()
    const second = createNavHistory()
    second.restore(saved)
    expect(second.canBack()).toBe(true)
    expect(second.canForward()).toBe(false)
    expect(second.back()?.path).toBe('/a.ts')
    expect(second.canForward()).toBe(true)
    expect(second.forward()?.path).toBe('/b.ts')
  })

  it('快照是浅拷贝：导出后继续记录不影响已导出内容', () => {
    const nav = createNavHistory()
    nav.record({ path: '/a.ts' })
    const saved = nav.snapshot()
    nav.record({ path: '/b.ts' })
    expect(saved.past).toHaveLength(1)
  })

  it('恢复时丢弃非法项并按实例容量截断', () => {
    const nav = createNavHistory(2)
    nav.restore({ past: [{ path: '/a.ts' }, { path: '' } as never, { path: '/b.ts' }, { path: '/c.ts' }], future: [] })
    expect(nav.snapshot().past.map((e) => e.path)).toEqual(['/b.ts', '/c.ts'])
    expect(nav.snapshot().future).toEqual([])
  })

  it('restore(null/undefined) 不动现有历史', () => {
    const nav = createNavHistory()
    nav.record({ path: '/a.ts' })
    nav.restore(null)
    nav.restore(undefined)
    expect(nav.snapshot().past.map((e) => e.path)).toEqual(['/a.ts'])
  })
})

describe('navStateLoad / navStateSave', () => {
  class MemoryStorage {
    private map = new Map<string, string>()
    getItem(key: string): string | null {
      return this.map.has(key) ? (this.map.get(key) as string) : null
    }
    setItem(key: string, value: string): void {
      this.map.set(key, value)
    }
    removeItem(key: string): void {
      this.map.delete(key)
    }
  }
  const holder = globalThis as { localStorage?: unknown }

  beforeAll(() => { holder.localStorage = new MemoryStorage() })
  afterAll(() => { delete holder.localStorage })

  it('存档往返 + 空存档删键', () => {
    const scope = 'ws:d:/x'
    navStateSave(scope, { past: [{ path: '/a.ts', line: 4 }], future: [] })
    expect(navStateLoad(scope)).toEqual({ past: [{ path: '/a.ts', line: 4 }], future: [] })
    navStateSave(scope, { past: [], future: [] })
    expect(holder.localStorage && (holder.localStorage as MemoryStorage).getItem(CACHE_KEY.navHistory + scope)).toBeNull()
    expect(navStateLoad(scope)).toBeNull()
  })

  it('无存档 → null', () => {
    expect(navStateLoad('ws:d:/missing')).toBeNull()
  })
})
