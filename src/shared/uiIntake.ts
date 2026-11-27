/**
 * dsh-vscode-mode shared — UI 材料页契约（页面 / 客户端 / 宿主三面共用）。
 *
 * 这一层只放浏览器可用的常量、结构与纯函数，不引用 node 内置模块：
 * 页面生成与落盘在 host，页面消息校验与回传在 client，两边必须用同一份
 * 路径、令牌、尺寸和清单文案规则，避免三处漂移。
 * @author ddj 2026年11月26号
 */

/** 页面发给宿主的消息来源标记（页面 → 客户端）。 */
export const UI_INTAKE_SOURCE = 'edrv-ui-intake'

/** 宿主回给页面的消息来源标记（客户端 → 页面）。 */
export const UI_INTAKE_HOST_SOURCE = 'edrv-ui-intake-host'

/** 生成材料的宿主工具名（客户端据此自动打开页面）。 */
export const UI_INTAKE_TOOL = 'ui_builder_intake'

/** 材料页目录相对设计目录的后缀（`<pagesDir>/<slug>/intake/`）。 */
export const UI_INTAKE_DIR = 'intake'

/** 空白材料页文件名。 */
export const UI_INTAKE_PAGE_FILE = 'materials.html'

/** 页面内嵌配置脚本的 id（生成、校验、客户端读回共享）。 */
export const UI_INTAKE_CONFIG_ID = 'dsh-ui-intake-config'

/** 材料清单 schema 标识（写入 request.json）。 */
export const UI_INTAKE_SCHEMA = 'ui-builder-intake/2'

/** 材料角色：效果图 / 素材图。 */
export type UiIntakeRole = 'mock' | 'material'

/** 允许的图片扩展名与 MIME（页面提示、宿主校验共用）。 */
export const UI_INTAKE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 允许的图片扩展名（小写、无点）。 */
export const UI_INTAKE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp', 'gif']

/** 上传限制（项目 config 不覆盖时使用；页面从宿主注入的同一组值展示）。 */
export interface UiIntakeLimits {
  /** 一次提交的图片总数（效果图 + 素材）。 */
  maxFiles: number
  /** 单张图片最大字节数。 */
  maxFileBytes: number
  /** 一次提交的图片总字节数。 */
  maxTotalBytes: number
  /** 单张图片最大像素数（解码后）。 */
  maxPixels: number
  /** 单边最大像素。 */
  maxSide: number
  /** 接受的 MIME 列表。 */
  mediaTypes: string[]
}

/** 默认限制：与既有临时实现的 50 张 / 8 MB / 32 MB 对齐，另加解码像素上限。 */
export const UI_INTAKE_DEFAULT_LIMITS: UiIntakeLimits = {
  maxFiles: 50,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxSide: 10_000,
  mediaTypes: [...UI_INTAKE_MEDIA_TYPES],
}

/** 页面注入的配置（页面 JS 与客户端校验读取；宿主保存时重新核对）。 */
export interface UiIntakePageConfig {
  /** 本次材料页令牌；消息必须携带同一令牌。 */
  token: string
  /** 页面相对项目根的路径（/ 分隔）。 */
  pagePath: string
  /** 设计 slug。 */
  slug: string
  /** 设计目录（相对项目根，/ 分隔）。 */
  pagesDir: string
  /** 项目根绝对路径（/ 分隔）。 */
  projectRoot: string
  /** 页面标题（界面名称默认值）。 */
  title: string
  /** 设计尺寸默认值。 */
  screen: { w: number; h: number }
  /** 项目事实（只读展示；不参与保存校验）。 */
  ui: { system?: string; bindStyle?: string; commonDir?: string; matchMode?: string }
  /** 项目素材事实（只读展示）。 */
  assets: { inProject?: string; artRoot?: string }
  /** 上传限制（页面与客户端提示、宿主校验共用）。 */
  limits: UiIntakeLimits
  /** 生成时间（ISO 字符串）。 */
  createdAt: string
}

/** 页面提交的表单字段（宿主校验后原样写入清单）。 */
export interface UiIntakeForm {
  title: string
  width: number
  height: number
  notes: string
  targetPrefab: string
  mockPath: string
  assetPaths: string
  sprites: string
}

/** 页面提交的一张图片（bytes 只在 base64 回退通道出现）。 */
export interface UiIntakeFileInput {
  role: UiIntakeRole
  originalName: string
  mediaType: string
  /** 页面读出的尺寸（宿主会用字节内容复核）。 */
  width?: number
  height?: number
  /** 官方 fileUpload 回执（优先通道）。 */
  receiptId?: string
  /** base64 字节（回退通道）。 */
  data?: string
}

/** 材料清单里的图片记录（宿主写入 request.json）。 */
export interface UiIntakeAsset {
  role: UiIntakeRole
  /** 用户选择时的原始文件名（保留中文与大小写）。 */
  originalName: string
  /** 实际保存的文件名（清洗后，可能加序号）。 */
  savedName: string
  /** 相对项目根的保存路径（/ 分隔）。 */
  relativePath: string
  /** 绝对路径（/ 分隔；方便识图工具直接读取）。 */
  absolutePath: string
  mediaType: string
  width: number
  height: number
  bytes: number
  sha256: string
}

