/**
 * dsh-vscode-mode host — LSP 环境需求检测注册表。
 * 每个语言注册一个检测器：扫描当前环境，返回未满足的需求清单（含一键安装与官网链接信息）。
 * 新接入 LSP：在 CHECKERS 加一个检测器条目；需要内置安装器时在 INSTALLERS 注册同前缀安装函数。
 * 检测在 status/redetect/configUpdate 时执行（不缓存），保证安装完成后状态即时刷新。
 * 作者 ddj 2026年09月03号
 */
import { dirname } from 'node:path'
import { candidateCSharpServers, dotnetWithRuntime, runtimeMajorOf } from './providers.js'
import { startEnvInstall } from './dotnetProvision.js'
import type { LspMissingEnv } from '../shared/lsp.js'

/** dotnet 运行时需求构造（DotRush / ms-Roslyn 共用）。 */
function dotnetRuntimeRequirement(major: number, detail: string): LspMissingEnv {
  return {
    id: 'dotnet-runtime:' + major,
    label: '.NET 运行时 ' + major + '.0',
    detail,
    installable: true,
    manualUrl: 'https://dotnet.microsoft.com/download/dotnet/' + major + '.0',
    manualLabel: '官网下载',
  }
}

/** csharp 检测器：DotRush 缺运行时 / ms-Roslyn 缺 dotnet。 */
function checkCSharp(home: string): LspMissingEnv[] {
  const found = candidateCSharpServers(home)
  const missing: LspMissingEnv[] = []
  if (found.dotrushDll) {
    const major = runtimeMajorOf(dirname(found.dotrushDll))
    if (major !== null && dotnetWithRuntime(major) === null) {
      missing.push(dotnetRuntimeRequirement(major, 'DotRush 语言服务器运行所需'))
    }
    return missing
  }
  if (found.roslynDll && !found.dotnet) {
    // 官方 Roslyn 服务器分支未实测，保守按 LTS 8 基线提示
    missing.push(dotnetRuntimeRequirement(8, 'Roslyn 语言服务器运行所需'))
  }
  return missing
}

/** lua 检测器：EmmyLua/LuaLS 自带运行时，无外部依赖。 */
function checkLua(): LspMissingEnv[] {
  return []
}

/** 检测器注册表（按 languageId；新 LSP 在此加条目即可）。 */
const CHECKERS: Record<string, (home: string) => LspMissingEnv[]> = {
  lua: checkLua,
  csharp: checkCSharp,
}

/** 安装器注册表（按需求 id 前缀匹配；新依赖类型在此加条目）。 */
const INSTALLERS: { prefix: string; run: (id: string) => boolean }[] = [
  {
    prefix: 'dotnet-runtime:',
    run: (id) => {
      const major = Number.parseInt(id.slice('dotnet-runtime:'.length), 10)
      return Number.isInteger(major) ? startEnvInstall(major) : false
    },
  },
]

/**
 * 检测某语言未满足的环境需求（仅返回缺失项；检测器异常按无需求处理）。
 * @author ddj 2026年09月03号
 * @param languageId 语言 id
 * @param home DSH home（测试可注入临时目录）
 * @returns 缺失需求清单
 */
export function envRequirementsFor(languageId: string, home: string): LspMissingEnv[] {
  const checker = CHECKERS[languageId]
  if (!checker) return []
  try {
    return checker(home)
  } catch {
    return []
  }
}

/**
 * 尝试一键安装某条需求（存在内置安装器时启动，进行中/已满足返回 false）。
 * @author ddj 2026年09月03号
 * @param id 需求标识（如 dotnet-runtime:10）
 * @returns 是否成功启动安装
 */
export function installRequirement(id: string): boolean {
  const installer = INSTALLERS.find((it) => id.startsWith(it.prefix))
  if (!installer) return false
  return installer.run(id)
}
