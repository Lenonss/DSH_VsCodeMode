/**
 * dsh-vscode-mode 设置安装自适应层测试：legacy / service / none 三策略分支，
 * 以及依赖解析链（schema 包改名 / dsh-settings 可选）。
 * 作者 ddj 2026-09-02 / 2026-09-18
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pickSchema,
  loadSettingsDeps,
  resetSettingsDeps,
  resetSettingsInstallObserved,
  runSettingsInstall,
  schemaLibName,
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

describe('loadSettingsDeps 解析链', () => {
  beforeEach(() => resetSettingsDeps())

  /** 构造按包名分派的 import 桩（未列出的包名抛 MODULE_NOT_FOUND）。 */
  const importerOf = (table: Record<string, unknown>) => async (specifier: string): Promise<unknown> => {
    if (specifier in table) return table[specifier]
    throw Object.assign(new Error('Cannot find module ' + specifier), { code: 'ERR_MODULE_NOT_FOUND' })
  }

  it('用户安装形态：只有新名 @deepseek-ai/schemastery 且无 dsh-settings 也能加载', async () => {
    // 复刻线上 npm 安装：插件包无 devDependency，安装树只有改名后的 @deepseek-ai/schemastery；
    // 修复前 Promise.all 里 hostImport('schemastery') 失败会整体 reject → section 永不装配。
    const deps = await loadSettingsDeps(importerOf({ '@deepseek-ai/schemastery': { default: zStub() } }))
    expect(deps, '只给新名也必须解析成功').not.toBeNull()
    expect(typeof deps!.z.object).toBe('function')
    expect(deps!.installSettingsSection, 'alpha 线无 legacy 导出属正常').toBeUndefined()
    expect(schemaLibName()).toBe('@deepseek-ai/schemastery')
  })

  it('rc 线形态：裸 schemastery + dsh-settings legacy 导出', async () => {
    const install = vi.fn()
    const deps = await loadSettingsDeps(importerOf({
      '@deepseek-ai/dsh-settings': { installSettingsSection: install },
      schemastery: { default: zStub() },
    }))
    expect(deps?.installSettingsSection).toBe(install)
    expect(schemaLibName(), '新名优先，落到旧名时报告旧名').toBe('schemastery')
  })

  it('CJS 互操作三层形态都能取到 z', async () => {
    for (const shape of [
      { default: zStub() },
      { default: { default: zStub() } },
      { 'module.exports': { default: zStub() } },
    ]) {
      resetSettingsDeps()
      const deps = await loadSettingsDeps(importerOf({ '@deepseek-ai/schemastery': shape }))
      expect(deps, JSON.stringify(Object.keys(shape)) + ' 形态应可解析').not.toBeNull()
    }
  })

  it('两个包名都解析不到 → null 降级且不抛错', async () => {
    await expect(loadSettingsDeps(importerOf({}))).resolves.toBeNull()
    expect(schemaLibName()).toBe('')
  })

  it('pickSchema：缺 object/string 构造器时视为非法', () => {
    expect(pickSchema({ default: {} })).toBeNull()
    expect(pickSchema(null)).toBeNull()
    expect(pickSchema({ default: zStub() })).not.toBeNull()
  })
})

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
