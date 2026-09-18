// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏「SVN 变更」面板（工作副本状态视图）。
 *
 * 形态对齐 TortoiseSVN「Check for Modifications」的**列表 + 分组 + 行内动作**骨架：
 * 头部（标题 / 工作副本根名 / ⟳）+ 显示开关（未版本控制 / 忽略项）+ 批量条 +
 * 按 changelist 分组的行列表 + 空态/加载态/未受管理态。行 = 状态字母（按 SVN_STATUS_TONE
 * 着色）+ 相对路径 + 动作按钮（比较 / 加入 / 还原）；双击行走「与基线比较」。
 *
 * 数据来源：ctx.svnChanges（EditorView 经 svnStatus.ensureSvnChanges 拉取后注入），
 * 本面板不自行发 RPC，避免与文件树重复拉取；⟳ 触发 refreshSvnChanges 后由事件回流重渲染。
 * 显示开关持久化到 localStorage（CACHE_KEY.svn + scope），与既有面板一致。
 * 作者 ddj 2026年09月16号
 */
import React from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  SVN_ADD_LABEL,
  SVN_DIFF_BASE_LABEL,
  SVN_REVERT_LABEL,
  SVN_STATUS_LABEL,
  SVN_STATUS_LETTER,
  SVN_STATUS_TONE,
  isSvnDiffable,
  svnVisibleChanges,
} from '../../../shared/svn.js'
import { CACHE_KEY } from '../../paths.js'
import { refreshSvnChanges, svnAdd, svnRevert } from '../../svnStatus.js'
import type { SidebarCtx } from '../types.js'

/** 未分组条目的分组键（changelist 为空）。 */
const NO_CHANGELIST = '（未分组）'

/** 还原确认文案（新增文件不会被删除是 svn revert 的实际语义，须如实告知）。 */
const REVERT_CONFIRM_HEAD = '确认还原以下 '
const REVERT_CONFIRM_TAIL = ' 个文件的本地改动？新增（A）文件在磁盘上会保留，仅取消登记。'

// --region 显示开关持久化

/**
 * 读取面板显示开关（损坏/不可用安全）。
 * @author ddj 2026年09月16号
 * @param scope 作用域键
 * @returns 开关（默认：显示未版本控制、隐藏忽略项）
 */
function loadFilter(scope) {
  const fallback = { unversioned: true, ignored: false }
  if (!scope) return fallback
  try {
    const raw = window.localStorage.getItem(CACHE_KEY.svn + scope)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return {
      unversioned: parsed?.unversioned !== false,
      ignored: parsed?.ignored === true,
    }
  } catch (error) {
    return fallback
  }
}

/**
 * 写面板显示开关（配额/隐私模式失败静默）。
 * @author ddj 2026年09月16号
 * @param scope 作用域键
 * @param filter 开关
 */
function saveFilter(scope, filter) {
  if (!scope) return
  try {
    window.localStorage.setItem(CACHE_KEY.svn + scope, JSON.stringify(filter))
  } catch (error) { /* 配额满/隐私模式忽略 */ }
}
// --endregion

// --region 展示元素

/**
 * 刷新按钮图标（官方 IconRefreshOutline16；原语缺失回落文本 ⟳）。
 * @author ddj 2026年09月16号
 * @returns 图标元素或回落文本
 */
function refreshIconEl() {
  if (typeof IconRefreshOutline16 !== 'function') return '⟳'
  return React.createElement(IconRefreshOutline16, { size: 14 })
}

/**
 * 条目状态字母元素（按 tone 着色）。
 * @author ddj 2026年09月16号
 * @param entry 变更条目
 * @returns 字母元素
 */
function statusLetterEl(entry) {
  const tone = SVN_STATUS_TONE[entry.status] ?? 'plain'
  return React.createElement('span', {
    className: 'edrv-svn-ch edrv-svn-ch-' + tone,
    title: SVN_STATUS_LABEL[entry.status] ?? entry.status,
  }, SVN_STATUS_LETTER[entry.status] ?? '?')
}

/**
 * 按 changelist 把条目分组（未分组恒排末位；组内保持工作副本原顺序）。
 * @author ddj 2026年09月16号
 * @param entries 已过滤的变更清单
 * @returns 分组数组（name + entries）
 */
