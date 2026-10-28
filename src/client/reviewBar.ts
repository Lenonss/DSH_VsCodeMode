/**
 * 官方差异栏派生视图：位置、导航提示、失效说明与 Keep 提示的唯一来源。
 * 计数口径分离：待审是「记录数」，可跳转是「块数」，两者不同源，
 * 全部块失效时必须给出可操作叙事，不能只留一句「无法定位」。
 * 另含侧车（legacy）栏的标识文案与官方链路不可用说明：两套栏外观相近，
 * 必须显式区分，否则用户会误判为插件未升级。
 * 作者 ddj 2026年10月27号
 */
import { sessionErrorText } from './sessionError.js'

/** 官方差异栏输入：全部来自 EditorView dock 快照，不读取磁盘或 RPC。 */
export interface ReviewBarInput {
  /** 可定位（非 stale）的差异块数 */
  jumps: number
  /** 无法定位的历史差异块数 */
  stale: number
  /** 已确认无法匹配的块数；省略时兼容历史栏计数 */
  staleMissing?: number
  /** 全上下文多命中的块数 */
  staleAmbiguous?: number
  /** 官方详情已就绪且没有行级块；与 coarse 独立 */
  noBlocks?: boolean
  /** 当前差异块索引（0 基） */
  index: number
  /** 编辑器内容是否已就绪；未就绪时不得断言差异失效 */
  ready: boolean
  /** 当前文件的官方待审记录数 */
  pendingRecords: number
  /** 当前记录是否可 Keep（detail.capability.keep） */
  canKeep: boolean
}

/** 官方差异栏派生文案；调用方只负责渲染，不再自行拼装计数与提示。 */
export interface ReviewBarView {
  /** 差异位置文案，如 `2 / 6`、`无可跳转`、`载入中` */
  position: string
  /** 上一个差异按钮提示（兼作禁用原因） */
  navPrevTitle: string
  /** 下一个差异按钮提示（兼作禁用原因） */
  navNextTitle: string
  /** 失效说明，空串表示不显示 */
  notice: string
  /** 说明级别：warn 表示需要用户决策 */
  noticeTone: 'info' | 'warn'
  /** Keep 按钮提示 */
  keepHint: string
  /** 待审计数提示 */
  pendingTitle: string
}

