/**
 * dsh-vscode-mode client — 图片文件判定、data URL 组装与缩放纯逻辑（编辑区图片预览面板用）。
 * 纯函数、无 DOM 依赖，便于单测；MIME 表收敛在 shared/rpc.ts（host base64 响应同源）；
 * 缩放：步进/clamp 为纯函数，页签记忆为模块级 Map（会话+路径键，EditorView 卸载清空、不持久化）。
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

/** 图片缩放下限（25%，低于此档不再缩小）。 */
export const ZOOM_MIN = 0.25

/** 图片缩放上限（400%，高于此档不再放大）。 */
export const ZOOM_MAX = 4

/** 图片缩放步进（10%/档，−/＋ 按钮每点一次的变化量）。 */
export const ZOOM_STEP = 0.1

/** 页签缩放记忆表：键 = zoomKeyOf(会话, 路径)，值 = 显式缩放或 null（适应宽度）。 */
const zoomMem: Map<string, number | null> = new Map()

/**
 * 图片缩放收敛：clamp 到 25%–400% 并按整百分比取整（消除浮点步进噪声）。
 * @author ddj 2026年09月22号
 * @param zoom 目标缩放（非有限数值按 100% 处理）
 * @returns 收敛后的缩放比例
 */
export function clampZoom(zoom: number): number {
  const value = Number.isFinite(zoom) ? zoom : 1
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 100) / 100
}

/**
 * 图片缩放步进：按 10%/档变化并 clamp（dir 为负即缩小，其余按放大处理）。
 * @author ddj 2026年09月22号
 * @param base 起始缩放（适应宽度态由调用方实测当前渲染缩放传入）
 * @param dir 方向：< 0 缩小，≥ 0 放大
 * @returns 步进后的缩放比例
 */
export function zoomStepOf(base: number, dir: number): number {
  return clampZoom(base + (dir < 0 ? -ZOOM_STEP : ZOOM_STEP))
}

/**
 * 页签缩放记忆键（会话 + 路径；NUL 分隔，防止两段拼接撞键）。
 * @author ddj 2026年09月22号
 * @param sessionId 会话 id
 * @param path 图片路径
 * @returns 记忆键
 */
export function zoomKeyOf(sessionId: string | null | undefined, path: string | null | undefined): string {
  return String(sessionId ?? '') + '\u0000' + String(path ?? '')
}

/**
 * 写入页签缩放记忆（null = 适应宽度；会话级生命周期，不进 localStorage）。
 * @author ddj 2026年09月22号
 * @param key zoomKeyOf 产出的记忆键
 * @param zoom 记忆缩放（null = 适应宽度）
 */
export function rememberZoom(key: string, zoom: number | null): void {
  zoomMem.set(key, zoom)
}

/**
 * 读取页签缩放记忆（无记忆返回 null，调用方按初始适应宽度处理）。
 * @author ddj 2026年09月22号
 * @param key zoomKeyOf 产出的记忆键
 * @returns 记忆缩放或 null
 */
export function recallZoom(key: string): number | null {
  return zoomMem.get(key) ?? null
}

/**
 * 清空全部页签缩放记忆（EditorView 卸载时调用）。
 * @author ddj 2026年09月22号
 */
export function clearZoomMem(): void {
  zoomMem.clear()
}
