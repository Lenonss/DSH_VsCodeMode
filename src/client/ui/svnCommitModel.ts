/**
 * dsh-vscode-mode client — 提交对话框纯投影（分区 / 默认勾选 / 校验 / 结果行）。
 *
 * 纯函数、无 RPC、无 React：勾选规则（谁默认勾、谁默认不勾）是产品口径，
 * 必须能单测，否则「默认不勾未版本化」这类保护很容易在改 UI 时被顺手改掉。
 * @author ddj 2026年11月15号
 */
import type { SvnAiPlanCommit, SvnChangeEntry, SvnCommitEntry, SvnCommitResult, SvnStatusTone } from '../../shared/svn.js'
import { COMMIT_SUBJECT_MAX, SVN_STATUS_TONE, commitMsgErrorOf, isSvnChange, isSvnDiffable } from '../../shared/svn.js'

/** 提交对话框里的一个分区。 */
export interface CommitSection {
  /** 分区键（changelist:<name> / ungrouped / unversioned）。 */
  key: string
  /** 展示名。 */
  label: string
  /** 分区内条目。 */
  entries: SvnChangeEntry[]
  /** 默认是否勾选。 */
  defaultChecked: boolean
}

/** 提交范围种子（AI 拆分建议 → 预填提交对话框）。 */
export interface CommitSeed {
  /** 预选路径。 */
  paths: string[]
  /** 预填提交信息。 */
  message?: string
}

/** 「提交时忽略」保留名（TortoiseSVN 约定：该组默认不提交）。 */
export const IGNORE_ON_COMMIT = 'ignore-on-commit'

/**
 * 变更清单 → 分区（changelist 组 / 未分组 / 未版本控制）。
 * 默认勾选：changelist 组与未分组为是；未版本控制与 ignore-on-commit 为否。
 *
 * 只登记过分区、当前没有可提交改动的组也要出现在清单里：svn status 会把这些条目
 * 以 item="normal" 返回，而 `isSvnChange` 只收可提交条目，组会被整体过滤掉；
 * 故用计划里的 changelists 名补出空分区（0 条目），避免「看不到其它提交组」。
 * @author ddj 2026年11月15号 / 2026年11月21号
 * @param entries 变更清单
 * @param knownChangelists 空分区兜底用的 changelist 名（来自提交计划）
 * @returns 分区列表（顺序：分组按名字、未分组、未版本控制）
 */
export function commitSectionsOf(entries: readonly SvnChangeEntry[], knownChangelists: readonly string[] = []): CommitSection[] {
  const groups = new Map<string, SvnChangeEntry[]>()
  const ungrouped: SvnChangeEntry[] = []
  const unversioned: SvnChangeEntry[] = []
  for (const entry of entries) {
    if (!entry || !isSvnChange(entry)) continue
    if (entry.status === 'unversioned') { unversioned.push(entry); continue }
    if (entry.changelist) {
      const bucket = groups.get(entry.changelist)
      if (bucket) bucket.push(entry)
      else groups.set(entry.changelist, [entry])
      continue
    }
    ungrouped.push(entry)
  }
  const names = [...new Set([...groups.keys(), ...knownChangelists.filter(Boolean)])].sort((a, b) => a.localeCompare(b))
  const sections: CommitSection[] = []
  for (const name of names) {
    sections.push({
      key: 'changelist:' + name,
      label: name,
      entries: groups.get(name) ?? [],
      defaultChecked: name !== IGNORE_ON_COMMIT,
    })
  }
  if (ungrouped.length) sections.push({ key: 'ungrouped', label: '（未分组）', entries: ungrouped, defaultChecked: true })
  if (unversioned.length) sections.push({ key: 'unversioned', label: '（未版本控制）', entries: unversioned, defaultChecked: false })
  return sections
}

/**
 * 默认勾选集合（种子存在时只勾种子内路径，用于「逐组提交」预填）。
 * @author ddj 2026年11月15号
 * @param sections 分区
 * @param seed 预选路径（空 = 按分区默认）
 * @returns 勾选路径集合
 */
