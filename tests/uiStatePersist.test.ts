/**
 * 界面状态镜像（client state/uiStatePersist.ts）单测：注入假存储，不触真实 localStorage 与网络。
 * 覆盖：键分类（含派生条目缓存不镜像）/ 写穿与删除 / 工作区与全局分区 / 去抖合并 /
 *       失败重试一次 + 逐键回退 + 按体积分批 / 水合只填本地缺失键（本地优先）/
 *       首次搬运标记仅在整批成功后落盘 / 水合失败重试与「水合阶段结束」语义 / 无门控上报口径。
 * 作者 ddj 2026-09-28 / 2026-09-29
 */
import { describe, expect, it } from 'vitest'
import {
  chunkPatch,
  createUiStateMirror,
  HYDRATE_RETRY_MAX,
  isGlobalKey,
  isMirroredKey,
  localMirrorKeys,
  SEEDED_KEY,
  type UiStorage,
  type UiStateMirror,
  type UiStatePush,
} from '../src/client/state/uiStatePersist.js'

/** 等一轮宏任务（重试回调内部 await fetch，需让微任务全部跑完）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** 内存版 localStorage（类原型上带 setItem/removeItem，供 install 包装）。 */
class FakeStorage implements UiStorage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }
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

interface Harness {
  storage: FakeStorage
  mirror: UiStateMirror
  pushes: Array<{ payload: UiStatePush; sessionId?: string }>
  drain: () => void
}

/**
 * 组装镜像测试台：手动调度器（drain 触发去抖回调），push 记录调用并可选失败。
 * @author ddj 2026年09月28号
 */
function makeHarness(options: {
  local?: Record<string, string>
  host?: { keys?: Record<string, string>; globals?: Record<string, string> }
  failPush?: boolean
  chunkBytes?: number
  reject?: (payload: UiStatePush) => boolean
} = {}): Harness {
  const storage = new FakeStorage()
  for (const [key, value] of Object.entries(options.local ?? {})) storage.setItem(key, value)
  const pushes: Array<{ payload: UiStatePush; sessionId?: string }> = []
  const jobs: Array<() => void> = []
  const push = async (payload: UiStatePush, sessionId?: string): Promise<void> => {
    pushes.push({ payload, sessionId })
    if (options.failPush || options.reject?.(payload)) throw new Error('网络不可用')
  }
  const mirror = createUiStateMirror({
    storage,
    push,
    fetch: async () => options.host ?? {},
    sessionIdOf: () => 'sid-1',
    chunkBytes: options.chunkBytes,
    schedule: (fn: () => void) => {
      jobs.push(fn)
      return jobs.length
    },
    cancel: () => { /* 测试不记句柄：重复 drain 只会 flush 空批次 */ },
  })
  return {
    storage,
    mirror,
    pushes,
    drain: () => {
      for (const job of jobs.splice(0)) job()
    },
  }
}

describe('isMirroredKey', () => {
  it('只镜像 edrv. 前缀且排除自身标记键与派生条目缓存', () => {
    expect(isMirroredKey('edrv.editor.v3.ws:d:/a')).toBe(true)
    expect(isMirroredKey('edrv.debug')).toBe(true)
    expect(isMirroredKey('edrv.cache.explorer.v1.ws:d:/a')).toBe(true)
    expect(isMirroredKey('edrv.cache.entries.v2.ws:d:/a')).toBe(false)
    expect(isMirroredKey(SEEDED_KEY)).toBe(false)
    expect(isMirroredKey('dsh-vscode-mode.shortcuts-migrated.v1.win32.win32')).toBe(false)
    expect(isMirroredKey('other-app.key')).toBe(false)
  })
})

describe('chunkPatch', () => {
  it('按体积切分，单键超限独占一批，空补丁为空数组', () => {
    const patch = { a: 'x'.repeat(10), b: 'y'.repeat(10), c: 'z'.repeat(10) }
    expect(chunkPatch(patch, 15)).toEqual([{ a: patch.a }, { b: patch.b }, { c: patch.c }])
    expect(chunkPatch(patch, 100)).toEqual([patch])
    expect(chunkPatch({ big: 'x'.repeat(100) }, 10)).toEqual([{ big: 'x'.repeat(100) }])
    expect(chunkPatch({})).toEqual([])
  })
})

describe('isGlobalKey', () => {
  it('诊断开关/侧栏提示/工作区栏目折叠为全局键，其余按键归工作区', () => {
    expect(isGlobalKey('edrv.debug')).toBe(true)
    expect(isGlobalKey('edrv.side-hint-dismissed')).toBe(true)
    expect(isGlobalKey('edrv.ws-fold.v1.')).toBe(true)
    expect(isGlobalKey('edrv.editor.v3.ws:d:/a')).toBe(false)
    expect(isGlobalKey('edrv.cache.viewstate.v1.ws:d:/a')).toBe(false)
  })
})

