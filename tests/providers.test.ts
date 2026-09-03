/**
 * lsp/providers.ts C# 发现纯函数测试（临时目录伪造扩展布局，不启动真实服务器）。
 * 覆盖：DotRush 发现与启动参数、ms-Roslyn 优先级、皆未发现时的 reason、
 * dotnetWithRuntime 的运行时版本探测（注入候选目录）。
 * 作者 ddj 2026-09-03
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { candidateCSharpServers, dotnetCandidates, dotnetWithRuntime, findSdkRoot, resolveCSharpProvider, sdkEnvOf, sdkVersionOf } from '../src/lsp/providers.js'

/** 本轮测试创建的临时 home（afterEach 统一清理）。 */
const homes: string[] = []

afterEach(() => {
  delete process.env.DSH_LSP_EXT_DIRS
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
})

/** 建临时 home 并登记清理；同时把扫描列表覆盖为该 home 的 extensions 目录（隔离真实机器）。 */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-lsp-test-'))
  homes.push(home)
  process.env.DSH_LSP_EXT_DIRS = join(home, 'dsh-vscode-mode', 'extensions')
  return home
}

/** 在临时 home 安装伪 DotRush 扩展（package.json + LanguageServer/DotRush.dll + runtimeconfig）。 */
function installDotRush(home: string, version = '26.9.244'): string {
  const extDir = join(home, 'dsh-vscode-mode', 'extensions', 'nromanov.dotrush-' + version)
  const lsDir = join(extDir, 'extension', 'bin', 'LanguageServer')
  mkdirSync(lsDir, { recursive: true })
  writeFileSync(join(extDir, 'package.json'), JSON.stringify({ publisher: 'nromanov', name: 'dotrush', version }))
  writeFileSync(join(lsDir, 'DotRush.dll'), 'fake')
  writeFileSync(join(lsDir, 'DotRush.runtimeconfig.json'), JSON.stringify({
    runtimeOptions: { framework: { name: 'Microsoft.NETCore.App', version: '10.0.0' } },
  }))
  return extDir
}

/** 在临时 home 安装伪 ms-dotnettools.csharp 扩展（.roslyn 服务器 dll）。 */
function installMsCSharp(home: string, version = '2.75.0'): string {
  const extDir = join(home, 'dsh-vscode-mode', 'extensions', 'ms-dotnettools.csharp-' + version)
  const roslynDir = join(extDir, '.roslyn')
  mkdirSync(roslynDir, { recursive: true })
  writeFileSync(join(roslynDir, 'Microsoft.CodeAnalysis.LanguageServer.dll'), 'fake')
  return extDir
}

