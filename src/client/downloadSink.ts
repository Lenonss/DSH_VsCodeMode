/**
 * dsh-vscode-mode client — 下载落盘位置（目录选择器）。
 *
 * 浏览器原生 `<a download>` 由浏览器决定保存位置，页面拿不到路径；本模块用
 * File System Access API 的 `showDirectoryPicker` 让用户在点「下载」时选一次目标文件夹，
 * 之后把文件按工作区相对路径逐个写进去（文件夹下载自动建子目录，仍不打包）。
 *
 * 约束：
 * - 选择器必须在用户手势的同步栈里调用，故入口函数都把 `pickSaveSink()` 放在第一个 await；
 * - 需要安全上下文（https / localhost）与 Chromium 系浏览器，Firefox / Safari / 局域网 http
 *   一律回落到浏览器默认下载目录，并在界面上说明原因，不静默改语义；
 * - 用户取消选择（AbortError）与「不可用」区分开：前者终止整批，后者继续下载。
 * 作者 ddj 2026年11月03号
 */

// --region 类型

/** 落盘去处：写入用户所选目录，或回落到浏览器默认下载目录。 */
export type SaveSink =
  | { kind: 'dir'; dir: SinkDir }
  | { kind: 'browser'; reason: SaveFallback }

/** 回落到浏览器下载的原因（调用方据此给出提示文案）。 */
export type SaveFallback = 'unsupported' | 'insecure' | 'denied'

/** 可写文件的句柄（File System Access API 的子集）。 */
export interface SinkWritable {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

/** 文件句柄（仅用到创建可写流）。 */
export interface SinkFileHandle {
  createWritable(): Promise<SinkWritable>
}

/** 目录句柄（仅用到列目录与建子目录/文件）。 */
export interface SinkDir {
  name: string
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<SinkDir>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<SinkFileHandle>
  queryPermission?(opts: { mode: 'readwrite' }): Promise<string>
  requestPermission?(opts: { mode: 'readwrite' }): Promise<string>
}

/** `window.showDirectoryPicker` 的最小签名。 */
type DirPicker = (opts?: { id?: string; mode?: string; startIn?: string }) => Promise<SinkDir>

// --endregion

// --region 选择器

/**
 * 当前浏览器/上下文是否可能弹出目录选择器（安全上下文 + API 存在）。
 * @author ddj 2026年11月03号
 * @returns 可用为 true；不安全上下文或缺 API 为 false
 */
export function canPickDirectory(): boolean {
  return pickerOf() !== undefined
}

/**
 * 让用户选择保存目录。
 * @author ddj 2026年11月03号
 * @returns 所选目录 / 回落原因 / 'cancelled'（用户取消，整批终止）
 * @sideEffects 弹出系统目录选择器，成功后可能触发一次写权限请求
 */
export async function pickSaveSink(): Promise<SaveSink | 'cancelled'> {
  const win = globalThis as { isSecureContext?: boolean; showDirectoryPicker?: DirPicker }
  if (win.isSecureContext === false) return { kind: 'browser', reason: 'insecure' }

  const picker = pickerOf()
  if (!picker) return { kind: 'browser', reason: 'unsupported' }

  let dir: SinkDir
  try {
    dir = await picker({ id: 'vsm-download', mode: 'readwrite', startIn: 'downloads' })
  } catch (error) {
    return isAbort(error) ? 'cancelled' : { kind: 'browser', reason: 'denied' }
  }

  return (await ensureWritable(dir)) ? { kind: 'dir', dir } : { kind: 'browser', reason: 'denied' }
}

/**
 * 取回 `showDirectoryPicker`（不安全上下文视为没有）。
 * @author ddj 2026年11月03号
 * @returns 绑定到 globalThis 的选目录函数；不可用为 undefined
 */
function pickerOf(): DirPicker | undefined {
  const win = globalThis as { isSecureContext?: boolean; showDirectoryPicker?: DirPicker }
  if (win.isSecureContext === false) return undefined
  return typeof win.showDirectoryPicker === 'function' ? win.showDirectoryPicker.bind(win) : undefined
}

/**
 * 确认目录可写（部分浏览器选择后仍需显式请求一次 readwrite 权限）。
 * @author ddj 2026年11月03号
 * @param dir 目录句柄
 * @returns 已获得写权限为 true
 * @throws 权限查询本身抛错时向上透传（由调用方按回落处理）
 */
async function ensureWritable(dir: SinkDir): Promise<boolean> {
  if (!dir.queryPermission) return true
  if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  if (!dir.requestPermission) return false
  return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted'
}

// --endregion

// --region 写入

/**
 * 把字节写到所选目录下的相对路径处（自动逐级建子目录）。
 * @author ddj 2026年11月03号
 * @param dir 目标目录句柄
 * @param relPath 工作区相对路径（分隔符 `/`；越界段 `..` 会被丢弃）
 * @param bytes 原始字节
 * @sideEffects 在用户所选目录内创建目录与文件并覆盖同名文件
 * @throws 磁盘写入失败或文件名非法时透传底层错误
 */
export async function writeFileToDir(dir: SinkDir, relPath: string, bytes: Uint8Array): Promise<void> {
  const parts = pathSegments(relPath)
  const fileName = parts.pop() ?? 'download'

  let parent = dir
  for (const part of parts) parent = await parent.getDirectoryHandle(part, { create: true })

  const handle = await parent.getFileHandle(fileName, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(bytes)
  } finally {
    await writable.close()
  }
}

/**
 * 相对路径切段（过滤空段、`.` 与越界 `..`，兼容反斜杠）。
 * @author ddj 2026年11月03号
 * @param relPath 工作区相对路径
 * @returns 安全的路径段（末段为文件名）
 */
function pathSegments(relPath: string): string[] {
  return relPath
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.' && part !== '..')
}

/**
 * 判断是否用户取消（AbortError），不依赖 DOMException 构造函数的存在。
 * @author ddj 2026年11月03号
 * @param error 捕获值
 * @returns 取消为 true
 */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError'
}

// --endregion