describe('localMirrorKeys', () => {
  it('过滤非镜像键并保留原顺序', () => {
    const storage = new FakeStorage()
    storage.setItem('other', '1')
    storage.setItem('edrv.a', '1')
    storage.setItem(SEEDED_KEY, '1')
    storage.setItem('edrv.b', '2')
    expect(localMirrorKeys(storage)).toEqual(['edrv.a', 'edrv.b'])
  })
})

describe('createUiStateMirror 写穿', () => {
  it('包装 localStorage 写口：镜像键入批、非镜像键不动', async () => {
    const h = makeHarness()
    expect(h.mirror.install()).toBe(true)
    h.storage.setItem('edrv.editor.v3.ws:d:/a', '{"tabs":[]}')
    h.storage.setItem('other-app.key', 'x')
    h.drain()
    await h.mirror.flush()
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0].payload).toEqual({ keys: { 'edrv.editor.v3.ws:d:/a': '{"tabs":[]}' } })
    expect(h.pushes[0].sessionId).toBe('sid-1')
    // 原始写入不被吞掉
    expect(h.storage.getItem('edrv.editor.v3.ws:d:/a')).toBe('{"tabs":[]}')
  })

  it('removeItem 以 null 上送（host 侧删除语义）', async () => {
    const h = makeHarness()
    h.mirror.install()
    h.storage.removeItem('edrv.search.v1.ws:d:/a')
    h.drain()
    await h.mirror.flush()
    expect(h.pushes[0].payload).toEqual({ keys: { 'edrv.search.v1.ws:d:/a': null } })
  })

  it('全局键走 globals 分区、工作区键走 keys 分区，两分区各自成请求', async () => {
    const h = makeHarness()
    h.mirror.install()
    h.storage.setItem('edrv.debug', '1')
    h.storage.setItem('edrv.editor.v3.ws:d:/a', 'x')
    h.drain()
    await h.mirror.flush()
    expect(h.pushes.map((p) => p.payload)).toEqual([
      { keys: { 'edrv.editor.v3.ws:d:/a': 'x' } },
      { globals: { 'edrv.debug': '1' } },
    ])
  })

  it('去抖窗口内的多次写入合并为一次上送', async () => {
    const h = makeHarness()
    h.mirror.install()
    h.storage.setItem('edrv.a', '1')
    h.storage.setItem('edrv.b', '2')
    h.storage.setItem('edrv.a', '3')
    h.drain()
    await h.mirror.flush()
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0].payload).toEqual({ keys: { 'edrv.a': '3', 'edrv.b': '2' } })
  })

  it('上送失败重试一次后逐键回退，仍失败则计入丢弃键数', async () => {
    const h = makeHarness({ failPush: true })
    h.mirror.install()
    h.storage.setItem('edrv.a', '1')
    // 不 drain：直接 flush 才能拿到本批的丢弃键数（去抖回调已消费批次时 flush 返回 0）
    await expect(h.mirror.flush()).resolves.toBe(1)
    // 整批 2 次 + 逐键 2 次全部失败
    expect(h.pushes).toHaveLength(4)
  })

  it('整批被拒时逐键回退，其余键仍能落盘', async () => {
    const h = makeHarness({ reject: (payload) => Object.keys(payload.keys ?? {}).length > 1 })
    h.mirror.install()
    h.storage.setItem('edrv.a', '1')
    h.storage.setItem('edrv.b', '2')
    h.drain()
    await expect(h.mirror.flush()).resolves.toBe(0)
    // 整批 2 次失败 + 逐键各 1 次成功
    expect(h.pushes).toHaveLength(4)
    const single = h.pushes.filter((p) => Object.keys(p.payload.keys ?? {}).length === 1)
    expect(Object.assign({}, ...single.map((p) => p.payload.keys))).toEqual({ 'edrv.a': '1', 'edrv.b': '2' })
  })

  it('超过单批上限时自动分批，每批不超过上限', async () => {
    const h = makeHarness({ chunkBytes: 20 })
    h.mirror.install()
    h.storage.setItem('edrv.a', 'x'.repeat(20))
    h.storage.setItem('edrv.b', 'y'.repeat(20))
    h.drain()
    await expect(h.mirror.flush()).resolves.toBe(0)
    expect(h.pushes).toHaveLength(2)
    expect(h.pushes[0].payload).toEqual({ keys: { 'edrv.a': 'x'.repeat(20) } })
    expect(h.pushes[1].payload).toEqual({ keys: { 'edrv.b': 'y'.repeat(20) } })
  })

  it('空批次不发起上送', async () => {
    const h = makeHarness()
    h.mirror.install()
    await h.mirror.flush()
    expect(h.pushes).toHaveLength(0)
  })
})

