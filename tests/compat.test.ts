/** host 兼容层测试：身份常量 / 探测 / 护栏 / 报告。作者 ddj 2026年08月24号 */
import { describe, expect, it } from 'vitest'
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
