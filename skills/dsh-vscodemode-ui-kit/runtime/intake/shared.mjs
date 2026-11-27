#!/usr/bin/env node
/**
 * 材料页服务共享的纯函数：图片校验、文件名清洗、表单校验、清单消息。
 *
 * 只依赖 Node 内置模块，供 `server.mjs`、`intake.mjs` 与回归脚本使用；
 * 不读写项目文件。文件名/路径只作为数据清洗，不作为命令或模板执行。
 * @author ddj 2026年11月26号
 */
import { createHash } from 'node:crypto'

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const FORM_LIMITS = { title: 120, notes: 12000, targetPrefab: 512, mockPath: 1024, assetPaths: 12000, sprites: 4000 }
export const SUBMISSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u

/** 判断字面量是否为普通对象。 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** SHA-256 十六进制。 */
export function sha256Of(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** 媒体类型归一化。 */
export function normalizeMediaType(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  return raw === 'image/jpg' ? 'image/jpeg' : raw
}

/** 媒体类型对应的扩展名（不带点）。 */
export function extOfMedia(mediaType) {
  if (mediaType === 'image/png') return 'png'
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  if (mediaType === 'image/gif') return 'gif'
  return 'png'
}

/** 文件名清洗：去掉路径、控制字符和 Windows 保留结尾，保留中文原名。 */
export function cleanName(value) {
  let name = String(value ?? '').replace(/\\/gu, '/').split('/').pop() ?? ''
  name = name.replace(/[\u0000-\u001f<>:"|?*]/gu, '_').trim()
  name = name.replace(/[. ]+$/u, '')
  if (name === '.' || name === '..') name = ''
  return name.slice(0, 120)
}

/** 按媒体类型补扩展名；重名加序号。 */
export function savedNameOf(original, mediaType, used) {
  const leaf = cleanName(original) || ('image.' + extOfMedia(mediaType))
  const dot = leaf.lastIndexOf('.')
  const ext = dot > 0 ? leaf.slice(dot + 1).toLowerCase() : extOfMedia(mediaType)
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf
  let candidate = stem + '.' + ext
  let index = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = stem + '-' + index + '.' + ext
    index += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

/** 读 16/24/32 位整数。 */
function be16(bytes, offset) { return (bytes[offset] << 8) | bytes[offset + 1] }
function le16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8) }
function le24(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) }
function be32(bytes, offset) { return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0 }

/** JPEG SOF 标记。 */
function isJpegSof(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

/** PNG 尺寸与格式。 */
function pngInfo(bytes) {
  if (bytes.length < 24) return null
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return null
  if (be32(bytes, 12) !== 0x49484452) return null
  const width = be32(bytes, 16)
  const height = be32(bytes, 20)
  return width > 0 && height > 0 ? { mediaType: 'image/png', width, height } : null
}

/** JPEG 尺寸（扫到第一个 SOF）。 */
function jpegInfo(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let index = 2
  while (index + 1 < bytes.length) {
    if (bytes[index] !== 0xff) return null
    while (index < bytes.length && bytes[index] === 0xff) index += 1
    if (index >= bytes.length) return null
    const marker = bytes[index]
    index += 1
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd9 || marker === 0xda) return null
    if (index + 1 >= bytes.length) return null
    const length = be16(bytes, index)
    if (length < 2 || index + length > bytes.length) return null
    if (isJpegSof(marker)) {
      if (length < 7) return null
      const height = be16(bytes, index + 3)
      const width = be16(bytes, index + 5)
      return width > 0 && height > 0 ? { mediaType: 'image/jpeg', width, height } : null
    }
    index += length
  }
  return null
}

/** GIF 尺寸。 */
function gifInfo(bytes) {
  if (bytes.length < 10) return null
  const head = String.fromCharCode(...bytes.subarray(0, 6))
  if (head !== 'GIF87a' && head !== 'GIF89a') return null
  const width = le16(bytes, 6)
  const height = le16(bytes, 8)
  return width > 0 && height > 0 ? { mediaType: 'image/gif', width, height } : null
}

/** WebP 尺寸（VP8 / VP8L / VP8X）。 */
function webpInfo(bytes) {
  if (bytes.length < 30) return null
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return null
  const chunk = String.fromCharCode(...bytes.subarray(12, 16))
  if (chunk === 'VP8X') {
    const width = le24(bytes, 24) + 1
    const height = le24(bytes, 27) + 1
    return { mediaType: 'image/webp', width, height }
  }
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    const width = le16(bytes, 26) & 0x3fff
    const height = le16(bytes, 28) & 0x3fff
    return width > 0 && height > 0 ? { mediaType: 'image/webp', width, height } : null
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null
    const packed = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
    const width = (packed & 0x3fff) + 1
    const height = ((packed >> 14) & 0x3fff) + 1
    return { mediaType: 'image/webp', width, height }
  }
  return null
}

