/**
 * dsh-vscode-mode host — UI 材料落盘（原始图片 + 原始文件名 + 尺寸 + 表单 + 清单）。
 *
 * 约定：`<项目>/<pagesDir>/<slug>/intake/submissions/<submissionId>/`
 *   original/<保存名>  原始字节，按内容类型校验后原样保存
 *   request.json       清单（v2，兼容 v1 读取）
 * 每次提交独立目录、先写临时目录再原子改名；相同内容重复提交直接复用旧清单，
 * 不覆盖用户材料。所有写入都先核对材料页令牌与项目路径边界。
 * @author ddj 2026年11月26号
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { loadUiIntakeLimits } from './uiIntakePage.js'
import {
  UI_INTAKE_SCHEMA,
  buildIntakeMessage,
  intakePagePathOf,
  isIntakePagePath,
  isIntakeSlug,
  isIntakeSubmissionId,
  isIntakeToken,
  normalizeRelPath,
  parseIntakePageConfig,
  slugOfIntakePage,
  type UiIntakeAsset,
  type UiIntakeFileInput,
  type UiIntakeForm,
  type UiIntakeLimits,
  type UiIntakeManifest,
  type UiIntakePageConfig,
} from './shared/uiIntake.js'

/** 已读出字节、等待落盘的一张图片。 */
export interface IncomingIntakeFile {
  role: 'mock' | 'material'
  originalName: string
  mediaType: string
  width?: number
  height?: number
  bytes: Uint8Array
}

/** 保存请求（宿主 RPC 已把回执/base64 转成 IncomingIntakeFile）。 */
export interface SaveIntakeInput {
  /** 项目根绝对路径（由宿主按会话目录向上探测，不接受客户端指定）。 */
  projectRoot: string
  sessionId: string
  pagePath: string
  token: string
  submissionId: string
  form: unknown
  files: IncomingIntakeFile[]
  now?: Date
}

/** 保存结果（成功携带清单与消息；失败只带原因）。 */
export type SaveIntakeResult =
  | {
    ok: true
    submissionId: string
    manifestPath: string
    absoluteManifestPath: string
    manifest: UiIntakeManifest
    message: string
    assets: UiIntakeAsset[]
    duplicate: boolean
    sentAt?: string
  }
  | { ok: false; error: string; code?: 'page' | 'token' | 'form' | 'files' | 'path' | 'conflict' }

/** 最新提交查询结果。 */
export interface LatestIntakeResult {
  ok: boolean
  found?: boolean
  submissionId?: string
  manifestPath?: string
  absoluteManifestPath?: string
  sentAt?: string
  sentConfirmed?: boolean
  form?: UiIntakeForm
  assets?: UiIntakeAsset[]
  message?: string
  error?: string
}

/** 标记已送达结果。 */
export interface MarkSentResult {
  ok: boolean
  sentAt?: string
  confirmed?: boolean
  error?: string
}

/** 图片头解析结果。 */
export interface ImageInfo {
  mediaType: string
  width: number
  height: number
}

/** 把路径统一成 / 分隔。 */
function slash(path: string): string {
  return path.replace(/\\/g, '/')
}

