/**
 * dsh-vscode-mode host — 调试目标进程枚举（Windows）。
 * 用 PowerShell Get-Process 取 窗口标题/进程名/路径（完整 Unicode，无 GBK 乱码），
 * 等价替代 VS Code 扩展的 emmy_tool.exe list_processes（扩展侧 QuickPick 的数据源），
 * 匹配语义一致：processName 对 窗口标题 或 进程文件名 做**包含**匹配。
 * emmylua_attach 仅支持 Windows（适配器原生限制），非 Windows 返回空表。
 * 作者 ddj 2026年09月29号
 */
import { execFile } from 'node:child_process'
import type { DapProcessInfo } from '../shared/dap.js'

/** PowerShell 单行命令：仅带主窗口的进程，JSON 输出（UTF-8）。 */
export const PROCESS_LIST_CMD =
  '$OutputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
  'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |' +
  ' Select-Object Id,ProcessName,MainWindowTitle,Path | ConvertTo-Json -Compress -Depth 2'

/** 单进程 JSON 视图（ConvertTo-Json 输出形状）。 */
interface ProcessJsonRow {
  Id?: number
  ProcessName?: string
  MainWindowTitle?: string
  Path?: string | null
}

/**
 * 解析 ConvertTo-Json 输出为进程列表（纯函数，可单测）。
 * 单条时 PowerShell 输出对象而非数组，两种形状都接受。
 * @author ddj 2026年09月29号
 * @param text PowerShell stdout
 * @returns 进程列表（无效行剔除）
 */
export function parseProcessListJson(text: string): DapProcessInfo[] {
  let data: unknown
  try { data = JSON.parse(text) } catch { return [] }
  const rows = Array.isArray(data) ? data : [data]
  const out: DapProcessInfo[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const item = row as ProcessJsonRow
    const pid = typeof item.Id === 'number' ? item.Id : Number.NaN
    if (!Number.isFinite(pid) || pid <= 0) continue
    const path = typeof item.Path === 'string' ? item.Path : ''
    const name = path ? path.split(/[\\/]/).pop() ?? (item.ProcessName ?? '') : (item.ProcessName ?? '') + '.exe'
    out.push({ pid, title: typeof item.MainWindowTitle === 'string' ? item.MainWindowTitle : '', path, name })
  }
  return out
}

/**
 * 按 processName 过滤进程（与 VS Code 扩展口径一致：标题或文件名包含匹配；空串全量）。
 * @author ddj 2026年09月29号
 * @param items 全量进程
 * @param processName 过滤词
 */
export function filterProcesses(items: DapProcessInfo[], processName?: string): DapProcessInfo[] {
  const needle = (processName ?? '').trim()
  if (!needle) return items
  return items.filter((it) => it.title.includes(needle) || it.name.includes(needle))
}

/**
 * 枚举带主窗口的进程（Windows；spawn 失败/非 Windows 返回空表不抛错）。
 * @author ddj 2026年09月29号
 */
export function listProcesses(): Promise<DapProcessInfo[]> {
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_LIST_CMD],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 << 20 },
      (error, stdout) => {
        if (error && !stdout) { resolve([]); return }
        resolve(parseProcessListJson(String(stdout ?? '')))
      })
  })
}
