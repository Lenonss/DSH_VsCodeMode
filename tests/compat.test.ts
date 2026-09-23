/** host 兼容层测试：身份常量 / 探测 / 护栏 / 报告。作者 ddj 2026年08月24号 / 2026年09月18号 / 2026年09月23号 */
import { describe, expect, it } from 'vitest'
import { buildSettingsSchema, loadSettingsDeps, resetSettingsDeps, resetConfigVolatileState, configVolatileState } from '../src/fileOpenSettings.js'
import {
  LEGACY_PROJECT_PREFIX,
  MCP_PACKAGE,
  PLUGIN_NAME,
  PROJECT_ENTRY_PREFIX,
  ROUTE_PREFIX,
  buildReport,
  detectExternal,
  detectGuards,
  duplicateEntries,
  entryHash,
  isProjectEntryId,
  noteOwnRoute,
  resetOwnRoutes,
  routeConflict,
  versionAdapters,
} from '../src/compat.js'

describe('identity constants', () => {
  it('新旧项目 MCP 前缀与判定一致', () => {
    expect(PROJECT_ENTRY_PREFIX).toBe('vsm-mcp.')
    expect(LEGACY_PROJECT_PREFIX).toBe('vsm-mcp:')
    expect(isProjectEntryId('vsm-mcp.abc123.alpha')).toBe(true)
    expect(isProjectEntryId('vsm-mcp:abc123:alpha')).toBe(true)
    expect(isProjectEntryId('include:mcp-codegraph')).toBe(false)
  })

  it('entryHash 解析新旧格式的 workspace hash', () => {
    expect(entryHash('vsm-mcp.abc123.alpha')).toBe('abc123')
    expect(entryHash('vsm-mcp:abc123:alpha')).toBe('abc123')
    expect(entryHash('include:mcp-codegraph')).toBeUndefined()
  })

  it('包名与路由前缀不漂移', () => {
    expect(PLUGIN_NAME).toBe('dsh-vscode-mode')
    expect(MCP_PACKAGE).toBe('@deepseek-ai/dsh-mcp-client')
    expect(ROUTE_PREFIX).toBe('/edrv')
  })
})

describe('routeConflict', () => {
  it('精确路由占用 /edrv 前缀时告警', () => {
    const web = { exact: new Map([['/edrv/rpc', {}]]), prefixes: new Map() }
    expect(routeConflict(web, '/edrv')).toContain('/edrv/rpc')
  })

  it('其他前缀路由与本前缀重叠时告警', () => {
    const web = { exact: new Map(), prefixes: new Map([['/edrv/vendor', {}]]) }
    expect(routeConflict(web, '/edrv')).toContain('/edrv/vendor')
    const sibling = { exact: new Map(), prefixes: new Map([['/edrv2', {}]]) }
    expect(routeConflict(sibling, '/edrv')).toBeNull()
  })

  it('无冲突或内部表不可读时返回 null', () => {
    expect(routeConflict({ exact: new Map(), prefixes: new Map() }, '/edrv')).toBeNull()
    expect(routeConflict({}, '/edrv')).toBeNull()
    expect(routeConflict(undefined, '/edrv')).toBeNull()
  })

  it('本插件自有路由不计入冲突（自误报排除）', () => {
    const web = { exact: new Map([['/edrv/rpc', {}]]), prefixes: new Map([['/edrv/vendor', {}]]) }
    expect(routeConflict(web, '/edrv')).toContain('/edrv/rpc')
    noteOwnRoute('exact', '/edrv/rpc')
    noteOwnRoute('prefix', '/edrv/vendor')
    expect(routeConflict(web, '/edrv')).toBeNull()
    resetOwnRoutes()
    expect(routeConflict(web, '/edrv')).toContain('/edrv/rpc')
  })
})

describe('duplicateEntries', () => {
  const loaderOf = (names) => ({ entries: () => names.map((name) => ({ options: { name } })) })

  it('重复装配时给出清理提示', () => {
    const ctx = { get: () => loaderOf([PLUGIN_NAME, PLUGIN_NAME, 'other']) }
    expect(duplicateEntries(ctx)).toHaveLength(1)
    expect(duplicateEntries(ctx)[0]).toContain('cordis.patch.yml')
  })

  it('唯一装配或无 loader 时无警告', () => {
    expect(duplicateEntries({ get: () => loaderOf([PLUGIN_NAME, 'other']) })).toEqual([])
    expect(duplicateEntries({ get: () => undefined })).toEqual([])
  })
})

describe('detectExternal', () => {
  const mcpCtx = {
    get: (name) => {
      if (name === 'loader') return { entries: () => [{ options: { name: MCP_PACKAGE } }, { options: { name: 'other' } }] }
      if (name === 'settings') return { describe: () => [], update: async () => {} }
      return undefined
    },
  }
  const bareCtx = { get: () => undefined }

  it('按运行时可探测到 MCP 条目与 settings 服务', () => {
    const out = detectExternal(mcpCtx, true)
    expect(out[0].name).toBe(MCP_PACKAGE)
    expect(out[0].active).toBe(true)
    expect(out[1].active).toBe(true)
    expect(out[2].active).toBe(true)
  })

  it('空环境与依赖缺失时全部 inactive 并带说明', () => {
    const out = detectExternal(bareCtx, false)
    expect(out.every((item) => !item.active)).toBe(true)
    expect(out[1].note).toContain('降级')
  })

  it('依赖可用时报告实际命中的 schema 库名（macOS 排查用）', async () => {
    resetSettingsDeps()
    // 复刻用户安装形态：安装树只有改名后的 @deepseek-ai/schemastery，无 dsh-settings legacy 导出
    const deps = await loadSettingsDeps(async (specifier: string) => {
      if (specifier === '@deepseek-ai/schemastery') {
        return { default: { object: () => ({ default: (v: unknown) => v }), string: () => ({ default: (v: unknown) => v }) } }
      }
      throw Object.assign(new Error('not found'), { code: 'ERR_MODULE_NOT_FOUND' })
    })
    expect(deps, '只给新名也必须解析成功（本次 Mac 兼容修复的核心）').not.toBeNull()
    const out = detectExternal(mcpCtx, true)
    expect(out[1].name).toBe('设置持久化（@deepseek-ai/dsh-settings）')
    expect(out[1].active).toBe(true)
    expect(out[1].note).toContain('@deepseek-ai/schemastery')
  })
})

