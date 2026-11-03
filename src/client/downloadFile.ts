/**
 * dsh-vscode-mode client — 资源管理器「下载到本机」下载原语。
 *
 * 远程访问时工作区在远端机器上，浏览器拿不到本地落盘入口：本模块把
 * 「相对路径 → 主机字节 → 浏览器下载」串成一条链，供右键菜单调用。
 *
 * 读取走 shared 的 readBinaryPreview：本机走 edrv.readBinary 原始字节，远程代理
 * 会剥掉 x-edrv-* 响应头、自动回退 edrv.read 的 base64 分支（功能不降级，体积 +33%）。
 *
 * 约束：
 * - 不打包、不新增主机 RPC；勾选多个文件时逐个下载原文件（串行，避免并发大文件
 *   打爆 RPC 内存，也贴合「不打包」的产品决策）。
 * - 单个文件失败不整批中断：失败条目记入结果，由调用方统一提示。
 * 作者 ddj 2026年11月03号
 */
import { readBinaryPreview } from '../shared/rpc.js'
import { baseNameOf } from '../shared/fsNames.js'
import { rpc } from './rpc.js'
import type { SaveFallback, SaveSink } from './downloadSink.js'
import { pickSaveSink, writeFileToDir } from './downloadSink.js'
import type { TreeMenuTarget } from './sidebar/contextMenu.js'
import type { SidebarCtx } from './sidebar/types.js'
import { openDownloader } from './ui/DownloadPicker.js'

// --region 类型

/** 单个文件的下载结果（字节数供提示用）。 */
export interface DownloadedFile {
  path: string
  size: number
}

/** 批量下载结果：成功路径保持入参顺序，失败保留主机原文。 */
export interface DownloadBatch {
  ok: string[]
  failed: Array<{ path: string; message: string }>
}

/** 批量下载选项。 */
export interface DownloadOpts {
  sessionId?: string
  /** 取消信号：只在下个文件开始前检查（不中断进行中的请求）。 */
  signal?: AbortSignal
  /** 每完成一个文件回调一次（done 含成功与失败）。 */
  onProgress?: (done: number, total: number, path: string) => void
  /** 落盘去处；缺省按浏览器默认下载目录（`<a download>`）。 */
  sink?: SaveSink
}

// --endregion

// --region 单文件

/**
 * 触发浏览器下载（Blob + 隐藏 <a download>），与 Excel 导出同一落盘范式。
 * @author ddj 2026年11月03号
 * @param bytes 原始字节
 * @param fileName 保存文件名（浏览器重名时自动加序号）
 * @param mime MIME 类型；空值退化为 application/octet-stream
 * @sideEffects 创建并点击一个游离 <a> 节点，60 秒后释放 objectURL
 */
