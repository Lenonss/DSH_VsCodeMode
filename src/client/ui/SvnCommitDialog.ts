// @ts-nocheck
/**
 * dsh-vscode-mode client — 原生提交对话框（22-agent-tools-and-commit）。
 *
 * 结构对齐「SVN 更新」窗口：标题栏（✕ 走 FloatingWindow 的 actions）+ 工具带 + 有列头的
 * 勾选表格 + 提交信息编排区 + 遥测行 + 页脚主操作。勾选范围是主信息，主按钮自带数量；
 * 分组头三态勾选；ignore-on-commit 与未版本控制默认不勾并在分组头就地标注。
 * 提交前仍单次 window.confirm 确认；AI 结果只回填文本框，**绝不自动提交**。
 * @author ddj 2026年11月15号
 */
import React from 'react'
import { ContextMenu } from './ContextMenu.js'
import { copyText } from '../copyText.js'
import { runSvnAction } from '../svnActions.js'
import { FloatingWindow } from './FloatingWindow.js'
import { AI_COMMIT_STYLE_LABEL, AI_COMMIT_IDLE, runAiCommit } from '../aiCommit.js'
import { svnCommitNow, svnCommitPlan } from '../svnCommit.js'
import { SVN_ACTION_BY_ID } from '../../shared/svnActions.js'
import type { SvnChangeEntry } from '../../shared/svn.js'
import { SVN_STATUS_LABEL, SVN_STATUS_LETTER, SVN_STATUS_TONE } from '../../shared/svn.js'
import { updateParent } from './svnUpdateModel.js'
import {
  commitActs,
  commitHintOf,
  commitMessageErrorOf,
  commitResultLinesOf,
  commitSectionsOf,
  commitStatsOf,
  defaultCheckedOf,
  groupTriStateOf,
  nextRowPick,
} from './svnCommitModel.js'

/** 状态分级的展示顺序（页脚计数同序，避免数字跳动）。 */
const TONE_ORDER = ['modified', 'added', 'deleted', 'conflict', 'plain']

/** 状态分级 → 中文标签。 */
const TONE_LABEL = { modified: '修改', added: '新增', deleted: '删除', conflict: '冲突', plain: '其他' }

/**
 * 勾选范围 → 一行计数文案（页脚左键位）。
 * @author ddj 2026年11月15号
 * @param stats 勾选统计
 * @returns 如「已选 6 / 17 个文件 · 修改 5 · 新增 1」
 */
function statsTextOf(stats) {
  const parts = ['已选 ' + stats.picked + ' / ' + stats.total + ' 个文件']
  for (const tone of TONE_ORDER) {
    const count = stats.byTone[tone] ?? 0
    if (count) parts.push(TONE_LABEL[tone] + ' ' + count)
  }
  return parts.join(' · ')
}

/**
 * 分组头右侧的默认不勾标记（勾选规则本身在模型层，这里只负责说清楚）。
 * @author ddj 2026年11月15号
 * @param section 分区
 * @returns 标记文案；默认勾选的分组返回 null
 */
function sectionNoteOf(section) {
  if (section.defaultChecked) return null

  return section.key === 'unversioned' ? '默认不选' : '默认不提交'
}

/**
 * 勾选里是否含未版本控制文件（提交确认文案用）。
 * @author ddj 2026年11月15号
 * @param sections 分区
 * @param checked 勾选路径集合
 * @returns 是否含未版本控制条目
 */
function hasUnversionedOf(sections, checked) {
  return sections.some((section) => section.key === 'unversioned'
    && section.entries.some((entry) => checked.has(entry.path)))
}

/**
 * 复选框元素（仓库 UI 原语无 Checkbox，沿用原生控件 + CSS 定制外观）。
 * @author ddj 2026年11月15号
 * @param checked 是否勾选 @param onToggle 切换回调 @param title 提示 @param indeterminate 半选
 * @returns 复选框元素
 */
function checkBoxEl(checked, onToggle, title, indeterminate = false) {
  return React.createElement('input', {
    type: 'checkbox',
    className: 'edrv-svncommit-cb',
    checked,
    title,
    onChange: () => onToggle(),
    ref: (node) => { if (node) node.indeterminate = indeterminate },
  })
}

/**
 * 分组头（吸顶）：三态勾选 + 分区名 + 默认不勾标记 + 条目数。
 * @author ddj 2026年11月15号
 * @param section 分区 @param tri 三态 @param onToggle 整组切换
 * @returns 分组头元素
 */
