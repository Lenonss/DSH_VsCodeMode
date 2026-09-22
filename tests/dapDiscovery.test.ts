/** 清单驱动适配器发现测试（临时 home 伪造扩展布局，不读真实机器）。作者 ddj 2026年09月21号 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearDiscoveryCache, debuggerDecls } from '../src/dap/discovery.js'

const homes: string[] = []

afterEach(() => {
  delete process.env.DSH_LSP_EXT_DIRS
  clearDiscoveryCache()
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
})

/** 建临时 home 并把扫描列表覆盖为其 extensions 目录（隔离真实机器，沿用 providers.test 惯例）。 */
function makeHome(): { home: string; extRoot: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dap-disc-'))
  homes.push(home)
  const extRoot = join(home, 'dsh-vscode-mode', 'extensions')
  mkdirSync(extRoot, { recursive: true })
  process.env.DSH_LSP_EXT_DIRS = extRoot
  return { home, extRoot }
}

/** 写伪扩展清单 + 任意占位入口文件。 */
function installExt(extRoot: string, dirName: string, debuggers: unknown[], files: string[] = []): string {
  const extDir = join(extRoot, dirName)
  mkdirSync(extDir, { recursive: true })
  writeFileSync(join(extDir, 'package.json'), JSON.stringify({ publisher: 'x', name: dirName, version: '1.0.0', contributes: { debuggers } }))
  for (const rel of files) {
    mkdirSync(join(extDir, rel, '..'), { recursive: true })
    writeFileSync(join(extDir, ...rel.split('/')), '// adapter')
  }
  return extDir
}

describe('debuggerDecls', () => {
  it('识别 node 运行时适配器（emmylua 形态）与平台 program 覆盖', () => {
    const { extRoot } = makeHome()
    installExt(extRoot, 'tangzx.emmylua-0.9.41', [
      {
        type: 'emmylua_attach', label: 'EmmyLua Attach', runtime: 'node',
        program: './out/attach.js',
        configurationAttributes: { attach: { properties: { ext: { default: ['.lua', '.lua.txt', '.lua.bytes'] } } } },
      },
    ], ['out/attach.js'])
    const decls = debuggerDecls(true, extRoot)
    const attach = decls.find((d) => d.type === 'emmylua_attach')
    expect(attach).toBeTruthy()
    expect(attach!.available).toBe(true)
    expect(attach!.runtime).toBe('node')
    expect(attach!.program).toBe(join(extRoot, 'tangzx.emmylua-0.9.41', 'out', 'attach.js'))
    expect(attach!.exts).toEqual(['.lua', '.lua.txt', '.lua.bytes'])
    expect(attach!.extensionId).toBe('tangzx.emmylua')
  })

  it('识别原生可执行适配器（windows.program 覆盖 + args 透传）', () => {
    const { extRoot } = makeHome()
    // 真实 DotRush 清单声明 languages（未声明则 exts 不限 = []）；基名 + .exe 双入口文件保证两平台 available
    installExt(extRoot, 'nromanov.dotrush-26.9.244', [
      { type: 'coreclr', label: '.NET Core Debugger', program: 'extension/bin/Debugger/clrdbg', args: ['--interpreter=vscode'], languages: ['csharp'], windows: { program: 'extension/bin/Debugger/clrdbg.exe' } },
    ], ['extension/bin/Debugger/clrdbg', 'extension/bin/Debugger/clrdbg.exe'])
    const decls = debuggerDecls(true, extRoot)
    const coreclr = decls.find((d) => d.type === 'coreclr')
    expect(coreclr).toBeTruthy()
    expect(coreclr!.available).toBe(true)
    expect(coreclr!.runtime).toBeUndefined()
    expect(coreclr!.args).toEqual(['--interpreter=vscode'])
    expect(coreclr!.program.endsWith('clrdbg.exe') || coreclr!.program.endsWith('clrdbg')).toBe(true)
    expect(coreclr!.exts).toEqual(['.cs', '.csx'])
  })

  it('入口不存在 → available=false 带原因（如 DotRush 按需下载的 clrdbg）', () => {
    const { extRoot } = makeHome()
    installExt(extRoot, 'nromanov.dotrush-26.9.244', [
      { type: 'coreclr', label: '.NET Core Debugger', program: 'extension/bin/Debugger/clrdbg', windows: { program: 'extension/bin/Debugger/clrdbg.exe' } },
    ])
    const decls = debuggerDecls(true, extRoot)
    const coreclr = decls.find((d) => d.type === 'coreclr')
    expect(coreclr!.available).toBe(false)
    expect(coreclr!.reason).toContain('适配器入口不存在')
  })

  it('同 type 多扩展并存 → 清单版本降序取最高（0.10.0 > 0.9.41，numeric 感知）', () => {
    const { extRoot } = makeHome()
    installExt(extRoot, 'tangzx.emmylua-0.9.41', [
      { type: 'emmylua_attach', program: './out/old.js' },
    ], ['out/old.js'])
    installExt(extRoot, 'tangzx.emmylua-0.10.0', [
      { type: 'emmylua_attach', program: './out/new.js' },
    ], ['out/new.js'])
    const decls = debuggerDecls(true, extRoot)
    expect(decls.filter((d) => d.type === 'emmylua_attach')).toHaveLength(1)
    expect(decls.find((d) => d.type === 'emmylua_attach')!.program.endsWith('new.js')).toBe(true)
  })

  it('不支持的 runtime → available=false 带原因', () => {
    const { extRoot } = makeHome()
    installExt(extRoot, 'x.some-jvm-1.0.0', [
      { type: 'java', program: './a.jar', runtime: 'java' },
    ], ['a.jar'])
    const decls = debuggerDecls(true, extRoot)
    const java = decls.find((d) => d.type === 'java')
    expect(java!.available).toBe(false)
    expect(java!.reason).toContain('暂不支持运行时')
  })

  it('languages → 扩展名映射（LSP 侧同源）', () => {
    const { extRoot } = makeHome()
    installExt(extRoot, 'x.lang-1.0.0', [
      { type: 'csharp', program: './a.exe', languages: ['csharp'] },
    ], ['a.exe'])
    const decls = debuggerDecls(true, extRoot)
    expect(decls.find((d) => d.type === 'csharp')!.exts).toEqual(['.cs', '.csx'])
  })

  it('无扩展根 / 无声明 → 空表', () => {
    const { home } = makeHome()
    expect(debuggerDecls(true, home)).toEqual([])
  })
})
