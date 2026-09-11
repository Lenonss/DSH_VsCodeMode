/**
 * dsh-vscode-mode client — 把文件/选中内容注入会话对话输入框（composer draft）。
 * 复用 DSH 官方输入门面：ctx.conversation.input.for(sessions.scope(sessionId)) → SessionInput。
 * 引用 chip：insertReference（reference source，发送时序列化为 @path 文本）；忙态降级为纯文本 setDraft。
 * 纯函数部分 node 可单测。
 * 作者 ddj 2026-08-25
 */

/** 文件引用可选的行区间（选中内容用）。 */
export interface RefRange {
  startLine: number
  endLine: number
}

/** 引用动作的返回状态（failed = 两条通道都没写成，内容未被改动）。 */
export type AddOutcome = 'ok' | 'busy' | 'unavailable' | 'failed'

/** 引用外观类型：文件/文件夹（DSH reference source 均支持）。 */
export type RefAppearance = 'file' | 'folder'

/** 把追加引用结果映射为可读文案（ok 用 okText；busy 提示已降级纯文本；unavailable 提示不可用）。
 * @author ddj 2026年09月03号 / 2026年09月11号
 * @param outcome 追加结果状态
 * @param okText 成功文案（如「已添加文件引用」/「已添加文件夹引用」）
 * @returns 状态栏/通知用文案
 */
export function statusOfAdd(outcome: AddOutcome, okText: string): string {
  if (outcome === 'ok') return okText
  if (outcome === 'busy') return okText + '（已降级纯文本）'
  if (outcome === 'failed') return '添加引用失败（输入框忙或未就绪，请重试）'
  return '无法添加到对话（无会话或输入框不可用）'
}

/** DSH reference source 名（dsh-client-ui-reference 注册的 @file/@session 统一源）。 */
const REF_SOURCE = 'reference'

/** 输入快照的引用出现项（clipboard 投影中的位置与长度，用于坐标换算）。 */
export interface OccurrenceLike {
  /** clipboard 投影中的起始偏移（chip 左边界）。 */
  offset?: number
  /** clipboard 投影中的长度（chip 展开成 `@path` 全文的长度）。 */
  length?: number
}

/** 输入快照（draft 为 clipboard 投影；occurrences 为 chip 列表）。 */
export interface CursorSnapshot {
  draft: string
  draftRev: number
  occurrences?: readonly OccurrenceLike[]
}

/**
 * 把 clipboard 投影的末尾折算成 **detect 投影**的末尾。
 *
 * ⚠️ 两个投影对 chip 的计长不同，混用会直接毁掉已插入的引用（真实缺陷，勿改回 `draft.length`）：
 * DSH 的 `$composerLayout()` 中 chip 在 detect 投影里只贡献 **1 个 U+FFFC**，
 * 在 clipboard 投影里贡献 `clipboardText` 全文
 * （`pushLeaf('chip', kid, '￼', kid.getTextContent())`）。
 * 而 `insertReference(ref, span)` 的 span 走 detect 坐标并经 `selectSpan` 校验：
 * `span.end > layout.detectLength` 时返回 null → 插入失败。
 *
 * 旧实现直接用 `draft.length`（clipboard 长度）当 detect 起点：草稿里一旦有 chip，
 * 该值就超出 detect 长度 → 插入被拒 → 落入 `setDraft` 兜底，
 * 而 `setDraft` 会整篇重建并剔除 U+FFFC（`text.replace(REFERENCE_PLACEHOLDER_RE, '')`），
 * 于是**既有 chip 被销毁、引用退化为重复的纯文本**（即「连续添加多个引用显示异常」）。
 *
 * 换算：每个 chip 在 clipboard 中多算了 `length - 1`，逐个扣回即得 detect 末尾。
 * 无 occurrences（旧版 DSH）时退化为 `draft.length`，与旧行为一致。
 * @author ddj 2026年09月11号
 * @param snapshot 输入快照
 * @returns detect 投影中的文档末尾偏移
 */
export function detectEndOf(snapshot: CursorSnapshot): number {
  const total = String(snapshot?.draft ?? '').length
  const occurrences = snapshot?.occurrences
  if (!Array.isArray(occurrences) || !occurrences.length) return total
  let clipped = 0
  for (const occurrence of occurrences) {
    const length = Number(occurrence?.length ?? 0)
    if (!Number.isFinite(length) || length <= 1) continue
    clipped += length - 1
  }
  return Math.max(0, total - clipped)
}

