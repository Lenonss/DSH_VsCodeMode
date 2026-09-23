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
  sectionOf,
  settingsInstallNote,
  settingsInstallStrategy,
  updateSection,
  buildSettingsSchema,
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

  it('forms：0.1.7 无 installSection 但 describe+update 在场 → forms 策略', async () => {
    const provider = { describe: () => [], update: async () => {} }
    const ctx = {
      on: vi.fn(() => () => {}),
      effect: vi.fn(),
      inject: (_services: string[], callback: (sctx: unknown) => void) => callback({ get: () => provider }),
    }
    const strategy = await runSettingsInstall(ctx as never, NS, {}, {}, hooks, async () => ({ z: zStub() }))
    expect(strategy).toBe('forms')
    expect(settingsInstallStrategy()).toBe('forms')
    expect(settingsInstallNote()).toContain('SettingsForms')
    // 变更通知接线：订阅 settings/document-updated 且经 effect 挂 disposer
    expect(ctx.on).toHaveBeenCalledTimes(1)
    expect(ctx.on.mock.calls[0][0]).toBe('settings/document-updated')
    expect(ctx.effect).toHaveBeenCalledTimes(1)
  })

  it('forms 订阅回调：同 ns 变化推 setSource+onChange，异 ns 忽略', async () => {
    let handler: ((ns: unknown) => void) | undefined
    const provider = {
      describe: () => [{ ns: NS, value: { fileOpenTool: 'vscode' }, revision: 7 }],
      update: async () => {},
    }
    const ctx = {
      on: vi.fn((_name: string, h: (ns: unknown) => void) => { handler = h; return () => {} }),
      effect: vi.fn(),
      inject: (_services: string[], callback: (sctx: unknown) => void) => callback({ get: () => provider }),
    }
    let pushed: unknown
    let changes = 0
    await runSettingsInstall(ctx as never, NS, {}, {}, {
      setSource: (source) => { pushed = source() },
      onChange: () => { changes += 1 },
    }, async () => ({ z: zStub() }))
    expect(handler).toBeTypeOf('function')
    handler?.('other-ns')
    expect(changes).toBe(0)
    handler?.(NS)
    expect(changes).toBe(1)
    expect(pushed).toEqual({ fileOpenTool: 'vscode' })
  })

  it('forms 缺 describe 或 update 之一 → 仍 none 降级', async () => {
    const ctx = {
      inject: (_services: string[], callback: (sctx: unknown) => void) =>
        callback({ get: () => ({ describe: () => [] }) }),
    }
    const strategy = await runSettingsInstall(ctx as never, NS, {}, {}, hooks, async () => ({ z: zStub() }))
    expect(strategy).toBe('none')
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

describe('sectionOf 形状校验读取', () => {
  it('ns 命中且 value 为对象 → 命中（0.1.7 entry Config 值与旧 section 值同形）', () => {
    const provider = { describe: () => [{ ns: NS, value: { fileOpenTool: 'a' }, revision: 3 }] }
    expect(sectionOf(provider, NS)?.revision).toBe(3)
  })

  it('ns 同名但 value 非对象（数组/标量）→ 不命中（防误命中非设置数据）', () => {
    const provider = { describe: () => [{ ns: NS, value: [1, 2] }, { ns: NS, value: 'x' }] }
    expect(sectionOf(provider, NS)).toBeUndefined()
  })

  it('provider 缺失 / describe 缺失 / ns 未命中 → undefined 不抛错', () => {
    expect(sectionOf(undefined, NS)).toBeUndefined()
    expect(sectionOf({}, NS)).toBeUndefined()
    expect(sectionOf({ describe: () => [{ ns: 'other', value: {} }] }, NS)).toBeUndefined()
  })
})

describe('updateSection 冲突自愈写入', () => {
  it('正常写入直接成功（带 revision 栅栏）', async () => {
    const update = vi.fn(async () => {})
    const provider = { describe: () => [{ ns: NS, value: {}, revision: 5 }], update }
    const result = await updateSection(provider, NS, { fileOpenTool: 'vscode' })
    expect(result.ok).toBe(true)
    expect(update).toHaveBeenCalledWith(NS, { fileOpenTool: 'vscode' }, 5)
  })

  it('SettingsConflictError（code 通道）→ 重读 revision 重试一次成功', async () => {
    let calls = 0
    const update = vi.fn(async (_ns: string, _patch: object, revision?: number) => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' })
      expect(revision, '重试须用重读到的新 revision').toBe(9)
    })
    // 首写带 expectedRevision=2（短路不读 describe）；冲突重试才走 describe 重读
    const provider = { describe: () => [{ ns: NS, value: {}, revision: 9 }], update }
    const result = await updateSection(provider, NS, { a: 1 }, 2)
    expect(result).toEqual({ ok: true, conflict: true })
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[0][2]).toBe(2)
  })

  it('构造器名通道识别冲突；非冲突错误结构化返回不抛错', async () => {
    const conflictErr = Object.assign(new Error('x'), { name: 'SettingsConflictError' })
    const provider = {
      describe: () => [{ ns: NS, value: {}, revision: 1 }],
      update: vi.fn(async () => { throw conflictErr }),
    }
    const conflictResult = await updateSection(provider, NS, {})
    expect(conflictResult.ok).toBe(false)
    expect(conflictResult.conflict).toBe(true)
    const plainErr = { update: vi.fn(async () => { throw new Error('disk full') }) }
    const plainResult = await updateSection(plainErr, NS, {})
    expect(plainResult.ok).toBe(false)
    expect(plainResult.error).toContain('disk full')
  })

  it('服务无 update → 结构化失败（调用方走内存降级）', async () => {
    const result = await updateSection({}, NS, {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain('update')
  })
})

describe('buildSettingsSchema 字段全集', () => {
  it('与设置键逐字一致（Config 声明与 section 安装同源）', () => {
    // zStub 的 z.object(shape) 返回 {default} 包装：取 shape 须经 .default() 展开
    const wrapped = buildSettingsSchema(zStub()) as { default: (value: Record<string, unknown>) => { shape: Record<string, unknown> } }
    const keys = Object.keys(wrapped.default({}).shape).sort()
    expect(keys).toEqual([
      'aiEffort', 'aiInline', 'aiModel', 'aiProvider',
      'fileOpenTool', 'integrationBaseUrl', 'keybindings', 'maxOpenEditors',
      'nativeOpenExts', 'sidebarMinWidth', 'svnPath', 'tortoisePath',
    ].sort())
  })
})