/** Windows 大小写不敏感路径比较。 */
function fold(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

/** 判断 child 是否位于 parent 下（含相等）。 */
function inside(parent: string, child: string): boolean {
  const left = fold(slash(parent)).replace(/\/+$/u, '')
  const right = fold(slash(child)).replace(/\/+$/u, '')
  return right === left || right.startsWith(left + '/')
}

/** 取文件 basename（两种分隔符都算路径分隔）。 */
function leafOf(value: string): string {
  const normalized = String(value ?? '')
  return normalized.slice(Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\')) + 1)
}

/** 去掉会破坏文件名/路径的字符，保留中文与大小写。 */
function cleanName(value: string): string {
  let name = leafOf(value)
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[<>:"|?*]/gu, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = '_' + name
  return name.length > 120 ? name.slice(0, 120) : name
}

/** 扩展名（小写、无点）；没有返回空串。 */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 媒体类型对应的扩展名。 */
function extOfMedia(mediaType: string): string {
  if (mediaType === 'image/png') return 'png'
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  if (mediaType === 'image/gif') return 'gif'
  return 'png'
}

/**
 * 生成安全且保留原名的保存名；同名时加序号。
 * @author ddj 2026年11月26号
 * @param original 原始文件名
 * @param mediaType 媒体类型
 * @param used 已用名集合（大小写不敏感）
 * @returns 保存名
 */
export function savedNameOf(original: string, mediaType: string, used: Set<string>): string {
  const leaf = cleanName(original) || ('image.' + extOfMedia(mediaType))
  const ext = extOf(leaf) || extOfMedia(mediaType)
  const stem = extOf(leaf) ? leaf.slice(0, leaf.length - ext.length - 1) : leaf
  let candidate = stem + '.' + ext
  let index = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = stem + '-' + index + '.' + ext
    index += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

/** 判断媒体类型是否可接受（image/jpg 归一到 image/jpeg）。 */
export function normalizeMediaType(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'image/jpg') return 'image/jpeg'
  return raw
}

/** 读 16 位大端。 */
function be16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

/** 读 16 位小端。 */
function le16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

/** 读 24 位小端。 */
function le24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

/** 读 32 位大端。 */
function be32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

/** JPEG SOF 标记集合（含扩展/渐进等）。 */
function isJpegSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

/** PNG 尺寸。 */
function pngInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 24) return null
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) return null
  if (be32(bytes, 12) !== 0x49484452) return null
  const width = be32(bytes, 16)
  const height = be32(bytes, 20)
  return width > 0 && height > 0 ? { mediaType: 'image/png', width, height } : null
}

/** JPEG 尺寸（扫到第一个 SOF）。 */
function jpegInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    while (i < bytes.length && bytes[i] === 0xff) i += 1
    if (i >= bytes.length) return null
    const marker = bytes[i]
    i += 1
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd9 || marker === 0xda) return null
    if (i + 1 >= bytes.length) return null
    const length = be16(bytes, i)
    if (length < 2 || i + length > bytes.length) return null
    if (isJpegSof(marker)) {
      if (length < 7) return null
      const height = be16(bytes, i + 3)
      const width = be16(bytes, i + 5)
      return width > 0 && height > 0 ? { mediaType: 'image/jpeg', width, height } : null
    }
    i += length
  }
  return null
}

/** GIF 尺寸。 */
function gifInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 10) return null
  const head = String.fromCharCode(...bytes.subarray(0, 6))
  if (head !== 'GIF87a' && head !== 'GIF89a') return null
  const width = le16(bytes, 6)
  const height = le16(bytes, 8)
  return width > 0 && height > 0 ? { mediaType: 'image/gif', width, height } : null
}

/** WebP 尺寸（VP8 / VP8L / VP8X）。 */
function webpInfo(bytes: Uint8Array): ImageInfo | null {
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
 * 从字节识别图片类型与尺寸；不是允许的图片时返回错误。
 * @author ddj 2026年11月26号
 * @param bytes 原始字节
 * @param declared 页面声明的媒体类型（会与内容复核）
 * @returns 图片信息或错误
 */
export function imageInfoOf(bytes: Uint8Array, declared?: string): { ok: true; info: ImageInfo } | { ok: false; error: string } {
  const info = pngInfo(bytes) ?? jpegInfo(bytes) ?? gifInfo(bytes) ?? webpInfo(bytes)
  if (!info) return { ok: false, error: '不是支持的图片（仅 PNG/JPG/WebP/GIF），或文件内容与类型不符' }
  const expected = normalizeMediaType(declared)
  if (expected && expected !== info.mediaType) {
    return { ok: false, error: '图片类型与内容不一致（声明 ' + expected + '，实际 ' + info.mediaType + '）' }
  }
  return { ok: true, info }
}

/** 校验表单，返回归一化值或错误。 */
export function formOf(raw: unknown): { ok: true; form: UiIntakeForm } | { ok: false; error: string } {
  const row = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const title = typeof row.title === 'string' ? row.title.trim() : ''
  if (!title) return { ok: false, error: '请填写界面名称' }
  if (title.length > 120) return { ok: false, error: '界面名称最多 120 个字' }
  const width = Number(row.width)
  const height = Number(row.height)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || width > 10000 || height < 100 || height > 10000) {
    return { ok: false, error: '设计尺寸必须是 100~10000 之间的整数' }
  }
  const text = (key: string, max: number): string => {
    const value = typeof row[key] === 'string' ? String(row[key]) : ''
    return value.length > max ? value.slice(0, max) : value
  }
  return {
    ok: true,
    form: {
      title,
      width,
      height,
      notes: text('notes', 12000),
      targetPrefab: text('targetPrefab', 512),
      mockPath: text('mockPath', 1024),
      assetPaths: text('assetPaths', 12000),
      sprites: text('sprites', 4000),
    },
  }
}