export function groupByChangelist(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const name = entry.changelist || NO_CHANGELIST
    const bucket = groups.get(name)
    if (bucket) bucket.push(entry)
    else groups.set(name, [entry])
  }
  const named = [...groups.entries()].filter(([name]) => name !== NO_CHANGELIST)
  const rest = groups.get(NO_CHANGELIST)
  if (rest) named.push([NO_CHANGELIST, rest])
  return named.map(([name, items]) => ({ name, entries: items }))
}

/**
 * 单条变更行（状态字母 + 路径 + 行内动作；双击 = 与基线比较）。
 * @author ddj 2026年09月16号
 * @param props.entry 变更条目
 * @param props.busy 批量动作进行中（按钮置灰）
 * @param props.onDiff 打开基线差异
 * @param props.onAdd 加入版本控制
 * @param props.onRevert 还原
 * @returns 行元素
 */
function SvnRow(props) {
  const { entry, busy, onDiff, onAdd, onRevert } = props
  const diffable = isSvnDiffable(entry.path, entry.status)
  const act = (label, title, danger, run) => React.createElement('button', {
    className: 'edrv-svn-act' + (danger ? ' edrv-svn-act-danger' : ''),
    title,
    disabled: busy,
    onClick: (event) => { event.stopPropagation(); run() },
  }, label)
  return React.createElement('div', {
    className: 'edrv-svn-row',
    title: entry.path,
    onDoubleClick: () => { if (diffable) onDiff(entry.path) },
  },
    statusLetterEl(entry),
    React.createElement('span', { className: 'edrv-svn-path' }, entry.path),
    React.createElement('span', { className: 'edrv-svn-acts' },
      (diffable ? act('比较', SVN_DIFF_BASE_LABEL + '（BASE 与工作区并排）', false, () => onDiff(entry.path)) : null),
      (!entry.versioned ? act('加入', SVN_ADD_LABEL, false, () => onAdd([entry.path])) : null),
      (entry.versioned ? act('还原', SVN_REVERT_LABEL + '（放弃本地改动）', true, () => onRevert([entry.path])) : null)))
}

/**
 * 列表主体：分组行 + 条目行；未受管理/加载中/无变更各自给出稳定文案。
 * @author ddj 2026年09月16号
 * @param state 列表状态（managed/entries/visible/groups）
 * @param handlers 行动作（onDiff/onAdd/onRevert/busy）
 * @returns 主体元素或元素数组
 */
function svnListBody(state, handlers) {
  if (!state.managed) return React.createElement('div', { className: 'edrv-tree-loading' }, '当前工作区不受 SVN 管理')
  if (state.entries === null) return React.createElement('div', { className: 'edrv-tree-loading' }, '读取变更中…')
  if (!state.visible.length) return React.createElement('div', { className: 'edrv-tree-loading' }, '无变更（工作副本干净）')
  const rows = []
  for (const group of state.groups) {
    if (state.groups.length > 1 || group.name !== NO_CHANGELIST) {
      rows.push(React.createElement('div', { key: 'g:' + group.name, className: 'edrv-svn-group' },
        React.createElement('span', null, 'changelist: ' + group.name),
        React.createElement('span', { className: 'edrv-svn-group-n' }, String(group.entries.length))))
    }
    for (const entry of group.entries) {
      rows.push(React.createElement(SvnRow, Object.assign({ key: entry.path, entry }, handlers)))
    }
  }
  return rows
}

/**
 * 工具条（显示开关 + 批量动作）。
 * @author ddj 2026年09月16号
 * @param props.filter 当前开关
 * @param props.count 可见条目数
 * @param props.paths 批量动作目标（add/revert 各自清单）
 * @param props.handlers 动作回调（toggle/add/revert/busy）
 * @returns 工具条元素数组
 */
function svnToolbarEl(props) {
  const { filter, count, paths, handlers } = props
  const check = (label, title, checked, onChange) => React.createElement('label', {
    className: 'edrv-svn-check', title,
  },
    React.createElement('input', { type: 'checkbox', checked, onChange }),
    React.createElement('span', null, label))
  return [
    React.createElement('div', { key: 'tools', className: 'edrv-svn-toolbar' },
      check('未版本控制', '显示未纳入版本控制的文件', filter.unversioned, handlers.toggleUnversioned),
      check('忽略项', '显示被忽略的文件', filter.ignored, handlers.toggleIgnored)),
    (count
      ? React.createElement('div', { key: 'bulk', className: 'edrv-svn-bulk' },
          React.createElement('span', { className: 'edrv-svn-count' }, String(count) + ' 项'),
          React.createElement('span', { style: { flex: 1 } }),
          (paths.unversioned.length
            ? React.createElement('button', {
                className: 'edrv-svn-act', disabled: handlers.busy,
                title: '把全部未版本控制文件加入版本控制',
                onClick: () => handlers.add(paths.unversioned),
              }, '全部加入')
            : null),
          (paths.revert.length
            ? React.createElement('button', {
                className: 'edrv-svn-act edrv-svn-act-danger', disabled: handlers.busy,
                title: '还原全部已受版本控制文件的本地改动',
                onClick: () => handlers.revert(paths.revert),
              }, '全部还原')
            : null))
      : null),
  ]
}
// --endregion