/** 伪造一个 dotnet 根目录（含指定版本的 shared/Microsoft.NETCore.App），返回 dotnet 可执行路径。 */
function fakeDotnet(root: string, runtimes: string[]): string {
  for (const version of runtimes) mkdirSync(join(root, 'shared', 'Microsoft.NETCore.App', version), { recursive: true })
  return join(root, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet')
}

describe('candidateCSharpServers', () => {
  it('发现 DotRush 扩展的服务器 dll 与版本', () => {
    const home = makeHome()
    installDotRush(home)
    const found = candidateCSharpServers(home)
    expect(found.dotrushDll).toContain('nromanov.dotrush-26.9.244')
    expect(found.dotrushDll).toContain(join('extension', 'bin', 'LanguageServer', 'DotRush.dll'))
    expect(found.dotrushVersion).toBe('26.9.244')
    expect(found.roslynDll).toBeUndefined()
    expect(found.omnisharpExe).toBeUndefined()
  })

  it('ms-Roslyn 与 DotRush 并存时均上报（优先级由 resolver 决定）', () => {
    const home = makeHome()
    installDotRush(home)
    installMsCSharp(home)
    const found = candidateCSharpServers(home)
    expect(found.roslynDll).toBeTruthy()
    expect(found.dotrushDll).toBeTruthy()
  })

  it('多版本 DotRush 并存时取清单版本最高者', () => {
    const home = makeHome()
    installDotRush(home, '26.9.244')
    installDotRush(home, '26.10.1')
    const found = candidateCSharpServers(home)
    expect(found.dotrushVersion).toBe('26.10.1')
    expect(found.dotrushDll).toContain('26.10.1')
  })
})

describe('resolveCSharpProvider', () => {
  it('仅有 DotRush：可运行时 argv=[dotnet, DotRush.dll] 无 --stdio；否则 none 并提示缺 .NET 10', () => {
    const home = makeHome()
    installDotRush(home)
    const spec = resolveCSharpProvider(undefined, home)
    if (dotnetWithRuntime(10)) {
      expect(spec.kind).toBe('discover')
      expect(spec.argv).toHaveLength(2)
      expect(spec.argv[1]).toContain('DotRush.dll')
      expect(spec.argv).not.toContain('--stdio')
      expect(spec.providerName).toBe('DotRush')
      expect(spec.version).toBe('26.9.244')
    } else {
      expect(spec.kind).toBe('none')
      expect(spec.ready).toBe(false)
      expect(spec.reason).toContain('.NET 10')
    }
  })

  it('ms-Roslyn 优先于 DotRush（本机有 dotnet 时）', () => {
    const home = makeHome()
    installDotRush(home)
    installMsCSharp(home)
    const spec = resolveCSharpProvider(undefined, home)
    if (dotnetCandidates().length) {
      expect(spec.kind).toBe('discover')
      expect(spec.argv[1]).toContain('Microsoft.CodeAnalysis.LanguageServer.dll')
      expect(spec.argv[2]).toBe('--stdio')
    } else {
      expect(spec.kind).toBe('none')
    }
  })

  it('皆未发现：reason 提示 ms-dotnettools.csharp / DotRush 两类扩展', () => {
    const spec = resolveCSharpProvider(undefined, makeHome())
    expect(spec.ready).toBe(false)
    expect(spec.reason).toContain('未发现 ms-dotnettools.csharp / DotRush 扩展')
  })
})

describe('dotnetWithRuntime', () => {
  it('按大版本挑选满足运行时要求的 dotnet', () => {
    const rootA = makeHome()
    const rootB = makeHome()
    const dotnetA = fakeDotnet(join(rootA, 'dotnet-a'), ['9.0.10'])
    const dotnetB = fakeDotnet(join(rootB, 'dotnet-b'), ['8.0.13', '10.0.5'])
    expect(dotnetWithRuntime(10, [dotnetA, dotnetB])).toBe(dotnetB)
    expect(dotnetWithRuntime(9, [dotnetA, dotnetB])).toBe(dotnetA)
    expect(dotnetWithRuntime(11, [dotnetA, dotnetB])).toBeNull()
  })
})

describe('findSdkRoot / sdkEnvOf', () => {
  it('挑选含 sdk 目录的 dotnet 根并生成环境变量', () => {
    const rootA = makeHome()
    const rootB = makeHome()
    const noSdk = fakeDotnet(join(rootA, 'dotnet-a'), [])
    const withSdkRoot = join(rootB, 'dotnet-b')
    mkdirSync(join(withSdkRoot, 'sdk', '9.0.306'), { recursive: true })
    const withSdk = join(withSdkRoot, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet')
    expect(findSdkRoot([noSdk, withSdk])).toBe(withSdkRoot)
    expect(sdkVersionOf(withSdkRoot)).toBe('9.0.306')
    const env = sdkEnvOf(withSdkRoot)
    expect(env.DOTNET_ROOT).toBe(withSdkRoot)
    expect(env.DOTNET_MSBUILD_SDK_RESOLVER_CLI_DIR).toBe(withSdkRoot)
    expect(env.DOTNET_SDK_PATH).toBe(join(withSdkRoot, 'sdk', '9.0.306'))
  })

  it('无 SDK 的候选返回 null / 空', () => {
    const root = makeHome()
    const noSdk = fakeDotnet(join(root, 'd'), [])
    expect(findSdkRoot([noSdk])).toBeNull()
    expect(sdkVersionOf(join(root, 'd'))).toBeNull()
  })
})