/** token 哈希（清单只存哈希，不落原始令牌）。 */
export function tokenHashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 字节哈希。 */
function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 读页面配置并核对路径/令牌/项目根。 */
async function pageConfigOf(input: {
  projectRoot: string
  pagesDir: string
  pagePath: string
  token: string
}): Promise<{ ok: true; config: UiIntakePageConfig; absolutePath: string } | { ok: false; error: string; code: 'page' | 'token' }> {
  const slug = slugOfIntakePage(input.pagePath, input.pagesDir)
  if (!slug || !isIntakePagePath(input.pagePath, input.pagesDir, slug)) {
    return { ok: false, error: '材料页路径不在 ' + input.pagesDir + '/<slug>/intake/ 下', code: 'page' }
  }
  const absolutePath = join(input.projectRoot, ...input.pagePath.split('/'))
  let text: string
  try {
    const info = await stat(absolutePath)
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return { ok: false, error: '材料页不存在或过大', code: 'page' }
    text = await readFile(absolutePath, 'utf8')
  } catch {
    return { ok: false, error: '材料页不存在：' + slash(absolutePath), code: 'page' }
  }
  const config = parseIntakePageConfig(text)
  if (!config) return { ok: false, error: '材料页配置无法读取', code: 'page' }
  if (fold(config.projectRoot) !== fold(slash(input.projectRoot))) return { ok: false, error: '材料页不属于当前项目', code: 'page' }
  if (config.pagePath !== input.pagePath || config.slug !== slug || config.pagesDir !== input.pagesDir) {
    return { ok: false, error: '材料页路径/设计目录与项目约定不一致', code: 'page' }
  }
  if (config.token !== input.token) return { ok: false, error: '材料页令牌已失效：请重新打开材料页', code: 'token' }
  return { ok: true, config, absolutePath }
}

/** 确保目录存在并返回真实路径，且必须仍在父目录内。 */
async function realDirWithin(parent: string, target: string): Promise<string> {
  await mkdir(target, { recursive: true })
  const real = await realpath(target)
  const realParent = await realpath(parent).catch(() => parent)
  if (!inside(realParent, real) && fold(slash(realParent)) !== fold(slash(real))) {
    throw new Error('目录越界：' + slash(target))
  }
  return real
}

/** 读一份清单（失败返回 null）。 */
async function readManifest(path: string): Promise<UiIntakeManifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (value === null || typeof value !== 'object') return null
    const row = value as Record<string, unknown>
    if (row.kind !== 'ui-builder-intake' || typeof row.submissionId !== 'string') return null
    return value as UiIntakeManifest
  } catch {
    return null
  }
}

/** 相对提交目录的清单路径。 */
function manifestRelPath(pagesDir: string, slug: string, submissionId: string): string {
  return pagesDir + '/' + slug + '/intake/submissions/' + submissionId + '/request.json'
}

