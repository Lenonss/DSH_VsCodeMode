/** Official popup ownership contracts. @author ddj 2026年11月04号 */
import { describe, it, expect, vi } from 'vitest'
import { officialMenus } from '../src/client/contextMenusOfficial.js'

/** @private @author ddj 2026年11月04号 @returns Minimal official registry fixture. */
function fixture() {
  const contributions: any[] = []
  const service = { register: vi.fn((item: any) => { contributions.push(item); return vi.fn() }), open: vi.fn(), close: vi.fn() }
  Object.assign(service, { active: { getSnapshot: () => service.open.mock.calls.at(-1)?.[0] } })
  const bridge = officialMenus({ get: () => service })!
  const valid = vi.fn(() => true)
  const run = vi.fn()
  bridge.open('resource', 's1', 'a.ts', { x: 1, y: 2 }, [{ id: 'delete', label: 'Delete', danger: true, separator: true, run }], valid)
  const target = service.open.mock.calls[0][0].value
  return { bridge, service, contributions, valid, run, target }
}

describe('official menu bridge', () => {
  it('falls back when capability is absent or incomplete', () => {
    expect(officialMenus({ get: () => undefined })).toBeUndefined()
    expect(officialMenus({ get: () => ({ open() {} }) })).toBeUndefined()
  })
  it('preserves action flags and permits select after resolution abort', async () => {
    const f = fixture(), controller = new AbortController()
    const actions = f.contributions[0].resolve(f.target, controller.signal)
    expect(actions[0]).toMatchObject({ danger: true, separatorBefore: true })
    controller.abort()
    await actions[0].run()
    expect(f.run).toHaveBeenCalledTimes(1)
  })
  it('invalidates only the matching occurrence and blocks stale actions', async () => {
    const f = fixture()
    const action = f.contributions[0].resolve(f.target, new AbortController().signal)[0]
    f.bridge.invalidate(() => true)
    expect(f.service.close).not.toHaveBeenCalled()
    f.bridge.invalidate(f.valid)
    expect(f.service.close).toHaveBeenCalledTimes(1)
    await action.run()
    expect(f.run).not.toHaveBeenCalled()
  })
  it('rejects foreign owners, invalid scope and disposed callbacks', async () => {
    const f = fixture()
    expect(f.contributions[0].resolve({ owner: 'other' }, new AbortController().signal)).toEqual([])
    const action = f.contributions[0].resolve(f.target, new AbortController().signal)[0]
    f.bridge.dispose()
    await action.run()
    expect(f.run).not.toHaveBeenCalled()
  })
})