function sectionHeadEl(section, tri, onToggle) {
  const note = sectionNoteOf(section)
  return React.createElement('div', { className: 'edrv-svncommit-group', key: section.key },
    checkBoxEl(tri === 'all', onToggle, tri === 'part' ? '部分勾选，点击全选本分区' : '全选本分区', tri === 'part'),
    React.createElement('span', { className: 'edrv-svncommit-gname', title: section.label }, section.label),
    note ? React.createElement('span', { className: 'edrv-svncommit-gnote', title: '该分区默认不勾选；需要提交时逐条勾上' }, note) : null,
    React.createElement('span', { className: 'edrv-svncommit-gcount' }, section.entries.length + ' 项'))
}

/** 右键菜单目标：文件行（row）或提交信息框（msg）；msg 额外带着打开时的选区。 */
interface CommitMenu {
  x: number
  y: number
  kind: 'row' | 'msg'
  entry: SvnChangeEntry | null
  node: HTMLTextAreaElement | null
  start: number
  end: number
  /** 右键瞬间生效的选中路径（多选批量动作的作用域）。 */
  paths: string[]
}

/**
 * 右键菜单状态（坐标 + 目标）；同一事件内可切换目标，关闭由 ContextMenu 的 capture 监听发起。
 * @author ddj 2026年11月21号
 * @returns 菜单状态、打开与关闭
 */
function useCommitMenu() {
  const [menu, setMenu] = React.useState(null)
  /** @private @author ddj 2026年11月21号 @param event 右键事件 @param kind 目标种类 @param entry 行条目 @param node 文本框 @returns void */
  const open = (event, kind, entry, node, paths) => {
    event.preventDefault()
    event.stopPropagation()

    // 选区在打开时定格：菜单点击后焦点已移走，再读 selectionStart 会丢范围
    const start = node && typeof node.selectionStart === 'number' ? node.selectionStart : 0
    const end = node && typeof node.selectionEnd === 'number' ? node.selectionEnd : start
    setMenu({ x: event.clientX, y: event.clientY, kind, entry: entry ?? null, node: node ?? null, start, end, paths: paths ?? [] })
  }

  return { menu, open, close: () => setMenu(null) }
}

/**
 * 行选中（Ctrl 切换 / Shift 范围）：与更新窗口同一套手势，纯逻辑在 nextRowPick 里可单测。
 * @author ddj 2026年11月21号
 * @param order 当前显示顺序（路径）
 * @returns 选中路径与选择动作
 */
function useRowPick(order) {
  const [pick, setPick] = React.useState({ selected: [], anchor: null })
  const orderRef = React.useRef(order)
  orderRef.current = order

  // 清单重载后丢弃已不存在的路径，避免批量动作打到过期目标
  React.useEffect(() => {
    setPick((current) => {
      const selected = current.selected.filter((path) => order.includes(path))
      return selected.length === current.selected.length ? current : { selected, anchor: null }
    })
  }, [order])

  /** @private @author ddj 2026年11月21号 @param event 点击事件 @param path 目标路径 @returns void */
  const choose = (event, path) => {
    const mode = event.shiftKey ? 'range' : (event.ctrlKey || event.metaKey) ? 'toggle' : 'single'
    setPick((current) => nextRowPick(current, orderRef.current, path, mode))
  }

  return { selected: pick.selected, choose }
}

/**
 * 右键瞬间的生效选中：目标已在选中集合里就批量，否则先把选中改成该行。
 * @author ddj 2026年11月21号
 * @param rowPick 行选中状态 @param entry 右键目标
 * @returns 生效选中路径
 */
function pickPathsOf(rowPick, entry) {
  if (!entry) return []
  if (rowPick.selected.includes(entry.path)) return rowPick.selected

  rowPick.choose({}, entry.path)
  return [entry.path]
}

/**
 * 键盘唤起菜单（Shift+F10 / 菜单键），锚到该行左下角（对齐文件树 menuKey）。
 * @author ddj 2026年11月21号
 * @param event 键盘事件 @param entry 该行条目 @param onOpen 打开菜单回调
 * @returns void
 */
function openMenuByKey(event, entry, onOpen) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return

  event.preventDefault()
  const rect = event.currentTarget.getBoundingClientRect()
  onOpen({ preventDefault: () => {}, stopPropagation: () => {}, clientX: rect.left, clientY: rect.bottom }, 'row', entry)
}

