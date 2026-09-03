/**
 * lsp/dotnetProvision.ts 纯函数测试（不触网络、不落真实目录）。
 * 覆盖：平台运行时资产挑选、用户级 dotnet 目录形态。
 * 作者 ddj 2026-09-03
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pickRuntimeAsset, userDotnetDir, type RuntimeAsset } from '../src/lsp/dotnetProvision.js'

const FILES: RuntimeAsset[] = [
  { name: 'dotnet-runtime-win-x64.zip', url: 'https://example/win-x64.zip', hash: 'a' },
  { name: 'dotnet-runtime-win-arm64.zip', url: 'https://example/win-arm64.zip', hash: 'b' },
  { name: 'dotnet-runtime-osx-x64.tar.gz', url: 'https://example/osx-x64.tar.gz', hash: 'c' },
  { name: 'dotnet-runtime-osx-arm64.tar.gz', url: 'https://example/osx-arm64.tar.gz', hash: 'd' },
  { name: 'dotnet-runtime-linux-x64.tar.gz', url: 'https://example/linux-x64.tar.gz', hash: 'e' },
]

describe('pickRuntimeAsset', () => {
  it('win32 x64 → zip 资产', () => {
    expect(pickRuntimeAsset(FILES, 'win32', 'x64')?.name).toBe('dotnet-runtime-win-x64.zip')
  })
  it('win32 arm64 → arm64 zip 资产', () => {
    expect(pickRuntimeAsset(FILES, 'win32', 'arm64')?.name).toBe('dotnet-runtime-win-arm64.zip')
  })
  it('darwin arm64 → osx tar.gz 资产', () => {
    expect(pickRuntimeAsset(FILES, 'darwin', 'arm64')?.name).toBe('dotnet-runtime-osx-arm64.tar.gz')
  })
  it('linux x64 → linux tar.gz 资产', () => {
    expect(pickRuntimeAsset(FILES, 'linux', 'x64')?.name).toBe('dotnet-runtime-linux-x64.tar.gz')
  })
  it('无匹配资产返回 null', () => {
    expect(pickRuntimeAsset([], 'win32', 'x64')).toBeNull()
  })
})

describe('userDotnetDir', () => {
  it('Windows 指向 LOCALAPPDATA\\Microsoft\\dotnet，其它平台指向 ~/.dotnet', () => {
    const dir = userDotnetDir()
    if (process.platform === 'win32') {
      expect(dir.toLowerCase()).toContain(join('microsoft', 'dotnet').toLowerCase())
    } else {
      expect(dir).toBe(join(process.env.HOME ?? '', '.dotnet'))
    }
  })
})
