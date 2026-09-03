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

/** 引用动作的返回状态。 */
export type AddOutcome = 'ok' | 'busy' | 'unavailable'

/** 引用外观类型：文件/文件夹（DSH reference source 均支持）。 */
export type RefAppearance = 'file' | 'folder'

/** 把追加引用结果映射为可读文案（ok 用 okText；busy 提示已降级纯文本；unavailable 提示不可用）。
 * @author ddj 2026年09月03号
 * @param outcome 追加结果状态
 * @param okText 成功文案（如「已添加文件引用」/「已添加文件夹引用」）
 * @returns 状态栏/通知用文案
 */
export function statusOfAdd(outcome: AddOutcome, okText: string): string {
  if (outcome === 'ok') return okText
  if (outcome === 'busy') return okText + '（输入框忙，已降级纯文本）'
  return '无法添加到对话（无会话或输入框不可用）'
}

/** DSH reference source 名（dsh-client-ui-reference 注册的 @file/@session 统一源）。 */
const REF_SOURCE = 'reference'

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
  state: { getSnapshot: () => { draft: string; draftRev: number } }
  insertReference: (ref: ReferenceInsertLike, span: TokenSpanLike) => boolean
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
    return (shell && typeof (shell as InputLike).setDraft === 'function') ? shell as InputLike : undefined
  } catch {
    return undefined
  }
}

/** 取当前草稿长度与版本；无输入门面时返回 null。
 * @author ddj 2026年08月25号 */
function draftCursor(input: InputLike | undefined): { draft: string; draftRev: number } | null {
  try {
    const s = input?.state?.getSnapshot?.()
    if (!s) return null
    return { draft: String(s.draft ?? ''), draftRev: Number(s.draftRev ?? 0) }
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

/**
 * 创建「添加到对话」动作集（apply 阶段构建一次，随 props 传给 EditorView）。
 * @author ddj 2026年08月25号
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
    const span: TokenSpanLike = { start: cur.draft.length, end: cur.draft.length, draftRev: cur.draftRev }
    const ok = safeInsert(input, reference, span)
    if (!ok) {
      // 忙态（adjudicating/submitting）或 CAS 失败：降级纯文本追加，保证动作有落点。
      const gap = cur.draft.length > 0 && !/\s$/.test(cur.draft) ? ' ' : ''
      input.setDraft(cur.draft + gap + mention + ' ')
      return 'busy'
    }
    return 'ok'
  }

  return { appendReference }
}