export function defaultCheckedOf(sections: readonly CommitSection[], seed: readonly string[] = []): Set<string> {
  if (seed.length) return new Set(seed)
  const checked = new Set<string>()
  for (const section of sections) {
    if (!section.defaultChecked) continue
    for (const entry of section.entries) checked.add(entry.path)
  }
  return checked
}

/** 已勾选范围统计（工具带「已选 N / M」、遥测行与主按钮计数同源）。 */
export interface CommitStats {
  /** 全部分区条目数。 */
  total: number
  /** 已勾选条目数。 */
  picked: number
  /** 已勾选条目按状态分级计数（分级口径见 SVN_STATUS_TONE）。 */
  byTone: Record<SvnStatusTone, number>
}

/**
 * 统计提交范围：总数、勾选数、勾选条目按状态分级计数。
 * @author ddj 2026年11月15号
 * @param sections 分区
 * @param checked 勾选路径集合
 * @returns 统计结果（byTone 只统计已勾选条目；空集合各计数为 0）
 */
export function commitStatsOf(sections: readonly CommitSection[], checked: ReadonlySet<string>): CommitStats {
  const byTone: Record<SvnStatusTone, number> = { modified: 0, added: 0, deleted: 0, conflict: 0, plain: 0 }
  let total = 0
  let picked = 0
  for (const section of sections) {
    for (const entry of section.entries) {
      total += 1
      if (!checked.has(entry.path)) continue

      picked += 1
      byTone[SVN_STATUS_TONE[entry.status] ?? 'plain'] += 1
    }
  }
  return { total, picked, byTone }
}

/**
 * 分区勾选三态（分组头的全选 / 半选 / 未选）。
 * @author ddj 2026年11月15号
 * @param section 分区
 * @param checked 勾选路径集合
 * @returns `all` 全选、`none` 未选（含空分区）、`part` 部分勾选
 */
export function groupTriStateOf(section: CommitSection, checked: ReadonlySet<string>): 'all' | 'none' | 'part' {
  let picked = 0
  for (const entry of section.entries) {
    if (checked.has(entry.path)) picked += 1
  }
  if (!picked) return 'none'

  return picked === section.entries.length ? 'all' : 'part'
}

/**
 * 提交信息校验（首行 + 正文；与 host 同口径，只用于按钮禁用与就地提示）。
 * @author ddj 2026年11月15号
 * @param message 完整提交信息
 * @returns 错误文案；合法为 null
 */
export function commitMessageErrorOf(message: string): string | null {
  const text = String(message ?? '')
  if (!text.trim()) return '请填写提交信息'
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const subject = (lines[0] ?? '').trim()
  const body = lines.slice(1).join('\n').trim()
  return commitMsgErrorOf(subject, body)
}

/**
 * 提交信息字符数提示（首行超长时前置警告）。
 * @author ddj 2026年11月15号
 * @param message 完整提交信息
 * @returns 状态位文案
 */
export function commitHintOf(message: string): string {
  const lines = String(message ?? '').replace(/\r\n/g, '\n').split('\n')
  const subject = (lines[0] ?? '').trim()
  if (!subject) return '首行将作为提交标题'
  return '首行 ' + subject.length + '/' + COMMIT_SUBJECT_MAX + ' 字符'
}

/**
 * 提交结果 → 展示行（新版本号 / 逐文件动作 / 跳过项 / 冲突）。
 * @author ddj 2026年11月15号
 * @param result 提交结果
 * @returns 展示行（空数组 = 无内容）
 */
export function commitResultLinesOf(result: SvnCommitResult | null | undefined): string[] {
  if (!result) return []
  const lines: string[] = []
  lines.push(result.revision !== undefined ? '提交成功：r' + result.revision : result.summary)
  for (const entry of result.entries ?? []) lines.push(entry.action + ' ' + entry.path)
  for (const path of result.skipped ?? []) lines.push('跳过 ' + path + '（无待提交变更）')
  for (const path of result.conflicts ?? []) lines.push('冲突 ' + path + '（请先更新并解决）')
  return lines
}