/** chip 列表按 clipboard 偏移升序（官方已排序，此处防御性归一，丢弃非法项）。 */
function chipsOf(snapshot: CursorSnapshot): Array<{ offset: number; length: number }> {
  const occurrences = snapshot?.occurrences
  if (!Array.isArray(occurrences) || !occurrences.length) return []
  const out: Array<{ offset: number; length: number }> = []
  for (const occurrence of occurrences) {
    const offset = Number(occurrence?.offset ?? Number.NaN)
    const length = Number(occurrence?.length ?? Number.NaN)
    if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 1) continue
    out.push({ offset: Math.max(0, offset), length })
  }
  return out.sort((a, b) => a.offset - b.offset)
}

/**
 * detect 偏移 → clipboard 偏移（paddingAt 用：draft 是 clipboard 投影，不能直接按下标取字符）。
 * 每个位于该偏移之前的 chip 在 clipboard 中多占 `length − 1`，累计补上即可。
 * @author ddj 2026年09月11号
 * @param snapshot 输入快照
 * @param detectOffset detect 投影偏移
 * @returns clipboard 投影偏移（已夹到 draft 范围内）
 */
export function detectToClipboardOf(snapshot: CursorSnapshot, detectOffset: number): number {
  const total = String(snapshot?.draft ?? '').length
  const target = Math.max(0, Math.min(Number(detectOffset) || 0, detectEndOf(snapshot)))
  let shift = 0
  for (const chip of chipsOf(snapshot)) {
    const chipDetect = chip.offset - shift
    if (chipDetect >= target) break
    shift += chip.length - 1
  }
  return Math.max(0, Math.min(target + shift, total))
}

/**
 * 插入点两侧是否需要补空格（仅纯文本通道需要；chip 由 facade 自行补尾随空格）。
 *
 * 在 detect 坐标的任意位置求值，故**末尾追加的行为与旧实现逐字符一致**
 * （末尾前为非空白 → 前后各补一个空格；末尾前已是空白 → 只补尾随空格），
 * 同时正确支持「插在文本中间」不再贴字。
 * @author ddj 2026年09月11号
 * @param snapshot 输入快照
 * @param detectOffset detect 投影插入点
 * @returns 是否需要前导/尾随空格
 */
export function paddingAt(snapshot: CursorSnapshot, detectOffset: number): { lead: boolean; tail: boolean } {
  const draft = String(snapshot?.draft ?? '')
  const at = detectToClipboardOf(snapshot, detectOffset)
  const before = at > 0 ? draft.slice(at - 1, at) : ''
  const after = at < draft.length ? draft.slice(at, at + 1) : ''
  return {
    lead: before !== '' && !/\s/.test(before),
    // 末尾（after 为空）也补尾随空格：与旧「追加到末尾」行为一致
    tail: after === '' || !/\s/.test(after),
  }
}

/**
 * 解析插入点（detect 坐标）：优先用输入框**当前光标/选区**（`caretSpan()`，
 * 官方契约即 detect 坐标，无选区时回落文档末尾），并夹到 `[0, detectLength]`。
 *
 * 选区非塌缩时取 `end`（右边界）—— 插入而非替换，绝不删除用户已选中的内容。
 * caret 缺失/非法（旧版 facade 无该方法、抛异常、NaN 等）一律回落到文档末尾。
 * @author ddj 2026年09月11号
 * @param caret caretSpan() 的返回值（可为 null/非法）
 * @param detectLength detect 投影文档长度
 * @returns detect 投影插入偏移
 */
export function insertOffsetOf(caret: unknown, detectLength: number): number {
  const max = Math.max(0, Number(detectLength) || 0)
  if (!caret || typeof caret !== 'object') return max
  const span = caret as { start?: unknown; end?: unknown }
  const raw = Number(span.end)
  const value = Number.isFinite(raw) ? raw : Number(span.start)
  if (!Number.isFinite(value)) return max
  return Math.max(0, Math.min(value, max))
}

/**
 * 生成 DSH @file 语法引用串：cwd 相对化、\ → /、含空白时按 @"path" 语法加引号。
 * cwd 外/无法相对化的路径回退原路径。
 * @author ddj 2026年08月25号
 * @param path 打开的文件路径（相对 cwd 或绝对）
 * @param cwd 会话工作区目录（可选）
 * @returns 引用串（如 @src/index.ts 或 @"a b.ts"）
 */
