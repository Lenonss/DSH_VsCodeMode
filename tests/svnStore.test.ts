/**
 * client SVN 数据源通用缓存层（svnStore.ts）测试。
 * 覆盖：缓存命中时 latest() 切回该 key 的载荷——守护「非 SVN 工作区切回后
 * 右键菜单/命令栏 SVN 显隐残留上一个工作区载荷」的回归（2026-09-22 实测 bug）。
 * 手法：stub global.fetch（client rpc 的唯一出口）与 window（事件断言），
 * 镜像 tests/svnChanges.test.ts 的既有风格。
 * 作者 ddj 2026年09月22号
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSvnStore } from '../src/client/svnStore.js'

/** 载荷最小面：只断言 managed（显隐判定关键字段）。 */
interface StatusLike {
  managed: boolean
  svnCli: boolean
}

/**
 * 创建一个待测 status 数据源（与 svnStatus.ts 的 statusStore 同形配置）。
 * @author ddj 2026年09月22号
 * @returns 数据源实例
 */
function makeStore() {
  return createSvnStore<'svn.status', StatusLike>({
    method: 'svn.status',
    event: 'edrv:svn-status',
    select: (res) => ({ value: res as unknown as StatusLike }),
  })
}

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
  return { calls, getCount: () => at }
}

/** 等一轮微任务（RPC then 链落定）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** SVN 工作区与非 SVN 工作区的两种载荷。 */
const SVN_OK = { ok: true, managed: true, svnCli: true }
const NOT_SVN = { ok: true, managed: false, svnCli: false }

describe('createSvnStore.ensure', () => {
  let win: ReturnType<typeof makeWindow>

  beforeEach(() => {
    win = makeWindow()
    ;(globalThis as unknown as { window: unknown }).window = win
  })

  it('成功拉取后写缓存、更新 latest() 并广播事件（基线语义不变）', async () => {
    const store = makeStore()
    const state = stubFetch([SVN_OK])
    store.ensure('s1', 'ws:/svn')
    await flush()
    expect(store.get('ws:/svn')?.managed).toBe(true)
    expect(store.latest()?.managed).toBe(true)
    expect(state.getCount()).toBe(1)
    expect(win.countOf('edrv:svn-status')).toBe(1)
  })

  it('切到非 SVN 再切回：缓存命中把 latest() 切回该 scope，且零新请求零新事件', async () => {
    const store = makeStore()
    const state = stubFetch([SVN_OK, NOT_SVN])
    store.ensure('s1', 'ws:/svn')
    await flush()
    store.ensure('s1', 'ws:/plain')
    await flush()
    expect(store.latest()?.managed).toBe(false)
    // 切回 SVN 工作区：缓存命中，latest() 必须回到该 scope 的载荷（本 bug 的回归守护）
    store.ensure('s1', 'ws:/svn')
    await flush()
    expect(store.latest()?.managed).toBe(true)
    expect(store.get('ws:/svn')?.managed).toBe(true)
    // 命中路径不得发多余 RPC，也不得重复广播（状态面由调用方同步读回）
    expect(state.getCount()).toBe(2)
    expect(win.countOf('edrv:svn-status')).toBe(2)
  })

  it('force 重取仍绕过缓存：发新请求并更新 latest()', async () => {
    const store = makeStore()
    const state = stubFetch([SVN_OK, NOT_SVN])
    store.ensure('s1', 'ws:/svn')
    await flush()
    store.ensure('s1', 'ws:/svn', true)
    await flush()
    expect(state.getCount()).toBe(2)
    expect(store.latest()?.managed).toBe(false)
    expect(store.get('ws:/svn')?.managed).toBe(false)
  })

  it('失败（ok:false）不写缓存、不更新 latest()', async () => {
    const store = makeStore()
    stubFetch([SVN_OK, { ok: false, error: '不受 SVN 管理' }])
    store.ensure('s1', 'ws:/svn')
    await flush()
    store.ensure('s1', 'ws:/plain')
    await flush()
    expect(store.get('ws:/plain')).toBeNull()
    expect(store.latest()?.managed).toBe(true)
  })
})
