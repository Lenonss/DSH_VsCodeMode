import { afterEach, describe, expect, it, vi } from 'vitest'
import { addReloadGuard, createPageReload, installPageReload, pageKeysAllowed } from '../src/client/pageReload.js'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

/** @private @author ddj 2026年10月12号 @returns Test operations without actual reload or network. */
function operations() { return { flush: vi.fn(async () => {}), reload: vi.fn(), notify: vi.fn(), timeoutMs: 10 } }

describe('guarded page-only reload', () => {
  it.each(['未保存文件', '未保存 PDF', '待保存', '保存中', '外部冲突'])('refuses %s before preparing or flushing', async (reason) => {
    const deps = operations()
    const guard = { check: () => reason, prepare: vi.fn() }
    await createPageReload(deps, [guard]).request()
    expect(deps.flush).not.toHaveBeenCalled()
    expect(guard.prepare).not.toHaveBeenCalled()
    expect(deps.reload).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenCalledWith('未刷新：' + reason)
  })
  it('prepares and awaits flush before reloading', async () => {
    const deps = operations()
    const prepare = vi.fn()
    await createPageReload(deps, [{ check: () => null, prepare }]).request()
    expect(prepare).toHaveBeenCalledOnce()
    expect(deps.flush).toHaveBeenCalledOnce()
    expect(deps.reload).toHaveBeenCalledOnce()
  })
  it('serializes requests and rechecks changes while flushing', async () => {
    const deps = operations()
    let finish!: () => void
    deps.flush.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    let dirty = false
    const controller = createPageReload(deps, [{ check: () => dirty ? 'changed' : null, prepare: () => {} }])
    const first = controller.request()
    await controller.request()
    expect(deps.flush).toHaveBeenCalledOnce()
    dirty = true
    finish()
    await first
    expect(deps.reload).not.toHaveBeenCalled()
  })
  it('does not reload on flush failure or timeout', async () => {
    const deps = operations()
    deps.flush.mockRejectedValueOnce(new Error('network'))
    const controller = createPageReload(deps, [])
    await controller.request()
    expect(deps.notify).toHaveBeenCalledWith('未刷新：Error: network')
    vi.useFakeTimers()
    deps.flush.mockImplementation(() => new Promise(() => {}))
    const pending = controller.request()
    await vi.advanceTimersByTimeAsync(10)
    await pending
    expect(deps.reload).not.toHaveBeenCalled()
    expect(deps.notify).toHaveBeenLastCalledWith('未刷新：Error: 界面状态保存超时')
  })
  it('cancels pending work on disposal', async () => {
    const deps = operations()
    let finish!: () => void
    deps.flush.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const controller = createPageReload(deps, [])
    const pending = controller.request()
    controller.dispose()
    finish()
    await pending
    expect(deps.reload).not.toHaveBeenCalled()
  })
  it('owns one root listener, respects dialogs and unregisters', async () => {
    const target = new EventTarget()
    const reload = vi.fn()
    vi.stubGlobal('window', Object.assign(target, { location: { reload } }))
    const querySelector = vi.fn(() => null as unknown)
    vi.stubGlobal('document', { querySelector })
    const flush = vi.fn(async () => {})
    const dispose = installPageReload(flush, vi.fn())
    querySelector.mockReturnValue({})
    expect(pageKeysAllowed()).toBe(false)
    target.dispatchEvent(new Event('edrv.command.reloadWindow'))
    expect(flush).not.toHaveBeenCalled()
    querySelector.mockReturnValue(null)
    const release = addReloadGuard({ check: () => null, prepare: () => {} })
    target.dispatchEvent(new Event('edrv.command.reloadWindow'))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(reload).toHaveBeenCalledOnce()
    release(); dispose()
    target.dispatchEvent(new Event('edrv.command.reloadWindow'))
    expect(flush).toHaveBeenCalledOnce()
  })
})
