/**
 * dsh-vscode-mode client — PDF 文件判定与 base64 编解码（编辑区 PDF 面板用）。
 * 纯函数、无 DOM 依赖，便于单测；PDF_MIME 收敛在 shared/rpc.ts（host base64 响应同源）。
 * @author ddj 2026年09月22号
 */
import { PDF_MIME } from '../shared/rpc.js'

export { PDF_MIME }

/**
 * 判断路径是否为 PDF 文件（取 basename 扩展名，大小写不敏感）。
 * @author ddj 2026年09月22号
 * @param path 文件路径（`/` 或 `\` 分隔均可）
 * @returns 是否 PDF 文件
 */
export function isPdfPath(path: string): boolean {
  const base = String(path || '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 && base.slice(dot + 1).toLowerCase() === 'pdf'
}

/**
 * base64 文本 → 二进制字节（喂给 pdf.js getDocument 的 data 入参）。
 * @author ddj 2026年09月22号
 * @param base64 base64 文本（不含 data: 前缀，host edrv.read base64 响应携带）
 * @returns 原始字节
 */
export function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(String(base64 || ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * 二进制字节 → base64 文本（编辑保存回传 host 前的编码步骤）。
 * @author ddj 2026年09月22号
 * @param bytes 原始字节
 * @returns base64 文本
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}
