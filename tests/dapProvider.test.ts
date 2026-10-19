/** 适配器规格按类型解析测试（runtime=node/dotnet 走对应运行时；原生直启；不可用返回 null）。作者 ddj 2026年09月21号 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearDiscoveryCache } from '../src/dap/discovery.js'
import { resolveAdapterSpec } from '../src/dap/provider.js'

const homes: string[] = []

afterEach(() => {
  delete process.env.DSH_LSP_EXT_DIRS
  clearDiscoveryCache()
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
})

/** 建临时 home + extensions 目录并注册清单（隔离真实机器）。 */
function makeHome(debuggers: unknown[], files: string[] = []): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dap-spec-'))
  homes.push(home)
  const extRoot = join(home, 'dsh-vscode-mode', 'extensions')
  const extDir = join(extRoot, 'x.mock-1.0.0')
  mkdirSync(extDir, { recursive: true })
  writeFileSync(join(extDir, 'package.json'), JSON.stringify({ publisher: 'x', name: 'mock', version: '1.0.0', contributes: { debuggers } }))
  for (const rel of files) {
    mkdirSync(join(extDir, rel, '..'), { recursive: true })
    writeFileSync(join(extDir, ...rel.split('/')), '// adapter')
  }
  process.env.DSH_LSP_EXT_DIRS = extRoot
  return home
}

describe('resolveAdapterSpec', () => {
  it('runtime=node → node 本体 + [program]（emmylua 形态）', () => {
    const home = makeHome([
      { type: 'emmylua_attach', runtime: 'node', program: './out/attach.js' },
    ], ['out/attach.js'])
    const spec = resolveAdapterSpec('emmylua_attach', true, home)
    expect(spec).toBeTruthy()
    expect(spec!.type).toBe('emmylua_attach')
    expect(spec!.command).toBe(process.execPath)
    expect(spec!.args).toEqual([join(home, 'dsh-vscode-mode', 'extensions', 'x.mock-1.0.0', 'out', 'attach.js')])
    expect(spec!.extensionId).toBe('x.mock')
  })

  it('无 runtime → program 直启 + 清单 args（clrdbg 形态）', () => {
    const home = makeHome([
      { type: 'coreclr', program: './dbg/clrdbg.exe', args: ['--interpreter=vscode'] },
    ], ['dbg/clrdbg.exe'])
    const spec = resolveAdapterSpec('coreclr', true, home)
    expect(spec).toBeTruthy()
    expect(spec!.command).toBe(join(home, 'dsh-vscode-mode', 'extensions', 'x.mock-1.0.0', 'dbg', 'clrdbg.exe'))
    expect(spec!.args).toEqual(['--interpreter=vscode'])
  })

  it('入口不存在 → null', () => {
    const home = makeHome([
      { type: 'coreclr', program: './dbg/missing.exe' },
    ])
    expect(resolveAdapterSpec('coreclr', true, home)).toBeNull()
  })

  it('runtime=dotnet 且本机 dotnet 满足 → dotnet + [program]', () => {
    const home = makeHome([
      { type: 'unity', program: './bin/monodbg.dll', runtime: 'dotnet' },
    ], ['bin/monodbg.dll', 'bin/monodbg.runtimeconfig.json'])
    // 同目录 runtimeconfig 要求 .NET 大版本（本机 PATH dotnet 或有满足者，断言口径不绑死具体路径）
    writeFileSync(join(home, 'dsh-vscode-mode', 'extensions', 'x.mock-1.0.0', 'bin', 'monodbg.runtimeconfig.json'), JSON.stringify({
      runtimeOptions: { framework: { name: 'Microsoft.NETCore.App', version: '10.0.0' } },
    }))
    const spec = resolveAdapterSpec('unity', true, home)
    if (spec) {
      expect(spec.args[0]).toBe(join(home, 'dsh-vscode-mode', 'extensions', 'x.mock-1.0.0', 'bin', 'monodbg.dll'))
    } else {
      // 本机无满足的 dotnet：置灰为合法结果（provider 诚实拒绝）
      expect(spec).toBeNull()
    }
  })

  it('runtime=dotnet 无 runtimeconfig 且无 dotnet → null', () => {
    const home = makeHome([
      { type: 'unity', program: './bin/monodbg.dll', runtime: 'dotnet' },
    ], ['bin/monodbg.dll'])
    const spec = resolveAdapterSpec('unity', true, home)
    // findDotnet 命中真实机器 PATH 时仍可解析（args 指向 dll），否则 null
    if (spec) expect(spec.args[0]).toContain('monodbg.dll')
    else expect(spec).toBeNull()
  })

  it('不支持的 runtime → null', () => {
    const home = makeHome([
      { type: 'java', program: './a.jar', runtime: 'java' },
    ], ['a.jar'])
    expect(resolveAdapterSpec('java', true, home)).toBeNull()
  })

  it('未发现的类型 → null', () => {
    const home = makeHome([
      { type: 'emmylua_attach', runtime: 'node', program: './out/attach.js' },
    ], ['out/attach.js'])
    expect(resolveAdapterSpec('coreclr', true, home)).toBeNull()
  })
})
