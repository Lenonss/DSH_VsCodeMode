/**
 * dsh-vscode-mode client — 侧栏「测试验收」面板的纯逻辑（无 React、无 IO，可直接单测）。
 *
 * 面板把「读到的数据」与本文件给出的「该怎么显示」分开：状态文案、按钮是否可点、
 * 行上写什么，全在这里算；组件只负责摆位置。
 * @author ddj 2026年11月26号
 */
import { POLICY_MAX_BYTES } from '../shared/testCheckPolicyDefault.js'
import type { TestCheckCounts, TestCheckSheetSummary, TestCheckView } from '../shared/testCheck.js'

//region 类型

/** 规范披露状态（面板状态行与保存按钮共用）。 */
export interface PolicyView {
  /** 规范文件绝对路径。 */
  path: string
  /** 当前生效正文。 */
  text: string
  /** true = 用的是默认规则。 */
  isDefault: boolean
}

/** 保存按钮可用性判定入参。 */
export interface SavePolicyInput {
  /** 会话工作区（没有工作区时一律不可保存）。 */
  cwd?: string | null
  /** 编辑框里的草稿。 */
  draft: string
  /** 当前生效正文（用来判断有没有改动）。 */
  savedText: string
  /** 当前是否在用默认规则。 */
  isDefault: boolean
}

//endregion

//region 规范

/**
 * 状态行文案：说清「现在用的是哪一份」和「保存会写到哪」。
 * @author ddj 2026年11月26号
 * @param view 规范状态
 * @returns 一行文案
 */
export function policyStatusText(view: PolicyView): string {
  if (!view.path) return '当前使用默认规则（没有工作区，不能保存到项目）'
  return view.isDefault
    ? '当前使用默认规则；保存后写入 ' + view.path
    : '已保存到 ' + view.path
}

/**
 * 保存按钮文案：编辑框清空时语义是「删掉自定义规则，回到默认」，按钮要如实写出来。
 * @author ddj 2026年11月26号
 * @param draft 编辑框草稿
 * @returns 按钮文案
 */
export function policySaveLabel(draft: string): string {
  return String(draft ?? '').trim() === '' ? '恢复默认' : '保存'
}

/**
 * 保存按钮是否可点：需要工作区、需要有改动，且「已经是默认还清空」这种空操作不给点。
 * @author ddj 2026年11月26号
 * @param input 判定入参
 * @returns 可点返回 true
 */
export function canSavePolicy(input: SavePolicyInput): boolean {
  if (!input.cwd) return false

  const draft = String(input.draft ?? '').replace(/\r\n/g, '\n')
  if (draft === String(input.savedText ?? '')) return false
  if (draft.trim() === '' && input.isDefault) return false
  return true
}

/**
 * 规则正文的字节数（UTF-8；与宿主截断口径一致）。
 * @author ddj 2026年11月26号
 * @param text 规则正文
 * @returns 字节数
 */
export function policyBytesOf(text: string): number {
  return new TextEncoder().encode(String(text ?? '')).length
}

/**
 * 是否超过规则正文上限（超了会被截断，面板要提示）。
 * @author ddj 2026年11月26号
 * @param bytes 字节数
 * @returns 超限返回 true
 */
export function isPolicyOversize(bytes: number): boolean {
  return Number(bytes) > POLICY_MAX_BYTES
}

/**
 * 体积文案：`9.2 KB / 上限 8 KB`。
 * @author ddj 2026年11月26号
 * @param bytes 字节数
 * @returns 一行文案
 */
export function policySizeText(bytes: number): string {
  const size = (Number(bytes) / 1024).toFixed(1)
  return size + ' KB / 上限 ' + String(POLICY_MAX_BYTES / 1024) + ' KB'
}

//endregion

//region 验收单

/**
 * 行上的计数文案（通过/总数；总数为 0 时显示「空单」）。
 * @author ddj 2026年11月26号
 * @param counts 汇总计数
 * @returns 短文本
 */
export function sheetTallyOf(counts: TestCheckCounts | null | undefined): string {
  if (!counts || counts.total <= 0) return '空单'
  return String(counts.pass) + '/' + String(counts.total)
}

/**
 * 全部单列表行的副文案：快照缺失时提示走移除，正常时提示点开快照。
 * @author ddj 2026年11月26号
 * @param hasSnapshot 快照是否存在
 * @returns 一行提示
 */
export function sheetRowHint(hasSnapshot: boolean): string {
  return hasSnapshot ? '点行打开 docs 里的快照' : '快照缺失：可先导出，或直接移除这一条'
}

/**
 * 移除确认弹窗正文：把要删的两个路径写清楚，别让人点到后悔。
 * @author ddj 2026年11月26号
 * @param title 单子标题
 * @param dir 单子目录
 * @param snapshotPath 快照路径
 * @returns 多行确认文案
 */
export function removeConfirmText(title: string, dir: string, snapshotPath: string): string {
  return '移除验收单「' + title + '」？\n\n会删除：\n' + dir + '\n' + snapshotPath + '\n\n删除后不能恢复。'
}

/**
 * 把当前单的最新计数合并进「全部验收单」那一行（轮询后本地更新，不再请求列表）。
 *
 * 计数与标题都没变时返回原数组引用，避免每 2.5 秒无谓重渲染。
 * @author ddj 2026年11月26号
 * @param rows 当前列表行
 * @param view 当前单的派生视图（null 表示没有）
 * @returns 新的行数组（无变化时是原引用）
 */
export function mergeSheetCounts(
  rows: readonly TestCheckSheetSummary[],
  view: TestCheckView | null,
): readonly TestCheckSheetSummary[] {
  if (!view) return rows
  const target = rows.find((row) => row.id === view.id)
  if (!target) return rows

  const before = target.counts
  const after = view.counts
  const unchanged = target.title === view.title
    && before.total === after.total && before.pass === after.pass
    && before.fail === after.fail && before.blocked === after.blocked
    && before.todo === after.todo && before.stale === after.stale
  if (unchanged) return rows

  return rows.map((row) => (row.id === view.id ? { ...row, counts: after, title: view.title } : row))
}

//endregion
