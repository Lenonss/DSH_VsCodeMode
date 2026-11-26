/**
 * dsh-vscode-mode host — /html-plan 的附件落盘纯逻辑。
 *
 * 职责：从已入库的图片/文件引用生成安全的文件名、派生固定 slug、按顺序写进
 * plans/<slug>/assets/，并产出交给 agent 的附件说明。所有外部能力（读字节、写文件）
 * 走入参注入，本模块不直接碰 ctx 与文件系统，便于 node 单测。
 * @author ddj 2026年11月24号
 */

//region 结构面

/** 落盘成功的一个附件。 */
export interface StagedAttachment {
  /** assets/ 下的文件名。 */
  name: string
  /** 工作区相对路径：plans/<slug>/assets/<name>。 */
  relativePath: string
  /** 字节数。 */
  bytes: number
  /** 来源类型。 */
  kind: 'image' | 'file'
}

/** 被跳过的附件及原因。 */
export interface SkippedAttachment {
  /** 展示用文件名。 */
  name: string
  /** 跳过原因（可直接读）。 */
  reason: string
}

/** 一次附件落盘的结果。 */
export interface AttachmentStage {
  /** 固定 slug。 */
  slug: string
  /** assets 目录（工作区相对路径）。 */
  dir: string
  /** 已写入的附件。 */
  files: StagedAttachment[]
  /** 未写入的附件。 */
  skipped: SkippedAttachment[]
}

/** 落盘依赖（真实实现由命令层提供）。 */
export interface AttachmentStageDeps {
  /** 命令收到的 ImageBlock / FileBlock 列表，按提交顺序。 */
  blocks: readonly unknown[]
  /** 固定 slug。 */
  slug: string
  /** 取消信号。 */
  signal?: AbortSignal
  /** 读图片字节（参数是 attachment 引用）。 */
  readImage: (ref: unknown, signal?: AbortSignal) => Promise<Uint8Array>
  /** 读文件字节（参数是 attachment 引用）。 */
  readFile: (ref: unknown, signal?: AbortSignal) => Promise<Uint8Array>
  /** 写一个附件（参数是工作区相对路径）。 */
  write: (relativePath: string, bytes: Uint8Array) => Promise<void>
  /** 落盘根目录（工作区相对路径）；缺省 `plans/<slug>`，测试验收模式用它指到 `.dsh/test-check/<id>`。 */
  root?: string
  /** 单文件上限，默认 25 MB。 */
  maxBytes?: number
  /** 附件数量上限，默认 12 个。 */
  maxCount?: number
}

/** 一个内容块的引用视图。 */
interface AttachmentRefView {
  /** 原始 attachment 引用对象（交给读字节函数）。 */
  raw: unknown
  /** 存储 id（用于去重）。 */
  id: string
  /** 原始显示名。 */
  name: string
  /** 媒体类型。 */
  mediaType: string
  /** 块类型。 */
  kind: 'image' | 'file'
}

//endregion

//region 常量

/** assets 目录名。 */
export const ATTACHMENTS_DIR = 'assets'
/** 单文件落盘上限：超过就不复制（避免把工作区写满）。 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** 单次命令最多接收的附件数。 */
export const MAX_ATTACHMENTS = 12
/** 文件名长度上限（保留扩展名）。 */
export const MAX_FILE_NAME = 80

/** 媒体类型 → 扩展名（文件名缺失时兜底）。 */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/zip': '.zip',
}

/** 派生 slug 时跳过的常见虚词（只影响可读性，不改变语义）。 */
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'add', 'new'])

/** Windows 保留文件名。 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

//endregion

//region 工具

/**
 * 取异常的展示文案。
 * @author ddj 2026年11月24号
 * @param error 捕获值
 * @returns 可读文案
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

/**
 * 按媒体类型取扩展名。
 * @author ddj 2026年11月24号
 * @param mediaType 媒体类型
 * @returns 形如 `.png` 的扩展名；未知类型返回空串
 */
export function extensionOf(mediaType: string): string {
  const value = String(mediaType ?? '').toLowerCase()
  const known = MIME_EXT[value]
  if (known) return known
  const match = /^[a-z]+\/([a-z0-9.+-]+)$/.exec(value)
  if (!match) return ''
  const suffix = match[1].replace(/[^a-z0-9]/g, '').slice(0, 5)
  return suffix ? '.' + suffix : ''
}

