/**
 * dsh-vscode-mode client — UI 材料页消息协议（页面 ↔ 客户端）。
 *
 * 只放浏览器可用的纯逻辑：来源判别、工具结果解析、路径归属、字节/base64、
 * 投递状态归一。DOM、RPC 与官方服务装配见 uiIntakeBridge.ts，便于 node 单测。
 * @author ddj 2026年11月26号
 */
import { UI_INTAKE_SOURCE, isIntakePagePath, normalizeRelPath } from '../shared/uiIntake.js'

/** 页面 hello 未确认时的重试间隔（页面侧只做触发，客户端不轮询）。 */
export const INTAKE_HELLO_RETRY_MS = 1500

/** 页面单次提交允许的等待时间（毫秒；超过后页面提示失败但保留内容）。 */
export const INTAKE_SUBMIT_TIMEOUT_MS = 5 * 60 * 1000

/** 页面消息的最小结构。 */
export interface IntakePageMessage {
  source: typeof UI_INTAKE_SOURCE
  type: string
  token?: unknown
  pagePath?: unknown
  projectRoot?: unknown
  submissionId?: unknown
  form?: unknown
  files?: unknown
  [key: string]: unknown
}

/** 工具结果里的页面信息。 */
export interface IntakeToolPayload {
  ok: true
  pagePath: string
  absolutePath?: string
  slug?: string
}

/** 记录窄化。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/** 字符串取值（非空）。 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * 判断消息是否来自材料页（只认来源标记；令牌/窗口另由调用方校验）。
 * @author ddj 2026年11月26号
 * @param data postMessage 载荷
 * @returns 是否材料页消息
 */
export function intakeMessageOf(data: unknown): IntakePageMessage | null {
  const row = asRecord(data)
  if (!row || row.source !== UI_INTAKE_SOURCE || typeof row.type !== 'string') return null
  return row as IntakePageMessage
}

/**
 * 判断路径 a 是否包含 b（相等也算）；Windows 盘符路径大小写不敏感。
 * @author ddj 2026年11月26号
 * @param parent 父路径
 * @param child 子路径
 * @returns 是否包含
 */
export function pathUnder(parent: unknown, child: unknown): boolean {
  const left = textOf(parent)
  const right = textOf(child)
  if (!left || !right) return false
  const fold = (value: string): string => {
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '')
    return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized
  }
  const a = fold(left)
  const b = fold(right)
  if (b.split('/').includes('..')) return false
  return b === a || b.startsWith(a + '/')
}

/**
 * 把工具结果 content 里的文本块拼起来（模型工具结果是文本 JSON）。
 * @author ddj 2026年11月26号
 * @param content 工具结果内容块
 * @returns 文本；没有文本块时 null
 */
export function toolTextOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  let out = ''
  for (const block of content) {
    const row = asRecord(block)
    if (row?.type === 'text' && typeof row.text === 'string') out += row.text
  }
  return out ? out : null
}

/**
 * 解析 `ui_builder_intake` 工具结果文本。
 * @author ddj 2026年11月26号
 * @param text 工具结果文本
 * @returns 成功页面信息；失败/畸形返回 null
 */
export function intakeToolPayloadOf(text: unknown): IntakeToolPayload | null {
  const raw = textOf(text)
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const row = asRecord(value)
  if (!row || row.ok !== true) return null
  const pagePath = normalizeRelPath(row.pagePath)
  if (!pagePath) return null
  return {
    ok: true,
    pagePath,
    ...(textOf(row.absolutePath) ? { absolutePath: String(row.absolutePath).replace(/\\/g, '/') } : {}),
    ...(textOf(row.slug) ? { slug: String(row.slug) } : {}),
  }
}

/**
 * 页面配置与消息的绑定校验：令牌、页面路径、项目根三者必须一致。
 * @author ddj 2026年11月26号
 * @param config 页面内嵌配置
 * @param message 页面消息
 * @param pagesDir 设计目录
 * @returns 是否匹配
 */
export function intakeBindingOk(
  config: { token: string; pagePath: string; pagesDir: string; projectRoot: string },
  message: IntakePageMessage,
  pagesDir: string,
): boolean {
  if (textOf(message.token) !== config.token) return false
  if (normalizeRelPath(message.pagePath) !== config.pagePath) return false
  if (config.pagesDir !== pagesDir) return false
  if (!isIntakePagePath(config.pagePath, config.pagesDir)) return false
  const root = textOf(message.projectRoot)
  return root !== undefined && root.replace(/\\/g, '/').replace(/\/+$/u, '') === config.projectRoot.replace(/\/+$/u, '')
}

/**
 * 把页面送来的 ArrayBuffer 视图归一成 Uint8Array。
 * @author ddj 2026年11月26号
 * @param value 页面文件字节
 * @returns 字节；非法时 null
 */
export function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}

/**
 * 浏览器侧 base64（分块，避免大数组展开爆栈）。
 * @author ddj 2026年11月26号
 * @param bytes 字节
 * @returns base64 字符串
 */
export function base64Of(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

/**
 * 官方 fileUpload 结果解析：只认 ok:true 且有 receiptId。
 * @author ddj 2026年11月26号
 * @param result 服务返回值
 * @returns 回执；失败时 null
 */
export function receiptOf(result: unknown): string | null {
  const row = asRecord(result)
  if (!row || row.ok !== true) return null
  const value = asRecord(row.value)
  return textOf(value?.receiptId) ?? null
}

/**
 * 官方 fileUpload 失败原因（用于提示/诊断）。
 * @author ddj 2026年11月26号
 * @param result 服务返回值
 * @returns 可读原因
 */
export function uploadErrorOf(result: unknown): string {
  const row = asRecord(result)
  const error = asRecord(row?.error)
  return textOf(error?.message) ?? '上传失败'
}

/** 投递证据归一：只有 accepted 算“会话已接收”，submitted/unknown 不算。 */
export type IntakeSendOutcome = 'accepted' | 'unconfirmed' | 'failed'

/**
 * 把 sendTaskResult 的状态归一成页面状态。
 * @author ddj 2026年11月26号
 * @param result 投递结果
 * @returns accepted / unconfirmed / failed
 */
export function sendOutcomeOf(result: unknown): IntakeSendOutcome {
  const row = asRecord(result)
  const status = textOf(row?.status)
  if (status === 'accepted') return 'accepted'
  if (status === 'submitted' || status === 'unknown' || status === 'cancelled') return 'unconfirmed'
  return 'failed'
}
