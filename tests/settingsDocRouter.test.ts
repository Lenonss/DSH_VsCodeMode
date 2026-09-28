import { describe, expect, it } from 'vitest'
import { patchSettingsDoc, probeSettingsDoc } from '../src/client/settingsDocRouter.js'

function makeService(calls: unknown[]) {
  const service = {}
  Object.defineProperty(service, 'openSettingsDocument', {
    configurable: true,
    enumerable: true,
    get: () => async (...args: unknown[]) => {
      calls.push(args)
      return { ok: true, value: { opened: true } }
    },
  })
  return service
}

describe('probeSettingsDoc', () => {
  it('finds the optional remote settings document API', () => {
    const service = makeService([])
    expect(probeSettingsDoc({ get: (name) => name === 'remote.settings' ? service : undefined })).toBe(service)
  })

  it('returns undefined when the service or method is absent', () => {
    expect(probeSettingsDoc({ get: () => undefined })).toBeUndefined()
    expect(probeSettingsDoc({ get: () => ({}) })).toBeUndefined()
    expect(probeSettingsDoc({ get: () => { throw new Error('missing') } })).toBeUndefined()
  })
})

describe('patchSettingsDoc', () => {
  it('opens the prepared path in the plugin editor without invoking the native opener', async () => {
    const nativeCalls: unknown[] = []
    const service = makeService(nativeCalls)
    const opened: string[] = []
    const restore = patchSettingsDoc(service, async () => ({ ok: true, path: 'C:/Users/test/.dsh/cordis.patch.yml' }), (path) => opened.push(path))
    expect(await (service as { openSettingsDocument: () => Promise<unknown> }).openSettingsDocument()).toEqual({ ok: true, value: { opened: true } })
    expect(opened).toEqual(['C:/Users/test/.dsh/cordis.patch.yml'])
    expect(nativeCalls).toEqual([])
    restore?.()
  })

  it('falls back to native opening if path preparation fails', async () => {
    const nativeCalls: unknown[] = []
    const service = makeService(nativeCalls)
    const opened: string[] = []
    const restore = patchSettingsDoc(service, async () => ({ ok: false, error: 'provider unavailable' }), (path) => opened.push(path))
    const result = await (service as { openSettingsDocument: () => Promise<unknown> }).openSettingsDocument()
    expect(result).toEqual({ ok: true, value: { opened: true } })
    expect(opened).toEqual([])
    expect(nativeCalls).toEqual([[]])
    restore?.()
  })

  it('restores the original accessor on disposal', async () => {
    const nativeCalls: unknown[] = []
    const service = makeService(nativeCalls)
    const original = Object.getOwnPropertyDescriptor(service, 'openSettingsDocument')
    const restore = patchSettingsDoc(service, async () => ({ ok: true, path: 'settings.yml' }), () => {})
    restore?.()
    expect(Object.getOwnPropertyDescriptor(service, 'openSettingsDocument')?.get).toBe(original?.get)
    await (service as { openSettingsDocument: () => Promise<unknown> }).openSettingsDocument()
    expect(nativeCalls).toEqual([[]])
  })
})
