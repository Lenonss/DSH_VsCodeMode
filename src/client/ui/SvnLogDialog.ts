// @ts-nocheck
/**
 * dsh-vscode-mode client — SVN 日志弹窗（P3，居中弹窗形态，TortoiseSVN Revision Log Dialog 对标）。
 *
 * 蓝图：plans/svn-integration/06-log-ui-reference.md（§5 P0 全量，2026-09-17 实施）。
 * 布局（P0-14 起为 TortoiseSVN 同款上中下三段全宽）：
 *       头部（标题 + ✕）→ 过滤栏（字段下拉 + 搜索框 + 正则开关 + From/To 日期）→
 *       上段：修订列表（列头行 + 单行五列，全宽，高度可拖）→
 *       中段：完整提交信息（meta + 正文，全宽，高度可拖）→
 *       下段：变更路径（含 Copy from 列与受影响灰显，占余，独立滚动）→
 *       底部（状态行 + 勾选项 + 按钮组）。
 *       弹窗外框整体可拖拽调尺寸（右缘调宽 / 底缘调高 / 右下角双向，双击复位）。
 * 已实现 P0：过滤语法（-/+/!/引号/空格 AND/正则回落，G2 前端过滤）· Actions 聚合徽标 ·
 *       日期列与区间 · 蓝行（copy 进来）· 受影响路径灰显/隐藏 · Copy from 列 ·
 *       右键菜单（复用 ContextMenu）· 复制修订 · F5/↑↓ 键盘 · 按钮组 · 状态行 · 列头排序（G10）。
 * 已实现 P1 批 A：多选（Ctrl/Shift + anchor 回落）· 比较两个修订（host svn.diffPair）·
 *       Statistics 统计窗（SvnLogStats 纯前端聚合）· 分页改追加（缓存键去 limit 维度）。
 * 已实现 P1 批 B：与工作副本比较 · Show Range（区间模式徽标 + 回到最新）· Stop on copy ·
 *       WC 版号行加粗（仅文件目标）。
 * 已实现 P1 批 C：Include merged revs（P1-5，嵌套 logentry → 灰字缩进行）· Show All 上限
 *       提到 SVN_LOG_SHOW_ALL_LIMIT（P1-7，仍是有界护栏，真全量按蓝图结论不做）。
 * 作者 ddj 2026年09月16号 / 2026年09月17号 / 2026年09月18号
 */
import React from 'react'
import { SVN_LOG_ACTION_LABEL } from '../../shared/svn.js'
import { orderLogEntries } from '../../svnLog.js'
import { SVN_LOG_SHOW_ALL_LIMIT } from '../svnLog.js'
import { ModalShell } from './ModalShell.js'
import { ContextMenu } from './ContextMenu.js'
import type { ContextMenuEntry } from './ContextMenu.js'
import { SvnLogStats } from './SvnLogStats.js'
import { csvOf, downloadText, htmlTableOf } from './svnExport.js'

/** 弹窗默认宽（P0-14 可拖拽调整；窄屏按视口 clamp）。 */
const DIALOG_W_DEFAULT = 920
/** 弹窗默认高（P0-14 可拖拽调整）。 */
const DIALOG_H_DEFAULT = 720
/** 弹窗宽/高 clamp 下限（P0-14）。 */
const DIALOG_W_MIN = 680
const DIALOG_H_MIN = 480
/** 修订列表默认高（上段；P0-14 双击复位值）。 */
const LIST_H_DEFAULT = 280
/** 修订列表高 clamp 下限。 */
const LIST_H_MIN = 200
/** 提交信息区默认高（中段；P0-14 双击复位值）。 */
const MSG_H_DEFAULT = 140
/** 提交信息区高 clamp 下限。 */
const MSG_H_MIN = 60
/** 分段拖拽时下段保留的最小空间。 */
const PANE_KEEP_MIN = 170
/** 日志动作字母的配色分级（新增=绿、删除=红、替换=紫、修改=蓝）。 */
const ACTION_TONE = { A: 'added', D: 'deleted', R: 'added', M: 'modified' }
/** 排序键 → 列头名（P0-12；顺序 = 列头展示顺序）。 */
const SORT_COLUMNS = [
  { key: 'revision', label: '版本' },
  { key: 'actions', label: '动作' },
  { key: 'author', label: '作者' },
  { key: 'date', label: '日期' },
  { key: 'message', label: '信息' },
]
/** 可排序键集合（actions 列仅展示徽标，不参与排序）。 */
const SORT_KEYS = ['revision', 'author', 'date', 'message']
/** 过滤字段下拉（官方 findtype 的本插件可达子集）。 */
const FILTER_FIELDS = [
  { key: 'all', label: '全部' },
  { key: 'message', label: '信息' },
  { key: 'paths', label: '路径' },
  { key: 'author', label: '作者' },
  { key: 'revision', label: '版本' },
]

/**
 * 取提交信息首行（列表展示用）。
 * @author ddj 2026年09月16号
 * @param message 提交信息全文
 * @returns 首行文本
 */
function firstLineOf(message) {
  const text = String(message ?? '').trim()
  if (!text) return '（无提交信息）'
  return text.split(/\r?\n/)[0]
}

/**
 * 格式化提交时间（ISO8601 → 本地可读；解析失败原样返回）。
 * @author ddj 2026年09月16号
 * @param date ISO8601 字符串
 * @returns 展示文本
 */
function dateTextOf(date) {
  const text = String(date ?? '')
  if (!text) return ''
  const at = new Date(text)
  return Number.isNaN(at.getTime()) ? text : at.toLocaleString()
}

/**
 * 列内短时间（MM/DD HH:mm；解析失败原样返回，完整时间进 tooltip）。
 * @author ddj 2026年09月17号
 * @param date ISO8601 字符串
 * @returns 短时间文本
 */
function dateShortOf(date) {
  const at = new Date(String(date ?? ''))
  if (Number.isNaN(at.getTime())) return String(date ?? '')
  const pad = (n) => String(n).padStart(2, '0')
  return pad(at.getMonth() + 1) + '/' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes())
}

/**
 * 该版本的变更动作聚合（A/D/R/M 去重保序；P0-2）。
 * @author ddj 2026年09月17号
 * @param entry 日志条目
 * @returns 动作字母数组
 */
function actionsOf(entry) {
  const seen = []
  for (const p of entry.paths || []) {
    if (p?.action && !seen.includes(p.action)) seen.push(p.action)
  }
  return seen
}

/**
 * 动作字母元素（按 action 着色，带官方语义 tooltip）。
 * @author ddj 2026年09月16号
 * @param action 动作字母
 * @returns 字母元素
 */
function actionLetterEl(action) {
  const key = action || 'M'
  return React.createElement('span', {
    className: 'edrv-svn-ch edrv-svn-ch-' + (ACTION_TONE[key] ?? 'plain'),
    title: SVN_LOG_ACTION_LABEL[key] ?? key,
  }, key)
}

/**
 * 条目在显示列表中的层级（0 = 顶层；≥1 = 某父条目的 merged 子项；未出现 = null）。
 *
 * 只识别到一级嵌套：解析侧最深实测 1 层（更深按 1 级展示，不递归铺开）。
 * @author ddj 2026年09月18号
 * @param list 显示中的顶层条目列表
 * @param revision 目标修订号
 * @returns 层级或 null
 */
function levelInList(list, revision) {
  if (!Array.isArray(list)) return null
  for (const item of list) {
    if (item.revision === revision) return 0
    if ((item.merged || []).some((sub) => sub.revision === revision)) return 1
  }
  return null
}

