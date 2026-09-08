/**
 * dsh-vscode-mode host — 资源管理器右键菜单「在 DSH 文件编辑中打开」（跨平台）。
 * - Windows：launcher（assets/shell/dsh-open.cs 经 csc 编译 WinExe，csc 缺失降级 ps1）安装到
 *   ~/.dsh/dsh-vscode-mode/shell/，HKCU\Software\Classes 三类菜单键（`*`/Directory/Directory\Background）。
 * - Linux：dsh-open.sh + GNOME Files（Nautilus）右键脚本 + KDE Dolphin 服务菜单（纯文件写入）。
 * - macOS：dsh-open.sh（Finder 快速操作由用户按配方手动创建，自动检测/移除）。
 * 生命周期：注册成功写 marker（shell/registered.json）→ 插件卸载/reload 清理注册痕迹，
 * 启动时 marker 存在则自动恢复（更新插件不丢注册）；用户显式「移除注册」删 marker 永不自动恢复。
 * 所有 reg/csc 调用经 subprocess 服务 argv 数组（卸载清理用 child_process 直调，teardown 可靠）。
 * 纯函数（键路径/命令行/ini/脚本内容）可单测。
 * 作者 ddj 2026-09-07
 */
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assetsDirOf, dshHome, PLUGIN_ID } from './paths.js'
import { INTEGRATION_BASE_DEFAULT, SHELL_MENU_LEAF } from './shared/integration.js'
import { unitySourceDir } from './unityBridge.js'
import type { ShellIntegrationStatus, ShellLauncherState, ShellMenuEntry } from './shared/integration.js'
import type { Ctx } from './store.js'

/** 菜单显示名（Windows 键默认值 / Linux 菜单项名 / macOS workflow 名）。 */
export const MENU_LABEL = '在 DSH 文件编辑中打开'
/** 编译 launcher 文件名（Windows）。 */
export const LAUNCHER_EXE = 'dsh-open.exe'
/** launcher C# 源文件名。 */
export const LAUNCHER_CS = 'dsh-open.cs'
/** 降级 launcher 脚本名（Windows）。 */
export const LAUNCHER_PS1 = 'dsh-open.ps1'
/** POSIX launcher 脚本名（Linux/macOS 通用）。 */
export const LAUNCHER_SH = 'dsh-open.sh'
/** 深链基址配置文件名。 */
export const INI_NAME = 'dsh-open.ini'
/** 注册 marker 文件名（存在 = 用户注册过且未显式移除）。 */
export const MARKER_NAME = 'registered.json'
/** command 中文件路径占位符（多选时资源管理器逐项展开重复该占位符）。 */
export const FILE_TOKEN = '%1'
/** 文件夹空白处场景的路径占位符。 */
export const BACKGROUND_TOKEN = '%V'
/** Icon 值名。 */
export const REG_VALUE_NAME_ICON = 'Icon'
/** Nautilus 右键脚本文件名。 */
export const NAUTILUS_NAME = MENU_LABEL
/** Dolphin 服务菜单文件名。 */
export const DOLPHIN_NAME = 'dsh-editor.desktop'
/** Finder 快速操作（workflow 包）目录名。 */
export const FINDER_NAME = MENU_LABEL + '.workflow'
/** DSH 小鲸鱼图标文件名（右键菜单 Icon，注册时复制到安装目录）。 */
export const WHALE_ICO = 'dsh-whale.ico'

/** 一次 argv 运行结果（退出码 + 输出）。 */
interface RunOutcome { code: number | null; output: string }

/** 注册 marker 内容。 */
interface RegistrationMarker { baseUrl: string; at: string }

/**
 * reg.exe 路径（SystemRoot 派生；env 可注入便于测试）。
 * @author ddj 2026年09月07号
 * @param env 环境映射（缺省 process.env）
 * @returns reg.exe 绝对路径
 */
export function regExe(env: Record<string, string | undefined> = process.env): string {
  return join(systemRoot(env), 'System32', 'reg.exe')
}

/**
 * csc.exe 候选列表（.NET Framework 4.x 常驻路径，按存在性取首个）。
 * @author ddj 2026年09月07号
 * @param env 环境映射（缺省 process.env）
 * @returns 候选绝对路径列表
 */