/** @private @author ddj 2026年10月27号 @param value 任意计数输入 @returns 非负整数，NaN/负数/非数字归零 */
function safeCount(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

/** @private @author ddj 2026年10月28号 @param stale 无法定位块数。 @param ambiguous 多命中块数。 @param noBlocks 是否无行级块。 @returns 导航原因与准确的失效叙事。 */
function staleMessage(stale: number, ambiguous: number, noBlocks: boolean): { reason: string; notice: string } {
  if (noBlocks) {
    const reason = '该记录的官方补丁没有可定位的行级差异块'
    return { reason, notice: `${reason}，无法行内跳转；可展开详情核对官方记录。` }
  }
  if (ambiguous === 0) {
    return { reason: '该记录的改动已不在当前文件中，无可跳转差异',
      notice: `本记录 ${stale} 处改动均已不在当前文件中（被后续编辑覆盖或已撤销）；可点 Keep 结案（只标记已采纳，不改写磁盘），或展开详情核对原始增删。` }
  }

  const reason = '同一段上下文在当前文件出现多次，无法唯一定位'
  if (ambiguous === stale) return { reason, notice: `${reason}（可能存在重复代码块），可展开详情核对原始增删。` }
  return { reason: '部分改动缺失，其余上下文存在多处匹配，无法唯一定位',
    notice: `${stale - ambiguous} 处改动未在当前文件中找到，${ambiguous} 处上下文出现多次、无法唯一定位；可展开详情核对原始增删。` }
}

/**
 * 派生差异栏文案。
 * @public
 * @author ddj 2026年10月27号
 * @param input 差异计数、就绪状态与 Keep 能力
 * @returns 栏内位置、导航提示与失效说明
 */
export function reviewBarView(input: ReviewBarInput): ReviewBarView {
  const jumps = safeCount(input.jumps)
  const stale = safeCount(input.stale)
  const index = safeCount(input.index)
  const pendingTitle = `${safeCount(input.pendingRecords)} 条官方待审记录` + (input.ready ? `，本文件可跳转 ${jumps} 处` : '')
  const ambiguous = Math.min(stale, safeCount(input.staleAmbiguous))
  const missing = Math.min(stale - ambiguous, safeCount(input.staleMissing ?? stale - ambiguous))
  let keepHint = '保留当前记录的未处理修改'
  if (input.ready === true && jumps === 0 && input.canKeep && (stale > 0 || input.noBlocks)) {
    keepHint = '保留该记录的全部改动并结案：只标记已采纳，不改写磁盘'
    if (!input.noBlocks && ambiguous === 0 && missing === stale) {
      keepHint = '保留该记录的全部改动并结案：这些改动已不在文件中，记录将被标记为已采纳（不改写磁盘）'
    }
  }

  // 载入期所有块天然 stale，此时只能报告进度，不能断言改动已失效。
  if (input.ready !== true) {
    return { position: '载入中', navPrevTitle: '文件载入中', navNextTitle: '文件载入中', notice: '', noticeTone: 'info', keepHint, pendingTitle }
  }

  if (jumps > 0) {
    const at = Math.min(index + 1, jumps)
    const notice = stale > 0 ? `${stale} 处历史差异无法定位（其余 ${jumps} 处可跳转），展开详情查看原始增删。` : ''
    return { position: `${at} / ${jumps}`, navPrevTitle: '上一个差异', navNextTitle: '下一个差异', notice, noticeTone: 'info', keepHint, pendingTitle }
  }

  if (stale > 0) {
    const { reason, notice } = staleMessage(stale, ambiguous, input.noBlocks === true)
    return { position: '无可跳转', navPrevTitle: reason, navNextTitle: reason, notice, noticeTone: 'warn', keepHint, pendingTitle }
  }

  const notice = safeCount(input.pendingRecords) > 0 ? '该记录的官方补丁没有可定位的行级差异块' : ''
  const reason = notice || '当前文件没有可定位差异'
  return { position: '—', navPrevTitle: reason, navNextTitle: reason, notice, noticeTone: 'info', keepHint, pendingTitle }
}

/** 非官方栏标识：没有官方待审记录时回落的那套栏必须自述来源，避免被当成旧版插件。 */
export const SIDECAR_LABEL = '历史改动'

/** 非官方栏标识的悬停说明：讲清这些改动为何不在官方列表里。 */
export const SIDECAR_LABEL_TITLE = '这些改动没有进入官方审查列表，是插件早期版本自动保存的改动留痕。Keep 只标记为已看过，不改文件；Undo 会校验后写回文件。'

/** 非官方 Keep 的作用域说明：只标记记录，不写磁盘。 */
export const SIDECAR_KEEP_TITLE = '标记这些历史改动为已看过：只改记录，不改写磁盘文件，也不影响官方审查。'

/** 非官方 Undo 的作用域说明：走原有回滚校验写回磁盘，但不影响官方记录。 */
export const SIDECAR_UNDO_TITLE = '撤销这些历史改动（写回受回滚校验保护）：只影响这份历史记录，不影响官方审查。'

/** 当前端没有该会话时，差异栏里给中性说明而不是红色报错。 */
export const SESSION_DOWN_NOTICE = '这个会话没在当前端激活，官方审查数据暂时读不到；下面的历史改动仍可查看、Keep、Undo。'

/** 官方链路不可用提示；null 表示官方元数据正常，不需要提示。 */
export interface OfficialDownView {
  /** 提示正文，已含「官方差异不可用」前缀与可读原因 */
  text: string
  /** 重试按钮文案 */
  retryLabel: string
}

/**
 * 把官方元数据通道的失败翻译成可操作提示。
 * @public
 * @author ddj 2026年10月28号
 * @param error `edrv.review.list` 返回的错误原文（reviewFeed 的 error 字段）
 * @returns 提示正文与重试文案；空错误表示官方通道正常
 */
export function officialDownView(error: unknown): OfficialDownView | null {
  const reason = sessionErrorText(error).trim()
  if (!reason) return null

  return { text: `官方差异不可用：${reason}`, retryLabel: '重试' }
}