/**
 * 上窗格可渲染行：顶层条目 + 其 merged 子项（P1-5，紧贴父条目之后、缩进一级）。
 * 只展平不排序：merged 的顺序由 svn 输出决定（父条目内嵌套顺序即官方交错顺序）。
 * @author ddj 2026年09月18号
 * @param list 排序后的顶层条目（null = 未加载）
 * @returns [{ item, level }]
 */
function logRowsOf(list) {
  if (!Array.isArray(list)) return []
  const rows = []
  for (const item of list) {
    rows.push({ item, level: 0 })
    for (const sub of item.merged || []) rows.push({ item: sub, level: 1 })
  }
  return rows
}

/**
 * 单个目标之内 merged 子项总数（状态行口径：顶层修订之外还显示了多少条）。
 * @author ddj 2026年09月18号
 * @param list 排序后的顶层条目（null = 未加载）
 * @returns merged 子项数
 */
function mergedCountOf(list) {
  if (!Array.isArray(list)) return 0
  let total = 0
  for (const item of list) total += (item.merged || []).length
  return total
}

/**
 * 写剪贴板（优先异步 API，非安全上下文回落 execCommand；失败静默忽略）。
 * @author ddj 2026年09月18号
 * @param text 文本
 */
function copyTextOf(text) {
  try {
    void navigator.clipboard?.writeText(text)
  } catch (e) {
    try {
      const input = document.createElement('textarea')
      input.value = text
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
    } catch (e2) { /* 非安全上下文等：忽略 */ }
  }
}

/**
 * 变更路径是否「受影响」（P0-5：目标路径自身或其子孙；仓库外恒非受影响，G9）。
 * @author ddj 2026年09月17号
 * @param path 变更路径条目
 * @param target 打开日志时的目标（'' = 工作区根）
 * @returns 是否受影响
 */
function isAffectedPath(path, target) {
  if (!target) return true
  const rel = path?.relPath
  if (rel === null || rel === undefined) return false
  return rel === target || rel.startsWith(target + '/')
}

/**
 * 把过滤表达式按官方语法切成词元（引号内空格不切；"" 为字面引号；无反斜杠转义）。
 * @author ddj 2026年09月17号
 * @param query 原始过滤串
 * @returns 词元数组
 */
export function tokenizeLogQuery(query) {
  const text = String(query ?? '')
  const tokens = []
  let current = ''
  let inQuote = false
  const push = () => { if (current) { tokens.push(current); current = '' } }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { current += '"'; i++ } // "" 自转义
      else if (ch === '"') { inQuote = false; push() } // 闭合引号结束词元
      else current += ch
      continue
    }
    if (ch === '"') {
      // 非引号态的 "" = 字面引号（官方 `""` 语义）；单个 " 开启短语模式（引号内空格不切分）
      if (text[i + 1] === '"') { current += '"'; i++ }
      else inQuote = true
      continue
    }
    if (/\s/.test(ch)) { push(); continue }
    current += ch
  }
  if (inQuote) push() // 未闭合引号：已有内容作为词元收尾
  else push()
  return tokens
}

/**
 * 单词元在字段文本上是否命中（regex 模式编译失败回落子串，不抛错）。
 * @author ddj 2026年09月17号
 * @param term 词元文本
 * @param hay 小写字段文本
 * @param rawText 原始字段文本（regex 用）
 * @param useRegex 是否正则模式
 * @returns 是否命中
 */
function termHits(term, hay, rawText, useRegex) {
  if (!useRegex) return hay.includes(term.toLowerCase())
  try { return new RegExp(term, 'i').test(rawText) } catch (e) { return hay.includes(term.toLowerCase()) }
}

/**
 * 条目在指定字段上的原始匹配文本（all = 四段拼接）。
 * @author ddj 2026年09月17号
 * @param entry 日志条目
 * @param field 字段键
 * @returns 文本
 */
function rawTextOf(entry, field) {
  const paths = (entry.paths || []).map((p) => String(p?.relPath ?? p?.path ?? '')).join(' ')
  if (field === 'message') return String(entry.message ?? '')
  if (field === 'paths') return paths
  if (field === 'author') return String(entry.author ?? '')
  if (field === 'revision') return String(entry.revision ?? '')
  return String(entry.author ?? '') + ' ' + String(entry.revision ?? '') + ' ' + paths + ' ' + String(entry.message ?? '')
}

/**
 * 条目在指定字段上的小写匹配文本。
 * @author ddj 2026年09月17号
 * @param entry 日志条目
 * @param field 字段键
 * @returns 小写文本
 */
function filterTextOf(entry, field) {
  return rawTextOf(entry, field).toLowerCase()
}

/**
 * 官方过滤语法判定（P0-1，G2：纯前端）：
 * - 空格分隔多项全部必须匹配（AND）；`"短语"` 含空格；`""` 为字面引号
 * - `-项` 排除、`+项` 重新纳入（顺序敏感，对同一命中后写的生效）
 * - 置首 `!` 整表达式取反；regex 模式逐词元编译、失败回落子串
 * 无反斜杠转义（官方语义中它不是转义符）。
 * @author ddj 2026年09月17号
 * @param query 原始过滤串
 * @param field 字段（all/message/paths/author/revision）
 * @param useRegex 是否正则模式
 * @returns 判定函数
 */
export function parseLogFilter(query, field = 'all', useRegex = false) {
  const tokens = tokenizeLogQuery(query)
  const negate = tokens.length > 0 && tokens[0].startsWith('!')
  const head = negate ? tokens[0].slice(1) : tokens[0]
  const ordered = (head ? [head, ...tokens.slice(1)] : tokens.slice(1))
    .map((t) => {
      if (t.startsWith('-') && t.length > 1) return { kind: 'ex', term: t.slice(1) }
      if (t.startsWith('+') && t.length > 1) return { kind: 'in', term: t.slice(1) }
      return { kind: 'and', term: t }
    })
  return (entry) => {
    const hay = filterTextOf(entry, field)
    const raw = rawTextOf(entry, field)
    let allPlain = true
    let verdict = null // null = 无 -/+ 命中；'ex' = 排除；'in' = 纳入（后写覆盖）
    for (const t of ordered) {
      // 不提前退出：后面的 + 项仍可挽救 plain 失败（官方顺序敏感语义）
      if (t.kind === 'and') { if (!termHits(t.term, hay, raw, useRegex)) allPlain = false }
      else if (termHits(t.term, hay, raw, useRegex)) verdict = t.kind
    }
    let pass = verdict ? verdict === 'in' : allPlain
    if (negate) pass = !pass
    return pass
  }
}

/**
 * 复制修订的官方五字段文本（P0-9：版本号/作者/日期/信息/变更清单）。
 * @author ddj 2026年09月17号
 * @param entry 日志条目
 * @returns 多行文本
 */
export function revisionClipboardText(entry) {
  const lines = [
    'r' + entry.revision + ' ' + (entry.author || '（无作者）') + ' ' + dateTextOf(entry.date),
    String(entry.message ?? '（无提交信息）'),
  ]
  const paths = entry.paths || []
  if (paths.length) {
    lines.push('变更文件（' + paths.length + '）：')
    for (const p of paths) lines.push('  ' + (p.action || 'M') + ' ' + String(p.relPath ?? p.path))
  }
  return lines.join('\n')
}

/**
 * 动作徽标配色类（与 .edrv-svn-ch-* 同语义配色，独立小尺寸）。
 * @author ddj 2026年09月17号
 * @param action 动作字母
 * @returns 类名
 */
