/**
 * host integrate.ts 纯函数测试：注册表键路径 / command 值 / ini 内容 / 工具路径派生 /
 * POSIX 注册路径与脚本内容（Nautilus/Dolphin/Finder/marker）。不 spawn 任何进程。
 * 作者 ddj 2026-09-07
 */
import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_TOKEN,
  cscCandidates,
  commandValue,
  dolphinMenu,
  dolphinMenuPaths,
  FILE_TOKEN,
  finderWorkflowPath,
  iniContent,
  LAUNCHER_EXE,
  LAUNCHER_PS1,
  LAUNCHER_SH,
  markerFile,
  menuKeyPaths,
  nautilusPath,
  nautilusScript,
  ps1CommandValue,
  regExe,
} from '../src/integrate.js'
import { INTEGRATION_BASE_DEFAULT } from '../src/shared/integration.js'

describe('menuKeyPaths', () => {
  it('三类菜单键固定在 HKCU\\Software\\Classes（免管理员）', () => {
    const paths = menuKeyPaths()
    expect(paths.files).toBe('HKCU\\Software\\Classes\\*\\shell\\DSHEditor')
    expect(paths.dir).toBe('HKCU\\Software\\Classes\\Directory\\shell\\DSHEditor')
    expect(paths.background).toBe('HKCU\\Software\\Classes\\Directory\\Background\\shell\\DSHEditor')
  })
})

describe('commandValue / ps1CommandValue', () => {
  it('exe 版 command：<exe> "%1"（引号包裹含空格路径）', () => {
    expect(commandValue('C:\\Program Files\\dsh-open.exe')).toBe('"C:\\Program Files\\dsh-open.exe" "%1"')
  })

  it('文件夹空白处用 %V 占位符', () => {
    expect(commandValue('C:\\x\\dsh-open.exe', BACKGROUND_TOKEN)).toBe('"C:\\x\\dsh-open.exe" "%V"')
    expect(FILE_TOKEN).toBe('%1')
  })

  it('ps1 版 command：隐藏窗口运行脚本', () => {
    const value = ps1CommandValue('C:\\shell\\dsh-open.ps1', BACKGROUND_TOKEN, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(value).toBe('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\shell\\dsh-open.ps1" "%V"')
  })
})

describe('iniContent / 工具路径', () => {
  it('ini 内容去掉尾斜杠影响由 launcher 侧 Trim 处理，这里只写 base 行', () => {
    expect(iniContent('http://127.0.0.1:9999')).toBe('[dsh]\nbase=http://127.0.0.1:9999\n')
    expect(iniContent('')).toBe('[dsh]\nbase=' + INTEGRATION_BASE_DEFAULT + '\n')
  })

  it('reg.exe / csc.exe 由 SystemRoot 派生', () => {
    expect(regExe({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\reg.exe')
    expect(regExe({})).toBe('C:\\Windows\\System32\\reg.exe')
    const candidates = cscCandidates({ SystemRoot: 'C:\\Windows' })
    expect(candidates[0]).toContain('Framework64')
    expect(candidates[1]).toContain('Microsoft.NET\\Framework\\v4.0.30319')
    expect(LAUNCHER_EXE).toBe('dsh-open.exe')
    expect(LAUNCHER_PS1).toBe('dsh-open.ps1')
  })
})

describe('POSIX 注册（纯路径/内容，跨平台分隔符归一）', () => {
  const slash = (p: string): string => p.replace(/\\/g, '/')

  it('Nautilus / Dolphin / Finder / marker 路径固定（home 可注入）', () => {
    expect(slash(nautilusPath('/home/u'))).toBe('/home/u/.local/share/nautilus/scripts/在 DSH 文件编辑中打开')
    const menus = dolphinMenuPaths('/home/u').map(slash)
    expect(menus).toEqual([
      '/home/u/.local/share/kio/servicemenus/dsh-editor.desktop',
      '/home/u/.local/share/kservices5/ServiceMenus/dsh-editor.desktop',
    ])
    expect(slash(finderWorkflowPath('/Users/u'))).toBe('/Users/u/Library/Services/在 DSH 文件编辑中打开.workflow')
    expect(slash(markerFile('/home/u/.dsh'))).toBe('/home/u/.dsh/dsh-vscode-mode/shell/registered.json')
    expect(LAUNCHER_SH).toBe('dsh-open.sh')
  })

  it('Nautilus 脚本内容：shebang + launcher 引用 + 多选循环', () => {
    const script = nautilusScript('/home/u/.dsh/dsh-vscode-mode/shell/dsh-open.sh')
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(script).toContain('NAUTILUS_SCRIPT_SELECTED_FILE_PATHS')
    expect(script).toContain('shell/' + LAUNCHER_SH)
  })

  it('Dolphin 服务菜单内容：Exec 引号包裹 + %F 多选', () => {
    const menu = dolphinMenu('/home/u/.dsh/dsh-vscode-mode/shell/dsh-open.sh')
    expect(menu).toContain('Name=在 DSH 文件编辑中打开')
    expect(menu).toContain('Exec="/home/u/.dsh/dsh-vscode-mode/shell/dsh-open.sh" %F')
    expect(menu).toContain('KonqPopupMenu/Plugin')
  })
})