/**
 * AI 拆分建议 → 提交对话框种子（逐组提交入口只预填，不自动提交）。
 * @author ddj 2026年11月15号
 * @param group AI 拆分建议组
 * @returns 种子（路径 + 信息草稿）
 */
export function commitSeedOf(group: SvnAiPlanCommit): CommitSeed {
  const body = group.body ?? ''
  return {
    paths: [...group.paths],
    message: body ? group.subject + '\n\n' + body : group.subject,
  }
}

/**
 * 逐文件动作 → 着色分组（结果区）。
 * @author ddj 2026年11月15号
 * @param entries 动作列表
 * @returns 每行文本与语义色
 */
export function commitEntryLinesOf(entries: readonly SvnCommitEntry[]): Array<{ text: string; tone: string }> {
  const tone: Record<SvnCommitEntry['action'], string> = { M: 'modified', A: 'added', D: 'deleted', R: 'added' }
  return entries.map((entry) => ({ text: entry.action + ' ' + entry.path, tone: tone[entry.action] ?? 'plain' }))
}

/** 提交行右键菜单的动作可用性（纯投影：不可用即不执行）。 */
export interface CommitActs {
  /** 与基线比较（仅可文本比较的文件）。 */
  compare: boolean
  /** 查看日志（仅受版本控制的目标）。 */
  log: boolean
  /** 打开工作区文件。 */
  open: boolean
  /** 打开父目录。 */
  openParent: boolean
  /** 复制路径。 */
  copyPath: boolean
  /** 勾选 / 取消勾选该行。 */
  toggle: boolean
  /** SVN 还原该行。 */
  revert: boolean
  /** 加入版本控制（仅未版本控制的目标）。 */
  add: boolean
}

/**
 * 计算提交行在右键菜单里的动作可用性。
 *
 * 提交进行中一律不可用：此时改勾选会改变已发出的提交范围，读写都会与结果打架。
 * @author ddj 2026年11月21号
 * @param entry 待提交条目（缺省 = 无目标，全部不可用）
 * @param busy 提交或 AI 生成进行中
 * @returns 各动作可用性
 */
export function commitActs(entry: SvnChangeEntry | null | undefined, busy: boolean): CommitActs {
  if (!entry) {
    return { compare: false, log: false, open: false, openParent: false, copyPath: false, toggle: false, revert: false, add: false }
  }

  const usable = !busy
  return {
    compare: usable && isSvnDiffable(entry.path, entry.status),
    log: usable && entry.versioned,
    open: usable,
    openParent: usable,
    copyPath: usable,
    toggle: usable,
    revert: usable && entry.versioned,
    add: usable && !entry.versioned,
  }
}

/** 行选中（多选）状态：提交范围仍由复选框决定，选中只服务批量菜单。 */
export interface RowPick {
  /** 选中路径（恒按显示顺序）。 */
  selected: string[]
  /** Shift 范围锚点。 */
  anchor: string | null
}

/**
 * 行选中变更：单击选中、Ctrl 切换、Shift 从锚点取范围。
 * @author ddj 2026年11月21号
 * @param pick 当前选中 @param order 显示顺序 @param path 目标路径 @param mode single | toggle | range
 * @returns 新的选中状态（顺序恒按显示顺序）
 */
export function nextRowPick(pick: RowPick, order: readonly string[], path: string, mode: 'single' | 'toggle' | 'range'): RowPick {
  if (mode === 'range' && pick.anchor) {
    const from = order.indexOf(pick.anchor)
    const to = order.indexOf(path)
    if (from >= 0 && to >= 0) return { selected: order.slice(Math.min(from, to), Math.max(from, to) + 1), anchor: pick.anchor }
  }

  if (mode === 'toggle') {
    const next = pick.selected.includes(path) ? pick.selected.filter((item) => item !== path) : [...pick.selected, path]
    return { selected: order.filter((item) => next.includes(item)), anchor: path }
  }

  return { selected: order.includes(path) ? [path] : [], anchor: path }
}