/** 提交目录的绝对路径。 */
function submissionDir(projectRoot: string, pagesDir: string, slug: string, submissionId: string): string {
  return join(projectRoot, ...(pagesDir + '/' + slug + '/intake/submissions/' + submissionId).split('/'))
}

/** 校验并归一化入站文件。 */
function assetsOf(
  files: IncomingIntakeFile[],
  limits: UiIntakeLimits,
): { ok: true; assets: Array<IncomingIntakeFile & { savedName: string; sha256: string; info: ImageInfo }> } | { ok: false; error: string } {
  if (files.length > limits.maxFiles) return { ok: false, error: '一次最多提交 ' + limits.maxFiles + ' 张图片' }
  let total = 0
  let mocks = 0
  const used = new Set<string>()
  const assets: Array<IncomingIntakeFile & { savedName: string; sha256: string; info: ImageInfo }> = []
  for (const file of files) {
    if (file.role !== 'mock' && file.role !== 'material') return { ok: false, error: '图片角色无效' }
    if (file.role === 'mock') mocks += 1
    if (mocks > 1) return { ok: false, error: '效果图最多一张' }
    if (file.bytes.byteLength === 0) return { ok: false, error: '图片为空：' + file.originalName }
    if (file.bytes.byteLength > limits.maxFileBytes) {
      return { ok: false, error: '单张图片最多 ' + Math.round(limits.maxFileBytes / 1024 / 1024) + ' MB：' + file.originalName }
    }
    total += file.bytes.byteLength
    if (total > limits.maxTotalBytes) {
      return { ok: false, error: '一次提交最多 ' + Math.round(limits.maxTotalBytes / 1024 / 1024) + ' MB，请减少图片' }
    }
    const mediaType = normalizeMediaType(file.mediaType)
    if (!limits.mediaTypes.includes(mediaType)) {
      return { ok: false, error: '只支持 ' + limits.mediaTypes.join(' / ') + '：' + file.originalName }
    }
    const info = imageInfoOf(file.bytes, mediaType)
    if (!info.ok) return { ok: false, error: info.error + '：' + file.originalName }
    if (info.info.width > limits.maxSide || info.info.height > limits.maxSide || info.info.width * info.info.height > limits.maxPixels) {
      return { ok: false, error: '图片尺寸过大（单边 ≤ ' + limits.maxSide + '，总像素 ≤ ' + limits.maxPixels + '）：' + file.originalName }
    }
    const savedName = savedNameOf(file.originalName, info.info.mediaType, used)
    assets.push({ ...file, mediaType: info.info.mediaType, savedName, sha256: sha256Of(file.bytes), info: info.info })
  }
  return { ok: true, assets }
}

/** 内容指纹：页面 + 表单 + 文件哈希；用于跨刷新/重试去重。 */
function contentKeyOf(pagePath: string, form: UiIntakeForm, assets: Array<{ role: string; originalName: string; sha256: string }>): string {
  return sha256Of(Buffer.from(JSON.stringify({
    pagePath,
    form,
    files: assets.map((asset) => [asset.role, asset.originalName, asset.sha256]),
  }), 'utf8'))
}

/**
 * 保存一次材料提交。
 * @author ddj 2026年11月26号
 * @param input 会话、页面、令牌、表单与已解码图片
 * @returns 清单路径、消息与是否复用旧提交
 */
