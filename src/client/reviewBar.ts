/**
 * 官方差异栏派生视图：位置、导航提示、失效说明与 Keep 提示的唯一来源。
 * 计数口径分离：待审是「记录数」，可跳转是「块数」，两者不同源，
 * 全部块失效时必须给出可操作叙事，不能只留一句「无法定位」。
 * 作者 ddj 2026年10月27号
 */

/** 官方差异栏输入：全部来自 EditorView dock 快照，不读取磁盘或 RPC。 */
export interface ReviewBarInput {
  /** 可定位（非 stale）的差异块数 */
  jumps: number
  /** 无法定位的历史差异块数 */
  stale: number
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

/** @private @author ddj 2026年10月27号 @returns 无差异可跳转时的 Keep 提示 */
function fullStaleKeepHint(): string {
  return '保留该记录的全部改动并结案：这些改动已不在文件中，记录将被标记为已采纳（不改写磁盘）'
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
  const keepHint = jumps === 0 && stale > 0 && input.canKeep ? fullStaleKeepHint() : '保留当前记录的未处理修改'

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
    const reason = '该记录的改动已不在当前文件中，无可跳转差异'
    const notice = `本记录 ${stale} 处改动均已不在当前文件中（被后续编辑覆盖或已撤销）；可点 Keep 结案（只标记已采纳，不改写磁盘），或展开详情核对原始增删。`
    return { position: '无可跳转', navPrevTitle: reason, navNextTitle: reason, notice, noticeTone: 'warn', keepHint, pendingTitle }
  }

  return { position: '—', navPrevTitle: '当前文件没有可定位差异', navNextTitle: '当前文件没有可定位差异', notice: '', noticeTone: 'info', keepHint, pendingTitle }
}
