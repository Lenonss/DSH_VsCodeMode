/**
 * dsh-vscode-mode client — 图片文件判定与 data URL 组装（编辑区图片预览面板用）。
 * 纯函数、无 DOM 依赖，便于单测；MIME 表收敛在 shared/rpc.ts（host base64 响应同源）。
 * @author ddj 2026年09月08号
 */
import { IMAGE_MIME } from '../shared/rpc.js'

/** 可预览的图片扩展名集合（小写、无点）。 */
const IMAGE_EXT_SET: Set<string> = new Set(Object.keys(IMAGE_MIME))

/**
 * 判断路径是否为可预览的图片文件（取 basename 扩展名，大小写不敏感）。
 * @author ddj 2026年09月08号
 * @param path 文件路径（`/` 或 `\` 分隔均可）
 * @returns 是否图片文件
 */
export function isImagePath(path: string): boolean {
  const base = String(path || '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return IMAGE_EXT_SET.has(base.slice(dot + 1).toLowerCase())
}

/**
 * 判断路径是否为 SVG 文件（唯一提供「以文本打开」切换的图片格式）。
 * @author ddj 2026年09月08号
 * @param path 文件路径（`/` 或 `\` 分隔均可）
 * @returns 是否 SVG
 */
export function isSvgPath(path: string): boolean {
  const base = String(path || '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 && base.slice(dot + 1).toLowerCase() === 'svg'
}

/**
 * base64 文本 → 可直接赋给 `<img src>` 的 data URL。
 * @author ddj 2026年09月08号
 * @param base64 base64 文本（不含 data: 前缀）
 * @param mime MIME 类型（host edrv.read base64 响应携带）
 * @returns data URL 字符串
 */
export function dataUrlOf(base64: string, mime: string): string {
  return 'data:' + (mime || 'application/octet-stream') + ';base64,' + base64
}