describe('createUiStateMirror 水合', () => {
  it('只填本地缺失键并返回条数，本地已有值不被覆盖', async () => {
    const h = makeHarness({
      local: { 'edrv.editor.v3.ws:d:/a': '本地较新' },
      host: {
        keys: { 'edrv.editor.v3.ws:d:/a': 'host 旧值', 'edrv.sidebar.ws:d:/a': '{"on":true}' },
        globals: { 'edrv.debug': '1' },
      },
    })
    h.mirror.install()
    const filled = await h.mirror.hydrate()
    expect(filled).toBe(2)
    expect(h.mirror.hydrated()).toBe(true)
    expect(h.mirror.settled()).toBe(true)
    expect(h.storage.getItem('edrv.editor.v3.ws:d:/a')).toBe('本地较新')
    expect(h.storage.getItem('edrv.sidebar.ws:d:/a')).toBe('{"on":true}')
    expect(h.storage.getItem('edrv.debug')).toBe('1')
  })

  it('回填写入不回声上送（仅首次搬运把本地既有键推给 host）', async () => {
    const h = makeHarness({
      local: { 'edrv.rules.v1.ws:d:/a': '{"tab":1}' },
      host: { keys: { 'edrv.sidebar.ws:d:/a': '{"on":true}' } },
    })
    h.mirror.install()
    await h.mirror.hydrate()
    h.drain()
    await h.mirror.flush()
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0].payload).toEqual({ keys: { 'edrv.rules.v1.ws:d:/a': '{"tab":1}' } })
    expect(h.storage.getItem(SEEDED_KEY)).toBe('1')
  })

  it('非字符串/非镜像键的 host 值一律忽略', async () => {
    const h = makeHarness({
      host: {
        keys: { 'edrv.a': 'ok', 'other.key': 'x' } as Record<string, string>,
        globals: { [SEEDED_KEY]: '1' },
      },
    })
    h.mirror.install()
    const filled = await h.mirror.hydrate()
    expect(filled).toBe(1)
    expect(h.storage.getItem('edrv.a')).toBe('ok')
    expect(h.storage.getItem('other.key')).toBeNull()
  })

  it('host 取回失败首轮返回 0 且不抛错，安排重试并保持水合阶段未结束', async () => {
    const jobs: Array<() => void> = []
    const mirror = createUiStateMirror({
      storage: new FakeStorage(),
      push: async () => { /* 不调用 */ },
      fetch: async () => { throw new Error('host 不可达') },
      schedule: (fn: () => void) => { jobs.push(fn); return jobs.length },
    })
    mirror.install()
    await expect(mirror.hydrate()).resolves.toBe(0)
    expect(mirror.hydrated()).toBe(false)
    // 关键：未结束水合阶段 → 界面侧据此暂缓写存档（避免空初值覆盖 host 真实状态）
    expect(mirror.settled()).toBe(false)
    expect(jobs).toHaveLength(1)
  })

  it('重试成功即回填并结束水合阶段（会话晚到场景）', async () => {
    const storage = new FakeStorage()
    const jobs: Array<() => void> = []
    let fetches = 0
    const mirror = createUiStateMirror({
      storage,
      push: async () => { /* 不调用 */ },
      fetch: async () => {
        fetches += 1
        if (fetches === 1) throw new Error('会话不存在')
        return { keys: { 'edrv.editor.v3.ws:d:/a': '{"tabs":[]}' } }
      },
      schedule: (fn: () => void) => { jobs.push(fn); return jobs.length },
    })
    mirror.install()
    await expect(mirror.hydrate()).resolves.toBe(0)
    expect(storage.getItem('edrv.editor.v3.ws:d:/a')).toBeNull()
    const retry = jobs.shift()
    expect(retry).toBeTypeOf('function')
    ;(retry as () => void)()
    await tick()
    expect(fetches).toBe(2)
    expect(storage.getItem('edrv.editor.v3.ws:d:/a')).toBe('{"tabs":[]}')
    expect(mirror.hydrated()).toBe(true)
    expect(mirror.settled()).toBe(true)
  })

  it('重试耗尽（达 HYDRATE_RETRY_MAX）后结束水合阶段，不再排定重试', async () => {
    const jobs: Array<() => void> = []
    let fetches = 0
    const mirror = createUiStateMirror({
      storage: new FakeStorage(),
      push: async () => { /* 不调用 */ },
      fetch: async () => { fetches += 1; throw new Error('会话不存在') },
      schedule: (fn: () => void) => { jobs.push(fn); return jobs.length },
    })
    mirror.install()
    await mirror.hydrate()
    while (jobs.length) {
      const job = jobs.shift()
      ;(job as () => void)()
      await tick()
    }
    expect(fetches).toBe(HYDRATE_RETRY_MAX)
    expect(mirror.hydrated()).toBe(false)
    expect(mirror.settled()).toBe(true)
  })

  it('无门控上报：水合与结束阶段都会回调 report（诊断不依赖 debug 开关）', async () => {
    const calls: string[] = []
    const mirror = createUiStateMirror({
      storage: new FakeStorage(),
      push: async () => { /* 不调用 */ },
      fetch: async () => ({}),
      report: (text: string) => { calls.push(text) },
    })
    mirror.install()
    await mirror.hydrate()
    expect(calls.some((text) => text.includes('水合开始'))).toBe(true)
    expect(calls.some((text) => text.includes('水合阶段结束'))).toBe(true)
  })
})
