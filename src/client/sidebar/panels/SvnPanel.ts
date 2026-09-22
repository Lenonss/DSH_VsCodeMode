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
  pairMissingWithUnversioned,
  svnVisibleChanges,
} from '../../../shared/svn.js'
import { CACHE_KEY } from '../../paths.js'
import { refreshSvnChanges, svnAdd, svnConflictArtifacts, svnFileSizes, svnRemoteStatus, svnRevert } from '../../svnStatus.js'
import { csvOf, downloadText, htmlTableOf } from '../../ui/svnExport.js'
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
  const fallback = { unversioned: true, ignored: false, name: '' }
  if (!scope) return fallback
  try {
    const raw = window.localStorage.getItem(CACHE_KEY.svn + scope)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return {
      unversioned: parsed?.unversioned !== false,
      ignored: parsed?.ignored === true,
      // W1-2 名称过滤随开关一并持久化（旧数据缺字段 = 不过滤，向后兼容）
      name: typeof parsed?.name === 'string' ? parsed.name : '',
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
 * @author ddj 2026年09月16号 / 2026年09月20号
 * @param props.entry 变更条目
 * @param props.busy 批量动作进行中（按钮置灰）
 * @param props.onDiff 打开基线差异
 * @param props.onAdd 加入版本控制
 * @param props.onRevert 还原
 * @param props.onConflict 冲突副本对比（W2-4；仅冲突行出现按钮）
 * @param props.pairNote 疑似改名标记文案（W2-5；空 = 无配对）
 * @returns 行元素
 */
function SvnRow(props) {
  const { entry, busy, onDiff, onAdd, onRevert, onConflict, pairNote } = props
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
    (pairNote ? React.createElement('span', { className: 'edrv-svn-pair-mark', title: pairNote }, '⇄') : null),
    React.createElement('span', { className: 'edrv-svn-acts' },
      (entry.status === 'conflicted' ? act('冲突对比', '与 .mine/.rN 冲突副本并排对比（解决指引见差异视图顶部）', false, () => onConflict(entry.path)) : null),
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
  if (!state.visible.length) {
    // W1-2：名称过滤生效时区分「无匹配」与「无变更」，提示清空过滤框
    return React.createElement('div', { className: 'edrv-tree-loading' },
      state.nameFiltered ? '无匹配条目（名称过滤生效中，清空过滤框可看全部）' : '无变更（工作副本干净）')
  }
  const rows = []
  for (const group of state.groups) {
    if (state.groups.length > 1 || group.name !== NO_CHANGELIST) {
      rows.push(React.createElement('div', { key: 'g:' + group.name, className: 'edrv-svn-group' },
        React.createElement('span', null, 'changelist: ' + group.name),
        React.createElement('span', { className: 'edrv-svn-group-n' }, String(group.entries.length))))
    }
    for (const entry of group.entries) {
      rows.push(React.createElement(SvnRow, Object.assign({ key: entry.path, entry, pairNote: handlers.pairNotes?.[entry.path] }, handlers)))
    }
  }
  return rows
}

/**
 * 工具条（显示开关 + 名称过滤 + 批量动作 + 导出）。
 * @author ddj 2026年09月16号 / 2026年09月20号
 * @param props.filter 当前开关（含 W1-2 name）
 * @param props.count 可见条目数（名称过滤后）
 * @param props.countAll 全量条数（未按名称过滤，供「x/y 项」展示）
 * @param props.paths 批量动作目标（add/revert 各自清单；按未过滤集合计算）
 * @param props.handlers 动作回调（toggle/add/revert/onNameFilter/onExportCsv/onExportHtml/busy）
 * @returns 工具条元素数组
 */
function svnToolbarEl(props) {
  const { filter, count, countAll, paths, handlers } = props
  const check = (label, title, checked, onChange) => React.createElement('label', {
    className: 'edrv-svn-check', title,
  },
    React.createElement('input', { type: 'checkbox', checked, onChange }),
    React.createElement('span', null, label))
  const nameFiltered = String(filter.name || '').trim() !== ''
  return [
    React.createElement('div', { key: 'tools', className: 'edrv-svn-toolbar' },
      check('未版本控制', '显示未纳入版本控制的文件', filter.unversioned, handlers.toggleUnversioned),
      check('忽略项', '显示被忽略的文件', filter.ignored, handlers.toggleIgnored),
      React.createElement('input', {
        className: 'edrv-svn-name-filter',
        placeholder: '名称过滤：* ? 通配或子串',
        title: '按路径过滤条目（* 任意串、? 单字符；无通配符按子串包含，忽略大小写；只影响列表展示，不缩小批量动作范围）',
        value: filter.name || '',
        onChange: (event) => handlers.onNameFilter(event.target.value),
      })),
    (count
      ? React.createElement('div', { key: 'bulk', className: 'edrv-svn-bulk' },
          React.createElement('span', { className: 'edrv-svn-count' }, String(count) + (nameFiltered ? '/' + countAll : '') + ' 项'),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('button', {
            className: 'edrv-svn-act', title: '导出当前列表为 CSV（带 BOM，Excel 直开；状态/路径/changelist/修订）',
            onClick: handlers.onExportCsv,
          }, '导出CSV'),
          React.createElement('button', {
            className: 'edrv-svn-act', title: '导出当前列表为 HTML 报表（仅本地查看，不外发）',
            onClick: handlers.onExportHtml,
          }, '导出HTML'),
          (paths.unversioned.length
            ? React.createElement('button', {
                className: 'edrv-svn-act', disabled: handlers.busy,
                title: '把全部未版本控制文件加入版本控制（不受名称过滤影响）',
                onClick: () => handlers.add(paths.unversioned),
              }, '全部加入')
            : null),
          (paths.revert.length
            ? React.createElement('button', {
                className: 'edrv-svn-act edrv-svn-act-danger', disabled: handlers.busy,
                title: '还原全部已受版本控制文件的本地改动（不受名称过滤影响）',
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
  // W2-3：远端检查结果（null = 未检查；{ failed: true } = 失败降级；否则 { outdated, againstRev }）
  const [remote, setRemote] = React.useState(null)
  const [remoteBusy, setRemoteBusy] = React.useState(false)
  // W2-5：配对候选的文件大小（path → size|null）与成对结果
  const [sizes, setSizes] = React.useState({})

  // 作用域切换：重读该作用域自己的开关（同一工作区共享）并清掉远端/配对的会话内状态
  React.useEffect(() => {
    setFilter(loadFilter(scope))
    setRemote(null)
    setSizes({})
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

  /**
   * 远端更新检查（W2-3；host 侧 15s 短超时，离线/超时降级为提示条文案，不阻塞面板）。
   * @author ddj 2026年09月20号
   */
  const checkRemote = () => {
    if (remoteBusy) return
    setRemoteBusy(true)
    void svnRemoteStatus(sessionId, '').then((outcome) => {
      if (!outcome.ok) {
        setRemote({ failed: true })
        ctx?.notify?.(outcome.message)
        return
      }
      setRemote({ outdated: outcome.outdated ?? [], againstRev: outcome.againstRev ?? null })
    }).finally(() => setRemoteBusy(false))
  }

  /**
   * 冲突副本对比入口（W2-4，只读）：扫描 .mine/.working/.rN → 默认首个 .rN ↔ .mine 并排；
   * resolve 指引在差异视图顶部展示，本入口绝不自动执行 svn resolve（归 P2 破坏性批次）。
   * @author ddj 2026年09月20号
   * @param path 冲突文件的工作区相对路径
   */
  const openConflictDiff = (path) => {
    void svnConflictArtifacts(sessionId, path).then((outcome) => {
      if (!outcome.ok) { ctx?.notify?.(outcome.message); return }
      const artifacts = outcome.artifacts ?? []
      const revSide = artifacts.find((item) => item.kind === 'rev')
      const mineSide = artifacts.find((item) => item.kind === 'mine')
      if (!revSide || !mineSide) {
        ctx?.notify?.('未发现冲突副本（.mine/.rN）：' + artifacts.map((item) => item.name).join('、'))
        return
      }
      if (!ctx?.openSvnLocalPair) { ctx?.notify?.('当前视图不支持冲突对比'); return }
      ctx.openSvnLocalPair(revSide.path, mineSide.path, '.r' + (revSide.rev ?? '?'), '.mine', path)
    })
  }

  // W1-2：展示集合（含名称过滤）与批量动作集合（不含名称过滤）分离，「全部加入/还原」不缩小范围
  const shown = entries === null ? [] : svnVisibleChanges(entries, filter)
  const actionable = entries === null ? [] : svnVisibleChanges(entries, { unversioned: filter.unversioned, ignored: filter.ignored })
  const nameFiltered = String(filter.name || '').trim() !== ''

  // W2-5：`!`（missing）与 `?`（unversioned）共存时才做大小查询（候选少，一次批量查完成对）
  const missingEntries = entries === null ? [] : entries.filter((entry) => entry.status === 'missing')
  const unversionedEntries = entries === null ? [] : entries.filter((entry) => entry.status === 'unversioned')
  const candidates = [...missingEntries, ...unversionedEntries].map((entry) => entry.path)
  const pairsKnown = missingEntries.length > 0 && unversionedEntries.length > 0
    && candidates.every((path) => path in sizes)
  React.useEffect(() => {
    if (!pairsKnown && candidates.length) {
      void svnFileSizes(sessionId, candidates).then((table) => setSizes(table))
    }
  }, [pairsKnown, candidates.join('\n'), sessionId]) // eslint-disable-line react-hooks/exhaustive-deps
  const pairNoteOf = pairsKnown
    ? (() => {
      const notes = {}
      for (const pair of pairMissingWithUnversioned(entries ?? [], sizes)) {
        notes[pair.missingPath] = '疑似改名：原文件 → ' + pair.unversionedPath
        notes[pair.unversionedPath] = '疑似改名：← 原文件 ' + pair.missingPath
      }
      return notes
    })()
    : {}

  const openSvnDiff = (p) => ctx?.openSvnDiff?.(p)
  const handlers = {
    busy,
    onDiff: openSvnDiff,
    onConflict: openConflictDiff,
    pairNotes: pairNoteOf,
    onAdd: (paths) => runBatch('add', paths),
    onRevert: (paths) => runBatch('revert', paths),
  }

  /**
   * 导出当前展示列表（W1-4）：CSV 带 BOM 供 Excel 直开；HTML 本地报表；失败经 notify 提示。
   * @author ddj 2026年09月20号
   * @param kind 导出格式（'csv' | 'html'）
   */
  const onExport = (kind) => {
    const rows = shown.map((entry) => [
      SVN_STATUS_LETTER[entry.status] || '',
      entry.path,
      entry.changelist || '',
      entry.revision && entry.revision > 0 ? String(entry.revision) : '',
    ])
    const headers = ['状态', '路径', 'changelist', '修订']
    const stamp = new Date().toISOString().slice(0, 10)
    const done = kind === 'html'
      ? downloadText('svn-changes-' + stamp + '.html', htmlTableOf(headers, rows, 'SVN 变更列表 ' + stamp), 'text/html')
      : downloadText('svn-changes-' + stamp + '.csv', csvOf([headers, ...rows]), 'text/csv')
    if (!done) ctx?.notify?.('导出失败：浏览器下载能力不可用')
  }

  const listState = { managed, entries, visible: shown, groups: groupByChangelist(shown), nameFiltered }
  const toolbar = svnToolbarEl({
    filter,
    count: shown.length,
    countAll: actionable.length,
    paths: {
      unversioned: actionable.filter((entry) => !entry.versioned).map((entry) => entry.path),
      revert: actionable.filter((entry) => entry.versioned).map((entry) => entry.path),
    },
    handlers: Object.assign({}, handlers, {
      toggleUnversioned: () => applyFilter({ ...filter, unversioned: !filter.unversioned }),
      toggleIgnored: () => applyFilter({ ...filter, ignored: !filter.ignored }),
      onNameFilter: (name) => applyFilter({ ...filter, name }),
      onExportCsv: () => onExport('csv'),
      onExportHtml: () => onExport('html'),
      add: (paths) => runBatch('add', paths),
      revert: (paths) => runBatch('revert', paths),
    }),
  })
  const rootName = ctx?.svn?.wcRoot ? String(ctx.svn.wcRoot).split(/[\\/]/).pop() || ctx.svn.wcRoot : ''

  // W2-3：远端更新提示条（null = 未检查；failed = 降级文案；否则展示落后数与 against 修订）
  const remoteEl = remote === null
    ? null
    : React.createElement('div', { className: 'edrv-svn-hintbar' + (remote.failed ? ' edrv-svn-hintbar-warn' : '') },
        React.createElement('span', { style: { flex: 1 } },
          remote.failed
            ? '远端检查失败（网络不可达或超时；可用 ⟳ 或「检查远端」重试）'
            : (remote.outdated.length
              ? '远端有 ' + remote.outdated.length + ' 个更新（against r' + (remote.againstRev ?? '?') + '），其中本地已改 ' + remote.outdated.filter((item) => item.path && entries?.some((entry) => entry.path === item.path && entry.versioned)).length + ' 个；更新前请先提交或还原'
              : '远端无更新（against r' + (remote.againstRev ?? '?') + '）')),
        React.createElement('button', { className: 'edrv-svn-act', title: '关闭提示条', onClick: () => setRemote(null) }, '✕'))

  return React.createElement('div', { className: 'edrv-side-panel' },
    React.createElement('div', { className: 'edrv-side-head' },
      React.createElement('span', { className: 'edrv-side-title' }, 'SVN 变更'),
      React.createElement('span', { className: 'edrv-side-root', title: ctx?.svn?.wcRoot || '' }, rootName),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', {
        className: 'edrv-side-btn', title: '检查远端更新（svn status -u；约数秒，离线自动降级）',
        onClick: checkRemote,
      }, remoteBusy ? '…' : '⇅'),
      React.createElement('button', {
        className: 'edrv-side-btn', title: '刷新变更',
        onClick: () => { refreshSvnChanges(sessionId, scope); ctx?.refreshRecords?.() },
      }, refreshIconEl())),
    remoteEl,
    ...toolbar,
    React.createElement('div', { className: 'edrv-svn-list' }, svnListBody(listState, handlers)))
}