/**
 * 从字节识别图片；声明类型必须与内容一致。
 * @author ddj 2026年11月26号
 * @param {Uint8Array} bytes 原始字节
 * @param {string} [declared] 页面声明类型
 * @returns {{ok:true,info:{mediaType:string,width:number,height:number}}|{ok:false,error:string}}
 */
export function imageInfoOf(bytes, declared) {
  const info = pngInfo(bytes) ?? jpegInfo(bytes) ?? gifInfo(bytes) ?? webpInfo(bytes)
  if (!info) return { ok: false, error: '不是支持的图片（仅 PNG/JPG/WebP/GIF），或文件内容与类型不符' }
  const expected = normalizeMediaType(declared)
  if (expected && expected !== info.mediaType) {
    return { ok: false, error: '图片类型与内容不一致（声明 ' + expected + '，实际 ' + info.mediaType + '）' }
  }
  return { ok: true, info }
}

/** 草稿表单字段归一化：允许空标题/空尺寸，用于边填边存。 */
export function draftFieldsOf(raw) {
  const row = asRecord(raw) ?? {}
  const text = (key, max) => String(row[key] ?? '').slice(0, max)
  return {
    title: text('title', FORM_LIMITS.title),
    width: text('width', 16),
    height: text('height', 16),
    notes: text('notes', FORM_LIMITS.notes),
    targetPrefab: text('targetPrefab', FORM_LIMITS.targetPrefab),
    mockPath: text('mockPath', FORM_LIMITS.mockPath),
    assetPaths: text('assetPaths', FORM_LIMITS.assetPaths),
    sprites: text('sprites', FORM_LIMITS.sprites),
  }
}

/** 正式提交表单校验；返回归一化值或错误。 */
export function formOf(raw) {
  const draft = draftFieldsOf(raw)
  const title = draft.title.trim()
  if (!title) return { ok: false, error: '请填写界面名称' }
  const width = Number(draft.width)
  const height = Number(draft.height)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || width > 10000 || height < 100 || height > 10000) {
    return { ok: false, error: '设计尺寸必须是 100~10000 之间的整数' }
  }
  return { ok: true, form: { ...draft, title, width, height } }
}

/**
 * 生成交给 Agent 的继续指令；清单路径是项目内相对路径。
 * @param {{pagesDir:string,slug:string,manifestPath:string,title:string,screen:{w:number,h:number},assets:Array,hasMockPath:boolean}} input
 * @returns {string}
 */
export function buildMessage(input) {
  const mock = input.assets.find((asset) => asset.role === 'mock')
  const materials = input.assets.filter((asset) => asset.role !== 'mock')
  const mockLine = mock
    ? '效果图：' + mock.relativePath + '（原始文件名：' + mock.originalName + '）'
    : input.hasMockPath
      ? '效果图：未上传，路径见清单 mockPath（请先确认文件存在再读取）'
      : '效果图：未提供；请按设计说明与素材继续'
  return [
    '/ui-builder 继续设计',
    '材料清单：' + input.manifestPath,
    '界面：' + input.title + ' · ' + input.screen.w + '×' + input.screen.h,
    mockLine,
    '素材图：' + materials.length + ' 张（原始文件与保存路径都在清单 assets 里）',
    '请先读取清单和列出的实际图片（用当前环境可用的识图能力看内容，不要只看文件名），再创建 spec.json 并在同一目录生成可交互 HTML 设计页：' + input.pagesDir + '/' + input.slug + '/plan.html。',
    '本阶段只生成 HTML 设计页，暂不搭建 Unity 预制体，也不要修改项目已有资源。',
  ].join('\n')
}
