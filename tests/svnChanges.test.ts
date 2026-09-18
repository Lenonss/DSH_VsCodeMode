/**
 * P2 client 变更状态层（svnStatus.ts）测试。
 * 覆盖：ensureSvnChanges 在途去重 / scope 缓存 / force 重取 / 事件广播 / 截断标记 /
 * svnChangeMapOf 查表 / svnVisibleChanges 与 scope 隔离。
 * 手法：stub global.fetch（client rpc 的唯一出口）与 window（事件断言），镜像既有 client 测试风格。
 * 作者 ddj 2026-09-16
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureSvnChanges,
  getSvnChanges,
  clearSvnChanges,
  svnChangeMapOf,
  svnChangesCapped,
} from '../src/client/svnStatus.js'
import type { SvnChangeEntry } from '../src/shared/svn.js'

/** 一条变更条目（缺省 modified + 受版本控制）。 */
const entry = (path: string, over: Partial<SvnChangeEntry> = {}): SvnChangeEntry => ({
  path, status: 'modified', versioned: true, ...over,
})

/** window 桩：只需 dispatchEvent 可断言（emit 里对 CustomEvent 无其他依赖）。 */
function makeWindow() {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const dispatched: Record<string, number> = {}
  return {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      const bucket = listeners.get(type) ?? new Set()
      bucket.add(fn)
      listeners.set(type, bucket)
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent: (event: { type: string }) => {
      dispatched[event.type] = (dispatched[event.type] ?? 0) + 1
      for (const fn of listeners.get(event.type) ?? []) fn(event)
      return true
    },
    /** 某事件被派发的次数。 */
    countOf: (type: string) => dispatched[type] ?? 0,
  }
}

/** 安装 fetch 桩：返回排队的响应体（按调用顺序），并记录请求体。 */
function stubFetch(bodies: unknown[]) {
  const calls: string[] = []
  let at = 0
  const fetchMock = vi.fn((_url: string, init: { body: string }) => {
    calls.push(String(init?.body ?? ''))
    const body = bodies[Math.min(at, bodies.length - 1)]
    at += 1
    return Promise.resolve({ json: () => Promise.resolve(body) })
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock
  return { calls, fetchMock, getCount: () => at }
}

/** 等一轮微任务（RPC then 链落定）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ensureSvnChanges', () => {
  let win: ReturnType<typeof makeWindow>

  beforeEach(() => {
    clearSvnChanges()
    win = makeWindow()
    ;(globalThis as unknown as { window: unknown }).window = win
  })

  it('成功后写缓存、广播 edrv:svn-changes 并透出条目', async () => {
    const entries = [entry('a.ts')]
    stubFetch([{ ok: true, wcRoot: '/wc', entries, truncated: false }])
    ensureSvnChanges('s1', 'ws:/wc')
    await flush()
    expect(getSvnChanges('ws:/wc')).toEqual(entries)
    expect(win.countOf('edrv:svn-changes')).toBe(1)
    expect(svnChangesCapped('ws:/wc')).toBe(false)
  })

  it('在途去重：同一 scope 并发调用只发一次请求', async () => {
    const fetchState = stubFetch([{ ok: true, wcRoot: '/wc', entries: [], truncated: false }])
    ensureSvnChanges('s1', 'ws:/wc')
    ensureSvnChanges('s1', 'ws:/wc')
    await flush()
    expect(fetchState.getCount()).toBe(1)
  })

  it('已缓存时不再重复拉取（非 force）', async () => {
    const fetchState = stubFetch([{ ok: true, wcRoot: '/wc', entries: [entry('a.ts')], truncated: false }])
    ensureSvnChanges('s1', 'ws:/wc')
    await flush()
    ensureSvnChanges('s1', 'ws:/wc')
    await flush()
    expect(fetchState.getCount()).toBe(1)
  })

  it('force 绕过缓存：重新请求并更新载荷（含 truncated 标记）', async () => {
    const fetchState = stubFetch([
      { ok: true, wcRoot: '/wc', entries: [entry('a.ts')], truncated: false },
      { ok: true, wcRoot: '/wc', entries: [entry('b.ts')], truncated: true },
    ])
    ensureSvnChanges('s1', 'ws:/wc')
    await flush()
    ensureSvnChanges('s1', 'ws:/wc', true)
    await flush()
    expect(fetchState.getCount()).toBe(2)
    expect(getSvnChanges('ws:/wc')?.map((item) => item.path)).toEqual(['b.ts'])
    expect(svnChangesCapped('ws:/wc')).toBe(true)
  })

  it('失败（ok:false）不写缓存：保持「未加载」语义而非「无变更」', async () => {
    stubFetch([{ ok: false, error: '不受 SVN 管理' }])
    ensureSvnChanges('s1', 'ws:/wc')
    await flush()
    expect(getSvnChanges('ws:/wc')).toBeNull()
    expect(win.countOf('edrv:svn-changes')).toBe(0)
  })

  it('异常（fetch 抛错）不写缓存且不抛到调用方', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() => Promise.reject(new Error('network')))
    ensureSvnChanges('s1', 'ws:/wc')
    await flush()
    expect(getSvnChanges('ws:/wc')).toBeNull()
  })

  it('无 scope 时直接返回（不请求）', async () => {
    const fetchState = stubFetch([{ ok: true, entries: [] }])
    ensureSvnChanges('s1', null)
    await flush()
    expect(fetchState.getCount()).toBe(0)
  })

  it('scope 隔离：不同工作区各自缓存', async () => {
    stubFetch([
      { ok: true, wcRoot: '/a', entries: [entry('a.ts')], truncated: false },
      { ok: true, wcRoot: '/b', entries: [entry('b.ts')], truncated: false },
    ])
    ensureSvnChanges('s1', 'ws:/a')
    await flush()
    ensureSvnChanges('s1', 'ws:/b')
    await flush()
    expect(getSvnChanges('ws:/a')?.map((item) => item.path)).toEqual(['a.ts'])
    expect(getSvnChanges('ws:/b')?.map((item) => item.path)).toEqual(['b.ts'])
  })
})

describe('svnChangeMapOf', () => {
  let win: ReturnType<typeof makeWindow>

  beforeEach(() => {
    clearSvnChanges()
    win = makeWindow()
    ;(globalThis as unknown as { window: unknown }).window = win
  })

  it('未加载返回空表（徽标全空，不误报）', () => {
    expect(svnChangeMapOf('ws:/none')).toEqual({})
  })

  it('按路径建表；同路径重复条目保留首条', async () => {
    stubFetch([{
      ok: true,
      wcRoot: '/wc',
      entries: [entry('a.ts', { status: 'modified' }), entry('a.ts', { status: 'conflicted' }), entry('b.ts', { status: 'added' })],
      truncated: false,
    }])
    ensureSvnChanges('s1', 'ws:/wc')
    await flush()
    const map = svnChangeMapOf('ws:/wc')
    expect(Object.keys(map).sort()).toEqual(['a.ts', 'b.ts'])
    expect(map['a.ts'].status).toBe('modified')
  })
})