function actionLetterClass(action) {
  return 'edrv-svnlog-badge-' + (ACTION_TONE[action] ?? 'plain')
}

/**
 * 上窗格列头单格（P0-12：可排序列带方向指示；actions 列仅标签）。
 * @author ddj 2026年09月17号
 * @param props.col 列定义
 * @param props.sortKey 当前排序键（null = 默认倒序）
 * @param props.sortDir 当前方向
 * @param props.onSort 点列头回调
 * @returns 列头格元素
 */
function SortCol(props) {
  const { col, sortKey, sortDir, onSort } = props
  const sortable = SORT_KEYS.includes(col.key)
  const active = sortKey === col.key
  const arrow = active ? (sortDir === 'asc' ? '↑' : '↓') : ''
  return React.createElement('span', {
    className: 'edrv-svnlog-col' + (sortable ? ' edrv-svnlog-col-sortable' : '') + (active ? ' edrv-svnlog-col-on' : ''),
    title: sortable ? '按' + col.label + '排序；再点切换升/降序' : undefined,
    onClick: sortable ? () => onSort(col.key) : undefined,
  }, col.label + (arrow ? ' ' + arrow : ''))
}

/**
 * 上窗格列头行（与数据行共用同一套列宽 class；P0-12/D30；排序中显示复位入口）。
 * @author ddj 2026年09月17号
 * @param props.sortKey/sortDir/onSort/onSortReset 排序状态与回调
 * @returns 列头行元素
 */
function LogCols(props) {
  const { sortKey, sortDir, onSort, onSortReset } = props
  return React.createElement('div', { className: 'edrv-svnlog-cols' },
    SORT_COLUMNS.map((col) => React.createElement(SortCol, { key: col.key, col, sortKey, sortDir, onSort })),
    (sortKey
      ? React.createElement('button', {
          className: 'edrv-svn-act edrv-svnlog-sort-reset', title: '恢复默认（版本号降序，最新在上）', onClick: onSortReset,
        }, '默认')
      : null))
}

/**
 * 上窗格单行（单行五列：版本/动作徽标/作者/日期/信息首行；文件数与完整时间进 tooltip；
 * 蓝行 = 本线被 copy 进来的版本，P0-4）。
 * P1-5：merged 子项灰字 + 逐级缩进，前置「↳」标记与反向合并 tooltip。
 * @author ddj 2026年09月16号 / 2026年09月17号 / 2026年09月18号
 * @param props.item 日志条目（顶层或 merged 子项）
 * @param props.on 是否选中
 * @param props.wc 是否为工作副本当前版号（P1-9 加粗）
 * @param props.level 嵌套层级（0 = 顶层；P1-5）
 * @param props.onPick 选中回调（event, item；Ctrl/Shift 修饰由父级解释，P1-3）
 * @param props.onMenu 右键回调（event, item）
 * @returns 行元素
 */
function LogItem(props) {
  const { item, on, wc, level, onPick, onMenu } = props
  const actions = actionsOf(item)
  const copied = (item.paths || []).some((p) => p?.copyFrom)
  const merged = level > 0
  const title = (merged ? '合并进来的修订 · ' : '')
    + firstLineOf(item.message)
    + ' · r' + item.revision + ' · ' + dateTextOf(item.date)
    + ' · ' + (item.paths?.length || 0) + ' 文件'
    + (item.reverseMerge ? ' · 反向合并（reverse-merge）' : '')
  return React.createElement('div', {
    className: 'edrv-svnlog-item'
      + (on ? ' edrv-svnlog-item-on' : '')
      + (copied ? ' edrv-svnlog-item-copied' : '')
      + (merged ? ' edrv-svnlog-item-merged' : '')
      + (wc ? ' edrv-svnlog-item-wc' : ''),
    title,
    style: merged ? { paddingLeft: 6 + level * 18 } : undefined,
    onClick: (event) => onPick(event, item),
    onContextMenu: (event) => onMenu?.(event, item),
  },
    (merged ? React.createElement('span', { className: 'edrv-svnlog-cell edrv-svnlog-merge-mark' }, '↳') : null),
    React.createElement('span', { className: 'edrv-svnlog-cell edrv-svnlog-cell-rev edrv-svnlog-rev' }, 'r' + item.revision),
    React.createElement('span', { className: 'edrv-svnlog-cell edrv-svnlog-cell-act' },
      actions.map((a) => React.createElement('span', { key: a, className: 'edrv-svnlog-badge ' + actionLetterClass(a) }, a))),
    React.createElement('span', { className: 'edrv-svnlog-cell edrv-svnlog-cell-author' }, item.author || '（无作者）'),
    React.createElement('span', { className: 'edrv-svnlog-cell edrv-svnlog-cell-date', title: dateTextOf(item.date) }, dateShortOf(item.date)),
    React.createElement('span', { className: 'edrv-svnlog-cell edrv-svnlog-cell-msg' }, firstLineOf(item.message)))
}

/**
 * 拖拽分隔条（P0-13：竖条调左右分栏宽，横条调右侧上下占比；双击复位）。
 * @author ddj 2026年09月17号
 * @param props.vertical 是否竖向（col-resize）
 * @param props.title tooltip 主题
 * @param props.onDragStart pointerdown 回调（弹窗侧启动 window 级 move/up 跟踪）
 * @param props.onReset 双击复位
 * @returns 分隔条元素
 */
function Splitter(props) {
  const { vertical, title, onDragStart, onReset } = props
  return React.createElement('div', {
    className: vertical ? 'edrv-svnlog-vsplit' : 'edrv-svnlog-hsplit',
    title: title + '（双击复位）',
    onPointerDown: onDragStart,
    onDoubleClick: (event) => { event.stopPropagation(); onReset() },
  })
}

/**
 * 吞掉拖拽结束后浏览器派发的下一次合成 click（capture 一次性）。
 * 拖拽常把指针移出卡片，松手后 click 落在遮罩上会误触「点遮罩关闭」。
 * @author ddj 2026年09月17号
 */
function swallowNextClick() {
  const swallow = (event) => {
    event.stopPropagation()
    event.preventDefault()
    window.removeEventListener('click', swallow, true)
  }
  window.addEventListener('click', swallow, true)
  window.setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}

/**
 * 外框尺寸手柄（P0-14）：mode 'r'=右缘调宽 / 'b'=底缘调高 / 'c'=右下角双向；双击复位。
 * @author ddj 2026年09月17号
 * @param props.mode 手柄形态
 * @param props.onDragStart pointerdown 回调（弹窗侧启动 window 级跟踪）
 * @param props.onReset 双击复位
 * @returns 手柄元素
 */
function Grip(props) {
  const { mode, onDragStart, onReset } = props
  return React.createElement('div', {
    className: 'edrv-svnlog-grip edrv-svnlog-grip-' + mode,
    onPointerDown: (event) => onDragStart(event, mode),
    onDoubleClick: (event) => { event.stopPropagation(); onReset() },
  })
}

/**
 * 下窗格变更路径单行（双击看差异；目录打开；Copy from 成列 P0-7；非受影响灰显 P0-5）。
 * relPath 三态：null = 仓库外（显示仓库原路径）；'' = 工作副本根自身变更（如合并属性，
 * 显示占位文案）；其余 = 工作区相对路径。根条目不提供打开/差异动作。
 * @author ddj 2026年09月16号 / 2026年09月17号
 * @param props.item 日志路径条目
 * @param props.revision 所属版本
 * @param props.dim 非受影响（灰显）
 * @param props.onOpenFile 打开工作区文件
 * @param props.onOpenDiff 打开版本差异
 * @param props.onMenu 右键回调（event, item, revision）
 * @returns 行元素
 */