/**
 * 执行文本框编辑命令：原生 execCommand 优先（保住浏览器撤销栈），不可用时提示而不静默。
 * @author ddj 2026年11月21号
 * @param s 视图状态 @param node 目标文本框 @param command undo | redo | cut | copy | selectAll
 * @returns void
 */
function runEditCommand(s, node, command) {
  if (!node) return
  node.focus()

  if (command === 'selectAll') { node.select(); return }

  let ok = false
  try { ok = typeof document !== 'undefined' && document.execCommand(command) } catch { ok = false }
  if (!ok) { s.notify?.('该操作不可用，请用键盘快捷键'); return }

  // execCommand 只改 DOM 值：读回来同步受控状态，否则下一次渲染把这次编辑回滚掉
  s.setMessage(node.value)
}

/**
 * 粘贴：读剪贴板后按打开时的选区插入（浏览器默认拒绝 execCommand('paste')）。
 * @author ddj 2026年11月21号
 * @param s 视图状态 @param menu 菜单目标（含文本框与选区）
 * @returns void
 */
async function pasteInto(s, menu) {
  const node = menu.node
  if (!node) return

  const clip = typeof navigator === 'undefined' ? null : navigator.clipboard
  if (!clip || typeof clip.readText !== 'function') { s.notify?.('剪贴板读取不可用，请用 Ctrl+V'); return }

  let text = ''
  try { text = await clip.readText() } catch { s.notify?.('粘贴失败，请用 Ctrl+V'); return }

  const value = s.message ?? ''
  s.setMessage(value.slice(0, menu.start) + text + value.slice(menu.end))
  requestAnimationFrame(() => {
    const caret = menu.start + text.length
    node.focus()
    node.setSelectionRange?.(caret, caret)
  })
}

/**
 * 多选菜单：只做勾选与复制；破坏性动作仍限单行，避免一次误点还原多份本地改动。
 * @author ddj 2026年11月21号
 * @param s 视图状态 @param paths 选中路径
 * @returns 菜单条目
 */
function multiRowMenuOf(s, paths) {
  const busy = Boolean(s.busy || s.aiBusy)
  return [
    { id: 'pick-on', label: '勾选选中 ' + paths.length + ' 项', disabled: busy, onClick: () => s.setPickChecked(paths, true) },
    { id: 'pick-off', label: '取消勾选选中 ' + paths.length + ' 项', disabled: busy, onClick: () => s.setPickChecked(paths, false) },
    { id: 'copy', label: '复制 ' + paths.length + ' 条路径', separator: true, disabled: busy,
      onClick: () => { void copyText(paths.join('\n'), '已复制路径', s.notify) } },
  ]
}

/**
 * 单选菜单：核对 / 打开 / 勾选 / 写动作 / 复制；可用性全部来自 commitActs。
 * @author ddj 2026年11月21号
 * @param s 视图状态 @param entry 目标条目
 * @returns 菜单条目
 */
function oneRowMenuOf(s, entry) {
  const acts = commitActs(entry, Boolean(s.busy || s.aiBusy))
  const picked = s.checked.has(entry.path)
  return [
    { id: 'compare', label: '与基线比较', disabled: !acts.compare, onClick: () => s.onCompare?.(entry.path) },
    { id: 'log', label: '查看日志', disabled: !acts.log, onClick: () => s.onShowLog?.(entry.path) },
    { id: 'open', label: '打开文件', separator: true, disabled: !acts.open, onClick: () => s.onOpenFile?.(entry.path) },
    { id: 'parent', label: '打开父目录', disabled: !acts.openParent, onClick: () => s.onOpenParent?.(updateParent(entry.path)) },
    { id: 'toggle', label: picked ? '取消勾选此项' : '勾选此项', separator: true, disabled: !acts.toggle, onClick: () => s.toggle(entry.path) },
    { id: 'add', label: '加入版本控制', disabled: !acts.add, onClick: () => s.rowAction('add', entry.path) },
    { id: 'revert', label: '还原（放弃本地改动）…', danger: true, disabled: !acts.revert, onClick: () => s.rowAction('revert-cli', entry.path) },
    { id: 'copy', label: '复制路径', separator: true, disabled: !acts.copyPath, onClick: () => { void copyText(entry.path, '已复制路径', s.notify) } },
  ]
}