/** 材料清单页面块。 */
export interface UiIntakeManifestPage {
  path: string
  tokenHash: string
}

/** request.json 的完整结构（v2；读取 v1 旧清单时缺省字段按空处理）。 */
export interface UiIntakeManifest {
  v: 2
  kind: 'ui-builder-intake'
  schema: string
  projectRoot: string
  pagesDir: string
  slug: string
  submissionId: string
  sessionId: string
  createdAt: string
  page: UiIntakeManifestPage
  title: string
  screen: { w: number; h: number }
  notes: string
  targetPrefab: string
  mockPath: string
  assetPaths: string
  sprites: string
  project: { uiSystem?: string; bindStyle?: string; commonDir?: string; matchMode?: string; assets?: { inProject?: string; artRoot?: string } }
  assets: UiIntakeAsset[]
  message: string
  contentKey: string
  sentAt?: string
  sentConfirmed?: boolean
  messageId?: string
}

/** 宿主选用的设计目录（config.pages.dir 缺省值）。 */
export const UI_INTAKE_DEFAULT_PAGES_DIR = 'plans/ui'

/** slug 规则：小写字母、数字、短横线，首字符非短横线，长度 1~64。 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,63})$/u

/** 提交 id 规则：UUID v4 或 8~64 位安全串（页面生成 UUID；不要求特定版本）。 */
const SUBMISSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u

/** 令牌规则：32~128 位十六进制（宿主生成 32 位 hex）。 */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/u

/**
 * 判断 slug 是否合法。
 * @author ddj 2026年11月26号
 * @param value 候选 slug
 * @returns 是否合法
 */
export function isIntakeSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value)
}

/**
 * 判断提交 id 是否合法（防止路径段注入）。
 * @author ddj 2026年11月26号
 * @param value 候选 id
 * @returns 是否合法
 */
export function isIntakeSubmissionId(value: unknown): boolean {
  return typeof value === 'string' && SUBMISSION_RE.test(value)
}

/**
 * 判断令牌形状是否合法（不校验来源，只挡空串与控制字符）。
 * @author ddj 2026年11月26号
 * @param value 页面携带的令牌
 * @returns 是否合法
 */
export function isIntakeToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value)
}

/**
 * 归一化相对路径：\ → /、去 ./、拒绝绝对路径与 .. 段。
 * @author ddj 2026年11月26号
 * @param value 候选相对路径
 * @returns 归一化结果；非法时 null
 */
export function normalizeRelPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/u.test(raw) || raw.startsWith('//')) return null
  const parts: string[] = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') return null
    if (/[\u0000-\u001f\u007f]/u.test(part)) return null
    parts.push(part)
  }
  return parts.length ? parts.join('/') : null
}

/**
 * 由设计目录与 slug 拼出材料页相对路径。
 * @author ddj 2026年11月26号
 * @param pagesDir 设计目录（相对项目根）
 * @param slug 设计 slug
 * @returns `<pagesDir>/<slug>/intake/materials.html`；任一非法时 null
 */
export function intakePagePathOf(pagesDir: unknown, slug: unknown): string | null {
  const base = normalizeRelPath(pagesDir)
  if (!base || !isIntakeSlug(slug)) return null
  return base + '/' + slug + '/' + UI_INTAKE_DIR + '/' + UI_INTAKE_PAGE_FILE
}

/**
 * 判断相对路径是否是某个 slug 的材料页路径。
 * @author ddj 2026年11月26号
 * @param path 候选路径
 * @param pagesDir 设计目录
 * @param slug 期望 slug（可选；缺省时任意合法 slug）
 * @returns 是否匹配
 */
export function isIntakePagePath(path: unknown, pagesDir: unknown, slug?: unknown): boolean {
  const normalized = normalizeRelPath(path)
  const base = normalizeRelPath(pagesDir)
  if (!normalized || !base) return false
  const prefix = base + '/'
  if (!normalized.startsWith(prefix)) return false
  const rest = normalized.slice(prefix.length).split('/')
  if (rest.length !== 3 || rest[2] !== UI_INTAKE_PAGE_FILE || rest[1] !== UI_INTAKE_DIR) return false
  if (!isIntakeSlug(rest[0])) return false
  return slug === undefined ? true : rest[0] === slug
}

/**
 * 从材料页路径中取 slug。
 * @author ddj 2026年11月26号
 * @param path 材料页相对路径
 * @param pagesDir 设计目录
 * @returns slug；不匹配时 null
 */