export async function saveIntakeSubmission(input: SaveIntakeInput): Promise<SaveIntakeResult> {
  if (!isIntakeToken(input.token)) return { ok: false, error: '材料页令牌无效', code: 'token' }
  if (!isIntakeSubmissionId(input.submissionId)) return { ok: false, error: '提交编号无效', code: 'form' }
  const projectRoot = slash(resolve(input.projectRoot))
  const pagesDir = await pagesDirOfRoot(projectRoot)
  const slug = slugOfIntakePage(normalizeRelPath(input.pagePath), pagesDir)
  if (!slug || !isIntakeSlug(slug)) return { ok: false, error: '材料页路径无效', code: 'path' }
  const page = await pageConfigOf({ projectRoot, pagesDir, pagePath: input.pagePath, token: input.token })
  if (!page.ok) return { ok: false, error: page.error, code: page.code }
  const form = formOf(input.form)
  if (!form.ok) return { ok: false, error: form.error, code: 'form' }
  const limits = await loadUiIntakeLimits(projectRoot)
  const normalized = assetsOf(input.files, limits)
  if (!normalized.ok) return { ok: false, error: normalized.error, code: 'files' }
  const assets = normalized.assets
  const contentKey = contentKeyOf(input.pagePath, form.form, assets)

  const intakeRoot = join(projectRoot, ...(pagesDir + '/' + slug + '/intake').split('/'))
  let realIntake: string
  let realSubs: string
  try {
    realIntake = await realDirWithin(projectRoot, intakeRoot)
    realSubs = await realDirWithin(realIntake, join(realIntake, 'submissions'))
  } catch (error) {
    return { ok: false, error: '材料目录不可用：' + String(error), code: 'path' }
  }

  // 同内容重复提交：复用旧清单（保留原图与原始文件名），不新建目录。
  const duplicates = await findDuplicate(realSubs, intakesOf(page.config), contentKey)
  if (duplicates) {
    return {
      ok: true,
      submissionId: duplicates.submissionId,
      manifestPath: manifestRelPath(pagesDir, slug, duplicates.submissionId),
      absoluteManifestPath: slash(join(projectRoot, ...manifestRelPath(pagesDir, slug, duplicates.submissionId).split('/'))),
      manifest: duplicates,
      message: duplicates.message || '',
      assets: duplicates.assets,
      duplicate: true,
      ...(duplicates.sentAt ? { sentAt: duplicates.sentAt } : {}),
    }
  }

  const finalDir = join(realSubs, input.submissionId)
  const existing = await readManifest(join(finalDir, 'request.json'))
  if (existing) return { ok: false, error: '提交编号已存在但内容不同，请重新提交', code: 'conflict' }
  const tmpDir = join(realSubs, '.tmp-' + input.submissionId + '-' + randomBytes(4).toString('hex'))
  const createdAt = (input.now ?? new Date()).toISOString()
  const assetsOut: UiIntakeAsset[] = assets.map((asset) => {
    const relativePath = pagesDir + '/' + slug + '/intake/submissions/' + input.submissionId + '/original/' + asset.savedName
    return {
      role: asset.role,
      originalName: leafOf(asset.originalName) || asset.savedName,
      savedName: asset.savedName,
      relativePath,
      absolutePath: slash(join(projectRoot, ...relativePath.split('/'))),
      mediaType: asset.mediaType,
      width: asset.info.width,
      height: asset.info.height,
      bytes: asset.bytes.byteLength,
      sha256: asset.sha256,
    }
  })
  const message = buildIntakeMessage({
    pagesDir,
    slug,
    manifestPath: manifestRelPath(pagesDir, slug, input.submissionId),
    title: form.form.title,
    screen: { w: form.form.width, h: form.form.height },
    assets: assetsOut.map((asset) => ({ role: asset.role, relativePath: asset.relativePath, originalName: asset.originalName })),
    hasMockPath: Boolean(form.form.mockPath),
  })
  const manifest: UiIntakeManifest = {
    v: 2,
    kind: 'ui-builder-intake',
    schema: UI_INTAKE_SCHEMA,
    projectRoot,
    pagesDir,
    slug,
    submissionId: input.submissionId,
    sessionId: input.sessionId,
    createdAt,
    page: { path: input.pagePath, tokenHash: tokenHashOf(input.token) },
    title: form.form.title,
    screen: { w: form.form.width, h: form.form.height },
    notes: form.form.notes,
    targetPrefab: form.form.targetPrefab,
    mockPath: form.form.mockPath,
    assetPaths: form.form.assetPaths,
    sprites: form.form.sprites,
    project: projectBlockOf(page.config),
    assets: assetsOut,
    message,
    contentKey,
  }
  try {
    await mkdir(join(tmpDir, 'original'), { recursive: true })
    for (const [index, asset] of assets.entries()) {
      await writeFile(join(tmpDir, 'original', asset.savedName), asset.bytes)
      void index
    }
    await writeFile(join(tmpDir, 'request.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    await rename(tmpDir, finalDir)
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    const raced = await readManifest(join(finalDir, 'request.json'))
    if (raced && raced.contentKey === contentKey) {
      return {
        ok: true,
        submissionId: raced.submissionId,
        manifestPath: manifestRelPath(pagesDir, slug, raced.submissionId),
        absoluteManifestPath: slash(join(projectRoot, ...manifestRelPath(pagesDir, slug, raced.submissionId).split('/'))),
        manifest: raced,
        message: raced.message || '',
        assets: raced.assets,
        duplicate: true,
        ...(raced.sentAt ? { sentAt: raced.sentAt } : {}),
      }
    }
    return { ok: false, error: '材料保存失败：' + String(error), code: 'files' }
  }
  return {
    ok: true,
    submissionId: input.submissionId,
    manifestPath: manifestRelPath(pagesDir, slug, input.submissionId),
    absoluteManifestPath: slash(join(projectRoot, ...manifestRelPath(pagesDir, slug, input.submissionId).split('/'))),
    manifest,
    message,
    assets: assetsOut,
    duplicate: false,
  }
}

/** 从项目 config 读设计目录（缺省 plans/ui）。 */
async function pagesDirOfRoot(projectRoot: string): Promise<string> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(projectRoot, '.dsh', 'ui-kit', 'config.json'), 'utf8'))
    const row = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const pages = row.pages !== null && typeof row.pages === 'object' ? row.pages as Record<string, unknown> : {}
    return normalizeRelPath(pages.dir) ?? 'plans/ui'
  } catch {
    return 'plans/ui'
  }
}

