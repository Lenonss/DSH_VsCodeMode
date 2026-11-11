import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountExcel } from '../src/client/excel/mountExcel.js'
import { setPanelImport } from '../src/client/lazyPanel.js'

interface FakeNode { parentNode: any }

/** @private @author ddj 2026年11月10号 @returns Detached Node-like host recording appended children. */
function fakeHost() {
  const children: FakeNode[] = []
  const host: any = { isConnected: true, children }
  host.appendChild = (node: FakeNode) => { children.push(node); node.parentNode = host }
  return host
}

afterEach(() => { setPanelImport() })

describe('excel engine mounting', () => {
  it('reuses an already materialized panel without requesting the engine chunk', async () => {
    const host = fakeHost()
    const node: FakeNode = { parentNode: null }
    const state: any = { node }
    const load = vi.fn()

    await mountExcel(host, state, 'a.xlsx', undefined, load as any)

    expect(load).not.toHaveBeenCalled()
    expect(host.children).toEqual([node])
  })

  it('loads the engine once, then moves the shared node between views', async () => {
    const first = fakeHost()
    const state: any = {}
    const node: FakeNode = { parentNode: null }
    const excelPanel = vi.fn(() => { state.node = node; return node })
    const load = vi.fn(async () => excelPanel)

    await mountExcel(first, state, '/tmp/a.xlsx', '/tmp', load as any)
    const second = fakeHost()
    await mountExcel(second, state, '/tmp/a.xlsx', '/tmp', load as any)

    expect(excelPanel).toHaveBeenCalledExactlyOnceWith(state, '/tmp/a.xlsx', '/tmp')
    expect(load).toHaveBeenCalledTimes(1)
    expect(first.children).toEqual([node])
    expect(second.children).toEqual([node])
    expect(node.parentNode).toBe(second)
  })

  it('does not mount into a host that detached while the chunk was loading', async () => {
    const host = fakeHost()
    host.isConnected = false
    const state: any = {}
    const excelPanel = vi.fn(() => ({ parentNode: null }))

    await mountExcel(host, state, 'a.xlsx', undefined, (async () => excelPanel) as any)

    expect(excelPanel).not.toHaveBeenCalled()
    expect(host.children).toEqual([])
  })

  it('propagates a failed chunk request so the host can offer retry', async () => {
    const host = fakeHost()
    const load = vi.fn(async () => { throw new Error('offline') })

    await expect(mountExcel(host, {} as any, 'a.xlsx', undefined, load as any)).rejects.toThrow('offline')
    expect(host.children).toEqual([])
  })

  it('rejects a chunk that does not publish the panel factory', async () => {
    setPanelImport(async () => ({}))

    await expect(mountExcel(fakeHost(), {} as any, 'a.xlsx')).rejects.toThrow('表格脚本缺少面板导出')
  })
})
