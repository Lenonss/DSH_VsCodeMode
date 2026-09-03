/**
 * lsp/envRequirements.ts 环境需求检测测试（临时目录伪造扩展布局，不触网络）。
 * 覆盖：DotRush 缺运行时 → dotnet-runtime 需求（installable + manualUrl）、
 * 运行时满足 → 空、lua → 空、非法/未知需求 id 拒绝一键安装。
 * 作者 ddj 2026-09-03
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { envRequirementsFor, installRequirement } from '../src/lsp/envRequirements.js'
import { dotnetWithRuntime } from '../src/lsp/providers.js'

/** 本轮测试创建的临时 home（afterEach 统一清理）。 */
const homes: string[] = []

afterEach(() => {
  delete process.env.DSH_LSP_EXT_DIRS
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
})

/** 建临时 home 并登记清理；同时覆盖扫描列表（隔离真实机器）。 */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-envreq-test-'))
  homes.push(home)
  process.env.DSH_LSP_EXT_DIRS = join(home, 'dsh-vscode-mode', 'extensions')
  return home
}

/** 在临时 home 安装伪 DotRush 扩展（可指定 runtimeconfig 版本号，99.0.0 必然缺失）。 */
function installDotRush(home: string, version = '26.9.244', runtimeVersion = '10.0.0'): string {
  const extDir = join(home, 'dsh-vscode-mode', 'extensions', 'nromanov.dotrush-' + version)
  const lsDir = join(extDir, 'extension', 'bin', 'LanguageServer')
  mkdirSync(lsDir, { recursive: true })
  writeFileSync(join(extDir, 'package.json'), JSON.stringify({ publisher: 'nromanov', name: 'dotrush', version }))
  writeFileSync(join(lsDir, 'DotRush.dll'), 'fake')
  writeFileSync(join(lsDir, 'DotRush.runtimeconfig.json'), JSON.stringify({
    runtimeOptions: { framework: { name: 'Microsoft.NETCore.App', version: runtimeVersion } },
  }))
  return extDir
}

describe('envRequirementsFor', () => {
  it('DotRush 需要的运行时机器上没有 → 返回可安装需求与官网链接', () => {
    const home = makeHome()
    installDotRush(home, '26.9.244', '99.0.0') // 99 版本必然不存在 → 稳定命中缺失分支
    const missing = envRequirementsFor('csharp', home)
    expect(missing).toHaveLength(1)
    expect(missing[0].id).toBe('dotnet-runtime:99')
    expect(missing[0].installable).toBe(true)
    expect(missing[0].label).toContain('.NET 运行时 99')
    expect(missing[0].manualUrl).toContain('dotnet.microsoft.com')
    expect(missing[0].detail).toContain('DotRush')
  })

  it('运行时已满足 → 无 dotnet-runtime:10 缺失项；缺失机器 → 正确报告缺失', () => {
    const home = makeHome()
    installDotRush(home, '26.9.244', '10.0.0')
    const missing = envRequirementsFor('csharp', home)
    // CI（Linux）无 .NET 10：应报告缺失；本机装有用户级 .NET 10：应满足——两种机器都断言正确行为
    if (dotnetWithRuntime(10)) {
      expect(missing.every((m) => m.id !== 'dotnet-runtime:10')).toBe(true)
    } else {
      expect(missing.some((m) => m.id === 'dotnet-runtime:10')).toBe(true)
    }
  })

  it('lua 无外部环境依赖 → 恒为空', () => {
    const home = makeHome()
    installDotRush(home)
    expect(envRequirementsFor('lua', home)).toEqual([])
  })

  it('未知语言 → 空', () => {
    expect(envRequirementsFor('rust', makeHome())).toEqual([])
  })
})

describe('installRequirement', () => {
  it('未知需求前缀拒绝安装', () => {
    expect(installRequirement('jdk:17')).toBe(false)
  })

  it('非法版本号拒绝安装', () => {
    expect(installRequirement('dotnet-runtime:abc')).toBe(false)
  })
})