/** 页面配置里的项目事实块。 */
function projectBlockOf(config: UiIntakePageConfig): UiIntakeManifest['project'] {
  return {
    uiSystem: config.ui.system,
    bindStyle: config.ui.bindStyle,
    commonDir: config.ui.commonDir,
    matchMode: config.ui.matchMode,
    assets: { ...config.assets },
  }
}

/** 页面 + 令牌的匹配键（清单只存哈希）。 */
function intakesOf(config: UiIntakePageConfig): { pagePath: string; tokenHash: string } {
  return { pagePath: config.pagePath, tokenHash: tokenHashOf(config.token) }
}

/** 扫描最近提交找同内容清单。 */
async function findDuplicate(
  subsRoot: string,
  owner: { pagePath: string; tokenHash: string },
  contentKey: string,
): Promise<UiIntakeManifest | null> {
  let names: string[]
  try {
    names = await readdir(subsRoot)
  } catch {
    return null
  }
  names.sort().reverse()
  let seen = 0
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (seen >= 100) break
    seen += 1
    const manifest = await readManifest(join(subsRoot, name, 'request.json'))
    if (!manifest) continue
    if (manifest.page?.path !== owner.pagePath || manifest.page?.tokenHash !== owner.tokenHash) continue
    if (manifest.contentKey === contentKey) return manifest
  }
  return null
}

/**
 * 读取本页最近一次提交（刷新/插件重载后恢复状态）。
 * @author ddj 2026年11月26号
 * @param input 会话目录、页面与令牌
 * @returns 最近一次提交或未找到
 */