/**
 * 行菜单入口：多选走批量条目，单选走完整条目。
 * @author ddj 2026年11月21号
 * @param s 视图状态 @param menu 菜单目标（含打开时的选中路径）
 * @returns 菜单条目
 */
function rowMenuEntriesOf(s, menu) {
  const entry = menu && menu.entry
  if (!entry) return []

  const paths = menu.paths && menu.paths.length ? menu.paths : [entry.path]
  if (paths.length > 1) return multiRowMenuOf(s, paths)
  return oneRowMenuOf(s, entry)
}

/**
 * 菜单条目装配的唯一入口（渲染处与单测共用）。
 *
 * 这里必须吞掉装配异常：条目只是投影，抛出去会让 React 卸载整个 EditorView，
 * 表现为「右键后弹窗与编辑页一起白屏」——失败时给一条可读的禁用项即可。
 * @author ddj 2026年11月21号
 * @param s 视图状态 @param menu 菜单目标（缺省 = 无菜单）
 * @returns 菜单条目
 */
export function commitMenuEntriesOf(s, menu) {
  if (!menu) return []
  try {
    return menu.kind === 'row' ? rowMenuEntriesOf(s, menu) : msgMenuEntriesOf(s, menu)
  } catch {
    return [{ id: 'menu-error', label: '菜单装配失败：请关闭窗口重开', disabled: true }]
  }
}

/**
 * 提交信息框菜单条目：撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选（对齐官方提交框的编辑五项）。
 * @author ddj 2026年11月21号
 * @param s 视图状态 @param menu 菜单目标（含文本框与选区）
 * @returns 菜单条目
 */
function msgMenuEntriesOf(s, menu) {
  const node = menu.node
  const hasRange = menu.end > menu.start
  return [
    { id: 'undo', label: '撤销', hint: 'Ctrl+Z', onClick: () => runEditCommand(s, node, 'undo') },
    { id: 'redo', label: '重做', hint: 'Ctrl+Y', onClick: () => runEditCommand(s, node, 'redo') },
    { id: 'cut', label: '剪切', hint: 'Ctrl+X', separator: true, disabled: !hasRange, onClick: () => runEditCommand(s, node, 'cut') },
    { id: 'copy', label: '复制', hint: 'Ctrl+C', disabled: !hasRange, onClick: () => runEditCommand(s, node, 'copy') },
    { id: 'paste', label: '粘贴', hint: 'Ctrl+V', onClick: () => { void pasteInto(s, menu) } },
    { id: 'select-all', label: '全选', hint: 'Ctrl+A', separator: true, disabled: !s.message, onClick: () => runEditCommand(s, node, 'selectAll') },
  ]
}

/**
 * 单条待提交文件（勾选 / 状态字母 / 路径），支持右键与键盘唤起菜单。
 * @author ddj 2026年11月15号 / 2026年11月21号
 * @param entry 变更条目 @param checked 是否勾选 @param onToggle 切换 @param s 视图状态（菜单与动作）
 * @returns 行元素
 */
function rowEl(entry, checked, onToggle, s) {
  const tone = SVN_STATUS_TONE[entry.status] ?? 'plain'
  const opened = Boolean(s.menu && s.menu.kind === 'row' && s.menu.entry && s.menu.entry.path === entry.path)
  const selected = Boolean(s.selection && s.selection.includes(entry.path))
  return React.createElement('div', {
    className: 'edrv-svncommit-row' + (opened ? ' is-menu' : '') + (selected ? ' is-selected' : ''),
    role: 'row',
    'aria-selected': selected,
    tabIndex: 0,
    key: entry.path,
    onClick: (event) => s.pickRow(event, entry.path),
    onContextMenu: (event) => s.menuOpen(event, 'row', entry),
    onKeyDown: (event) => openMenuByKey(event, entry, s.menuOpen),
  },
    React.createElement('span', { className: 'edrv-svncommit-pick', role: 'cell' }, checkBoxEl(checked, onToggle, entry.path)),
    React.createElement('span', {
      className: 'edrv-svn-ch edrv-svn-ch-' + tone,
      role: 'cell',
      title: SVN_STATUS_LABEL[entry.status] ?? entry.status,
    }, SVN_STATUS_LETTER[entry.status] ?? '?'),
    React.createElement('span', { className: 'edrv-svncommit-path', role: 'cell', title: entry.path }, entry.path))
}