export function cscCandidates(env: Record<string, string | undefined> = process.env): string[] {
  const root = systemRoot(env)
  return [
    join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
}

/**
 * Windows 三类菜单键完整路径。
 * @author ddj 2026年09月07号
 * @param leaf 菜单键叶子名（缺省 DSHEditor）
 * @returns files/dir/background 三个键路径
 */
export function menuKeyPaths(leaf: string = SHELL_MENU_LEAF): { files: string; dir: string; background: string } {
  const root = 'HKCU\\Software\\Classes'
  return {
    files: root + '\\*\\shell\\' + leaf,
    dir: root + '\\Directory\\shell\\' + leaf,
    background: root + '\\Directory\\Background\\shell\\' + leaf,
  }
}

/**
 * launcher 安装目录（~/.dsh/dsh-vscode-mode/shell）。
 * @author ddj 2026年09月07号
 * @param home DSH home（测试可注入）
 * @returns 安装目录绝对路径
 */
export function shellInstallDir(home = dshHome()): string {
  return join(home, PLUGIN_ID, 'shell')
}

/**
 * Nautilus 右键脚本路径（~/.local/share/nautilus/scripts/）。
 * @author ddj 2026年09月07号
 * @param home 用户 home（测试可注入）
 */
export function nautilusPath(home = homedir()): string {
  return join(home, '.local', 'share', 'nautilus', 'scripts', NAUTILUS_NAME)
}

/**
 * Dolphin 服务菜单路径（新 kio/servicemenus + 旧 kservices5，两个都写）。
 * @author ddj 2026年09月07号
 * @param home 用户 home（测试可注入）
 */
export function dolphinMenuPaths(home = homedir()): string[] {
  return [
    join(home, '.local', 'share', 'kio', 'servicemenus', DOLPHIN_NAME),
    join(home, '.local', 'share', 'kservices5', 'ServiceMenus', DOLPHIN_NAME),
  ]
}

/**
 * Finder 快速操作 workflow 包路径（~/Library/Services/）。
 * @author ddj 2026年09月07号
 * @param home 用户 home（测试可注入）
 */
export function finderWorkflowPath(home = homedir()): string {
  return join(home, 'Library', 'Services', FINDER_NAME)
}

/**
 * 注册 marker 文件路径（shell/registered.json）。
 * @author ddj 2026年09月07号
 * @param home DSH home（测试可注入）
 */
export function markerFile(home = dshHome()): string {
  return join(shellInstallDir(home), MARKER_NAME)
}

/**
 * command 默认值（Windows 编译 exe 版）。
 * @author ddj 2026年09月07号
 * @param exePath launcher 绝对路径
 * @param token 路径占位符
 * @returns 注册表 command 值
 */
export function commandValue(exePath: string, token: string = FILE_TOKEN): string {
  return '"' + exePath + '" "' + token + '"'
}

/**
 * command 默认值（Windows 降级 ps1 版：隐藏窗口运行脚本）。
 * @author ddj 2026年09月07号
 * @param ps1Path launcher 脚本绝对路径
 * @param token 路径占位符
 * @param powerShell powershell.exe 路径（测试可注入）
 * @returns 注册表 command 值
 */
export function ps1CommandValue(ps1Path: string, token: string = FILE_TOKEN, powerShell = powerShellExe()): string {
  return '"' + powerShell + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ps1Path + '" "' + token + '"'
}

/**
 * dsh-open.ini 内容（base 行驱动 launcher 深链基址，三平台共用）。
 * @author ddj 2026年09月07号
 * @param baseUrl 深链基址
 * @returns ini 文件全文
 */
export function iniContent(baseUrl: string): string {
  return '[dsh]\nbase=' + (baseUrl.trim() || INTEGRATION_BASE_DEFAULT) + '\n'
}

/**
 * Nautilus 右键脚本内容（多选经 NAUTILUS_SCRIPT_SELECTED_FILE_PATHS 一次传给 launcher）。
 * @author ddj 2026年09月07号
 * @param launcherPath dsh-open.sh 绝对路径
 * @returns 脚本全文（#!/usr/bin/env bash）
 */
export function nautilusScript(launcherPath: string): string {
  return [
    '#!/usr/bin/env bash',
    '# 由 dsh-vscode-mode 生成：GNOME Files（Nautilus）右键脚本 → DSH 文件编辑',
    'launcher="$HOME/.dsh/dsh-vscode-mode/shell/' + LAUNCHER_SH + '"',
    'args=()',
    'while IFS= read -r line; do',
    '  [ -n "$line" ] && args+=("$line")',
    'done <<< "${NAUTILUS_SCRIPT_SELECTED_FILE_PATHS:-}"',
    'exec "$launcher" "${args[@]}"',
    '',
  ].join('\n')
}

/**
 * Dolphin 服务菜单内容（%F 多选传参）。
 * @author ddj 2026年09月07号
 * @param launcherPath dsh-open.sh 绝对路径
 * @returns .desktop 全文
 */
export function dolphinMenu(launcherPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Service',
    'X-KDE-ServiceTypes=KonqPopupMenu/Plugin',
    'MimeType=all/allfiles;inode/directory;',
    'Actions=openInDshEditor',
    '[Desktop Action openInDshEditor]',
    'Name=' + MENU_LABEL,
    'Icon=utilities-terminal',
    'Exec="' + launcherPath + '" %F',
    '',
  ].join('\n')
}