function PathRow(props) {
  const { item, revision, dim, onOpenFile, onOpenDiff, onMenu } = props
  const outside = item.relPath === null
  const isRoot = item.relPath === ''
  const actionable = !outside && !isRoot
  const open = () => { if (actionable) onOpenFile?.(item.relPath) }
  const diff = () => { if (actionable && item.kind !== 'dir') onOpenDiff?.(item.relPath, revision) }
  const relText = outside ? item.path + '（仓库外）' : (isRoot ? '（工作副本根）' : item.relPath)
  const buttons = actionable ? React.createElement('span', { className: 'edrv-svnlog-acts' },
    React.createElement('button', {
      className: 'edrv-svn-act', title: '在工作区打开该文件',
      onClick: (event) => { event.stopPropagation(); open() },
    }, '打开'),
    (item.kind === 'dir'
      ? null
      : React.createElement('button', {
          className: 'edrv-svn-act', title: '查看该版本与上一版的差异',
          onClick: (event) => { event.stopPropagation(); diff() },
        }, '差异')))
    : null
  return React.createElement('div', {
    className: 'edrv-svnlog-path' + (dim ? ' edrv-svnlog-path-dim' : ''),
    title: item.path + (item.copyFrom ? '（复制自 ' + item.copyFrom + '@' + (item.copyFromRev ?? '?') + '）' : '')
      + (outside ? '（仓库外路径）' : (isRoot ? '（工作副本根自身变更，常见于合并属性）' : ''))
      + (item.kind === 'dir' ? '' : '（双击查看该版本差异）'),
    onDoubleClick: () => { if (item.kind === 'dir') open(); else diff() },
    onContextMenu: (event) => onMenu?.(event, item, revision),
  },
    actionLetterEl(item.action),
    React.createElement('span', { className: 'edrv-svnlog-pathtext' }, relText),
    (item.kind === 'dir' ? React.createElement('span', { className: 'edrv-svnlog-kind' }, '目录') : null),
    (item.copyFrom ? React.createElement('span', { className: 'edrv-svnlog-kind' }, '复制') : null),
    React.createElement('span', { className: 'edrv-svnlog-copyfrom', title: item.copyFrom ? item.copyFrom + '@' + (item.copyFromRev ?? '?') : '' },
      item.copyFrom ? item.copyFrom + '@' + (item.copyFromRev ?? '?') : ''),
    buttons)
}

/**
 * 上窗格列表（列头行 + 数据行 + 「加载更多」；P0-13 宽度受拖拽控制）。
 * @author ddj 2026年09月16号 / 2026年09月17号
 * @param props.list 过滤排序后的条目（null = 未加载）
 * @param props.selected 选中条目数组（P1-3 多选；至少一条，由父级保证）
 * @param props.keyword 过滤词（决定空态文案）
 * @param props.busy 加载中
 * @param props.truncated 是否可能还有更多
 * @param props.sortKey/sortDir/onSort/onSortReset 列头排序
 * @param props.onPick 选中回调（event, item；P1-3 修饰键由父级解释）
 * @param props.onLoadMore 加载更多
 * @param props.onItemMenu 行右键回调
 * @param props.height 列表高度像素（P0-14 上段，拖拽受控；宽度随弹窗全宽）
 * @param props.wcRev 文件目标的工作副本版号（P1-9；null = 不加粗）
 * @returns 列表元素
 */
function LogList(props) {
  const { list, selected, keyword, busy, truncated, sortKey, sortDir, onSort, onSortReset, onPick, onLoadMore, onItemMenu, height, wcRev } = props
  let inner
  if (list === null) {
    inner = React.createElement('div', { className: 'edrv-tree-loading' }, busy ? '读取日志中…' : '尚未加载')
  } else if (!list.length) {
    inner = React.createElement('div', { className: 'edrv-tree-loading' }, keyword ? '无匹配条目' : '无提交历史')
  } else {
    inner = logRowsOf(list).map((row) => React.createElement(LogItem, {
      key: row.item.revision + ':' + row.level,
      item: row.item,
      on: selected.some((s) => s.revision === row.item.revision),
      wc: wcRev != null && row.item.revision === wcRev,
      level: row.level,
      onPick,
      onMenu: onItemMenu,
    }))
  }
  const more = truncated
    ? React.createElement('div', { className: 'edrv-svnlog-more' },
        React.createElement('button', {
          className: 'edrv-svn-act', disabled: busy, onClick: onLoadMore,
        }, busy ? '加载中…' : '加载更多（+100）'))
    : null
  return React.createElement('div', { className: 'edrv-svnlog-list', style: height ? { height } : undefined },
    React.createElement(LogCols, { sortKey, sortDir, onSort, onSortReset }),
    inner,
    more)
}

/**
 * 中段内容：提交信息（共用一个文本区域：单选 = 原样 meta+正文；多选 = 一条 meta 概要 + 单一 pre 内合并显示，
 * 每条带 r/作者/日期头行、横线分隔，对齐官方多选消息合并形态）。
 * @author ddj 2026年09月16号 / 2026年09月18号
 * @param props.selected 选中条目数组（≥1，由父级保证）
 * @returns meta 与正文元素
 */
function LogMsgInner(props) {
  const { selected } = props
  if (!selected || !selected.length) {
    return React.createElement('div', { className: 'edrv-svndiff-empty' }, '选择修订查看提交信息')
  }
  if (selected.length === 1) {
    const one = selected[0]
    return React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'edrv-svnlog-meta' },
        React.createElement('span', { className: 'edrv-svnlog-rev' }, 'r' + one.revision),
        React.createElement('span', null, one.author || '（无作者）'),
        React.createElement('span', { className: 'edrv-svnlog-date' }, dateTextOf(one.date))),
      React.createElement('pre', { className: 'edrv-svnlog-body' }, one.message || '（无提交信息）'))
  }
  const head = React.createElement('div', { className: 'edrv-svnlog-meta' },
    React.createElement('span', { className: 'edrv-svnlog-rev' }, 'r' + selected[0].revision + ' ~ r' + selected[selected.length - 1].revision),
    React.createElement('span', null, '已选 ' + selected.length + ' 条修订'),
    React.createElement('span', { className: 'edrv-svnlog-date' }, '信息合并显示'))
  const text = selected.map((entry) => 'r' + entry.revision + ' · ' + (entry.author || '（无作者）') + ' · ' + dateTextOf(entry.date)
    + '\n' + String(entry.message || '（无提交信息）')).join('\n----------------\n')
  return React.createElement(React.Fragment, null, head,
    React.createElement('pre', { className: 'edrv-svnlog-body' }, text))
}

/**
 * 多选合并的变更路径（按 path 去重，保留首次出现的动作与所属修订，供打开/差异动作定位）。
 * @author ddj 2026年09月18号
 * @param selected 选中条目数组（≥1）
 * @returns 合并后的路径条目（附所属修订 revision）
 */
function mergedPathsOf(selected) {
  const seen = new Map()
  for (const entry of selected) {
    for (const p of entry.paths || []) {
      if (!p?.path || seen.has(p.path)) continue
      seen.set(p.path, { ...p, revision: entry.revision })
    }
  }
  return [...seen.values()]
}

/**
 * 下段内容：变更路径（P1-3 合并视图——多选时按 path 去重合并；受影响灰显/隐藏 P0-5，G9 仓库外恒非受影响）。
 * @author ddj 2026年09月16号 / 2026年09月18号
 * @param props.selected 选中条目数组（≥1）
 * @param props.target 日志目标（受影响判定用）
 * @param props.onlyAffected 是否仅显示受影响路径
 * @param props.onOpenFile 打开工作区文件
 * @param props.onOpenDiff 打开版本差异
 * @param props.onPathMenu 路径行右键回调
 * @returns 路径头与行元素
 */