/**
 * 把过长的文件名裁到上限，优先保住扩展名。
 * @author ddj 2026年11月24号
 * @param name 已清洗过的文件名
 * @param limit 长度上限
 * @returns 裁好的文件名
 */
function trimName(name: string, limit: number): string {
  if (name.length <= limit) return name
  const dot = name.lastIndexOf('.')
  const suffix = dot > 0 && name.length - dot <= 9 ? name.slice(dot) : ''
  const base = suffix ? name.slice(0, dot) : name
  return base.slice(0, Math.max(1, limit - suffix.length)) + suffix
}

/**
 * 清洗附件文件名：去目录、去控制字符与 Windows 非法字符、补扩展名、避开保留名。
 * @author ddj 2026年11月24号
 * @param raw 原始显示名（可能为空或带路径）
 * @param index 提交顺序（兜底命名用）
 * @param kind 来源类型
 * @param mediaType 媒体类型（缺扩展名时补）
 * @returns 可安全写进 assets/ 的文件名
 */
export function safeFileName(raw: unknown, index: number, kind: 'image' | 'file', mediaType = ''): string {
  const text = String(raw ?? '').replace(/\\/g, '/')
  const leaf = text.slice(text.lastIndexOf('/') + 1)
  const cleaned = leaf
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, MAX_FILE_NAME)

  let name = cleaned
  if (!name) name = (kind === 'image' ? 'image-' : 'file-') + String(index + 1) + (extensionOf(mediaType) || (kind === 'image' ? '.png' : '.bin'))
  else if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
    const suffix = extensionOf(mediaType)
    if (suffix) name += suffix
  }

  name = trimName(name, MAX_FILE_NAME)
  if (RESERVED_NAME.test(name)) name = '_' + name
  return name
}

/**
 * 让同名附件错开（大小写不敏感，贴合 Windows 语义）。
 * @author ddj 2026年11月24号
 * @param name 候选文件名
 * @param used 已占用的文件名（小写）
 * @returns 唯一的文件名，并登记进 used
 */
export function uniqueFileName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) {
    used.add(name.toLowerCase())
    return name
  }

  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const suffix = dot > 0 ? name.slice(dot) : ''
  for (let serial = 2; serial < 100; serial += 1) {
    const candidate = base + '-' + String(serial) + suffix
    if (used.has(candidate.toLowerCase())) continue
    used.add(candidate.toLowerCase())
    return candidate
  }

  const fallback = base + '-' + String(Date.now()) + suffix
  used.add(fallback.toLowerCase())
  return fallback
}

/**
 * 生成本地时间戳 `YYYYMMDD-HHmm`（slug 兜底用）。
 * @author ddj 2026年11月24号
 * @param at 时间点
 * @returns 13 位时间戳片段
 */
function stampOf(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return String(at.getFullYear()) + pad(at.getMonth() + 1) + pad(at.getDate()) + '-' + pad(at.getHours()) + pad(at.getMinutes())
}

/**
 * 从任务文本派生固定 slug：取前几个 ASCII 词；词太少或没有可用词时用时间戳。
 * 中文任务里零散出现的单个短 ASCII 词（如 html）不足以当目录名，走时间戳兜底。
 * @author ddj 2026年11月24号
 * @param task 任务文本（可能全是中文）
 * @param at 时间点（兜底时间戳）
 * @returns kebab-case slug（只含小写字母、数字与连字符）
 */