/** SystemRoot 解析（env 可注入）。 */
function systemRoot(env: Record<string, string | undefined>): string {
  return env.SystemRoot || 'C:\\Windows'
}

/** powershell.exe 路径（Windows 降级注册用）。 */
function powerShellExe(env: Record<string, string | undefined> = process.env): string {
  return join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** POSIX launcher 脚本安装路径。 */
function shLauncherPath(home = dshHome()): string {
  return join(shellInstallDir(home), LAUNCHER_SH)
}

/**
 * 经 subprocess 服务运行一个命令（argv 数组，无 shell 插值）。
 * ⚠️ stdio 必须 'inherit'：受管 host 环境禁止管道 stdio（node spawn pipe → EPERM），
 * inherit 直写宿主控制台且不建管道；本模块只需退出码（reg query 缺键 = 退出码 1）。
 * done 契约宽松归一化：{exitCode,signal} / {code} / undefined / 抛错（spawn 失败）。
 * @author ddj 2026年09月07号
 * @param ctx DSH 上下文
 * @param argv 命令与参数
 * @param cwd 工作目录（须已存在）
 * @returns 退出码（0=成功）
 */
async function runArgv(ctx: Ctx, argv: string[], cwd = dshHome()): Promise<RunOutcome> {
  const sub = ctx.get('subprocess')
  if (!sub || typeof sub.spawn !== 'function') throw new Error('缺少 subprocess 服务')
  let handle: { done: Promise<unknown> }
  try {
    handle = sub.spawn({
      argv,
      cwd,
      stdio: { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
      graceMs: 10000,
    })
  } catch (error) {
    return { code: 1, output: String(error) }
  }
  try {
    return normalizeOutcome(await handle.done)
  } catch (error) {
    return { code: 1, output: String(error) }
  }
}

/** 归一化 done 结果（契约宽松：{exitCode,signal} / {code} / 字符串 / undefined）。 */
function normalizeOutcome(result: unknown): RunOutcome {
  if (result == null) return { code: 0, output: '' }
  if (typeof result === 'string') return { code: 0, output: result }
  const record = result as { exitCode?: unknown; code?: unknown }
  if (typeof record.exitCode === 'number') return { code: record.exitCode, output: '' }
  if (typeof record.code === 'number') return { code: record.code, output: '' }
  return { code: 0, output: '' }
}

/** 文件存在性探测（best-effort）。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Windows：探测一个注册表键是否存在（reg query 缺键 = 退出码 1，无需读输出）。 */
async function keyExists(ctx: Ctx, key: string): Promise<boolean> {
  const outcome = await runArgv(ctx, [regExe(), 'query', key, '/ve'])
  return outcome.code === 0
}

/** 读注册 marker（缺失/非法 → null）。 */
async function readMarker(home = dshHome()): Promise<RegistrationMarker | null> {
  try {
    const data = JSON.parse(await readFile(markerFile(home), 'utf8')) as { baseUrl?: unknown; at?: unknown }
    if (typeof data?.baseUrl !== 'string' || !data.baseUrl) return null
    return { baseUrl: data.baseUrl, at: typeof data.at === 'string' ? data.at : '' }
  } catch {
    return null
  }
}

/** 写注册 marker（父目录已存在）。 */
async function saveMarker(baseUrl: string, home = dshHome()): Promise<void> {
  const data: RegistrationMarker = { baseUrl, at: new Date().toISOString() }
  await writeFile(markerFile(home), JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/** 复制 POSIX launcher 并加执行位（三平台 ini 同写）。 */
async function installPosix(dir: string, baseUrl: string): Promise<void> {
  await copyFile(join(assetsDirOf(import.meta.url), 'shell', LAUNCHER_SH), join(dir, LAUNCHER_SH))
  await chmod(join(dir, LAUNCHER_SH), 0o755)
  await writeFile(join(dir, INI_NAME), iniContent(baseUrl), 'utf8')
}

/** 写 Nautilus 右键脚本（父目录按需创建 + 执行位）。 */
async function writeNautilus(home: string, launcherPath: string): Promise<void> {
  const script = nautilusPath(home)
  await mkdir(join(script, '..'), { recursive: true })
  await writeFile(script, nautilusScript(launcherPath), 'utf8')
  await chmod(script, 0o755)
}

/** 写 Dolphin 服务菜单（新/旧两个路径，父目录按需创建）。 */
async function writeDolphinMenus(home: string, launcherPath: string): Promise<void> {
  for (const menu of dolphinMenuPaths(home)) {
    await mkdir(join(menu, '..'), { recursive: true })
    await writeFile(menu, dolphinMenu(launcherPath), 'utf8')
  }
}

/** Linux：移除 Nautilus 脚本与 Dolphin 服务菜单（仅本插件自有文件）。 */
async function removePosixFiles(home: string): Promise<void> {
  await rm(nautilusPath(home), { force: true })
  for (const menu of dolphinMenuPaths(home)) await rm(menu, { force: true })
}

/** macOS：移除 Finder 快速操作（仅当其内容引用本插件 launcher，防误删用户手工产物）。 */
async function dropFinderMenu(home: string): Promise<void> {
  const dir = finderWorkflowPath(home)
  let text = ''
  try {
    text = await readFile(join(dir, 'Contents', 'document.wflow'), 'utf8')
  } catch {
    return
  }
  if (!text.includes('dsh-open')) return
  await rm(dir, { recursive: true, force: true })
}

/** 卸载清理专用：直调 reg delete（subprocess 服务在 teardown 可能已卸载）。⚠️ stdio 'ignore'：受管环境禁管道。 */
function regDeleteDirect(key: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(regExe(), ['delete', key, '/f'], { windowsHide: true, timeout: 5000, stdio: 'ignore' })
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * 查询系统集成状态（按平台探测条目注册状态 + launcher 安装态）。
 * @author ddj 2026年09月07号
 * @param ctx DSH 上下文
 * @param baseUrl 深链基址（设置 integrationBaseUrl）
 * @returns 集成状态
 */
export async function shellMenuStatus(ctx: Ctx, baseUrl: string): Promise<ShellIntegrationStatus> {
  const dir = shellInstallDir()
  const platform = process.platform
  let launcher: ShellLauncherState
  let entries: ShellMenuEntry[] = []
  if (platform === 'win32') {
    const exe = join(dir, LAUNCHER_EXE)
    const ps1 = join(dir, LAUNCHER_PS1)
    const compiled = await fileExists(exe)
    const ps1Present = await fileExists(ps1)
    launcher = { present: compiled || ps1Present, compiled, path: compiled ? exe : ps1 }
    entries = [
      { id: 'files', label: '文件', registered: await keyExists(ctx, menuKeyPaths().files) },
      { id: 'dir', label: '文件夹', registered: await keyExists(ctx, menuKeyPaths().dir) },
      { id: 'dirBackground', label: '文件夹空白处', registered: await keyExists(ctx, menuKeyPaths().background) },
    ]
  } else {
    const sh = shLauncherPath()
    launcher = { present: await fileExists(sh), compiled: false, path: sh }
    if (platform === 'linux') {
      const menus = dolphinMenuPaths()
      entries = [
        { id: 'nautilus', label: 'GNOME Files（Nautilus）', registered: await fileExists(nautilusPath()) },
        { id: 'dolphin', label: 'KDE Dolphin', registered: (await fileExists(menus[0])) || (await fileExists(menus[1])) },
      ]
    } else if (platform === 'darwin') {
      entries = [{ id: 'finder', label: 'Finder 快速操作', registered: await fileExists(finderWorkflowPath()), manual: true }]
    }
  }
  return { platform, launcher, entries, baseUrl, unityPackagePath: unitySourceDir() }
}

/**
 * 注册右键菜单（平台分发）：写 ini → 安装 launcher → 首次备份（Windows）→ 写菜单；
 * 成功后写 marker（驱动卸载清理与重启自动恢复）。
 * @author ddj 2026年09月07号
 * @param ctx DSH 上下文
 * @param baseUrl 深链基址
 * @returns 注册后状态
 */
export async function shellMenuRegister(ctx: Ctx, baseUrl: string): Promise<ShellIntegrationStatus> {
  const dir = shellInstallDir()
  await mkdir(dir, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(join(dir, INI_NAME), iniContent(baseUrl), 'utf8')
    await installIcon(dir)
    const compiled = await installLauncher(ctx, dir, true)
    if (!(await readMarker())) await backupKeys(ctx, dir)
    await writeMenuKeys(ctx, dir, compiled)
  } else if (process.platform === 'linux') {
    await installPosix(dir, baseUrl)
    const launcherPath = join(dir, LAUNCHER_SH)
    await writeNautilus(homedir(), launcherPath)
    await writeDolphinMenus(homedir(), launcherPath)
  } else if (process.platform === 'darwin') {
    // macOS 菜单由用户按 Automator 配方手动创建（UI 提供一键复制）；这里仅安装 launcher
    await installPosix(dir, baseUrl)
  }
  await saveMarker(baseUrl)
  return shellMenuStatus(ctx, baseUrl)
}

/**
 * 移除右键菜单注册（平台分发）+ 删除 marker（显式移除后重启不再自动恢复）。
 * @author ddj 2026年09月07号
 * @param ctx DSH 上下文
 * @param baseUrl 深链基址
 * @returns 移除后状态
 */
export async function shellMenuRemove(ctx: Ctx, baseUrl: string): Promise<ShellIntegrationStatus> {
  if (process.platform === 'win32') {
    const paths = menuKeyPaths()
    for (const key of [paths.files, paths.dir, paths.background]) {
      await runArgv(ctx, [regExe(), 'delete', key, '/f'])
    }
  } else if (process.platform === 'linux') {
    await removePosixFiles(homedir())
  } else if (process.platform === 'darwin') {
    await dropFinderMenu(homedir())
  }
  await rm(markerFile(), { force: true })
  return shellMenuStatus(ctx, baseUrl)
}

/**
 * 系统集成生命周期（index.ts 经 ctx.effect 挂载）：
 * 启动时 marker 存在 → 幂等自动恢复注册（插件更新/reload 不丢注册）；
 * 返回的 disposer 在插件卸载/reload 时清理注册痕迹（marker 保留供下次恢复）。
 * @author ddj 2026年09月07号
 * @param ctx DSH 上下文
 * @returns 卸载清理 disposer
 */
export function shellMenuLifecycle(ctx: Ctx): () => void {
  void restoreOnLoad(ctx).catch(() => {})
  return () => {
    void cleanupOnUnload().catch(() => {})
  }
}

/** 启动自动恢复：marker 存在才执行（幂等；exe 已存在跳过编译）。 */
async function restoreOnLoad(ctx: Ctx): Promise<void> {
  const marker = await readMarker()
  if (!marker) return
  await shellMenuRegister(ctx, marker.baseUrl)
}

/** 卸载清理：marker 存在 → 按平台移除注册痕迹（launcher 文件与 marker 保留）。 */
async function cleanupOnUnload(): Promise<void> {
  const marker = await readMarker()
  if (!marker) return
  if (process.platform === 'win32') {
    const paths = menuKeyPaths()
    for (const key of [paths.files, paths.dir, paths.background]) await regDeleteDirect(key)
  } else if (process.platform === 'linux') {
    await removePosixFiles(homedir())
  } else if (process.platform === 'darwin') {
    await dropFinderMenu(homedir())
  }
}

/**
 * 安装 Windows launcher：优先 csc 编译 exe（无控制台闪窗），任一候选失败降级复制 ps1。
 * @author ddj 2026年09月07号
 * @param ctx DSH 上下文
 * @param dir 安装目录（已存在）
 * @param force 是否强制重编译（自动恢复时 false：exe 已存在直接复用）
 * @returns 是否编译成功（false=降级 ps1）
 */
async function installLauncher(ctx: Ctx, dir: string, force: boolean): Promise<boolean> {
  const exe = join(dir, LAUNCHER_EXE)
  if (!force && await fileExists(exe)) return true
  const shellAssets = join(assetsDirOf(import.meta.url), 'shell')
  for (const candidate of cscCandidates()) {
    if (!(await fileExists(candidate))) continue
    try {
      await copyFile(join(shellAssets, LAUNCHER_CS), join(dir, LAUNCHER_CS))
      const outcome = await runArgv(ctx, [
        candidate,
        '/nologo',
        '/target:winexe',
        '/r:System.Windows.Forms.dll',
        '/r:System.Web.Extensions.dll',
        '/out:' + exe,
        join(dir, LAUNCHER_CS),
      ], dir)
      if (outcome.code === 0 && await fileExists(exe)) return true
    } catch { /* 任一候选失败继续降级 */ }
  }
  await copyFile(join(shellAssets, LAUNCHER_PS1), join(dir, LAUNCHER_PS1))
  return false
}

/**
 * 首次注册前备份 Windows 三类既有键（best-effort，键不存在时导出失败忽略）。
 * @author ddj 2026年09月07号
 * @param ctx DSH 上下文
 * @param dir 备份文件落盘目录
 */
async function backupKeys(ctx: Ctx, dir: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const paths = menuKeyPaths()
  const targets: Array<[string, string]> = [
    [paths.files, 'files'],
    [paths.dir, 'dir'],
    [paths.background, 'background'],
  ]
  for (const [key, name] of targets) {
    await runArgv(ctx, [regExe(), 'export', key, join(dir, 'backup-' + name + '-' + stamp + '.reg'), '/y'], dir)
  }
}

/** 复制 DSH 小鲸鱼 ico 到安装目录（右键菜单 Icon 用；缺失不阻塞注册）。 */
async function installIcon(dir: string): Promise<void> {
  try {
    await copyFile(join(assetsDirOf(import.meta.url), 'shell', WHALE_ICO), join(dir, WHALE_ICO))
  } catch { /* 图标缺失不阻塞注册 */ }
}

/**
 * 写 Windows 三类菜单键（显示名 + Icon + command 子键）。
 * @author ddj 2026年09月07号
 * @param ctx DSH 上下文
 * @param dir launcher 安装目录
 * @param compiled 是否为编译 exe（否则 ps1 command）
 */
async function writeMenuKeys(ctx: Ctx, dir: string, compiled: boolean): Promise<void> {
  const launcherPath = compiled ? join(dir, LAUNCHER_EXE) : join(dir, LAUNCHER_PS1)
  const iconPath = (await fileExists(join(dir, WHALE_ICO))) ? join(dir, WHALE_ICO) : launcherPath
  const keys: Array<[string, string]> = [
    [menuKeyPaths().files, FILE_TOKEN],
    [menuKeyPaths().dir, FILE_TOKEN],
    [menuKeyPaths().background, BACKGROUND_TOKEN],
  ]
  for (const [key, token] of keys) {
    const command = compiled ? commandValue(launcherPath, token) : ps1CommandValue(launcherPath, token)
    await addMenuKey(ctx, key, iconPath, command)
  }
}

/** 写一个 Windows 菜单键：默认值（显示名）+ Icon + command 子键。 */
async function addMenuKey(ctx: Ctx, key: string, iconPath: string, command: string): Promise<void> {
  const reg = regExe()
  await runArgv(ctx, [reg, 'add', key, '/ve', '/t', 'REG_SZ', '/d', MENU_LABEL, '/f'])
  await runArgv(ctx, [reg, 'add', key, '/v', REG_VALUE_NAME_ICON, '/t', 'REG_SZ', '/d', iconPath, '/f'])
  await runArgv(ctx, [reg, 'add', key + '\\command', '/ve', '/t', 'REG_SZ', '/d', command, '/f'])
}