function LogPathsInner(props) {
  const { selected, target, onlyAffected, onOpenFile, onOpenDiff, onPathMenu } = props
  if (!selected || !selected.length) {
    return React.createElement('div', { className: 'edrv-svndiff-empty' }, '选择修订查看变更文件')
  }
  const allPaths = mergedPathsOf(selected)
  const shownPaths = onlyAffected ? allPaths.filter((p) => isAffectedPath(p, target)) : allPaths
  const head = React.createElement('div', { className: 'edrv-svnlog-paths-head' },
    '变更文件（' + shownPaths.length + (onlyAffected && shownPaths.length !== allPaths.length ? '/' + allPaths.length : '') + '）',
    React.createElement('span', { style: { flex: 1 } }),
    React.createElement('span', { className: 'edrv-svnlog-hint' }, '双击行查看所属修订差异；灰显 = 目标路径之外'))
  const rows = shownPaths.length
    ? shownPaths.map((item, idx) => React.createElement(PathRow, {
        key: String(item.path) + ':' + idx,
        item,
        revision: item.revision,
        dim: !onlyAffected && !isAffectedPath(item, target),
        onOpenFile,
        onOpenDiff,
        onMenu: onPathMenu,
      }))
    : React.createElement('div', { className: 'edrv-tree-loading' },
        onlyAffected && allPaths.length ? '所选修订在目标路径下无变更（其余 ' + allPaths.length + ' 项已隐藏）' : '所选修订无变更路径（仅属性改动或未取 -v）')
  return React.createElement(React.Fragment, null, head, React.createElement('div', { className: 'edrv-svnlog-paths' }, rows))
}

/**
 * 头部（标题 + target + 关闭；Refresh 移到底部按钮组 P0-6）。
 * @author ddj 2026年09月16号 / 2026年09月17号
 * @param props.target 目标路径
 * @param props.onClose 关闭
 * @returns 头部元素
 */
function LogHead(props) {
  const { target, onClose } = props
  return React.createElement('div', { className: 'edrv-svnlog-head' },
    React.createElement('h3', { className: 'edrv-svnlog-title' }, 'SVN 日志'),
    React.createElement('span', { className: 'edrv-svnlog-target', title: target || '（工作区根）' }, target || '（工作区根）'),
    React.createElement('span', { style: { flex: 1 } }),
    React.createElement('button', { className: 'edrv-svn-act', title: '关闭', onClick: onClose }, '✕'))
}

/**
 * 过滤栏（P0-1 字段下拉 + 搜索框 + 正则开关；P0-3 From/To 日期区间）。
 * @author ddj 2026年09月17号
 * @param props.field/regexOn/query/from/to 及其回调
 * @returns 过滤栏元素
 */
function LogFilterBar(props) {
  const { field, regexOn, query, from, to, onField, onRegex, onQuery, onFrom, onTo } = props
  return React.createElement('div', { className: 'edrv-svnlog-filter' },
    React.createElement('select', {
      className: 'edrv-svnlog-field', value: field, title: '搜索字段',
      onChange: (event) => onField(event.target.value),
    }, FILTER_FIELDS.map((f) => React.createElement('option', { key: f.key, value: f.key }, f.label))),
    React.createElement('input', {
      className: 'edrv-svnlog-search', placeholder: '过滤：空格=AND，-排除，+纳入，!取反，"短语"',
      value: query, onChange: (event) => onQuery(event.target.value),
    }),
    React.createElement('label', { className: 'edrv-svnlog-check', title: '把每个词元当正则表达式（语法错误回落子串匹配）' },
      React.createElement('input', { type: 'checkbox', checked: regexOn, onChange: (event) => onRegex(event.target.checked) }),
      '正则'),
    React.createElement('label', { className: 'edrv-svnlog-check' },
      '从',
      React.createElement('input', { type: 'date', className: 'edrv-svnlog-date', value: from, onChange: (event) => onFrom(event.target.value) })),
    React.createElement('label', { className: 'edrv-svnlog-check' },
      '到',
      React.createElement('input', { type: 'date', className: 'edrv-svnlog-date', value: to, onChange: (event) => onTo(event.target.value) })))
}

/**
 * 状态行文案（P0-11：条数 + 范围 + 选中数 + 变更路径数；信息序对齐官方）。
 * @author ddj 2026年09月17号 / 2026年09月18号
 * @param params list 已加载全量 / filtered 过滤后 / shownCount / keyword / truncated / current / selectedCount 选中数（P1-3）
 * @returns 状态文本
 */
function statusLineOf(list, filtered, shownCount, keyword, truncated, current, selectedCount) {
  if (!list) return '未加载'
  const maxRev = list.length ? 'r' + list[0].revision : '—'
  const minRev = list.length ? 'r' + list[list.length - 1].revision : '—'
  const changedPaths = current ? (current.paths || []).length : 0
  // P1-5：merged 的条数按顶层列表统计（-g 时总条数可超过 -l，如实标出以免误判条数）
  const mergedCount = mergedCountOf(list)
  return '显示 ' + filtered.length + ' 条修订（' + minRev + ' ~ ' + maxRev + '）'
    + (mergedCount ? ' + 合并 ' + mergedCount + ' 条' : '')
    + ' · 选中 ' + (selectedCount || 1) + ' 条 · ' + changedPaths + ' 个变更路径'
    + (keyword ? '（过滤后 ' + shownCount + ' 条）' : '')
    + (truncated ? ' · 可能还有更多' : ' · 已全部加载')
}

/**
 * 日志条目 → 导出行（W1-4）：修订/作者/日期/提交信息/路径（relPath 优先，分号拼接）。
 * @author ddj 2026年09月20号
 * @param rows 日志条目数组
 * @returns 二维字符串表（不含表头）
 */
function logExportRows(rows) {
  return (rows || []).map((entry) => [
    'r' + String(entry.revision ?? ''),
    String(entry.author ?? ''),
    String(entry.date ?? ''),
    String(entry.message ?? ''),
    (entry.paths || []).map((item) => item.relPath || item.path).join('; '),
  ])
}

/**
 * 底部（状态行 P0-11 + 勾选项 P0-5/P1-4/P1-5 + 按钮组 P0-6：Next 100 / Show All / Refresh）。
 * @author ddj 2026年09月17号 / 2026年09月18号 / 2026年09月20号
 * @param props 见内部解构
 * @returns 底部元素
 */