/**
 * 「SVN 变更」面板主体。
 * @author ddj 2026年09月16号
 * @param props.ctx 面板共享上下文（sessionId/scope/svnChanges/svn/notify/openSvnDiff）
 * @returns 面板元素
 */
export function SvnPanel(props) {
  const ctx = props?.ctx
  const sessionId = ctx?.sessionId
  const scope = ctx?.scope
  const entries = ctx?.svnChanges ?? null
  const managed = Boolean(ctx?.svn?.managed && ctx?.svn?.svnCli)
  const [filter, setFilter] = React.useState(() => loadFilter(scope))
  const [busy, setBusy] = React.useState(false)

  // 作用域切换：重读该作用域自己的开关（同一工作区共享）
  React.useEffect(() => {
    setFilter(loadFilter(scope))
  }, [scope])

  const applyFilter = (next) => {
    setFilter(next)
    saveFilter(scope, next)
  }

  /**
   * 批量动作统一流程：先 confirm（仅还原需要）→ 执行 → 反馈 → 强制重查。
   * @author ddj 2026年09月16号
   * @param kind 'add' | 'revert'
   * @param paths 目标相对路径列表
   */
  const runBatch = (kind, paths) => {
    if (!paths.length) return
    if (kind === 'revert') {
      const head = REVERT_CONFIRM_HEAD + paths.length + REVERT_CONFIRM_TAIL
      if (!window.confirm(head + '\n\n' + paths.join('\n'))) return
    }
    setBusy(true)
    const task = kind === 'revert' ? svnRevert(sessionId, paths) : svnAdd(sessionId, paths)
    void task.then((outcome) => {
      ctx?.notify?.(outcome.message)
      refreshSvnChanges(sessionId, scope)
    }).finally(() => setBusy(false))
  }

  const visible = entries === null ? [] : svnVisibleChanges(entries, filter)
  const openSvnDiff = (p) => ctx?.openSvnDiff?.(p)
  const handlers = {
    busy,
    onDiff: openSvnDiff,
    onAdd: (paths) => runBatch('add', paths),
    onRevert: (paths) => runBatch('revert', paths),
  }
  const listState = { managed, entries, visible, groups: groupByChangelist(visible) }
  const toolbar = svnToolbarEl({
    filter,
    count: visible.length,
    paths: {
      unversioned: visible.filter((entry) => !entry.versioned).map((entry) => entry.path),
      revert: visible.filter((entry) => entry.versioned).map((entry) => entry.path),
    },
    handlers: Object.assign({}, handlers, {
      toggleUnversioned: () => applyFilter({ ...filter, unversioned: !filter.unversioned }),
      toggleIgnored: () => applyFilter({ ...filter, ignored: !filter.ignored }),
      add: (paths) => runBatch('add', paths),
      revert: (paths) => runBatch('revert', paths),
    }),
  })
  const rootName = ctx?.svn?.wcRoot ? String(ctx.svn.wcRoot).split(/[\\/]/).pop() || ctx.svn.wcRoot : ''

  return React.createElement('div', { className: 'edrv-side-panel' },
    React.createElement('div', { className: 'edrv-side-head' },
      React.createElement('span', { className: 'edrv-side-title' }, 'SVN 变更'),
      React.createElement('span', { className: 'edrv-side-root', title: ctx?.svn?.wcRoot || '' }, rootName),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', {
        className: 'edrv-side-btn', title: '刷新变更',
        onClick: () => { refreshSvnChanges(sessionId, scope); ctx?.refreshRecords?.() },
      }, refreshIconEl())),
    ...toolbar,
    React.createElement('div', { className: 'edrv-svn-list' }, svnListBody(listState, handlers)))
}
