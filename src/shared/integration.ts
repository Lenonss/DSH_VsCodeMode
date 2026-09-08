/**
 * dsh-vscode-mode shared — 系统集成载荷契约（Windows 右键菜单 + Unity 一键安装/更新）。
 * Purity rule: no node/react imports（platform 用 string 表示）。
 * 作者 ddj 2026-09-07
 */

/** Unity 内嵌包名（UPM 包名，同时是项目 Packages/ 下的目录名）。 */
export const UNITY_PACKAGE_NAME = 'com.dsh.editor'
/** 注册表菜单键叶子名（HKCU\Software\Classes\*\shell\<leaf>）。 */
export const SHELL_MENU_LEAF = 'DSHEditor'
/** 深链基址默认值（DSH Web GUI 默认端口，dsh-web.cmd 实证）。 */
export const INTEGRATION_BASE_DEFAULT = 'http://127.0.0.1:3080'

/** launcher 安装态。 */
export interface ShellLauncherState {
  /** launcher 文件是否已安装（编译 exe 或降级 ps1）。 */
  present: boolean
  /** 是否为已编译 exe（false = 降级 ps1）。 */
  compiled: boolean
  /** launcher 文件绝对路径（未安装时为期望路径）。 */
  path: string
}

/** 一条右键菜单注册条目（跨平台：Windows 三键 / Linux 两项 / macOS 快速操作）。 */
export interface ShellMenuEntry {
  /** 条目 id（files/dir/dirBackground/nautilus/dolphin/finder）。 */
  id: string
  /** 展示名。 */
  label: string
  /** 是否已注册。 */
  registered: boolean
  /** 是否需手动创建（macOS Automator 配方）。 */
  manual?: boolean
}

/** 系统集成状态（edrv.integration.status/register/unregister 载荷）。 */
export interface ShellIntegrationStatus {
  /** 宿主平台（'win32'/'linux'/'darwin'）。 */
  platform: string
  launcher: ShellLauncherState
  /** 菜单注册条目（按平台）。 */
  entries: ShellMenuEntry[]
  /** 深链基址（设置 integrationBaseUrl）。 */
  baseUrl: string
  /** Unity 包源目录（随插件分发的 unity/com.dsh.editor 绝对路径）。 */
  unityPackagePath: string
}

/** 一个已登记 Unity 项目的安装状态（edrv.unity.* 载荷）。 */
export interface UnityProjectEntry {
  /** 项目根（归一化绝对路径）。 */
  path: string
  /** 目录名（展示标题）。 */
  title: string
  /** 已安装版本（未安装 → null）。 */
  installedVersion: string | null
  /** 已安装且版本等于包源版本。 */
  upToDate: boolean
  /** 项目目录不存在。 */
  missingDir: boolean
  /** 非法原因（非 Unity 项目根等）。 */
  error?: string
}

/** edrv.unity.list 载荷。 */
export interface UnityListPayload {
  /** 包源版本（unity/com.dsh.editor/package.json 的 version）。 */
  sourceVersion: string | null
  /** 包源目录绝对路径。 */
  sourcePath: string
  /** 已登记项目及安装状态。 */
  projects: UnityProjectEntry[]
}