/**
 * 勾选表格：列头固定，分组头与行在同一个滚动区里。
 * @author ddj 2026年11月15号
 * @param s 视图状态
 * @returns 表格元素
 */
function tableEl(s) {
  if (!s.sections.length) {
    return React.createElement('div', { className: 'edrv-svncommit-table' },
      React.createElement('div', { className: 'edrv-svncommit-empty' }, s.plan ? '没有可提交的变更' : '正在读取变更清单…'))
  }

  const body = []
  for (const section of s.sections) {
    body.push(sectionHeadEl(section, groupTriStateOf(section, s.checked), () => s.toggleSection(section)))
    // 空分区（只登记过分区、当前无改动）：留一行说明，别让人以为列表被截断
    if (!section.entries.length) {
      body.push(React.createElement('div', { className: 'edrv-svncommit-emptyrow', key: section.key + ':empty' },
        '该分区当前没有待提交改动（分区已登记）'))
      continue
    }
    for (const entry of section.entries) {
      body.push(rowEl(entry, s.checked.has(entry.path), () => s.toggle(entry.path), s))
    }
  }
  return React.createElement('div', { className: 'edrv-svncommit-table' },
    React.createElement('div', { className: 'edrv-svncommit-cols' },
      React.createElement('span', null, '勾选'),
      React.createElement('span', null, '状态'),
      React.createElement('span', null, '路径')),
    React.createElement('div', { className: 'edrv-svncommit-list', role: 'table', 'aria-label': '待提交文件清单' }, ...body))
}

/**
 * 工具带：最近信息 / AI 风格 / AI 生成 / 保持锁定 / 已选计数。
 * @author ddj 2026年11月15号
 * @param s 视图状态
 * @returns 工具带元素
 */
function barEl(s) {
  const recent = s.plan?.recent?.length
    ? React.createElement('select', {
        className: 'edrv-svn-act edrv-svncommit-ctl',
        defaultValue: '',
        disabled: s.busy,
        title: '最近提交信息（选择后填入信息框）',
        onChange: (event) => {
          const index = Number(event.target.value)
          if (Number.isInteger(index) && index >= 0) s.setMessage(s.plan.recent[index] ?? '')
          event.target.value = ''
        },
      },
        React.createElement('option', { value: '' }, '最近信息…'),
        ...s.plan.recent.map((item, index) => React.createElement('option', {
          key: 'recent-' + index,
          value: String(index),
        }, item.split('\n')[0].slice(0, 60))))
    : null

  return React.createElement('div', { className: 'edrv-svncommit-bar' },
    recent,
    React.createElement('select', {
      className: 'edrv-svn-act edrv-svncommit-ctl',
      value: s.style,
      disabled: s.busy || s.aiBusy,
      title: 'AI 提交信息风格',
      onChange: (event) => s.setStyle(event.target.value),
    }, ...Object.keys(AI_COMMIT_STYLE_LABEL).map((key) => React.createElement('option', { key, value: key }, AI_COMMIT_STYLE_LABEL[key]))),
    React.createElement('button', {
      type: 'button',
      className: 'edrv-svn-act edrv-svncommit-ctl',
      title: 'AI 只分析已勾选文件，产出提交信息草稿（不会自动提交）',
      disabled: s.aiBusy || s.busy || !s.paths.length,
      onClick: s.generate,
    }, '✨ AI 生成提交信息'),
    React.createElement('label', { className: 'edrv-svn-check', title: '提交后保留锁定（--no-unlock）' },
      React.createElement('input', {
        className: 'edrv-svncommit-cb',
        type: 'checkbox',
        checked: s.keepLocks,
        disabled: s.busy,
        onChange: () => s.setKeepLocks(!s.keepLocks),
      }),
      ' 保持锁定'),
    React.createElement('span', { className: 'edrv-svncommit-badge', title: '已勾选 / 清单内全部文件' },
      '已选 ' + s.stats.picked + ' / ' + s.stats.total))
}

/**
 * 提交信息编排区：标签行（首行计数 / 就地错误）+ 文本框。
 * @author ddj 2026年11月15号
 * @param s 视图状态
 * @returns 编排区元素
 */