export function mentionOf(path: string, cwd: string | undefined): string {
  const raw = String(path)
  let rel = raw
  if (cwd) {
    const base = String(cwd).replace(/[\\/]+$/, '')
    const up = raw.replace(/\\/g, '/')
    const baseUp = base.replace(/\\/g, '/')
    if (up.startsWith(baseUp + '/')) rel = up.slice(baseUp.length + 1)
    else if (up === baseUp) rel = ''
  }
  rel = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!rel) rel = raw.replace(/\\/g, '/')
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(rel)) return '@' + raw
  return /\s/u.test(rel) ? `@"${rel}"` : `@${rel}`
}

/** 引用标签：文件名 + 可选行区间（chip 内展示，不带 @ 前缀）。
 * @author ddj 2026年08月25号 */
export function labelOf(path: string, range: RefRange | undefined): string {
  const base = String(path).split(/[\\/]/).pop() || String(path)
  if (!range || range.endLine < range.startLine) return base
  return range.startLine === range.endLine
    ? `${base} L${range.startLine}`
    : `${base} L${range.startLine}-${range.endLine}`
}

/** 引用 ref：引用串 + 可选行区间（序列化直出，agent 据此读取对应片段）。
 * @author ddj 2026年08月25号 */
export function refOf(mention: string, range: RefRange | undefined): string {
  if (!range || range.endLine < range.startLine) return mention
  return range.startLine === range.endLine
    ? `${mention} L${range.startLine}`
    : `${mention} L${range.startLine}-${range.endLine}`
}

/** 构造 DSH 文件引用插入载荷（source=reference，发送序列化为 mention(+range) 文本）。
 * @param path 目标路径（相对 cwd 或绝对）
 * @param cwd 会话工作区目录（可选）
 * @param range 行区间（可选）
 * @param appearance 引用外观：'file'（默认）| 'folder'
 */
export function buildFileRef(
  path: string,
  cwd: string | undefined,
  range?: RefRange,
  appearance: RefAppearance = 'file',
): { reference: ReferenceInsertLike; mention: string } {
  const mention = mentionOf(path, cwd)
  return {
    mention,
    reference: {
      source: REF_SOURCE,
      ref: refOf(mention, range),
      label: labelOf(path, range),
      appearance,
      clipboardText: mention,
    },
  }
}

/** 输入门面最小形状（运行时来自 ctx.conversation.input，避免引入新类型依赖）。 */
export interface InputLike {
  state: { getSnapshot: () => CursorSnapshot }
  /**
   * 当前光标/选区（**detect 坐标**；无选区时回落为文档末尾的塌缩 span）。
   * 官方 facade 契约：`caretSpan(): { start, end }`，与 insertReference 同一坐标系。
   */
  caretSpan?: () => { start?: number; end?: number } | null
  insertReference: (ref: ReferenceInsertLike, span: TokenSpanLike) => boolean
  /** 纯文本插入（官方 plain-text reference path；按 detect 坐标替换，不重建文档）。 */
  insertText?: (text: string, span: TokenSpanLike, keepCompleting?: boolean) => boolean
  setDraft: (text: string) => void
}

/** ReferenceInsert 结构形状（与 dsh-client-ui-input-trigger 类型一致）。 */
export interface ReferenceInsertLike {
  source: string
  ref: string
  label: string
  appearance?: 'session' | 'file' | 'folder'
  clipboardText: string
}

/** TokenSpan 结构形状（start/end 为草稿字符偏移，draftRev 为 CAS 版本）。 */
export interface TokenSpanLike {
  start: number
  end: number
  draftRev: number
}

/** ctx 依赖的最小面（sessions.scope + conversation.input）。 */
export interface CtxLike {
  get: (name: string) => unknown
}

/** 注入器产物：给 EditorView 用的动作集合。 */
export interface AddToConversation {
  /** 追加文件/文件夹引用 chip（@path [Lstart-end]）；忙态自动降级纯文本。 */
  appendReference(
    sessionId: string | undefined,
    path: string,
    range?: RefRange,
    appearance?: RefAppearance,
  ): Promise<AddOutcome>
}

/**
 * 解析会话输入门面；缺失时返回 undefined（动作侧守卫降级）。
 * @author ddj 2026年08月25号
 * @param ctx 客户端服务上下文
 * @param sessionId 会话 id
 * @returns SessionInput 或 undefined
 */
