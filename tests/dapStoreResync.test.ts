/** DAP store 客户端重装对账（resync）测试。作者 ddj 2026年09月21号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** 轮询定时器记录：node 环境无 window/定时器语义，用桩替掉全局才能断言「是否起轮询」。 */
const timers: Array<{ fn: () => void; ms: number }> = []
/** host RPC 桩（vi.mock 工厂被提升到文件顶部，引用必须经 vi.hoisted 提供）。 */
const rpcMock = vi.hoisted(() => vi.fn())

vi.mock('../src/client/rpc.js', () => ({ rpc: rpcMock }))

/**
 * 装配最小浏览器环境桩（store 的轮询分支与 debug-stopped 事件派发都依赖 window）。
 * @author ddj 2026年09月21号
 */
function stubBrowserEnv(): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    timers.push({ fn, ms })
    return timers.length
  }) as unknown as typeof setInterval
  globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval
}

/** 载入全新的 store 模块实例（模块级单例状态随 refresh/HMR 归零，测试须复现该前提）。 */
async function loadStore(): Promise<typeof import('../src/client/dap/store.js')['dapStore']> {
  return (await import('../src/client/dap/store.js')).dapStore
}

describe('dapStore.resync', () => {
  beforeEach(() => {
    vi.resetModules()
    rpcMock.mockReset()
    timers.length = 0
    stubBrowserEnv()
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('host 停在断点时采纳状态、起轮询且不回放历史事件', async () => {
    rpcMock.mockResolvedValue({ ok: true, state: { phase: 'paused', topFrame: { file: 'Assets/X.lua', line: 199 } }, events: [], nextSeq: 245 })
    const dapStore = await loadStore()
    await dapStore.resync()
    const snap = dapStore.getSnapshot()
    expect(snap.phase).toBe('paused')
    expect(snap.topFrame?.line).toBe(199)
    expect(rpcMock).toHaveBeenCalledWith('edrv.dap.poll', { since: Number.MAX_SAFE_INTEGER })
    expect(dapStore.outputs().length).toBe(0)
    expect(timers.length).toBe(1)
    expect(timers[0].ms).toBeGreaterThan(0)
  })

  it('host 空闲时保持 idle 且不起轮询', async () => {
    rpcMock.mockResolvedValue({ ok: true, state: { phase: 'idle', topFrame: null }, events: [], nextSeq: 3 })
    const dapStore = await loadStore()
    await dapStore.resync()
    expect(dapStore.getSnapshot().phase).toBe('idle')
    expect(timers.length).toBe(0)
  })

  it('已有轮询时不重复对账', async () => {
    rpcMock.mockResolvedValue({ ok: true, state: { phase: 'running', topFrame: null }, events: [], nextSeq: 9 })
    const dapStore = await loadStore()
    await dapStore.resync()
    await dapStore.resync()
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(timers.length).toBe(1)
  })

  it('host 拒绝时保持 idle 且不抛错', async () => {
    rpcMock.mockResolvedValue({ ok: false, error: '未知方法：edrv.dap.poll' })
    const dapStore = await loadStore()
    await expect(dapStore.resync()).resolves.toBeUndefined()
    expect(dapStore.getSnapshot().phase).toBe('idle')
    expect(timers.length).toBe(0)
  })
})