function composeEl(s) {
  const error = s.message.trim() ? s.messageError : null
  return React.createElement('div', { className: 'edrv-svncommit-compose' },
    React.createElement('div', { className: 'edrv-svncommit-composehead' },
      React.createElement('span', { className: 'edrv-svncommit-label' }, '提交信息'),
      React.createElement('span', { className: 'edrv-svncommit-hint' }, commitHintOf(s.message)),
      error ? React.createElement('span', { className: 'edrv-svncommit-error' }, error) : null),
    React.createElement('textarea', {
      className: 'edrv-svncommit-msg',
      value: s.message,
      rows: 4,
      spellCheck: false,
      placeholder: '首行是提交标题，例如：修复删除道具后背包不刷新。空一行可写正文。',
      onChange: (event) => s.setMessage(event.target.value),
      onContextMenu: (event) => s.menuOpen(event, 'msg', null, event.currentTarget),
    }))
}

/**
 * 提交结果回显（新版本号 / 逐文件动作 / 跳过 / 冲突）。
 * @author ddj 2026年11月15号
 * @param result 提交结果
 * @returns 结果元素；无结果返回 null
 */
function resultEl(result) {
  if (!result) return null
  const lines = commitResultLinesOf(result)
  return React.createElement('div', { className: 'edrv-svncommit-result' + (result.revision !== undefined ? ' is-ok' : '') },
    ...lines.map((line, index) => React.createElement('div', { key: 'r-' + index }, line)))
}

/**
 * 遥测行：错误 / 截断告警 / AI 状态与模型。
 * @author ddj 2026年11月15号
 * @param s 视图状态
 * @returns 遥测元素
 */
function telemetryEl(s) {
  const error = s.failed || s.loadError
  const aiText = s.ai.phase === 'running' ? 'AI 生成中…' : 'AI：' + s.ai.note
  return React.createElement('div', { className: 'edrv-svncommit-telemetry', role: 'status' },
    error ? React.createElement('span', { className: 'edrv-svncommit-error' }, error) : null,
    s.plan?.truncated
      ? React.createElement('span', { className: 'edrv-svncommit-warn', title: '变更清单被截断，可能未列出全部变更；请缩小范围或先用命令行确认' }, '清单已截断，可能未列出全部变更')
      : null,
    React.createElement('span', { className: 'edrv-svncommit-ai' }, aiText),
    s.ai.model ? React.createElement('span', { className: 'edrv-svncommit-ai', title: s.ai.model }, s.ai.model) : null)
}

/**
 * 页脚：计数 + 取消 + 主操作（提交按钮自带数量）。
 * @author ddj 2026年11月15号
 * @param s 视图状态
 * @returns 页脚元素
 */
function footEl(s) {
  return React.createElement('div', { className: 'edrv-svncommit-foot' },
    React.createElement('span', { className: 'edrv-svncommit-counts' }, s.paths.length ? statsTextOf(s.stats) : '未勾选任何文件'),
    React.createElement('button', { type: 'button', className: 'edrv-svn-act', disabled: s.busy, title: '取消（不提交）', onClick: s.onClose }, '取消'),
    React.createElement('button', {
      type: 'button',
      className: 'edrv-svn-act edrv-svncommit-primary',
      title: s.messageError ?? '提交已勾选文件',
      disabled: s.busy || Boolean(s.messageError) || !s.paths.length,
      onClick: s.submit,
    }, s.busy ? '提交中…' : '提交（' + s.paths.length + '）'))
}

/**
 * 读取提交计划与勾选态（seeded 时不再覆盖已有勾选，逐组提交预填优先）。
 * @author ddj 2026年11月15号
 * @param sessionId 会话 id
 * @param seed 预填（路径 + 信息）
 * @returns 计划、分区、勾选集合与提交信息
 */
