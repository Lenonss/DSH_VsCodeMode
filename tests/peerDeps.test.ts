/**
 * peerDependencies 卫生与预发布区间守卫（G5：DSH 版本适配）。
 *
 * 背景：本插件跨 rc / alpha 多条版本线运行，而 semver 有个易踩的规则 ——
 * 比较器若不含预发布标识（如 `>=0.1.0-rc.1`），则**任何**预发布版本都不满足该区间。
 * 实测：`satisfies('0.1.6-alpha.2', '>=0.1.0-rc.1 <0.2.0-0') === false`。
 * 即原 peer 区间表面覆盖 alpha 线，实际一个都匹配不上；故每条 alpha 版本线都要
 * 显式写成 `<主>.<次>-0` 形式（如 `>=0.1.6-0 <0.2.0-0`）才真正放行预发布。
 *
 * 本测试不依赖 semver（插件树未安装该依赖），改为断言区间字符串包含所需的
 * 预发布比较器 —— 足以守住「区间必须对 alpha 线可见」这一契约。
 * 作者 ddj 2026年09月18号
 */
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
const ALPHA_LINES = ['0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6']

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
    // @deepseek-ai/schemastery 是第三方 vendor 包（版本线 3.18.x，与 DSH 核心版本线无关），单独断言
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

  it('schema 库 peer 同时放行新旧包名（安装树只有 @deepseek-ai/schemastery）', () => {
    // DSH 自 0.1.5 起把 vendored schemastery 改名为 @deepseek-ai/schemastery；
    // 新名必须声明（否则 module-fallback 图不含它），旧名保留兼容 rc 线。
    expect(peers['@deepseek-ai/schemastery']).toBe('>=3.18.0 <4')
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
