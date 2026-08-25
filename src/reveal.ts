/**
 * dsh-vscode-mode host — 在 OS 文件浏览器中打开/定位路径（reveal 能力）。
 * 纯函数 revealCommand 平台分发 + revealInExplorer 经 ctx.subprocess.spawn 发射
 * （argv 数组、无 shell 插值，沿 workspace/revert 的 subprocess 契约）。
 * 文件 → 资源管理器选中定位；目录 → 打开目录；Linux 无通用定位协议 → 打开所在目录。
 * 作者 ddj 2026-08-27
 */
import { dirname } from 'node:path'
import type { Ctx } from './store.js'

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
 * 经 host subprocess 服务发射 opener（fire-and-forget 语义）。
 * Explorer 为 GUI 分离进程，非零退出码不视为失败；仅 spawn 级错误回失败。
 * @author ddj 2026年08月27号
 * @param ctx DSH host 上下文
 * @param absPath 绝对路径
 * @param isDir 是否为目录
 * @returns 成功或失败原因
 */
export async function revealInExplorer(ctx: Ctx, absPath: string, isDir: boolean): Promise<RevealResult> {
  const sub = ctx.get('subprocess')
  if (!sub || typeof sub.spawn !== 'function') {
    return { ok: false, error: '打开文件浏览器不可用：缺少 subprocess 服务' }
  }
  const { argv } = revealCommand(absPath, isDir)
  try {
    const handle = sub.spawn({
      argv,
      cwd: dirname(absPath),
      stdio: { stdout: { maxBytes: 1 << 16 }, stderr: { maxBytes: 1 << 16 }, stdin: 'ignore' },
      graceMs: 10000,
    })
    await handle.done
    return { ok: true }
  } catch (error) {
    return { ok: false, error: '打开失败：' + String(error) }
  }
}
