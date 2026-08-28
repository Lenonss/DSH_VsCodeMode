/**
 * dsh-vscode-mode host — 路径 ↔ file:// URI 转换（纯函数，node 可测）。
 * LSP 的 uri 字段必须是 file:// 绝对 URI；客户端 Monaco 用 edrv:///<encodeURI(path)>。
 * 作者 ddj 2026-08-27
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAbsolute, resolve as resolvePath } from 'node:path'

/**
 * 绝对路径 → file:// URI（Windows 盘符保留：D:/x → file:///D:/x）。
 * @author ddj 2026年08月27号
 * @param absPath 绝对路径（正/反斜杠均可）
 * @returns file:// URI
 */
export function pathToFileUri(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/')
  const drive = /^([A-Za-z]:)(?:\/(.*))?$/.exec(normalized)
  if (drive) {
    const tail = drive[2] ? '/' + drive[2].split('/').map(encodeURIComponent).join('/') : ''
    return 'file:///' + drive[1] + tail
  }
  return pathToFileURL(normalized).toString()
}

/**
 * file:// URI → 绝对路径（Windows file:///C:/x → C:\x）。
 * @author ddj 2026年08月27号
 * @param uri file:// URI
 * @returns 绝对路径
 */
export function fileUriToPath(fileUri: string): string {
  try {
    return fileURLToPath(fileUri)
  } catch (error) {
    return String(error)
  }
}

/**
 * 将（可能相对的）路径解析为绝对路径后转 file:// URI。
 * @author ddj 2026年08月27号
 * @param path 相对或绝对路径
 * @param cwd 解析相对路径的基准（可选）
 * @returns file:// URI
 */
export function resolveToFileUri(path: string, cwd?: string): string {
  const abs = isAbsolute(path) ? path : cwd ? resolvePath(cwd, path) : resolvePath(path)
  return pathToFileUri(abs)
}

/**
 * 判定绝对路径是否在给定根目录（含）内。
 * @author ddj 2026年08月27号
 * @param root 根目录绝对路径
 * @param target 目标绝对路径
 * @returns 是否在根内
 */
export function isInside(root: string, target: string): boolean {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  const t = target.replace(/\\/g, '/')
  return t === r.slice(0, -1) || t.startsWith(r)
}