export async function latestIntakeSubmission(input: {
  projectRoot: string
  pagePath: string
  token: string
}): Promise<LatestIntakeResult> {
  const projectRoot = slash(resolve(input.projectRoot))
  const pagesDir = await pagesDirOfRoot(projectRoot)
  const pagePath = normalizeRelPath(input.pagePath)
  if (!pagePath) return { ok: false, error: '材料页路径无效' }
  const page = await pageConfigOf({ projectRoot, pagesDir, pagePath, token: input.token })
  if (!page.ok) return { ok: false, error: page.error }
  const slug = slugOfIntakePage(pagePath, pagesDir)
  if (!slug) return { ok: false, error: '材料页路径无效' }
  const subsRoot = join(projectRoot, ...(pagesDir + '/' + slug + '/intake/submissions').split('/'))
  let names: string[]
  try {
    names = await readdir(subsRoot)
  } catch {
    return { ok: true, found: false }
  }
  const tokenHash = tokenHashOf(input.token)
  const found: UiIntakeManifest[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const manifest = await readManifest(join(subsRoot, name, 'request.json'))
    if (!manifest) continue
    if (manifest.page?.path !== pagePath || manifest.page?.tokenHash !== tokenHash) continue
    found.push(manifest)
    if (found.length >= 50) break
  }
  if (!found.length) return { ok: true, found: false }
  found.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
  const manifest = found[0]
  const manifestPath = manifestRelPath(pagesDir, slug, manifest.submissionId)
  return {
    ok: true,
    found: true,
    submissionId: manifest.submissionId,
    manifestPath,
    absoluteManifestPath: slash(join(projectRoot, ...manifestPath.split('/'))),
    ...(manifest.sentAt ? { sentAt: manifest.sentAt } : {}),
    sentConfirmed: manifest.sentConfirmed !== false,
    form: {
      title: manifest.title,
      width: manifest.screen?.w ?? 0,
      height: manifest.screen?.h ?? 0,
      notes: manifest.notes ?? '',
      targetPrefab: manifest.targetPrefab ?? '',
      mockPath: manifest.mockPath ?? '',
      assetPaths: manifest.assetPaths ?? '',
      sprites: manifest.sprites ?? '',
    },
    assets: Array.isArray(manifest.assets) ? manifest.assets : [],
    message: typeof manifest.message === 'string' ? manifest.message : '',
  }
}

/**
 * 记录一次提交已送达当前会话（客户端在 prompt 受理后调用）。
 * @author ddj 2026年11月26号
 * @param input 页面、令牌、提交编号、是否确认与消息 id
 * @returns 写入结果
 */
export async function markIntakeSent(input: {
  projectRoot: string
  pagePath: string
  token: string
  submissionId: string
  confirmed?: boolean
  messageId?: string
  now?: Date
}): Promise<MarkSentResult> {
  if (!isIntakeSubmissionId(input.submissionId)) return { ok: false, error: '提交编号无效' }
  const projectRoot = slash(resolve(input.projectRoot))
  const pagesDir = await pagesDirOfRoot(projectRoot)
  const pagePath = normalizeRelPath(input.pagePath)
  if (!pagePath) return { ok: false, error: '材料页路径无效' }
  const page = await pageConfigOf({ projectRoot, pagesDir, pagePath, token: input.token })
  if (!page.ok) return { ok: false, error: page.error }
  const path = join(projectRoot, ...manifestRelPath(pagesDir, page.config.slug, input.submissionId).split('/'))
  const manifest = await readManifest(path)
  if (!manifest) return { ok: false, error: '提交清单不存在' }
  if (manifest.page?.path !== pagePath || manifest.page?.tokenHash !== tokenHashOf(input.token)) {
    return { ok: false, error: '提交清单与材料页不匹配' }
  }
  const sentAt = (input.now ?? new Date()).toISOString()
  manifest.sentAt = sentAt
  manifest.sentConfirmed = input.confirmed !== false
  if (typeof input.messageId === 'string' && input.messageId) manifest.messageId = input.messageId
  const tmp = path + '.tmp-' + randomBytes(4).toString('hex')
  try {
    await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: '写入送达状态失败：' + String(error) }
  }
  return { ok: true, sentAt, confirmed: manifest.sentConfirmed }
}

/** 清单 schema 常量（测试/调用方复用）。 */
export const MANIFEST_SCHEMA = UI_INTAKE_SCHEMA

/** 类型导出：页面路径构造（调用方拼展示路径）。 */
export { intakePagePathOf }