export function downloadBytes(bytes: Uint8Array, fileName: string, mime: string): void {
  const type = mime || 'application/octet-stream'
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const anchor = document.createElement('a')

  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.click()

  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

/**
 * 读取单个文件的原始字节（二进制通道优先，base64 回退）。
 * @author ddj 2026年11月03号
 * @param path 工作区相对路径
 * @param sessionId 会话 id（工作区解析用）
 * @returns 字节 + MIME + 字节数（MIME 缺失按路径推断）
 * @throws 主机拒绝或读取失败时抛出主机错误原文（如「文件过大（>32MB）…」）
 */
export async function fetchDownload(path: string, sessionId?: string): Promise<{ bytes: Uint8Array; mime: string; size: number }> {
  const args = sessionId ? { sessionId, path } : { path }
  const out = await readBinaryPreview(rpc, args)
  if (!out.ok) throw new Error(out.error)
  if (out.via === 'binary') return { bytes: out.bytes, mime: out.mime, size: out.size }
  return { bytes: decodeBase64(out.content), mime: out.mime || 'application/octet-stream', size: out.size }
}

/**
 * 下载单个文件并落盘（所选目录则按相对路径写入，否则交给浏览器 `<a download>`）。
 * @author ddj 2026年11月03号
 * @param path 工作区相对路径
 * @param opts 会话 / 取消 / 落盘选项
 * @returns 路径与字节数
 * @throws 读取失败透传主机错误；目录写入失败透传底层错误
 */
export async function downloadOne(path: string, opts: DownloadOpts = {}): Promise<DownloadedFile> {
  const file = await fetchDownload(path, opts.sessionId)
  if (opts.sink?.kind === 'dir') {
    await writeFileToDir(opts.sink.dir, path, file.bytes)
  } else {
    downloadBytes(file.bytes, baseNameOf(path) || 'download', file.mime)
  }
  return { path, size: file.size }
}

// --endregion

// --region 批量与入口

/**
 * 串行下载多个文件（逐个原文件，不打包）。
 * @author ddj 2026年11月03号
 * @param paths 工作区相对路径列表（按用户勾选顺序）
 * @param opts 会话 / 取消 / 进度选项
 * @returns 成功与失败清单；单项失败不中断后续
 */
export async function downloadMany(paths: string[], opts: DownloadOpts = {}): Promise<DownloadBatch> {
  const ok: string[] = []
  const failed: Array<{ path: string; message: string }> = []

  for (const path of paths) {
    if (opts.signal?.aborted) break
    try {
      await downloadOne(path, opts)
      ok.push(path)
    } catch (error) {
      failed.push({ path, message: textOfError(error) })
    }
    opts.onProgress?.(ok.length + failed.length, paths.length, path)
  }

  return { ok, failed }
}

/**
 * 右键菜单入口：文件直下，文件夹 / 工作区根打开勾选弹窗。
 * @author ddj 2026年11月03号
 * @param target 右键目标（根空白区为 path='' 的 directory）
 * @param ctx 面板上下文（会话 id 与状态栏反馈）
 * @sideEffects 触发浏览器下载或挂载弹窗；错误经 ctx.notify 透出
 */
export async function downloadTarget(target: TreeMenuTarget, ctx?: SidebarCtx): Promise<void> {
  if (target.type === 'file') {
    await runBatch([target.path], ctx)
    return
  }

  openDownloader({
    root: target.path,
    sessionId: ctx?.sessionId,
    onConfirm: (paths: string[]) => { void runBatch(paths, ctx) },
  })
}

/**
 * 批量下载并统一反馈（先选保存目录，再逐文件落盘；开始一条、结束一条，避免逐文件刷屏）。
 * @author ddj 2026年11月03号
 * @param paths 勾选路径
 * @param ctx 面板上下文
 * @sideEffects 弹出目录选择器；用户取消则整批中止
 */
async function runBatch(paths: string[], ctx?: SidebarCtx): Promise<void> {
  if (!paths.length) return

  // 选择器必须在用户手势的同步栈里触发，故放在第一个 await 之前。
  const sink = await pickSaveSink()
  if (sink === 'cancelled') {
    ctx?.notify?.('已取消下载')
    return
  }
  if (sink.kind === 'browser') ctx?.notify?.(fallbackText(sink.reason))
  if (paths.length > 1) ctx?.notify?.('正在下载 ' + paths.length + ' 个文件…')

  try {
    const out = await downloadMany(paths, { sessionId: ctx?.sessionId, sink })
    ctx?.notify?.(batchText(out))
  } catch (error) {
    ctx?.notify?.('下载失败：' + textOfError(error))
  }
}

/**
 * 目录选择不可用时的提示文案（说明文件去了浏览器默认下载目录）。
 * @author ddj 2026年11月03号
 * @param reason 回落原因
 * @returns 单行提示文案
 */
function fallbackText(reason: SaveFallback): string {
  if (reason === 'unsupported') return '浏览器不支持选择保存目录，已保存到默认下载目录'
  if (reason === 'insecure') return '当前页面不是安全上下文（需 https 或 localhost），已保存到默认下载目录'
  return '未获得目录写入权限，已保存到默认下载目录'
}

/**
 * 批量结果口播文案。
 * @author ddj 2026年11月03号
 * @param out 批量结果
 * @returns 单行提示文案
 */
function batchText(out: DownloadBatch): string {
  if (!out.failed.length) return '已下载 ' + out.ok.length + ' 个文件'
  const first = out.failed[0]
  const tail = '（' + first.path + '：' + first.message + '）'
  if (!out.ok.length) return '下载失败：' + first.message + tail
  return '已下载 ' + out.ok.length + ' 个，失败 ' + out.failed.length + ' 个' + tail
}

// --endregion

// --region 工具

/**
 * base64 → 字节（回退通道解码；逐字节写入避免大文件二次拷贝放大）。
 * @author ddj 2026年11月03号
 * @param text base64 文本
 * @returns 原始字节
 */
function decodeBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * 错误可读文案（Error.message 优先，其余 String 化）。
 * @author ddj 2026年11月03号
 * @param error 捕获值
 * @returns 提示文案
 */
function textOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --endregion