export function slugFromTask(task: unknown, at: Date = new Date()): string {
  const words = String(task ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []
  const meaningful = words.filter((word) => !STOP_WORDS.has(word)).slice(0, 4)
  const usable = meaningful.length >= 2 || (meaningful.length === 1 && meaningful[0].length >= 6)
  const slug = usable ? meaningful.join('-').slice(0, 40).replace(/-+/g, '-').replace(/^-|-$/g, '') : ''
  return slug || 'attach-' + stampOf(at)
}

/**
 * 字节数的人类可读写法。
 * @author ddj 2026年11月24号
 * @param bytes 字节数
 * @returns 如 `812 KB`；非法值返回空串
 */
export function formatBytes(bytes: unknown): string {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
  if (value >= 1024) return String(Math.round(value / 1024)) + ' KB'
  return String(value) + ' B'
}

/**
 * 从一个内容块里取出引用视图。
 * @author ddj 2026年11月24号
 * @param block 命令收到的内容块
 * @returns 引用视图；不是图片/文件块时 null
 */
function refOf(block: unknown): AttachmentRefView | null {
  if (block === null || typeof block !== 'object') return null
  const row = block as { type?: unknown; attachment?: unknown }
  const kind = row.type === 'image' ? 'image' : row.type === 'file' ? 'file' : ''
  if (!kind || row.attachment === null || typeof row.attachment !== 'object') return null
  const ref = row.attachment as { attachmentId?: unknown; name?: unknown; mediaType?: unknown }
  return {
    raw: row.attachment,
    id: typeof ref.attachmentId === 'string' ? ref.attachmentId : '',
    name: typeof ref.name === 'string' ? ref.name : '',
    mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : '',
    kind,
  }
}

//endregion

//region 落盘与指令

/**
 * 把附件按提交顺序写进 plans/<slug>/assets/。
 *
 * 单个附件失败只记进 skipped，不影响其余附件；取消信号在每轮开始时检查。
 * @author ddj 2026年11月24号
 * @param deps 内容块、slug 与读写能力
 * @returns 已写入与被跳过的附件清单
 */
export async function stageAttachments(deps: AttachmentStageDeps): Promise<AttachmentStage> {
  const slug = String(deps.slug ?? '')
  const root = typeof deps.root === 'string' && deps.root.trim() ? deps.root.trim().replace(/\/+$/, '') : 'plans/' + slug
  const dir = root + '/' + ATTACHMENTS_DIR
  const maxBytes = deps.maxBytes ?? MAX_ATTACHMENT_BYTES
  const maxCount = deps.maxCount ?? MAX_ATTACHMENTS
  const files: StagedAttachment[] = []
  const skipped: SkippedAttachment[] = []
  const used = new Set<string>()
  const seen = new Set<string>()

  for (const [index, block] of deps.blocks.entries()) {
    if (deps.signal?.aborted) break
    const ref = refOf(block)
    if (!ref) {
      skipped.push({ name: 'attachment-' + String(index + 1), reason: '不是可用的图片或文件引用' })
      continue
    }
    if (ref.id && seen.has(ref.id)) continue
    if (ref.id) seen.add(ref.id)

    const name = uniqueFileName(safeFileName(ref.name, index, ref.kind, ref.mediaType), used)
    if (files.length >= maxCount) {
      skipped.push({ name, reason: '超过 ' + String(maxCount) + ' 个附件上限' })
      continue
    }

    try {
      const bytes = ref.kind === 'image'
        ? await deps.readImage(ref.raw, deps.signal)
        : await deps.readFile(ref.raw, deps.signal)
      if (bytes.byteLength > maxBytes) {
        skipped.push({ name, reason: '超过 ' + formatBytes(maxBytes) })
        continue
      }
      const relativePath = dir + '/' + name
      await deps.write(relativePath, bytes)
      files.push({ name, relativePath, bytes: bytes.byteLength, kind: ref.kind })
    } catch (error) {
      skipped.push({ name, reason: messageOf(error) })
    }
  }

  return { slug, dir, files, skipped }
}

/**
 * 生成交给 agent 的附件说明段（路径、类型、大小、页面写法）。
 * @author ddj 2026年11月24号
 * @param stage 落盘结果
 * @returns 逐行文本；没有附件时返回空数组
 */
export function attachmentLines(stage: AttachmentStage): string[] {
  const lines: string[] = []

  if (stage.files.length) {
    lines.push('附件已保存（页面里必须引用，不要复制到别处）：')
    for (const file of stage.files) {
      const size = formatBytes(file.bytes)
      const kindText = file.kind === 'image' ? '图片' : '文件'
      lines.push('- ' + file.relativePath + '（' + kindText + (size ? '，' + size : '') + '）')
    }
    lines.push('页面里用 <doc-attach label="随附材料"><doc-file src="assets/<文件名>">显示名</doc-file></doc-attach> 引用；')
    lines.push('图片先用 read_image 看清内容；文档或日志用 read 读原文。')
    lines.push('打包成功后 plans/' + stage.slug + '/assets/ 会被删除；要再打包一次就先给 plan.mjs 加 --keep-assets。')
  }

  if (stage.skipped.length) {
    lines.push('以下附件没能落盘，本次不要引用：')
    for (const item of stage.skipped) lines.push('- ' + item.name + '：' + item.reason)
  }

  return lines
}

//endregion