describe('detectGuards / buildReport', () => {
  const ctx = {
    get: (name) => {
      if (name === 'webServer') return { exact: new Map(), prefixes: new Map() }
      if (name === 'loader') return { entries: () => [{ options: { name: PLUGIN_NAME } }] }
      return undefined
    },
  }

  it('护栏健康时全 active 且无警告', async () => {
    const guards = detectGuards(ctx)
    expect(guards.every((g) => g.active)).toBe(true)
    const report = await buildReport(ctx, { depsAvailable: true, version: '9.9.9' })
    expect(report.pluginVersion).toBe('9.9.9')
    expect(report.warnings).toEqual([])
  })

  it('依赖缺失与路由冲突进入警告', async () => {
    const broken = {
      get: (name) => {
        if (name === 'webServer') return { exact: new Map([['/edrv/rpc', {}]]), prefixes: new Map() }
        if (name === 'loader') return { entries: () => [{ options: { name: PLUGIN_NAME } }, { options: { name: PLUGIN_NAME } }] }
        return undefined
      },
    }
    const report = await buildReport(broken, { depsAvailable: false, version: '9.9.9' })
    expect(report.warnings.some((w) => w.includes('dsh-settings'))).toBe(true)
    expect(report.warnings.some((w) => w.includes('/edrv'))).toBe(true)
    expect(report.warnings.some((w) => w.includes('cordis.patch.yml'))).toBe(true)
  })
})

describe('版本上界与 Config volatile 告警', () => {
  const ctx = {
    get: (name: string) => {
      if (name === 'webServer') return { exact: new Map(), prefixes: new Map() }
      if (name === 'loader') return { entries: () => [{ options: { name: PLUGIN_NAME } }] }
      return undefined
    },
  } as never

  /** 无 .volatile() 能力的 z 桩（复刻旧 schemastery 3.18.1）。 */
  const zLegacy = {
    object: (shape: unknown) => ({ default: (value: unknown) => ({ shape, value }) }),
    string: () => ({ default: (value: unknown) => value }),
    boolean: () => ({ default: (value: unknown) => value }),
    number: () => ({ default: (value: unknown) => value }),
  }
  /** 有 .volatile() 能力的 z 桩（复刻 3.18.4）。 */
  const zCapable = {
    lift: (field: Record<string, unknown>) => ({ ...field, volatile: () => ({ ...field, volatileMarked: true }) }),
    object(shape: unknown) { return { default: (value: unknown) => this.lift({ shape, value }) } },
    string() { return { default: (value: unknown) => this.lift({ value }) } },
    boolean() { return { default: (value: unknown) => this.lift({ value }) } },
    number() { return { default: (value: unknown) => this.lift({ value }) } },
  }

  it('0.1.7-alpha.2 不再报「高于已实测版本」；alpha.3 报且带上界新值', async () => {
    resetConfigVolatileState()
    const ok = await buildReport(ctx, { depsAvailable: true, version: '9.9.9', dshVersion: '0.1.7-alpha.2' })
    expect(ok.warnings.some((w) => w.includes('高于已实测版本'))).toBe(false)
    const next = await buildReport(ctx, { depsAvailable: true, version: '9.9.9', dshVersion: '0.1.7-alpha.3' })
    expect(next.warnings.some((w) => w.includes('0.1.7-alpha.2'))).toBe(true)
  })

  it('volatile 标记不完整且在 0.1.7 线 → 显式告警 + 适配行红', async () => {
    resetConfigVolatileState()
    buildSettingsSchema(zLegacy as never, { volatile: true })
    expect(configVolatileState()).toEqual({ requested: true, marked: 0, total: 15 })
    const report = await buildReport(ctx, { depsAvailable: true, version: '9.9.9', dshVersion: '0.1.7-alpha.2' })
    expect(report.warnings.some((w) => w.includes('volatile'))).toBe(true)
    const row = versionAdapters('0.1.7-alpha.2').find((item) => item.name.includes('volatile'))
    expect(row?.active).toBe(false)
    // 旧线（section 安装语义）不告警
    const old = await buildReport(ctx, { depsAvailable: true, version: '9.9.9', dshVersion: '0.1.6-alpha.2' })
    expect(old.warnings.some((w) => w.includes('volatile'))).toBe(false)
  })

  it('volatile 全量标记 → 无告警 + 适配行绿；未请求时不出该行', async () => {
    resetConfigVolatileState()
    buildSettingsSchema(zCapable as never, { volatile: true })
    const report = await buildReport(ctx, { depsAvailable: true, version: '9.9.9', dshVersion: '0.1.7-alpha.2' })
    expect(report.warnings.some((w) => w.includes('volatile'))).toBe(false)
    const row = versionAdapters('0.1.7-alpha.2').find((item) => item.name.includes('volatile'))
    expect(row?.active).toBe(true)
    expect(row?.note).toContain('15/15')
    resetConfigVolatileState()
    expect(versionAdapters('0.1.7-alpha.2').some((item) => item.name.includes('volatile'))).toBe(false)
  })
})
