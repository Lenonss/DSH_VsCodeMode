/**
 * dsh-vscode-mode client — 文件剪贴板（剪切/复制/粘贴的应用内单槽）。
 *
 * 浏览器拿不到系统文件剪贴板，按 VS Code 语义做应用内文件剪贴板：
 * 「剪切/复制」只登记源路径，「粘贴」时才走 edrv.fsMove / edrv.fsCopy 真正落盘。
 * 模块级单槽（同 searchSeed 一次性槽模式），不依赖 React/DOM，可 node 单测。
 * 作者 ddj 2026年09月22号
 */

/** 文件剪贴板内容。 */
export interface FileClip {
  /** copy = 复制；cut = 剪切（粘贴后源被移走）。 */
  mode: 'copy' | 'cut'
  /** 源路径（工作区相对）。 */
  path: string
}

/** 单槽剪贴板（null = 空）。 */
let clip: FileClip | null = null

/**
 * 写入文件剪贴板（重复以最后一次为准）。
 * @author ddj 2026年09月22号
 * @param mode copy = 复制；cut = 剪切
 * @param path 源路径（工作区相对）
 */
export function setFileClip(mode: FileClip['mode'], path: string): void {
  clip = { mode, path }
}

/**
 * 读取当前剪贴板（不清空；粘贴执行与「粘贴」灰显判定共用）。
 * @author ddj 2026年09月22号
 * @returns 剪贴板内容；空槽返回 null
 */
export function fileClipOf(): FileClip | null {
  return clip
}

/**
 * 清空文件剪贴板（剪切粘贴成功后；测试隔离用）。
 * @author ddj 2026年09月22号
 */
export function clearFileClip(): void {
  clip = null
}
