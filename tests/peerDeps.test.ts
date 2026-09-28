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
}

/** 本插件实际需要跨版本运行的 DSH alpha 版本线（0.1.2 起为 alpha 线）。 */
const ALPHA_LINES = ['0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7']

for (const [name, range] of Object.entries(pkg.peerDependencies ?? {}).filter(([key]) => key.startsWith('@deepseek-ai/dsh-'))) {
  describe(name + ' semantic range', () => {
    it.each(['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2'])('accepts %s in npm and the DSH gate', (version) => {
      expect(satisfies(version, range)).toBe(true)
      expect(satisfies(version, range, { includePrerelease: true })).toBe(true)
    })
    it.each(['0.2.0-alpha.1', '0.2.0', '1.0.0'])('rejects unadapted %s', (version) => {
      expect(satisfies(version, range)).toBe(false)
      expect(satisfies(version, range, { includePrerelease: true })).toBe(false)
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

  it('每条 @deepseek-ai peer 区间都显式放行各 alpha 版本线', () => {
    // @deepseek-ai/schemastery 已移入 dependencies（见下一条），peer 面只剩 DSH 核心包
    const dshPeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/') && name !== '@deepseek-ai/schemastery')
    expect(dshPeers.length).toBeGreaterThan(0)
    for (const [name, range] of dshPeers) {
      // 低频版本线（0.1.2+）必须带 `-0` 预发布比较器，否则 alpha 一个都匹配不上
      for (const line of ALPHA_LINES) {
        expect(range, name + ' 缺少 ' + line + ' 预发布区间（需形如 >=' + line + '-0 <0.2.0-0）')
          .toContain('>=' + line + '-0')
      }
      // 上界仍须排除 0.2.0（避免误放行到未适配的次版本）
      expect(range, name + ' 缺少 <0.2.0-0 上界').toContain('<0.2.0-0')
    }
  })

  it('schema 库新名进 dependencies 钉 volatile 版，bare peer 保留旧安装树', () => {
    // 0.1.7 设置页需要 .volatile()（@deepseek-ai/schemastery 3.18.4 提供，3.18.1 无该方法）；
    // 且 npm 安装形态只装 dependencies（v0.5.2 教训：peer 在用户端解析不到）。
    expect(pkg.dependencies?.['@deepseek-ai/schemastery']).toBe('~3.18.4')
    expect(peers['@deepseek-ai/schemastery']).toBeUndefined()
    expect(peers.schemastery).toBeTruthy()
  })

  it('slots / llm / tools 仍兼容 0.0.x 早期线', () => {
    for (const name of ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']) {
      expect(peers[name]).toContain('>=0.0.1-rc.1 <0.1.0')
    }
  })

  it('peer 区间不出现空串或占位值', () => {
    for (const [name, range] of Object.entries(peers)) {
      expect(typeof range, name).toBe('string')
      expect(range.trim(), name).not.toBe('')
      expect(range, name).not.toContain('workspace:')
    }
  })
})