export function inputFor(ctx: CtxLike, sessionId: string | undefined): InputLike | undefined {
  if (!sessionId) return undefined
  try {
    const sessions = ctx.get('sessions') as { scope?: (id: string) => unknown } | undefined
    const conversation = ctx.get('conversation') as { input?: { for: (actx: unknown) => unknown } } | undefined
    const actx = sessions?.scope?.(sessionId)
    const shell = actx && conversation?.input?.for?.(actx)
    // 探针须是我们的**实际依赖**（insertReference），而不是会被整篇重建的 setDraft
    return (shell && typeof (shell as InputLike).insertReference === 'function') ? shell as InputLike : undefined
  } catch {
    return undefined
  }
}

/** 取当前草稿快照（长度/版本/chip 列表）；无输入门面时返回 null。
 * @author ddj 2026年08月25号 / 2026年09月11号 */
function draftCursor(input: InputLike | undefined): CursorSnapshot | null {
  try {
    const s = input?.state?.getSnapshot?.()
    if (!s) return null
    return {
      draft: String(s.draft ?? ''),
      draftRev: Number(s.draftRev ?? 0),
      occurrences: Array.isArray(s.occurrences) ? s.occurrences : undefined,
    }
  } catch {
    return null
  }
}

/** 从 sessions 列表快照读会话工作区目录（与 index.ts 既有读取方式一致）。
 * @author ddj 2026年08月25号 */
function cwdOf(ctx: CtxLike, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  try {
    const sessions = ctx.get('sessions') as
      | { list?: { getSnapshot?: () => { byId?: Record<string, { cwd?: string }> } } }
      | undefined
    return sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd
  } catch {
    return undefined
  }
}

/** 输入门面插入引用（拦截异常视作未应用，走降级）。
 * @author ddj 2026年08月25号 */
function safeInsert(input: InputLike, reference: ReferenceInsertLike, span: TokenSpanLike): boolean {
  try {
    return input.insertReference(reference, span) === true
  } catch {
    return false
  }
}

/** 输入门面插入纯文本（官方 plain-text 通道；不存在或异常视作未应用）。
 * @author ddj 2026年09月11号 */
function safeInsertText(input: InputLike, text: string, span: TokenSpanLike): boolean {
  if (typeof input.insertText !== 'function') return false
  try {
    return input.insertText(text, span) === true
  } catch {
    return false
  }
}

/**
 * 读输入框当前光标（detect 坐标）；门面缺失/异常返回 null（由调用方回落到文档末尾）。
 * @author ddj 2026年09月11号
 * @param input 输入门面
 * @returns caretSpan 结果或 null
 */
function caretOf(input: InputLike): { start?: number; end?: number } | null {
  if (typeof input.caretSpan !== 'function') return null
  try {
    return input.caretSpan() ?? null
  } catch {
    return null
  }
}

/**
 * 创建「添加到对话」动作集（apply 阶段构建一次，随 props 传给 EditorView）。
 *
 * 插入位置 = 输入框**当前光标**（`caretSpan()`，detect 坐标；无光标提示时回落文档末尾），
 * 不再固定追加到最末尾。坐标一律用 **detect 投影**（见 detectEndOf 的缺陷说明）；
 * 两条写入通道都失败时**不写任何内容**并返回 'failed' —— 旧实现在此处退回 `setDraft`
 * 整篇重建，会把既有 chip 全部销毁（连续添加多个引用即触发）。
 * @author ddj 2026年08月25号 / 2026年09月11号
 * @param ctx 客户端服务上下文（sessions + conversation）
 * @returns 动作集
 */
export function createAddToConversation(ctx: CtxLike): AddToConversation {
  const appendReference: AddToConversation['appendReference'] = async (sessionId, path, range, appearance) => {
    const input = inputFor(ctx, sessionId)
    if (!input) return 'unavailable'
    const cur = draftCursor(input)
    if (!cur) return 'unavailable'
    const { reference, mention } = buildFileRef(path, cwdOf(ctx, sessionId), range, appearance)
    // 光标位置（detect 坐标）；caretSpan 不可用时 = 文档末尾（旧行为）
    const at = insertOffsetOf(caretOf(input), detectEndOf(cur))
    const span: TokenSpanLike = { start: at, end: at, draftRev: cur.draftRev }
    if (safeInsert(input, reference, span)) return 'ok'
    // chip 通道被拒（忙态/坐标 CAS 过期）：改用纯文本通道就地替换，**保留既有 chip**。
    const pad = paddingAt(cur, at)
    const text = (pad.lead ? ' ' : '') + mention + (pad.tail ? ' ' : '')
    if (safeInsertText(input, text, span)) return 'busy'
    // 两条通道都不可用：宁可不写，也不整篇重建（那会销毁用户已插入的引用）
    return 'failed'
  }

  return { appendReference }
}
