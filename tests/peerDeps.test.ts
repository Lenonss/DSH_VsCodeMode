/**
 * Test peer declarations using real semver rules.
 * npm excludes undeclared prerelease tuples; DSH's compatibility gate passes includePrerelease.
 * @author ddj 2026年09月28号
 */
import { satisfies } from 'semver'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
}

/** 跨版本样本用于验证宽松策略，不构成安装白名单。 */
const RELEASES = ['0.0.1', '0.1.7', '0.2.0', '1.0.0', '9.0.0']
const PRERELEASES = ['0.0.1-rc.1', '0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-alpha.2', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.3', '0.3.0-alpha.1', '1.0.0-rc.1', '9.0.0-alpha.1']
const dshPeers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

for (const [name, range] of dshPeers) {
  describe(name + ' semantic range', () => {
    it.each(RELEASES)('accepts release %s in npm and the DSH gate', (version) => {
      expect(satisfies(version, range)).toBe(true)
      expect(satisfies(version, range, { includePrerelease: true })).toBe(true)
    })
    it.each(PRERELEASES)('accepts prerelease %s in DSH; npm retains its default exclusion', (version) => {
      expect(satisfies(version, range)).toBe(false)
      expect(satisfies(version, range, { includePrerelease: true })).toBe(true)
    })
  })
}

describe('peerDependencies', () => {
  const peers = pkg.peerDependencies ?? {}

  it('不再声明已从核心树消失的 dsh-client-runtime（G5）', () => {
    // 该包自 0.1.2-alpha.1 起移除（slots 改由 dsh-client-ui-renderer 提供），
    // 声明它会让 module-fallback 图指向不存在的包。
    expect(Object.keys(peers)).not.toContain('@deepseek-ai/dsh-client-runtime')
  })

  it('声明浏览器半实际 require 的 dsh-client-ui-primitives（G5）', () => {
    // 构建产物 lib/client.js 顶部 require 该虚拟模块，未声明属依赖清单缺失。
    expect(Object.keys(peers)).toContain('@deepseek-ai/dsh-client-ui-primitives')
  })

  it('六项 DSH peer 统一使用 *，不再枚举版本线或设置上界', () => {
    expect(dshPeers.map(([name]) => name).sort()).toEqual([
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-tools',
    ])
    for (const [name, range] of dshPeers) {
      expect(range, name).toBe('*')
    }
  })

  it('schema 库新名进 dependencies 钉 volatile 版，bare peer 保留旧安装树', () => {
    // 0.1.7 设置页需要 .volatile()（@deepseek-ai/schemastery 3.18.4 提供，3.18.1 无该方法）；
    // 且 npm 安装形态只装 dependencies（v0.5.2 教训：peer 在用户端解析不到）。
    expect(pkg.dependencies?.['@deepseek-ai/schemastery']).toBe('~3.18.4')
    expect(peers['@deepseek-ai/schemastery']).toBeUndefined()
    expect(peers.schemastery).toBeTruthy()
  })

  it('开发期 DSH 版本独立固定，不随宽松 peer 自动漂移', () => {
    const expected = {
      '@deepseek-ai/dsh-client-ui-primitives': '0.1.6-alpha.1',
      '@deepseek-ai/dsh-client-ui-settings': '0.1.0-rc.8',
      '@deepseek-ai/dsh-client-ui-slots': '0.0.1-rc.1',
      '@deepseek-ai/dsh-llm': '0.0.1-rc.1',
      '@deepseek-ai/dsh-settings': '0.1.0-rc.8',
      '@deepseek-ai/dsh-tools': '0.0.1-rc.1',
    }
    for (const [name, version] of Object.entries(expected)) {
      expect(pkg.devDependencies?.[name], name).toBe(version)
    }
  })

  it('非 DSH 依赖约束保持不变', () => {
    expect(peers.cordis).toBe('>=4.0.0-rc <5')
    expect(peers.react).toBe('^18.2.0')
    expect(peers['react-dom']).toBe('^18.2.0')
    expect(peers.schemastery).toBe('^3.18.0')
  })

  it('peer 区间不出现空串或占位值', () => {
    for (const [name, range] of Object.entries(peers)) {
      expect(typeof range, name).toBe('string')
      expect(range.trim(), name).not.toBe('')
      expect(range, name).not.toContain('workspace:')
    }
  })
})

/**
 * engines.dsh 显式声明：DSH 的兼容闸门用 includePrerelease=true 求值，
 * 且一旦声明 engines.dsh，peerDependencies 就不参与判定（dsh-app-boot unmetRequirements）。
 * 因此该区间必须同时覆盖全部已适配版本线，又拦住未适配的 0.3+。
 * @author ddj 2026年10月19号
 */
describe('engines.dsh', () => {
  const range = pkg.engines?.dsh

  /** 已适配且必须放行的版本（含预发布与正式版）。 */
  const ACCEPTED = [
    '0.1.0-rc.1', '0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-alpha.2', '0.1.7-rc.2', '0.1.7',
    '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0-rc.3', '0.2.0', '0.2.1-rc.2', '0.2.1',
  ]

  /** 低于适配下限或超出适配上限，必须拦住。 */
  const REJECTED = ['0.0.1', '0.0.1-rc.1', '0.3.0-alpha.1', '0.3.0', '1.0.0-rc.1', '9.0.0-alpha.1']

  it('声明为字符串区间，不是空串或通配', () => {
    expect(typeof range).toBe('string')
    expect(range?.trim()).not.toBe('')
    expect(range).not.toBe('*')
  })

  it.each(ACCEPTED)('放行已适配版本 %s（DSH 闸门口径）', (version) => {
    expect(satisfies(version, range as string, { includePrerelease: true })).toBe(true)
  })

  it.each(REJECTED)('拦住未适配版本 %s（DSH 闸门口径）', (version) => {
    expect(satisfies(version, range as string, { includePrerelease: true })).toBe(false)
  })
})
