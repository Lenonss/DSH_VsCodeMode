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

/**
 * 是否绝对路径（**平台无关**判定）。
 *
 * ⚠️ 不能用 `node:path` 的 `isAbsolute`：它按**运行平台**解释路径——`isAbsolute('D:/ws/x')`
 * 在 Windows 是 `true`，在 Linux 是 **`false`**（盘符被当成普通路径段）。本插件的路径来自
 * DSH 工具参数（Windows 形态 `D:\...`），而 CI 跑 ubuntu → 依赖 `isAbsolute` 的判定会在
 * 门槛平台上静默失效（本地全绿、CI 恒红）。
 * 这里显式识别三种绝对形态：盘符（`D:/`、`D:\`）、UNC（`//`）、POSIX 根（`/`）。
 * @author ddj 2026年09月11号
 * @param path 待判定路径
 * @returns 是否绝对路径
 */
export function isAbsolutePath(path: string): boolean {
  const text = String(path ?? '')
  return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('//') || text.startsWith('/')
}

/**
 * 任意路径 → 工作区相对路径（LSP 文档键与 file:// URI 的唯一口径）。
 *
 * 为什么必须有这一步：`server.sync()` 用 `root + '/' + path` 拼 file:// URI，隐含假设 path 是
 * 工作区相对路径。但差异记录 `rec.path` 来自工具参数 `file_path`（绝对路径），于是绝对路径会被
 * 拼成 `<root>/<root>/Assets/...` 这种畸形 URI —— 服务器把它当成不存在的文档，didOpen 落空，
 * 引用/定义/hover/符号全部返回空。统一在入口归一化即可消除该形态差异。
 *
 * 约定：相对路径原样返回；root 内的绝对路径剥前缀；root 外（如 DSH 自身文件）原样返回，
 * 保持既有对工作区外文件的宽容行为。
 * @author ddj 2026年09月11号
 * @param root 工作区根目录（绝对路径）
 * @param path 相对或绝对路径
 * @returns 工作区相对路径（正斜杠）；无法归一时返回归一化后的原路径
 */
export function toWorkspacePath(root: string, path: string): string {
  const target = String(path ?? '').replace(/\\/g, '/')
  if (!target) return target
  // 已是相对路径：直接返回（快路径，也是绝大多数调用）
  if (!isAbsolutePath(target)) return target
  const base = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!base) return target
  // 大小写不敏感比较：Windows 盘符/目录名大小写常不一致，isInside 的精确匹配会漏判
  const lower = target.toLowerCase()
  const baseLower = base.toLowerCase()
  if (lower !== baseLower && !lower.startsWith(baseLower + '/')) return target
  return target.slice(base.length).replace(/^\/+/, '')
}