function useCommitLoad(sessionId, seed) {
  const [plan, setPlan] = React.useState(null)
  const [loadError, setLoadError] = React.useState('')
  const [sections, setSections] = React.useState([])
  const [checked, setChecked] = React.useState(() => new Set(seed?.paths ?? []))
  const [message, setMessage] = React.useState(() => seed?.message ?? '')
  const seeded = React.useRef(Boolean(seed?.paths?.length))

  /**
   * 重读清单（还原 / 加入之后）：保留仍存在条目的勾选，丢弃已消失的路径。
   * @author ddj 2026年11月21号
   * @returns void
   */
  const reload = React.useCallback(() => {
    void svnCommitPlan(sessionId).then((outcome) => {
      if (!outcome.ok || !outcome.plan) { setLoadError(outcome.message); return }

      const next = commitSectionsOf(outcome.plan.entries, outcome.plan.changelists)
      setPlan(outcome.plan)
      setSections(next)
      const live = new Set(next.flatMap((section) => section.entries.map((entry) => entry.path)))
      setChecked((current) => new Set([...current].filter((path) => live.has(path))))
    })
  }, [sessionId])

  React.useEffect(() => {
    let alive = true
    void svnCommitPlan(sessionId).then((outcome) => {
      if (!alive) return
      if (!outcome.ok || !outcome.plan) { setLoadError(outcome.message); return }

      setPlan(outcome.plan)
      const next = commitSectionsOf(outcome.plan.entries, outcome.plan.changelists)
      setSections(next)
      if (!seeded.current) setChecked(defaultCheckedOf(next))
      if (!seeded.current && !message && outcome.plan.recent?.length) setMessage(outcome.plan.recent[0])
    })
    return () => { alive = false }
  }, [sessionId])

  return { plan, loadError, sections, checked, setChecked, message, setMessage, reload }
}

/**
 * 提交对话框的写动作：AI 生成提交信息与提交本体（失败零重试）。
 * @author ddj 2026年11月15号
 * @param ctx 会话、勾选范围与提交口径
 * @returns 生成/提交动作及其状态
 */
function useCommitWrite(ctx) {
  const { sessionId, paths, sections, checked, setChecked, message, messageError, keepLocks, style, setMessage, notify, onCommitted } = ctx
  const [ai, setAi] = React.useState(AI_COMMIT_IDLE)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [failed, setFailed] = React.useState('')
  const aiBusy = ai.phase === 'running'

  /**
   * AI 生成提交信息（只分析已勾选文件）。
   * @author ddj 2026年11月15号
   */
  const generate = () => {
    if (aiBusy || busy) return
    setAi({ phase: 'running', note: '生成中…' })
    void runAiCommit(sessionId, paths, style).then((outcome) => {
      setAi(outcome.state)
      if (outcome.text) setMessage(outcome.text)
      else if (outcome.state.error) setFailed(outcome.state.error)
    })
  }

  /**
   * 提交（单次确认；失败零重试）。
   * @author ddj 2026年11月15号
   */
  const submit = () => {
    if (busy || messageError || !paths.length) return
    const ok = typeof window === 'undefined' ? false : window.confirm(
      '确认提交以下 ' + paths.length + ' 个文件？\n提交后无法用 SVN 撤销（只能反向合并或再提交修复）。'
      + (hasUnversionedOf(sections, checked) ? '\n\n注意：未版本控制文件将先被 svn add 再提交。' : ''),
    )
    if (!ok) return

    setBusy(true)
    setFailed('')
    void svnCommitNow(sessionId, { paths, message, keepLocks }).then((outcome) => {
      if (!outcome.ok || !outcome.result) { setFailed(outcome.message); notify?.(outcome.message); return }

      setResult(outcome.result)
      notify?.(outcome.message)
      if (outcome.result.revision !== undefined) {
        setChecked(new Set())
        onCommitted?.(outcome.result)
      }
    }).finally(() => setBusy(false))
  }

  return { ai, aiBusy, busy, result, failed, generate, submit }
}

/**
 * 提交对话框的全部状态与动作（渲染在下面的 builder 里按同一份视图取值）。
 * @author ddj 2026年11月15号
 * @param sessionId 会话 id
 * @param seed 预填（路径 + 信息；来自 AI 逐组提交）
 * @param notify 状态栏反馈
 * @param onCommitted 提交成功回调（刷新变更清单）
 * @returns 视图状态
 */