export function slugOfIntakePage(path: unknown, pagesDir: unknown): string | null {
  const normalized = normalizeRelPath(path)
  const base = normalizeRelPath(pagesDir)
  if (!normalized || !base || !normalized.startsWith(base + '/')) return null
  const rest = normalized.slice(base.length + 1).split('/')
  if (rest.length !== 3 || rest[1] !== UI_INTAKE_DIR || rest[2] !== UI_INTAKE_PAGE_FILE) return null
  return isIntakeSlug(rest[0]) ? rest[0] : null
}

/**
 * 解析页面内嵌的配置 JSON（页面由本插件生成，但读取侧仍做结构校验）。
 * @author ddj 2026年11月26号
 * @param html 页面文本
 * @returns 合法配置；解析失败/缺关键字段时 null
 */
export function parseIntakePageConfig(html: unknown): UiIntakePageConfig | null {
  const text = typeof html === 'string' ? html : ''
  const re = new RegExp('<script[^>]*\\bid=["\']' + UI_INTAKE_CONFIG_ID + '["\'][^>]*>([\\s\\S]*?)</script>', 'iu')
  const match = re.exec(text)
  if (!match) return null
  let raw: unknown
  try {
    raw = JSON.parse(match[1] ?? '')
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const screen = row.screen !== null && typeof row.screen === 'object' ? row.screen as Record<string, unknown> : {}
  const limitsRow = row.limits !== null && typeof row.limits === 'object' ? row.limits as Record<string, unknown> : {}
  const width = Number(screen.w)
  const height = Number(screen.h)
  const maxFiles = Number(limitsRow.maxFiles)
  const maxFileBytes = Number(limitsRow.maxFileBytes)
  const maxTotalBytes = Number(limitsRow.maxTotalBytes)
  if (!isIntakeToken(row.token) || !isIntakeSlug(row.slug)) return null
  if (!normalizeRelPath(row.pagePath) || !normalizeRelPath(row.pagesDir)) return null
  if (typeof row.projectRoot !== 'string' || !row.projectRoot) return null
  if (!(width > 0 && height > 0)) return null
  const limits: UiIntakeLimits = {
    maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : UI_INTAKE_DEFAULT_LIMITS.maxFiles,
    maxFileBytes: Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : UI_INTAKE_DEFAULT_LIMITS.maxFileBytes,
    maxTotalBytes: Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : UI_INTAKE_DEFAULT_LIMITS.maxTotalBytes,
    maxPixels: Number.isFinite(Number(limitsRow.maxPixels)) && Number(limitsRow.maxPixels) > 0 ? Number(limitsRow.maxPixels) : UI_INTAKE_DEFAULT_LIMITS.maxPixels,
    maxSide: Number.isFinite(Number(limitsRow.maxSide)) && Number(limitsRow.maxSide) > 0 ? Number(limitsRow.maxSide) : UI_INTAKE_DEFAULT_LIMITS.maxSide,
    mediaTypes: Array.isArray(limitsRow.mediaTypes)
      ? limitsRow.mediaTypes.filter((item): item is string => typeof item === 'string' && UI_INTAKE_MEDIA_TYPES.includes(item))
      : [...UI_INTAKE_MEDIA_TYPES],
  }
  const uiRow = row.ui !== null && typeof row.ui === 'object' ? row.ui as Record<string, unknown> : {}
  const assetsRow = row.assets !== null && typeof row.assets === 'object' ? row.assets as Record<string, unknown> : {}
  return {
    token: row.token,
    pagePath: normalizeRelPath(row.pagePath) as string,
    slug: row.slug,
    pagesDir: normalizeRelPath(row.pagesDir) as string,
    projectRoot: row.projectRoot.replace(/\\/g, '/'),
    title: typeof row.title === 'string' ? row.title : '',
    screen: { w: width, h: height },
    ui: {
      ...(typeof uiRow.system === 'string' ? { system: uiRow.system } : {}),
      ...(typeof uiRow.bindStyle === 'string' ? { bindStyle: uiRow.bindStyle } : {}),
      ...(typeof uiRow.commonDir === 'string' ? { commonDir: uiRow.commonDir } : {}),
      ...(typeof uiRow.matchMode === 'string' ? { matchMode: uiRow.matchMode } : {}),
    },
    assets: {
      ...(typeof assetsRow.inProject === 'string' ? { inProject: assetsRow.inProject } : {}),
      ...(typeof assetsRow.artRoot === 'string' ? { artRoot: assetsRow.artRoot } : {}),
    },
    limits,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
  }
}

/** 构造清单里给 agent 的用户消息（宿主保存时落盘，客户端重试时复用）。 */
export interface UiIntakeMessageInput {
  pagesDir: string
  slug: string
  manifestPath: string
  title: string
  screen: { w: number; h: number }
  assets: Array<Pick<UiIntakeAsset, 'role' | 'relativePath' | 'originalName'>>
  hasMockPath: boolean
}

/**
 * 构造材料清单消息：明确继续设计意图、清单路径、本阶段只生成 HTML 设计页。
 * @author ddj 2026年11月26号
 * @param input 页面与保存结果
 * @returns 发给当前会话的纯文本
 */
export function buildIntakeMessage(input: UiIntakeMessageInput): string {
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