function LogFoot(props) {
  const { list, filtered, shownCount, keyword, truncated, current, selectedCount, onlyAffected, onOnlyAffected, busy, onLoadMore, onShowAll, onRefresh, onStats, stopOnCopy, onStopCopy, includeMerged, onIncludeMerged, rangeActive, onOpenRange, onRangeReset, onExportCsv, onExportHtml } = props
  const status = statusLineOf(list, filtered, shownCount, keyword, truncated, current, selectedCount)
  return React.createElement('div', { className: 'edrv-svnlog-footwrap' },
    React.createElement('div', { className: 'edrv-svnlog-foot' },
      React.createElement('label', { className: 'edrv-svnlog-check', title: '隐藏不落在目标路径下的变更项（未勾时灰显）' },
        React.createElement('input', { type: 'checkbox', checked: onlyAffected, onChange: (event) => onOnlyAffected(event.target.checked) }),
        '仅显示受影响路径'),
      React.createElement('label', { className: 'edrv-svnlog-check', title: '官方 Stop on copy/rename：遇到从别处复制/重命名而来的路径即停止回溯（默认不勾）' },
        React.createElement('input', { type: 'checkbox', checked: stopOnCopy === true, onChange: (event) => onStopCopy?.(event.target.checked) }),
        'Stop on copy'),
      React.createElement('label', { className: 'edrv-svnlog-check', title: '官方 Include merged revisions（svn -g）：把合并进本路径的修订交错插入，灰字缩进显示（默认不勾；输出量更大）' },
        React.createElement('input', { type: 'checkbox', checked: includeMerged === true, onChange: (event) => onIncludeMerged?.(event.target.checked) }),
        'Include merged revs'),
      (rangeActive ? React.createElement('span', { className: 'edrv-svnlog-check', title: '区间模式：仅显示指定版本区间（svn -r START:END）' }, '区间模式') : null),
      React.createElement('span', { style: { flex: 1 } }),
      status),
    React.createElement('div', { className: 'edrv-svnlog-btns' },
      React.createElement('button', {
        className: 'edrv-svn-act', disabled: busy || !truncated || rangeActive,
        title: rangeActive ? '区间模式下不可加载更多（回到最新后可用）' : (truncated ? '再取 100 条' : '已到最早提交：该目标的全部历史已显示（svn 日志只含该路径发生过变更的版本）'),
        onClick: onLoadMore,
      }, 'Next 100'),
      React.createElement('button', {
        className: 'edrv-svn-act', disabled: busy || rangeActive,
        title: rangeActive
          ? '区间模式下不可用（回到最新后可用）'
          : '取到本插件上限 ' + SVN_LOG_SHOW_ALL_LIMIT + ' 条（超大仓库可能较慢；再往前的历史可用 Show Range… 指定区间）',
        onClick: onShowAll,
      }, 'Show All'),
      React.createElement('button', {
        className: 'edrv-svn-act', disabled: busy, title: '按版本区间拉取（P1-6；起始=较早、结束=较晚）',
        onClick: onOpenRange,
      }, 'Show Range…'),
      (rangeActive
        ? React.createElement('button', { className: 'edrv-svn-act', disabled: busy, title: '清除区间，回到默认 HEAD 往前的窗口', onClick: onRangeReset }, '回到最新')
        : null),
      React.createElement('button', {
        className: 'edrv-svn-act', disabled: busy || !filtered || !filtered.length,
        title: '导出当前过滤后的修订列表为 CSV（带 BOM，Excel 直开；修订/作者/日期/信息/路径）',
        onClick: onExportCsv,
      }, '导出CSV'),
      React.createElement('button', {
        className: 'edrv-svn-act', disabled: busy || !filtered || !filtered.length,
        title: '导出当前过滤后的修订列表为 HTML 报表（仅本地查看，不外发）',
        onClick: onExportHtml,
      }, '导出HTML'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', { className: 'edrv-svn-act', disabled: busy, title: '重新读取日志（F5）', onClick: onRefresh }, 'Refresh'),
      React.createElement('button', {
        className: 'edrv-svn-act', disabled: !list || !list.length,
        title: '统计当前显示的修订（期间 / 按作者 / 按日期，P1-10）', onClick: onStats,
      }, 'Statistics')))
}

/**
 * 日志弹窗主体（P0 蓝图实施：布局/过滤/排序/菜单/键盘/按钮组）。
 * @author ddj 2026年09月16号 / 2026年09月17号
 * @param props.target 目标路径（'' = 工作区根）
 * @param props.entries 日志条目（null = 未加载）
 * @param props.truncated 是否可能还有更多
 * @param props.error 错误文案
 * @param props.busy 加载中
 * @param props.onRefresh 刷新回调
 * @param props.onLoadMore 加载更多回调
 * @param props.onShowAll 取到上限回调（P0-6）
 * @param props.onOpenDiff 打开版本差异（path, revision）
 * @param props.onOpenFile 打开工作区文件（relPath）
 * @param props.onComparePair 比较两个选中修订（revA, revB，按选中顺序；P1-2，缺省时菜单隐藏该项）
 * @param props.onCompareWorking 某版本与工作副本比较（revision；P1-1，缺省时菜单隐藏该项）
 * @param props.stopOnCopy 是否勾选 Stop on copy（P1-4）
 * @param props.onStopCopy 勾选回调（on）
 * @param props.includeMerged 是否勾选 Include merged revs（P1-5）
 * @param props.onIncludeMerged 勾选回调（on）
 * @param props.rangeActive 是否处于 Show Range 区间模式（P1-6）
 * @param props.onShowRange 应用区间（start 较早，end 较晚；P1-6）
 * @param props.onRangeReset 清除区间回到最新（P1-6）
 * @param props.wcRev 文件目标的工作副本版号（P1-9；null = 不加粗，目录/根不传）
 * @param props.onClose 关闭回调
 * @returns 弹窗元素
 */
export function SvnLogDialog(props) {
  const {
    target, entries, truncated, error, busy, onRefresh, onLoadMore, onShowAll, onOpenDiff, onOpenFile, onComparePair, onCompareWorking, stopOnCopy, onStopCopy, includeMerged, onIncludeMerged, rangeActive, onShowRange, onRangeReset, wcRev, onClose,
  } = props
  const [selected, setSelected] = React.useState([]) // P1-3：多选数组（保点击顺序）
  const [anchorRev, setAnchorRev] = React.useState(null) // P1-3：Shift 范围基准 revision
  const [query, setQuery] = React.useState('')
  const [field, setField] = React.useState('all')
  const [regexOn, setRegexOn] = React.useState(false)
  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [onlyAffected, setOnlyAffected] = React.useState(false)
  const [sortKey, setSortKey] = React.useState(null)
  const [sortDir, setSortDir] = React.useState('desc')
  const [menu, setMenu] = React.useState(null)
  const [dlgW, setDlgW] = React.useState(() => Math.min(DIALOG_W_DEFAULT, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 24)) // P0-14：外框宽（拖拽受控）
  const [dlgH, setDlgH] = React.useState(() => Math.min(DIALOG_H_DEFAULT, (typeof window !== 'undefined' ? window.innerHeight : 800) - 24)) // P0-14：外框高（拖拽受控）
  const [listH, setListH] = React.useState(LIST_H_DEFAULT) // P0-14：上段修订列表高（拖拽受控）
  const [msgH, setMsgH] = React.useState(MSG_H_DEFAULT) // P0-14：中段提交信息高（拖拽受控）
  const [statsOpen, setStatsOpen] = React.useState(false) // P1-10：统计窗开关
  const [rangeOpen, setRangeOpen] = React.useState(false) // P1-6：区间输入弹窗开关
  const [rangeFrom, setRangeFrom] = React.useState('') // P1-6：起始修订（较早）
  const [rangeTo, setRangeTo] = React.useState('') // P1-6：结束修订（较晚）
  const bodyRef = React.useRef(null)

  const list = Array.isArray(entries) ? entries : null
  // 选中项：默认首条；数据刷新/过滤后仅保留仍存在的选中（G10：按 revision 维护），全部消失回落首条；
  // anchor 同步维护（P1-3：消失即置空，下次 Shift 回落单选）
  React.useEffect(() => {
    if (!list || !list.length) { setSelected([]); setAnchorRev(null); return }
    setSelected((prev) => {
      const kept = prev.filter((item) => list.some((x) => x.revision === item.revision))
      return kept.length ? kept : [list[0]]
    })
    setAnchorRev((prev) => (prev !== null && list.some((x) => x.revision === prev) ? prev : null))
  }, [list])

  // 过滤（P0-1 语法 + P0-3 日期区间）→ 排序（P0-12：先过滤后排序）
  const filtered = React.useMemo(() => {
    if (list === null) return null
    const predicate = parseLogFilter(query, field, regexOn)
    const range = dateRangePredicateOf(from, to)
    return list.filter((item) => predicate(item) && range(item))
  }, [list, query, field, regexOn, from, to])
  const sorted = React.useMemo(
    () => (filtered === null ? null : orderLogEntries(filtered, sortKey ?? 'revision', sortKey ? sortDir : 'desc')),
    [filtered, sortKey, sortDir],
  )
  // P1-3：可见选中 = 选中数组 ∩ 当前显示列表；current = 可见选中首条（详情/菜单主语），空则回落首条
  const visibleSelected = sorted
    ? selected.filter((item) => sorted.some((x) => x.revision === item.revision))
    : selected
  const current = visibleSelected.length
    ? visibleSelected[0]
    : (sorted && sorted.length ? sorted[0] : null)

  /** 点列头：同键切换升降，异键回落升序；复位入口在列头行（G10）。 */
  const onSort = (key) => {
    if (sortKey !== key) { setSortKey(key); setSortDir('asc'); return }
    setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
  }
  const onSortReset = () => { setSortKey(null); setSortDir('desc') }

  /**
   * 导出当前过滤后列表（W1-4）：CSV 带 BOM 供 Excel 直开 / HTML 本地报表；失败静默。
   * @author ddj 2026年09月20号
   * @param kind 导出格式（'csv' | 'html'）
   */
  const onExport = (kind) => {
    if (!sorted || !sorted.length) return
    const headers = ['修订', '作者', '日期', '信息', '路径']
    const rows = logExportRows(sorted)
    const stamp = new Date().toISOString().slice(0, 10)
    if (kind === 'html') downloadText('svn-log-' + stamp + '.html', htmlTableOf(headers, rows, 'SVN 日志 ' + stamp), 'text/html')
    else downloadText('svn-log-' + stamp + '.csv', csvOf([headers, ...rows]), 'text/csv')
  }

  /**
   * 多选点击解释（P1-3）：单击=单选；Ctrl=切换；Shift=以 anchor 为基准在显示列表内范围选。
   * anchor 缺失或不在显示列表时 Shift 回落单选（与选中项消失回落首条同策略）。
   * @author ddj 2026年09月17号
   * @param event 点击事件（读 ctrlKey/metaKey/shiftKey）
   * @param item 被点条目
   */
  const pickWithMods = (event, item) => {
    if (event.shiftKey && anchorRev !== null && sorted) {
      const a = sorted.findIndex((x) => x.revision === anchorRev)
      const b = sorted.findIndex((x) => x.revision === item.revision)
      if (a >= 0 && b >= 0) {
        setSelected(sorted.slice(Math.min(a, b), Math.max(a, b) + 1))
        return // Shift 不移动 anchor（官方同款）
      }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((prev) => {
        const has = prev.some((x) => x.revision === item.revision)
        return has ? prev.filter((x) => x.revision !== item.revision) : [...prev, item]
      })
      setAnchorRev(item.revision)
      return
    }
    setSelected([item])
    setAnchorRev(item.revision)
  }

  // P0-13 分栏拖拽：pointerdown 记起点，window 级 move/up 跟踪，apply 内按容器实时 clamp
  const startDrag = (event, axis, current, apply) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startY = event.clientY
    const move = (e) => {
      const delta = axis === 'x' ? e.clientX - startX : e.clientY - startY
      apply(current + delta)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      swallowNextClick()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // P0-14 外框调尺寸：mode 'r'=右缘调宽 / 'b'=底缘调高 / 'c'=角手柄双向；clamp 视口内
  const startResize = (event, mode) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startY = event.clientY
    const startW = dlgW
    const startH = dlgH
    const move = (e) => {
      if (mode !== 'b') setDlgW(Math.min(window.innerWidth - 24, Math.max(DIALOG_W_MIN, startW + (e.clientX - startX))))
      if (mode !== 'r') setDlgH(Math.min(window.innerHeight - 24, Math.max(DIALOG_H_MIN, startH + (e.clientY - startY))))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      swallowNextClick()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** 上段修订列表高度拖拽（clamp：下限 200，上限 = body 高 - 信息区/路径区保留空间）。 */
  const onListHDrag = (event) => startDrag(event, 'y', listH, (next) => {
    const total = bodyRef.current?.clientHeight ?? 0
    const max = Math.max(LIST_H_MIN + 80, total - msgH - PANE_KEEP_MIN)
    setListH(Math.min(max, Math.max(LIST_H_MIN, next)))
  })

  /** 中段提交信息高度拖拽（clamp：下限 60，上限 = body 高 - 列表/路径区保留空间）。 */
  const onMsgHDrag = (event) => startDrag(event, 'y', msgH, (next) => {
    const total = bodyRef.current?.clientHeight ?? 0
    const max = Math.max(MSG_H_MIN + 80, total - listH - PANE_KEEP_MIN)
    setMsgH(Math.min(max, Math.max(MSG_H_MIN, next)))
  })

  // 键盘：F5 刷新（防浏览器整页刷新）；↑↓ 在显示列表内移动选中（输入框内不劫持）
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'F5') { event.preventDefault(); onRefresh(); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const tag = String(event.target?.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return
      if (!sorted || !sorted.length) return
      event.preventDefault()
      const at = sorted.findIndex((item) => item.revision === selected[0]?.revision)
      const next = at < 0 ? 0 : Math.min(sorted.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))
      const hit = sorted[next]
      setSelected([hit]) // ↑↓ 折叠为单选（官方同款），并重置 Shift 基准
      setAnchorRev(hit.revision)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [sorted, onRefresh, selected])

  /** 复制当前选中修订（P0-9；剪贴板不可用静默忽略）。 */
  const copyRevision = (entry) => {
    if (!entry) return
    copyTextOf(revisionClipboardText(entry))
  }

  /**
   * 提交区间（P1-6）：两版号均为正整数才生效；起始=较早、结束=较晚（svn -r START:END 语义）。
   * @author ddj 2026年09月17号
   */
  const submitRange = () => {
    const start = Math.floor(Number(rangeFrom))
    const end = Math.floor(Number(rangeTo))
    if (!Number.isFinite(start) || start < 1 || !Number.isFinite(end) || end < 1) return
    setRangeOpen(false)
    onShowRange?.(start, end)
  }

  /**
   * 上窗格行右键菜单（P0-8 + P1-3 多选两项时插入「比较两个修订」，P1-2 由 onComparePair 承接）。
   *
   * P1-5：merged 行的工作副本动作不可达（其 paths 属**源分支**、本地不存在），
   * 故「与工作副本比较」禁用并给出原因；「与上一版本比较」仍按该修订仓库路径可用。
   */
  const onItemMenu = (event, entry) => {
    event.preventDefault()
    event.stopPropagation()
    const pair = visibleSelected.length === 2 ? visibleSelected : null
    // 是否 merged 行：看该修订在显示列表中的层级（0 = 顶层）
    const mergedRow = levelInList(sorted, entry.revision) === 1
    setMenu({
      x: event.clientX, y: event.clientY,
      entries: [
        (pair && onComparePair
          ? { id: 'cmp-pair', label: '比较两个修订（r' + pair[0].revision + ' ↔ r' + pair[1].revision + '）', disabled: !target, hint: target ? undefined : '仅文件目标', onClick: () => onComparePair(pair[0].revision, pair[1].revision) }
          : null),
        { id: 'cmp-prev', label: '与上一版本比较', disabled: !target, hint: target ? undefined : '仅文件目标', onClick: () => onOpenDiff?.(target, entry.revision) },
        {
          id: 'cmp-work',
          label: '与工作副本比较',
          disabled: !target || mergedRow,
          hint: !target ? '仅文件目标' : (mergedRow ? '合并进来的修订属源分支，工作副本无对应文件' : undefined),
          onClick: () => onCompareWorking?.(entry.revision),
        },
        { id: 'copy-rev', label: '复制修订信息', onClick: () => copyRevision(entry) },
      ].filter(Boolean),
    })
  }

  /** 下窗格路径行右键菜单（P0-8；G8 目录不可开差异，G9 仓库外不可打开）。 */
  const onPathMenu = (event, item, revision) => {
    event.preventDefault()
    event.stopPropagation()
    const outside = item.relPath === null
    const isDir = item.kind === 'dir'
    setMenu({
      x: event.clientX, y: event.clientY,
      entries: [
        { id: 'show-changes', label: '查看该版改动', disabled: outside || isDir, hint: isDir ? '目录无文本差异' : undefined, onClick: () => onOpenDiff?.(item.relPath, revision) },
        { id: 'open-local', label: '打开工作区文件', disabled: outside, onClick: () => onOpenFile?.(item.relPath) },
        { id: 'copy-path', label: '复制路径', onClick: () => copyTextOf(String(item.relPath ?? item.path)) },
      ],
    })
  }

  const errLine = error
    ? React.createElement('div', { className: 'edrv-svnlog-error' }, String(error))
    : null
  // P0-14 上中下三段全宽：上=修订列表（高可拖）/ 中=提交信息（高可拖）/ 下=变更路径（占余）
  const body = React.createElement('div', { className: 'edrv-svnlog-body', ref: bodyRef },
    React.createElement(LogList, {
      list: sorted, selected: visibleSelected, keyword: query.trim(), busy, truncated,
      sortKey, sortDir, onSort, onSortReset,
      onPick: pickWithMods, onLoadMore, onItemMenu,
      height: listH, wcRev,
    }),
    React.createElement(Splitter, {
      title: '调整修订列表高度', onDragStart: onListHDrag, onReset: () => setListH(LIST_H_DEFAULT),
    }),
    React.createElement('div', { className: 'edrv-svnlog-pane edrv-svnlog-msgpane', style: { height: msgH } },
      React.createElement(LogMsgInner, { selected: visibleSelected })),
    React.createElement(Splitter, {
      title: '调整提交信息区高度', onDragStart: onMsgHDrag, onReset: () => setMsgH(MSG_H_DEFAULT),
    }),
    React.createElement('div', { className: 'edrv-svnlog-pane edrv-svnlog-pathspane' },
      React.createElement(LogPathsInner, { selected: visibleSelected, target, onlyAffected, onOpenFile, onOpenDiff, onPathMenu })))

  return React.createElement(ModalShell, {
    dialogClass: 'edrv-svnlog-dialog',
    width: Math.round(dlgW) + 'px',
    cardStyle: { height: Math.round(dlgH) + 'px' },
    onClose,
  },
    React.createElement(LogHead, { target, onClose }),
    React.createElement(LogFilterBar, {
      field, regexOn, query, from, to,
      onField: setField, onRegex: setRegexOn, onQuery: setQuery, onFrom: setFrom, onTo: setTo,
    }),
    errLine,
    body,
    React.createElement(LogFoot, {
      list, filtered: sorted, shownCount: sorted ? sorted.length : 0, keyword: query.trim(), truncated, current,
      selectedCount: visibleSelected.length, onlyAffected, onOnlyAffected: setOnlyAffected, busy, onLoadMore, onShowAll, onRefresh,
      onStats: () => setStatsOpen(true), stopOnCopy, onStopCopy, includeMerged, onIncludeMerged,
      onExportCsv: () => onExport('csv'), onExportHtml: () => onExport('html'),
      rangeActive: rangeActive === true, onOpenRange: () => setRangeOpen(true), onRangeReset: () => onRangeReset?.(),
    }),
    React.createElement(Grip, { mode: 'r', onDragStart: startResize, onReset: () => { setDlgW(DIALOG_W_DEFAULT); setDlgH(DIALOG_H_DEFAULT) } }),
    React.createElement(Grip, { mode: 'b', onDragStart: startResize, onReset: () => { setDlgW(DIALOG_W_DEFAULT); setDlgH(DIALOG_H_DEFAULT) } }),
    React.createElement(Grip, { mode: 'c', onDragStart: startResize, onReset: () => { setDlgW(DIALOG_W_DEFAULT); setDlgH(DIALOG_H_DEFAULT) } }),
    (menu ? React.createElement(ContextMenu, { x: menu.x, y: menu.y, entries: menu.entries, onClose: () => setMenu(null) }) : null),
    (statsOpen ? React.createElement(SvnLogStats, { key: 'edrv-svnlog-stats', entries: sorted, onClose: () => setStatsOpen(false) }) : null),
    (rangeOpen ? React.createElement(ModalShell, {
      key: 'edrv-svnlog-range',
      dialogClass: 'edrv-svnlog-range',
      width: 'min(430px, calc(100vw - 40px))',
      zIndex: 192,
      onClose: () => setRangeOpen(false),
    },
      React.createElement('div', { className: 'edrv-svnlog-range-body' },
        React.createElement('h3', { className: 'edrv-svnlog-title' }, '显示区间（Show Range）'),
        React.createElement('div', { className: 'edrv-svnlog-range-row' },
          React.createElement('label', { className: 'edrv-svnlog-check' },
            '起始修订（较早）',
            React.createElement('input', {
              className: 'edrv-svnlog-range-input', type: 'number', min: 1, value: rangeFrom,
              onChange: (event) => setRangeFrom(event.target.value),
            })),
          React.createElement('label', { className: 'edrv-svnlog-check' },
            '结束修订（较晚）',
            React.createElement('input', {
              className: 'edrv-svnlog-range-input', type: 'number', min: 1, value: rangeTo,
              onChange: (event) => setRangeTo(event.target.value),
            }))),
        React.createElement('div', { className: 'edrv-svnlog-hint' }, 'svn 语义 -r 起始:结束；列表仍按版本号倒序显示，统计与状态行覆盖区间内条目'),
        React.createElement('div', { className: 'edrv-svnlog-range-btns' },
          React.createElement('button', { className: 'edrv-svn-act', onClick: () => setRangeOpen(false) }, '取消'),
          React.createElement('button', {
            className: 'edrv-svn-act',
            disabled: !(Number(rangeFrom) >= 1 && Number(rangeTo) >= 1),
            onClick: submitRange,
          }, '确定'))))
    : null))
}

/**
 * 日期区间判定（P0-3：From/To 含当日全天；解析失败的条目不因区间被过滤）。
 * @author ddj 2026年09月17号
 * @param from 起始日（YYYY-MM-DD 或空）
 * @param to 结束日（YYYY-MM-DD 或空）
 * @returns 判定函数
 */
function dateRangePredicateOf(from, to) {
  if (!from && !to) return () => true
  const min = from ? new Date(from + 'T00:00:00').getTime() : null
  const max = to ? new Date(to + 'T23:59:59.999').getTime() : null
  return (entry) => {
    const at = new Date(String(entry.date ?? '')).getTime()
    if (Number.isNaN(at)) return true
    if (min !== null && at < min) return false
    if (max !== null && at > max) return false
    return true
  }
}
