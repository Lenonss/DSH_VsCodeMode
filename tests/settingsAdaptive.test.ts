/**
 * dsh-vscode-mode 设置安装自适应层测试：legacy / service / none 三策略分支。
 * 作者 ddj 2026-09-02
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetSettingsInstallObserved,
  runSettingsInstall,
  settingsInstallNote,
  settingsInstallStrategy,
} from '../src/fileOpenSettings.js'

const NS = 'dsh-vscode-mode'
const hooks = { setSource: () => {}, onChange: () => {} }

/** 最小 schemastery z 桩（只构造不校验）。 */
function zStub() {
  return {
    object: (shape: unknown) => ({ default: (value: unknown) => ({ shape, value }) }),
    string: () => ({ default: (value: unknown) => value }),
    boolean: () => ({ default: (value: unknown) => value }),
    number: () => ({ default: (value: unknown) => value }),
  }
}

describe('runSettingsInstall 策略分派', () => {
  beforeEach(() => resetSettingsInstallObserved())

  it('legacy：dsh-settings 导出 installSettingsSection 时原样调用（rc 线）', async () => {
    const legacy = vi.fn()
    const ctx = {}
    const strategy = await runSettingsInstall(ctx as never, NS, {}, {}, hooks, async () => ({ installSettingsSection: legacy, z: zStub() }))
    expect(strategy).toBe('legacy')
    expect(legacy).toHaveBeenCalledTimes(1)
    expect(legacy.mock.calls[0][1]).toBe(NS)
    expect(settingsInstallStrategy()).toBe('legacy')
    expect(settingsInstallNote()).toContain('installSettingsSection')
  })

  it('service：导出已移除时走 settings 服务 installSection（alpha 线）', async () => {
    const install = vi.fn()
    const ctx = {
      inject: (services: string[], callback: (sctx: unknown) => void) => {
        expect(services).toEqual(['settings'])
        callback({ get: () => ({ installSection: install }) })
      },
    }
    const strategy = await runSettingsInstall(ctx as never, NS, {}, {}, hooks, async () => ({ z: zStub() }))
    expect(strategy).toBe('service')
    expect(install).toHaveBeenCalledTimes(1)
    expect(install.mock.calls[0][1]).toBe(NS)
    expect(settingsInstallStrategy()).toBe('service')
    expect(settingsInstallNote()).toContain('installSection')
  })

  it('service 路由存在但方法缺失 → none 降级', async () => {
    const ctx = {
      inject: (_services: string[], callback: (sctx: unknown) => void) => callback({ get: () => ({}) }),
    }
    const strategy = await runSettingsInstall(ctx as never, NS, {}, {}, hooks, async () => ({ z: zStub() }))
    expect(strategy).toBe('none')
    expect(settingsInstallStrategy()).toBe('none')
    expect(settingsInstallNote()).toContain('降级')
  })

  it('依赖缺失 / ctx 无 inject 且无 legacy → none，不抛错', async () => {
    expect(await runSettingsInstall({} as never, NS, {}, {}, hooks, async () => null)).toBe('none')
    expect(await runSettingsInstall({} as never, NS, {}, {}, hooks, async () => ({ z: zStub() }))).toBe('none')
    expect(settingsInstallStrategy()).toBe('none')
  })

  it('legacy 调用抛错时降级不抛出', async () => {
    const ctx = {
      inject: (_services: string[], callback: (sctx: unknown) => void) => callback({ settings: { installSection: vi.fn() } }),
    }
    const legacy = vi.fn(() => { throw new Error('boom') })
    const strategy = await runSettingsInstall(ctx as never, NS, {}, {}, hooks, async () => ({ installSettingsSection: legacy, z: zStub() }))
    expect(['service', 'none']).toContain(strategy)
    expect(settingsInstallStrategy()).not.toBe('unknown')
  })
})
