/**
 * client explorerEntriesCache 测试：纯函数（序列化/解析/裁剪）+ 会话镜像读写
 * （window.localStorage mock，node 环境）。
 * 作者 ddj 2026-08-31
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_DIR_ENTRIES,
  CACHE_MAX_DIRS,
  entriesCacheGet,
  entriesCacheIsFresh,
  entriesCachePut,
  entriesParse,
  entriesSerialize,
  entriesTrim,
} from '../src/client/state/explorerEntriesCache.js'

/** 内存 localStorage mock。 */
const store = new Map<string, string>()
const localStorageMock = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
}

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).window = { localStorage: localStorageMock }
})

beforeEach(() => {
  store.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const entry = (name: string, type: 'file' | 'directory' = 'file') => ({ name, path: 'src/' + name, type })

describe('entriesTrim', () => {
  it('目录按 ts 逐出最旧、单目录条目截断', () => {
    const data = {
      v: 2 as const,
      root: null,
      dirs: {
        'old': { ts: 1, entries: [entry('a')] },
        'new': { ts: 3, entries: [entry('b')] },
      },
    }
    expect(Object.keys(entriesTrim(data, 1).dirs)).toEqual(['new'])
    const big = { v: 2 as const, root: null, dirs: { 'x': { ts: 1, entries: [1, 2, 3].map((n) => entry('f' + n)) } } }
    expect(entriesTrim(big, 2, 2).dirs['x'].entries).toHaveLength(2)
  })
})

describe('entriesSerialize/entriesParse', () => {
  it('往返一致', () => {
    const data = { v: 2 as const, root: 'D:/ws', dirs: { 'src': { ts: 123, entries: [entry('a.ts')] } } }
    expect(entriesParse(entriesSerialize(data))).toEqual(data)
  })
  it('损坏/版本不符 → null；非法条目跳过', () => {
    expect(entriesParse(null)).toBeNull()
    expect(entriesParse('nope')).toBeNull()
    expect(entriesParse('{"v":1,"dirs":{}}')).toBeNull()
    const text = JSON.stringify({ v: 2, root: null, dirs: { 'a': { ts: 1, entries: [{ name: 'ok', path: 'a/ok', type: 'file' }, { bad: true }] } } })
    expect(entriesParse(text)!.dirs['a'].entries).toEqual([{ name: 'ok', path: 'a/ok', type: 'file' }])
  })
})

describe('entriesCacheGet/Put/IsFresh', () => {
  it('put 后内存镜像立即可读；防抖落盘后跨镜像恢复', () => {
    const sid = 'session-x'
    expect(entriesCacheGet(sid, 'src')).toBeNull()
    entriesCachePut(sid, 'src', [entry('a.ts')])
    expect(entriesCacheGet(sid, 'src')).toEqual([entry('a.ts')])
    expect(entriesCacheIsFresh(sid, 'src')).toBe(true)

    // 防抖 300ms 后 localStorage 有数据（键含会话 id）
    vi.advanceTimersByTime(300)
    const raw = store.get('edrv.cache.entries.v2.' + sid)!
    expect(raw).toContain('a.ts')
  })

  it('新鲜度窗口过期后 IsFresh=false，Get 仍可读（SWR 展示不受限）', () => {
    const sid = 'session-y'
    entriesCachePut(sid, 'src', [entry('a.ts')])
    vi.advanceTimersByTime(31_000)
    expect(entriesCacheIsFresh(sid, 'src')).toBe(false)
    expect(entriesCacheGet(sid, 'src')).not.toBeNull()
  })

  it('无 sessionId 全部 no-op', () => {
    entriesCachePut(undefined, 'src', [entry('a.ts')])
    expect(entriesCacheGet(undefined, 'src')).toBeNull()
  })

  it('单目录条目缓存截断到上限', () => {
    const sid = 'session-z'
    const big = []
    for (let i = 0; i < CACHE_DIR_ENTRIES + 50; i++) big.push(entry('f' + i))
    entriesCachePut(sid, 'big', big)
    expect(entriesCacheGet(sid, 'big')).toHaveLength(CACHE_DIR_ENTRIES)
  })

  it('目录数超上限逐出最旧（新 put 挤掉旧）', () => {
    const sid = 'session-w'
    for (let i = 0; i < CACHE_MAX_DIRS + 5; i++) entriesCachePut(sid, 'd' + i, [entry('a')])
    // 逐出发生在每次 put 的 trim：最旧的 d0.. 应被挤出
    expect(entriesCacheGet(sid, 'd0')).toBeNull()
    expect(entriesCacheGet(sid, 'd' + (CACHE_MAX_DIRS + 4))).not.toBeNull()
  })
})