function useCommitState(sessionId, seed, notify, onCommitted, onChanged) {
  const { plan, loadError, sections, checked, setChecked, message, setMessage, reload } = useCommitLoad(sessionId, seed)
  const [keepLocks, setKeepLocks] = React.useState(false)
  const [style, setStyle] = React.useState('plain')
  const paths = React.useMemo(() => [...checked], [checked])
  const stats = React.useMemo(() => commitStatsOf(sections, checked), [sections, checked])
  const messageError = commitMessageErrorOf(message)
  const write = useCommitWrite({
    sessionId, paths, sections, checked, setChecked, message, messageError, keepLocks, style, setMessage, notify, onCommitted,
  })

  /**
   * 单条勾选切换。
   * @author ddj 2026年11月15号
   * @param path 条目路径
   */
  const toggle = (path) => {
    const next = new Set(checked)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setChecked(next)
  }

  /**
   * 分区全选 / 全不选（半选时先全选）。
   * @author ddj 2026年11月15号
   * @param section 分区
   */
  const toggleSection = (section) => {
    const next = new Set(checked)
    const all = section.entries.every((entry) => next.has(entry.path))
    for (const entry of section.entries) {
      if (all) next.delete(entry.path)
      else next.add(entry.path)
    }
    setChecked(next)
  }

  // 显示顺序（分区 + 组内次序）：Shift 范围选择与批量动作都按这个顺序取
  const rowOrder = React.useMemo(
    () => sections.flatMap((section) => section.entries.map((entry) => entry.path)),
    [sections],
  )

  /**
   * 批量勾选 / 取消勾选（多选右键）：一次性写入集合，避免逐条 setChecked 互相覆盖。
   * @author ddj 2026年11月21号
   * @param targets 目标路径 @param on 勾选还是取消
   */
  const setPickChecked = (targets, on) => {
    const next = new Set(checked)
    for (const path of targets) {
      if (on) next.add(path)
      else next.delete(path)
    }
    setChecked(next)
  }

  /**
   * 行菜单的 SVN 写动作（还原 / 加入）：走动作目录执行器，确认守卫与刷新口径与树/页签菜单一致。
   * @author ddj 2026年11月21号
   * @param actionId 动作 id @param path 目标路径
   */
  const rowAction = (actionId, path) => {
    if (write.busy || write.aiBusy) return
    const def = SVN_ACTION_BY_ID[actionId]
    if (!def) return
    runSvnAction(def, { sessionId, path, notify, refreshChanges: () => { reload(); onChanged?.() } })
  }

  return {
    plan, loadError, sections, checked, message, setMessage, keepLocks, setKeepLocks, style, setStyle,
    paths, stats, messageError, toggle, toggleSection, rowOrder, setPickChecked, rowAction,
    ai: write.ai, aiBusy: write.aiBusy, busy: write.busy, result: write.result, failed: write.failed,
    generate: write.generate, submit: write.submit,
  }
}

/**
 * 提交对话框。
 * @author ddj 2026年11月15号
 * @param props.sessionId 会话 id
 * @param props.seed 预填（路径 + 信息；来自 AI 逐组提交）
 * @param props.onClose 关闭回调
 * @param props.onCommitted 提交成功回调（刷新变更清单）
 * @param props.notify 状态栏反馈
 * @returns 浮窗元素
 */
export function SvnCommitDialog(props) {
  const { sessionId, seed, onClose, onCommitted, notify } = props
  const s = useCommitState(sessionId, seed, notify, onCommitted, props.onChanged)
  const context = useCommitMenu()
  const rowPick = useRowPick(s.rowOrder)
  const view = {
    ...s, onClose, notify, selection: rowPick.selected, pickRow: rowPick.choose,
    menu: context.menu,
    menuOpen: (event, kind, entry, node) => context.open(event, kind, entry, node, pickPathsOf(rowPick, entry)),
    onCompare: props.onCompare, onShowLog: props.onShowLog,
    onOpenFile: props.onOpenFile, onOpenParent: props.onOpenParent,
  }
  const entries = commitMenuEntriesOf(view, context.menu)
  return React.createElement(FloatingWindow, {
    title: 'SVN 提交',
    dialogClass: 'edrv-svncommit-dialog',
    width: 880,
    height: 680,
    // 提交进行中禁止 Esc 关闭：关窗会丢掉 onCommitted 的成功回填与清单刷新。
    closeOnEsc: !s.busy,
    onClose,
    actions: React.createElement('button', {
      type: 'button',
      className: 'edrv-svncommit-close',
      title: s.busy ? '提交进行中；请等待结果' : '关闭（不提交）',
      'aria-label': '关闭提交窗口',
      disabled: s.busy,
      onClick: onClose,
    }, '✕'),
  },
    barEl(view),
    tableEl(view),
    composeEl(view),
    resultEl(s.result),
    telemetryEl(view),
    footEl(view),
    context.menu ? React.createElement(ContextMenu, {
      x: context.menu.x, y: context.menu.y, entries, zIndex: 193, onClose: context.close,
    }) : null)
}
