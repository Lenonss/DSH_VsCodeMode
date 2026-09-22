/**
 * dsh-vscode-mode host — 在 OS 文件浏览器中打开/定位路径（reveal 能力）。
 * 纯函数 revealCommand 平台分发 + revealSpawnOpts 启动选项 + revealInExplorer 发射。
 * 文件 → 资源管理器选中定位；目录 → 打开目录；Linux 无通用定位协议 → 打开所在目录。
 *
 * 刻意**不经** ctx.subprocess.spawn：DSH 的 Windows Job runner 硬编码
 * `windowsHide: true`（dsh-subprocess-local 的 launchWindowsJob 与 runner 内部 spawn），
 * 连 explorer.exe 的 GUI 窗口一并隐藏——RPC 回 ok:true 但窗口根本不出现。
 * GUI 拉起属 fire-and-forget，用 node child_process + detached + unref 才贴合语义。
 * 作者 ddj 2026年08月27号 / 2026年09月20号
 */
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'

/** reveal 结果（沿 revert.ts 的 Result 风格）。 */
export type RevealResult = { ok: true } | { ok: false; error: string }

/**
 * 构造平台 opener 的 argv（纯函数，platform 可注入便于单测）。
 * @author ddj 2026年08月27号
 * @param absPath 绝对路径
 * @param isDir 是否为目录
 * @param platform 目标平台（缺省当前进程平台）
 * @returns opener argv（无 shell 插值）
 */
export function revealCommand(absPath: string, isDir: boolean, platform: NodeJS.Platform = process.platform): { argv: string[] } {
  switch (platform) {
    case 'darwin':
      return { argv: ['open', '-R', absPath] }
    case 'win32':
      // 文件 → 定位并选中；目录 → 直接打开该目录
      return isDir
        ? { argv: ['explorer.exe', absPath] }
        : { argv: ['explorer.exe', '/select,', absPath] }
    default:
      // Linux 无通用 select 协议：文件打开所在目录、目录打开自身（KISS，对齐 better-sidebar）
      return { argv: ['xdg-open', isDir ? absPath : dirname(absPath)] }
  }
}

/**
 * 构造 opener 子进程启动选项。
 * `windowsHide` 必须为 **false**：置 true 会把 Explorer 等 GUI 窗口一起隐藏，
 * 症状即「RPC 回 ok:true 但窗口不出现」（本文件头注释记录的回归）。
 * @author ddj 2026年09月20号
 * @param cwd 子进程工作目录（打开文件时用其父目录）
 * @returns child_process.spawn 选项
 */
export function revealSpawnOpts(cwd: string): { cwd: string; stdio: 'ignore'; windowsHide: false; detached: true } {
  return { cwd, stdio: 'ignore', windowsHide: false, detached: true }
}

/**
 * 发射 opener 拉起 OS 文件浏览器（fire-and-forget 语义）。
 * Explorer 为 GUI 分离进程，非零退出码不视为失败，故只等 spawn 事件即返回；
 * 子进程脱离父进程组并 unref，避免阻塞宿主退出。
 * @author ddj 2026年08月27号 / 2026年09月20号
 * @param absPath 绝对路径
 * @param isDir 是否为目录
 * @returns 成功或失败原因
 */
export async function revealInExplorer(absPath: string, isDir: boolean): Promise<RevealResult> {
  const [program, ...args] = revealCommand(absPath, isDir).argv
  if (!program) return { ok: false, error: '打开失败：opener 命令为空' }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(program, args, revealSpawnOpts(dirname(absPath)))
      child.once('spawn', () => { child.unref(); resolve() })
      child.once('error', (error) => { reject(error) })
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: '打开失败：' + String(error) }
  }
}
