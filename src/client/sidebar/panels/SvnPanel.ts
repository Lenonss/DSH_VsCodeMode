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
import { IconRefreshOutline16, fileIconEl } from '../../ui/icons.js'
import {
  BATCH_PATHS_CAP,
  FILE_SIZES_CAP,
  SVN_ADD_LABEL,
  SVN_DIFF_BASE_LABEL,
  SVN_REVERT_LABEL,
  SVN_STATUS_LABEL,
  SVN_STATUS_LETTER,
  SVN_STATUS_TONE,
  buildAgentPrompt,
  ignoreItemsOf,
  isSvnDiffable,
  pairMissingWithUnversioned,
  svnChangelistNameErrorOf,
  svnChunksOf,
  svnVisibleChanges,
} from '../../../shared/svn.js'
import { CACHE_KEY } from '../../paths.js'
import { refreshSvnChanges, runPlanSteps, svnAdd, svnAiPlan, svnAiPlanPending, svnChangelist, svnChangesCapped, svnConflictArtifacts, svnFileSizes, svnIgnore, svnRemoteStatus, svnRevert } from '../../svnStatus.js'
import { csvOf, downloadText, htmlTableOf } from '../../ui/svnExport.js'
import { ContextMenu } from '../../ui/ContextMenu.js'
import type { ContextMenuEntry } from '../../ui/ContextMenu.js'
import { SvnAiPlanDialog } from '../../ui/SvnAiPlanDialog.js'
import { budgetGroupsOf } from './svnListBudget.js'
import type { SidebarCtx } from '../types.js'

/** 未分组条目的分组键（changelist 为空）。 */
const NO_CHANGELIST = '（未分组）'

/** 还原确认文案（新增文件不会被删除是 svn revert 的实际语义，须如实告知）。 */
const REVERT_CONFIRM_HEAD = '确认还原以下 '
const REVERT_CONFIRM_TAIL = ' 个文件的本地改动？新增（A）文件在磁盘上会保留，仅取消登记。'

/** 列表渐进渲染步长（初始也按此值）：数据量大时避免一次建满 DOM（面板随编辑区任意刷新重渲）。 */
const RENDER_STEP = 500
/** 还原确认弹窗最多完整列出的路径数（超出折叠为「…等 N 个文件」，防大列表拼超长文案卡 UI）。 */
const CONFIRM_PREVIEW_CAP = 50
/** 混合通道取件轮询间隔（毫秒）与次数上限（3s × 200 = 10 分钟无件自动停）。 */
const DEEP_POLL_MS = 3000
const DEEP_POLL_MAX = 200

// --region AI 智能整理（11-ai-changelist-triage）

/** 执行载荷（SvnAiPlanDialog 勾选结果；空段已剔除）。 */
interface AiSelected {
  groups: Array<{ name: string; paths: string[] }>
  reverts: string[]
  ignores: string[]
}

/** 弹窗执行状态（null = 预览阶段；status 终态 'done'）。 */
interface AiRunState {
  status: 'running' | 'pausing' | 'paused' | 'cancelling' | 'done'
  index: number
  total: number
  cur: string
  log: Array<{ ok: boolean; text: string }>
  cancelled: boolean
}

/**
 * 勾选载荷 → 步骤队列（顺序固定 还原 → 分组 → 忽略；块/组/目录各一步，进度粒度对齐）。
 * @author ddj 2026年09月23号
 * @param selected 勾选载荷
 * @param sessionId 会话 id
 * @returns 步骤队列
 */
function planStepsOf(selected: AiSelected, sessionId: string | undefined) {
  const steps = []
  const reverts = selected.reverts
  let revDone = 0
  for (const chunk of svnChunksOf(reverts, BATCH_PATHS_CAP)) {
    revDone += chunk.length
    steps.push({
      label: '还原 ' + revDone + '/' + reverts.length + ' 项',
      kind: 'revert', n: chunk.length,
      run: () => svnRevert(sessionId, chunk),
    })
  }
  const groups = selected.groups
  groups.forEach((group, index) => {
    let done = 0
    for (const chunk of svnChunksOf(group.paths, BATCH_PATHS_CAP)) {
      done += chunk.length
      steps.push({
        label: '分组 ' + (index + 1) + '/' + groups.length + ' 组（' + group.name + '）' + done + '/' + group.paths.length + ' 项',
        kind: 'group', n: chunk.length, key: group.name,
        run: () => svnChangelist(sessionId, chunk, group.name),
      })
    }
  })
  const items = ignoreItemsOf(selected.ignores)
  items.forEach((item, index) => {
    steps.push({
      label: '忽略目录 ' + (index + 1) + '/' + items.length + '（' + (item.dir || '工作副本根') + '）',
      kind: 'ignore', n: item.names.length,
      run: () => svnIgnore(sessionId, [item]),
    })
  })
  return steps
}

/**
 * 逐步日志 → 汇总文案（分段计数 + 失败数与首条原因）。
 * @author ddj 2026年09月23号
 * @param steps 步骤队列（提供 kind/n/key）
 * @param log 逐步日志
 * @param cancelled 是否取消剩余
 * @returns 汇总文案
 */
function planSummaryOf(steps, log, cancelled) {
  const sum = { revert: 0, group: 0, ignore: 0, failed: 0, firstFail: '' }
  const groupNames = new Set()
  log.forEach((entry, index) => {
    const step = steps[index]
    if (!step) return
    if (entry.ok) {
      sum[step.kind] += step.n
      if (step.kind === 'group' && step.key) groupNames.add(step.key)
    } else {
      sum.failed++
      if (!sum.firstFail) sum.firstFail = entry.text
    }
  })
  let text = 'AI 整理完成：还原 ' + sum.revert + ' · 分组 ' + groupNames.size + ' 组 ' + sum.group + ' 项 · 忽略 ' + sum.ignore + ' 项'
  if (sum.failed) text += '；失败 ' + sum.failed + '（首条：' + sum.firstFail + '）'
  if (cancelled) text += '；已取消剩余步骤'
  return text
}
// --endregion

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

// --region 分组折叠持久化

/**
 * 读取分组折叠集合（损坏/缺省安全；键独立于显示开关，旧数据无键 = 全展开，向后兼容）。
 * @author ddj 2026年09月23号
 * @param scope 作用域键
 * @returns 折叠组名集合
 */
function loadFold(scope) {
  const empty = new Set()
  if (!scope) return empty
  try {
    const raw = window.localStorage.getItem(CACHE_KEY.svn + scope + '#fold')
    if (!raw) return empty
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string') : [])
  } catch (error) {
    return empty
  }
}

/**
 * 写分组折叠集合（配额/隐私模式失败静默）。
 * @author ddj 2026年09月23号
 * @param scope 作用域键
 * @param names 折叠组名集合
 */
function saveFold(scope, names) {
  if (!scope) return
  try {
    window.localStorage.setItem(CACHE_KEY.svn + scope + '#fold', JSON.stringify([...names]))
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
 * React.memo：行 props（entry/pairNote/busy + 稳定回调）不变时跳过重渲染，
 * 面板因名称过滤/尺寸表等面板内状态重渲时，未受影响的行不再重建。
 * @author ddj 2026年09月16号 / 2026年09月20号 / 2026年09月23号
 * @param props.entry 变更条目
 * @param props.busy 批量动作进行中（按钮置灰）
 * @param props.onDiff 打开基线差异
 * @param props.onAdd 加入版本控制
 * @param props.onRevert 还原
 * @param props.onConflict 冲突副本对比（W2-4；仅冲突行出现按钮）
 * @param props.onMenu 行右键菜单（分区管理入口；参数为条目与视口坐标）
 * @param props.onOpen 单击跳转（编辑区打开/聚焦该文件）
 * @param props.pairNote 疑似改名标记文案（W2-5；空 = 无配对）
 * @returns 行元素
 */
const SvnRow = React.memo(function SvnRow(props) {
  const { entry, busy, onDiff, onAdd, onRevert, onConflict, onMenu, onOpen, pairNote } = props
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
    onClick: () => onOpen?.(entry.path),
    onDoubleClick: () => { if (diffable) onDiff(entry.path) },
    onContextMenu: (event) => {
      if (!onMenu) return
      event.preventDefault()
      onMenu(entry, event.clientX, event.clientY)
    },
  },
    fileIconEl(String(entry.path ?? '').split(/[\\/]/).pop() || ''),
    statusLetterEl(entry),
    React.createElement('span', { className: 'edrv-svn-path' }, entry.path),
    (pairNote ? React.createElement('span', { className: 'edrv-svn-pair-mark', title: pairNote }, '⇄') : null),
    React.createElement('span', { className: 'edrv-svn-acts' },
      (entry.status === 'conflicted' ? act('冲突对比', '与 .mine/.rN 冲突副本并排对比（解决指引见差异视图顶部）', false, () => onConflict(entry.path)) : null),
      (diffable ? act('比较', SVN_DIFF_BASE_LABEL + '（BASE 与工作区并排）', false, () => onDiff(entry.path)) : null),
      (!entry.versioned ? act('加入', SVN_ADD_LABEL, false, () => onAdd([entry.path])) : null),
      (entry.versioned ? act('还原', SVN_REVERT_LABEL + '（放弃本地改动）', true, () => onRevert([entry.path])) : null)))
})

/**
 * 列表主体：分组行 + 条目行（按预算渐进渲染）；未受管理/加载中/无变更各自给出稳定文案。
 * @author ddj 2026年09月16号 / 2026年09月23号
 * @param state 列表状态（managed/entries/visible/budget/nameFiltered/capped/collapsedSet/onFold）
 * @param handlers 行动作（onDiff/onAdd/onRevert/onMore/onGroupClRemove/onMenu/busy/pairNotes）
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
  for (const group of state.budget.groups) {
    // 组头恒渲染（含「未分组」，单组也出——提供折叠入口与计数）：
    // chevron + 名称 + 命名组「移出分区」+ 全量计数；点击组头切换折叠
    rows.push(React.createElement('div', {
      key: 'g:' + group.name,
      className: 'edrv-svn-group',
      title: '点击折叠/展开该分组',
      onClick: () => state.onFold?.(group.name),
    },
      React.createElement('span', { className: 'edrv-svn-fold-ch' }, group.folded ? '▸' : '▾'),
      React.createElement('span', null, 'changelist: ' + group.name),
      (group.name !== NO_CHANGELIST && handlers.onGroupClRemove
        ? React.createElement('button', {
            className: 'edrv-svn-act',
            disabled: handlers.busy,
            title: '把该分区全部文件移出 changelist（不改文件内容；超过 ' + BATCH_PATHS_CAP + ' 项自动分块执行）',
            onClick: (event) => { event.stopPropagation(); handlers.onGroupClRemove(group.name) },
          }, '移出分区')
        : null),
      React.createElement('span', { className: 'edrv-svn-group-n' }, String(group.full ?? group.entries.length))))
    if (group.folded) continue
    for (const entry of group.entries) {
      rows.push(React.createElement(SvnRow, Object.assign({ key: entry.path, entry, pairNote: handlers.pairNotes?.[entry.path] }, handlers)))
    }
  }
  if (state.budget.hasMore) {
    rows.push(React.createElement('button', {
      key: 'edrv-svn-more',
      className: 'edrv-svn-act edrv-svn-more',
      title: '继续渲染更多条目（每次 ' + RENDER_STEP + ' 条；批量动作与导出始终按全量集合计算，不受渲染预算影响）',
      onClick: handlers.onMore,
    }, '已显示 ' + state.budget.shown + ' / ' + state.budget.total + ' 项，显示更多'))
  }
  if (state.capped) {
    rows.push(React.createElement('div', { key: 'edrv-svn-capped', className: 'edrv-tree-loading' },
      '变更条目过多，清单已按上限截断（列表/批量/导出仅含已载入部分）；可用名称过滤缩小范围'))
  }
  return rows
}

/**
 * AI 助手 dock（设计定稿 12-panel-ai-bar）：accent 左竖轨 + 「AI 整理」标签 +
 * 快速分析/深度分析两按钮 + 定宽状态位。按钮文案恒定（忙态只换状态位文案，不跳版）；
 * AI 线程色三处同轨（竖轨/按钮描边/弹窗进度条，--dsw-alias-state-info-primary）。
 * @author ddj 2026年09月23号
 * @param props.managed/忙碌标志（managed/busy/aiBusy/deepWaiting/hasRun）
 * @param props.onQuick 快速分析回调（host LLM 直调）
 * @param props.onDeep 深度分析回调（会话 agent 投递回面板）
 * @returns dock 元素
 */
function aiBarEl(props) {
  const { managed, busy, aiBusy, deepWaiting, hasRun, onQuick, onDeep } = props
  const locked = !managed || busy || aiBusy || hasRun
  const status = aiBusy ? '分析中…' : (deepWaiting ? '等待助手投递…' : '就绪')
  return React.createElement('div', { className: 'edrv-svn-ai-bar' },
    React.createElement('span', { className: 'edrv-svn-ai-rail', 'aria-hidden': 'true' }),
    React.createElement('span', { className: 'edrv-svn-ai-label' }, 'AI 整理'),
    React.createElement('button', {
      className: 'edrv-svn-act edrv-svn-ai-btn',
      title: '快速分析：由模型直读变更与差异，产出分组/还原/忽略方案（分析后需勾选确认才执行）',
      disabled: locked,
      onClick: onQuick,
    }, '快速分析'),
    React.createElement('button', {
      className: 'edrv-svn-act edrv-svn-ai-btn',
      title: '深度分析：把分析任务填入对话，由 AI 助手借 codegraph/读文件深度分析后投递方案回本面板（执行仍需勾选确认）',
      disabled: locked || deepWaiting,
      onClick: onDeep,
    }, '深度分析'),
    React.createElement('span', { style: { flex: 1 } }),
    React.createElement('span', { className: 'edrv-svn-ai-status' }, status))
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
          // 导出簇 ┊ 动作簇（设计定稿：语义分组，分隔线只在两簇之间）
          React.createElement('button', {
            className: 'edrv-svn-act', title: '导出当前列表为 CSV（带 BOM，Excel 直开；状态/路径/changelist/修订）',
            onClick: handlers.onExportCsv,
          }, '导出 CSV'),
          React.createElement('button', {
            className: 'edrv-svn-act', title: '导出当前列表为 HTML 报表（仅本地查看，不外发）',
            onClick: handlers.onExportHtml,
          }, '导出 HTML'),
          ((paths.unversioned.length || paths.revert.length)
            ? React.createElement('span', { className: 'edrv-svn-sep' })
            : null),
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
  // 渐进渲染预算：过滤/作用域变化时重置，避免过滤后仍停留在旧的大预算
  const [renderLimit, setRenderLimit] = React.useState(RENDER_STEP)
  // ctx 由编辑区每轮渲染重建；行动作回调改读 ref 取最新值，回调身份才能稳定（行 React.memo 生效前提）
  const ctxRef = React.useRef(ctx)
  ctxRef.current = ctx
  // 行右键菜单状态（分区管理入口）：{ entry, x, y } | null
  const [menu, setMenu] = React.useState(null)
  // 分组折叠集合（组名；按作用域持久化，独立于显示开关键）
  const [collapsed, setCollapsed] = React.useState(() => loadFold(scope))
  // AI 智能整理：分析 busy / 方案（null = 未开弹窗）/ 执行状态（null = 预览阶段）
  const [aiBusy, setAiBusy] = React.useState(false)
  const [aiPlan, setAiPlan] = React.useState(null)
  const [aiRun, setAiRun] = React.useState(null)
  // 执行引擎控制面（暂停/取消标志 + 步骤边界唤醒；ref 保证回调身份稳定）
  const aiCtl = React.useRef({ paused: false, cancelled: false, wake: null })

  // 作用域切换：重读该作用域自己的开关（同一工作区共享）并清掉远端/配对的会话内状态
  React.useEffect(() => {
    setFilter(loadFilter(scope))
    setRemote(null)
    setSizes({})
    setRenderLimit(RENDER_STEP)
    setCollapsed(loadFold(scope))
  }, [scope])

  const applyFilter = (next) => {
    setFilter(next)
    setRenderLimit(RENDER_STEP)
    saveFilter(scope, next)
  }

  /**
   * 批量动作统一流程：先 confirm（仅还原需要）→ 执行 → 反馈 → 强制重查。
   * 确认文案只完整列前 CONFIRM_PREVIEW_CAP 条（大列表拼几千行弹窗文案会卡 UI），总数如实展示。
   * @author ddj 2026年09月16号 / 2026年09月23号
   * @param kind 'add' | 'revert'
   * @param paths 目标相对路径列表
   */
  const runBatch = React.useCallback((kind, paths) => {
    if (!paths.length) return
    if (kind === 'revert') {
      const preview = paths.length > CONFIRM_PREVIEW_CAP
        ? paths.slice(0, CONFIRM_PREVIEW_CAP).join('\n') + '\n…等 ' + paths.length + ' 个文件'
        : paths.join('\n')
      const head = REVERT_CONFIRM_HEAD + paths.length + REVERT_CONFIRM_TAIL
      if (!window.confirm(head + '\n\n' + preview)) return
    }
    setBusy(true)
    const task = kind === 'revert' ? svnRevert(sessionId, paths) : svnAdd(sessionId, paths)
    void task.then((outcome) => {
      ctxRef.current?.notify?.(outcome.message)
      refreshSvnChanges(sessionId, scope)
    }).finally(() => setBusy(false))
  }, [sessionId, scope])

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
        ctxRef.current?.notify?.(outcome.message)
        return
      }
      setRemote({ outdated: outcome.outdated ?? [], againstRev: outcome.againstRev ?? null })
    }).finally(() => setRemoteBusy(false))
  }

  /**
   * 冲突副本对比入口（W2-4，只读）：扫描 .mine/.working/.rN → 默认首个 .rN ↔ .mine 并排；
   * resolve 指引在差异视图顶部展示，本入口绝不自动执行 svn resolve（归 P2 破坏性批次）。
   * @author ddj 2026年09月20号 / 2026年09月23号
   * @param path 冲突文件的工作区相对路径
   */
  const openConflictDiff = React.useCallback((path) => {
    void svnConflictArtifacts(sessionId, path).then((outcome) => {
      const live = ctxRef.current
      if (!outcome.ok) { live?.notify?.(outcome.message); return }
      const artifacts = outcome.artifacts ?? []
      const revSide = artifacts.find((item) => item.kind === 'rev')
      const mineSide = artifacts.find((item) => item.kind === 'mine')
      if (!revSide || !mineSide) {
        live?.notify?.('未发现冲突副本（.mine/.rN）：' + artifacts.map((item) => item.name).join('、'))
        return
      }
      if (!live?.openSvnLocalPair) { live?.notify?.('当前视图不支持冲突对比'); return }
      live.openSvnLocalPair(revSide.path, mineSide.path, '.r' + (revSide.rev ?? '?'), '.mine', path)
    })
  }, [sessionId])

  // W1-2：展示集合（含名称过滤）与批量动作集合（不含名称过滤）分离，「全部加入/还原」不缩小范围。
  // 派生集合全部 memo 化：面板会随编辑区任意刷新重渲，entries/filter 不变时不再重复 O(n) 过滤。
  const shown = React.useMemo(
    () => (entries === null ? [] : svnVisibleChanges(entries, filter)),
    [entries, filter],
  )
  const actionable = React.useMemo(
    () => (entries === null ? [] : svnVisibleChanges(entries, { unversioned: filter.unversioned, ignored: filter.ignored })),
    [entries, filter],
  )
  const nameFiltered = String(filter.name || '').trim() !== ''

  // W2-5：改名配对候选。sizes 只服务配对，无 missing 文件时零请求（此前会把全部
  // unversioned 发给 svn.fileSizes 白耗 I/O）；请求子集对齐 host 上限（超出部分 host 会静默截断），
  // missing 优先占位，保证「有缺失文件」场景优先拿到双侧 size。
  const missingEntries = React.useMemo(
    () => (entries ?? []).filter((entry) => entry.status === 'missing'),
    [entries],
  )
  const unversionedEntries = React.useMemo(
    () => (entries ?? []).filter((entry) => entry.status === 'unversioned'),
    [entries],
  )
  const requested = React.useMemo(
    () => [...missingEntries, ...unversionedEntries].slice(0, FILE_SIZES_CAP).map((entry) => entry.path),
    [missingEntries, unversionedEntries],
  )
  const candidateKey = React.useMemo(() => requested.join('\n'), [requested])
  const pairsNeeded = missingEntries.length > 0 && unversionedEntries.length > 0
  const pairsKnown = pairsNeeded && requested.every((path) => path in sizes)
  React.useEffect(() => {
    if (pairsKnown || !requested.length) return
    void svnFileSizes(sessionId, requested).then((table) => setSizes(table))
    // requested 内容由 candidateKey 代理：同 key 必同内容，闭包取旧数组无碍（去重语义与旧 join 依赖一致）
  }, [pairsKnown, candidateKey, sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const pairNoteOf = React.useMemo(() => {
    if (!pairsKnown) return {}
    const notes = {}
    for (const pair of pairMissingWithUnversioned(entries ?? [], sizes)) {
      notes[pair.missingPath] = '疑似改名：原文件 → ' + pair.unversionedPath
      notes[pair.unversionedPath] = '疑似改名：← 原文件 ' + pair.missingPath
    }
    return notes
  }, [pairsKnown, entries, sizes])
  // 候选超上限时如实提示（此前候选超 200 时 pairsKnown 永远不成立，配对功能静默失效）
  const pairCapHint = pairsNeeded && (missingEntries.length + unversionedEntries.length) > FILE_SIZES_CAP

  // 远端提示条的「本地已改 N 个」计数：Set 查表 O(n+m)，替换旧的逐条 some（O(outdated×entries)）
  const versionedPathSet = React.useMemo(() => {
    const set = new Set()
    for (const entry of entries ?? []) {
      if (entry.versioned) set.add(entry.path)
    }
    return set
  }, [entries])

  /**
   * 分区操作统一流程：busy → 按 host 上限分块顺序执行 → 聚合反馈 → 强制重查。
   * 反馈计数以面板层 paths.length 为准（svn changelist 成功输出静默，host count 为 0）。
   * @author ddj 2026年09月23号
   * @param paths 目标相对路径列表
   * @param name 目标分区名；null = 移出分区
   */
  const runCl = React.useCallback(async (paths, name) => {
    if (!paths.length) return
    setBusy(true)
    const failures = []
    let done = 0
    try {
      for (const chunk of svnChunksOf(paths, BATCH_PATHS_CAP)) {
        const outcome = await svnChangelist(sessionId, chunk, name)
        if (outcome.ok) done += chunk.length
        else failures.push(outcome.message)
      }
    } finally {
      setBusy(false)
    }
    const total = paths.length
    if (!failures.length) {
      ctxRef.current?.notify?.(name === null
        ? '已移出分区（' + total + ' 项）'
        : '已移入分区「' + name + '」（' + total + ' 项）')
    } else {
      ctxRef.current?.notify?.('分区完成 ' + done + '/' + total + ' 项；' + failures[0])
    }
    refreshSvnChanges(sessionId, scope)
  }, [sessionId, scope])

  /**
   * 把单条条目移入分区：弹窗输入分区名（预填当前名，可直接改名）→ 共享校验 → 执行。
   * @author ddj 2026年09月23号
   * @param entry 变更条目
   */
  const moveToChangelist = async (entry) => {
    const name = await ctxRef.current?.prompt?.('移入 SVN 分区（changelist）', entry.changelist || '')
    if (!name) return
    const nameError = svnChangelistNameErrorOf(name)
    if (nameError) { ctxRef.current?.notify?.(nameError); return }
    await runCl([entry.path], name)
  }

  /**
   * 整组移出分区：取该分区全部条目（不受名称过滤/显示开关影响，与批量动作口径一致）。
   * @author ddj 2026年09月23号
   * @param groupName 分区名
   */
  const removeGroupCl = React.useCallback(async (groupName) => {
    const paths = (entries ?? []).filter((entry) => entry.changelist === groupName).map((entry) => entry.path)
    await runCl(paths, null)
  }, [entries, runCl])

  const openRowMenu = React.useCallback((entry, x, y) => setMenu({ entry, x, y }), [])
  const closeMenu = React.useCallback(() => setMenu(null), [])

  /**
   * AI 智能整理分析入口：host 一次性 LLM 分析（超时 AI_PLAN_TIMEOUT_MS=300s）→ 预览弹窗；失败 notify。
   * @author ddj 2026年09月23号
   */
  const runAiPlan = React.useCallback(() => {
    if (aiBusy || aiRun) return
    if (!entries || !entries.length) { ctxRef.current?.notify?.('无变更可分析'); return }
    setAiBusy(true)
    void svnAiPlan(sessionId).then((outcome) => {
      if (!outcome.ok || !outcome.plan) { ctxRef.current?.notify?.(outcome.message); return }
      setAiPlan(outcome)
    }).finally(() => setAiBusy(false))
  }, [aiBusy, aiRun, entries, sessionId])

  /** 暂停（步骤边界生效；当前 in-flight RPC 不可中断，UI 标注「等待当前步骤完成…」）。 */
  const aiPause = React.useCallback(() => {
    aiCtl.current.paused = true
    setAiRun((old) => (old ? { ...old, status: 'pausing' } : old))
  }, [])

  /** 继续（唤醒步骤边界等待，从断点续跑）。 */
  const aiResume = React.useCallback(() => {
    aiCtl.current.paused = false
    const wake = aiCtl.current.wake
    aiCtl.current.wake = null
    if (wake) wake()
    setAiRun((old) => (old ? { ...old, status: 'running' } : old))
  }, [])

  /** 取消剩余（已执行不回滚；唤醒边界等待让引擎立刻收尾）。 */
  const aiCancelRest = React.useCallback(() => {
    aiCtl.current.cancelled = true
    aiCtl.current.paused = false
    const wake = aiCtl.current.wake
    aiCtl.current.wake = null
    if (wake) wake()
    setAiRun((old) => (old ? { ...old, status: 'cancelling' } : old))
  }, [])

  /**
   * 预览确认 → 启动可暂停执行引擎（还原→分组→忽略固定顺序；单步失败继续）。
   * @author ddj 2026年09月23号
   * @param selected 勾选载荷
   */
  const onAiExecute = React.useCallback(async (selected) => {
    const live = ctxRef.current
    const steps = planStepsOf(selected, sessionId)
    if (!steps.length) return
    aiCtl.current = { paused: false, cancelled: false, wake: null }
    setAiRun({ status: 'running', index: 0, total: steps.length, cur: steps[0].label, log: [], cancelled: false })
    const ctl = {
      paused: () => aiCtl.current.paused,
      cancelled: () => aiCtl.current.cancelled,
      /** 步骤边界等待：paused 且未 cancelled 时挂起，由 resume/cancel 唤醒。 */
      wait: () => (aiCtl.current.paused && !aiCtl.current.cancelled
        ? new Promise((resolve) => { aiCtl.current.wake = () => resolve(undefined) })
        : Promise.resolve(undefined)),
    }
    const result = await runPlanSteps(steps, ctl, (tick) => {
      setAiRun((old) => (old ? {
        ...old,
        index: tick.done,
        total: tick.total,
        cur: tick.cur,
        log: tick.log,
        status: aiCtl.current.cancelled ? 'cancelling' : old.status,
      } : old))
    })
    setAiRun((old) => (old ? { ...old, status: 'done', cur: '', cancelled: result.cancelled } : old))
    live?.notify?.(planSummaryOf(steps, result.log, result.cancelled))
    refreshSvnChanges(sessionId, scope)
  }, [sessionId, scope])

  /** 关闭整理弹窗（「关闭并刷新」；预览阶段 = 取消零副作用）。 */
  const closeAiPlan = React.useCallback(() => {
    setAiPlan(null)
    setAiRun(null)
    refreshSvnChanges(sessionId, scope)
  }, [sessionId, scope])

  // --region 混合通道（01-hybrid-deep-analysis）：会话 agent 深度分析 → 投递回面板

  /** 取件轮询句柄（null = 未在轮询；卸载/取到/超时清理）。 */
  const deepTimer = React.useRef(null)
  const [deepWaiting, setDeepWaiting] = React.useState(false)

  /** 停止取件轮询（幂等）。 */
  const stopDeepPoll = React.useCallback(() => {
    if (deepTimer.current !== null) {
      clearInterval(deepTimer.current)
      deepTimer.current = null
    }
    setDeepWaiting(false)
  }, [])

  // 卸载清理（防轮询泄漏）
  React.useEffect(() => () => {
    if (deepTimer.current !== null) clearInterval(deepTimer.current)
  }, [])

  /**
   * 开启取件轮询：每 DEEP_POLL_MS 取一次收件箱，取到方案即开预览弹窗并停轮询；
   * DEEP_POLL_MAX 次无件自动停并提示（agent 可能没投递）。
   * @author ddj 2026年09月23号
   * @param since 注入时刻时间戳（旧投递不算新件）
   */
  const startDeepPoll = React.useCallback((since) => {
    stopDeepPoll()
    setDeepWaiting(true)
    let ticks = 0
    deepTimer.current = setInterval(() => {
      ticks += 1
      if (ticks > DEEP_POLL_MAX) {
        stopDeepPoll()
        ctxRef.current?.notify?.('等待 AI 助手方案超时（10 分钟），已停止取件')
        return
      }
      void svnAiPlanPending(sessionId, since).then((outcome) => {
        if (!outcome.ok || !outcome.plan) return
        stopDeepPoll()
        setAiPlan({
          plan: outcome.plan,
          entriesCount: (ctxRef.current?.svnChanges ?? []).length,
          diffIncluded: true,
          dropped: outcome.dropped ?? 0,
          model: undefined,
          source: 'agent',
        })
        ctxRef.current?.notify?.('AI 助手方案已送达，请勾选确认后执行')
      })
    }, DEEP_POLL_MS)
  }, [sessionId, stopDeepPoll])

  /**
   * 深度分析入口（02-deep-session-prompt 修正版）：**新建独立会话**承载任务
   * （不污染当前对话），草稿箱填入分析任务（变更清单由 agent 自跑只读 svn status
   * 取数，prompt 定长）→ 用户在新会话发送 → agent 投递方案回面板收件箱。
   * 降级：不支持自动新建会话时回落当前对话注入 + notify 注明。
   * @author ddj 2026年09月23号
   */
  const runDeepPlan = React.useCallback(() => {
    const live = ctxRef.current
    if (aiBusy || aiRun || deepWaiting) return
    if (!entries || !entries.length) { live?.notify?.('无变更可分析'); return }
    const wcRoot = live?.svn?.wcRoot ? String(live.svn.wcRoot) : ''
    const since = Date.now()
    const add = live?.addToConversation
    if (!add?.appendText) { live?.notify?.('无法填入任务（无会话或输入框不可用）'); return }
    /** 降级：当前对话注入（不支持自动新建会话时兜底）。 */
    const degrade = (prompt) => {
      void add.appendText(sessionId, prompt).then((outcome) => {
        if (outcome === 'ok' || outcome === 'busy') {
          live?.notify?.('已填入当前对话（降级），任务已自动发送，请在本对话查看')
          startDeepPoll(since)
        } else {
          live?.notify?.('发起失败：' + (outcome === 'unavailable' ? '无会话或输入框不可用' : '输入框忙，请重试'))
        }
      })
    }
    /** 统一收尾（点击即发送方案）：create 后构建 prompt（内嵌新会话 id）→ 发送任务。 */
    const sendAndWatch = (id) => {
      const prompt = buildAgentPrompt(wcRoot, id || sessionId || '')
      if (!id || typeof add.sendTask !== 'function') { degrade(prompt); return }
      void add.sendTask(id, prompt).then((sent) => {
        if (sent) {
          live?.notify?.('已在新会话发起深度分析（任务已自动发送），请在会话列表查看')
          startDeepPoll(since)
        } else {
          degrade(prompt)
        }
      })
    }
    void (add.startDraftSession
      ? add.startDraftSession(wcRoot || undefined)
      : Promise.resolve({ ok: false })
    ).then((result) => { sendAndWatch(result?.ok ? result.id : undefined) })
  }, [aiBusy, aiRun, deepWaiting, entries, sessionId, startDeepPoll])

  // --endregion

  /**
   * 切换分组折叠（纯 UI 状态；不重置渲染预算——折叠释放预算、展开继续用已有预算）。
   * @author ddj 2026年09月23号
   * @param name 组名
   */
  const toggleFold = React.useCallback((name) => {
    const next = new Set(collapsed)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setCollapsed(next)
    saveFold(scope, next)
  }, [scope, collapsed])

  /**
   * 行右键菜单条目：分区管理（svn changelist 仅支持受版本控制文件，
   * 未版本控制/忽略项禁用；目录条目的报错由 host 经 notify 透出）。
   * @author ddj 2026年09月23号
   * @param entry 变更条目
   * @returns 菜单条目
   */
  const rowMenuEntriesOf = (entry): ContextMenuEntry[] => [
    {
      id: 'cl-set',
      label: entry.changelist ? '移到其他分区…' : '移入分区…',
      disabled: !entry.versioned || busy,
      onClick: () => { void moveToChangelist(entry) },
    },
    {
      id: 'cl-remove',
      label: '移出分区' + (entry.changelist ? '「' + entry.changelist + '」' : ''),
      disabled: !entry.versioned || !entry.changelist || busy,
      onClick: () => { void runCl([entry.path], null) },
    },
  ]

  const openSvnDiff = React.useCallback((p) => ctxRef.current?.openSvnDiff?.(p), [])
  const openFileAt = React.useCallback((p) => ctxRef.current?.openFile?.(p), [])
  const onAdd = React.useCallback((paths) => runBatch('add', paths), [runBatch])
  const onRevert = React.useCallback((paths) => runBatch('revert', paths), [runBatch])
  const showMore = React.useCallback(() => setRenderLimit((old) => old + RENDER_STEP), [])
  const handlers = {
    busy,
    onDiff: openSvnDiff,
    onConflict: openConflictDiff,
    pairNotes: pairNoteOf,
    onAdd,
    onRevert,
    onMore: showMore,
    onMenu: openRowMenu,
    onGroupClRemove: removeGroupCl,
    onOpen: openFileAt,
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

  const groups = React.useMemo(() => groupByChangelist(shown), [shown])
  // 折叠组映射为空 entries 组（带 full 全量计数 + folded 标记）：不占渲染预算，组头仍可见
  const budget = React.useMemo(() => budgetGroupsOf(
    groups.map((g) => (collapsed.has(g.name)
      ? { name: g.name, entries: [], full: g.entries.length, folded: true }
      : g)),
    renderLimit,
  ), [groups, collapsed, renderLimit])
  const listState = { managed, entries, visible: shown, budget, nameFiltered, capped: svnChangesCapped(scope), collapsedSet: collapsed, onFold: toggleFold }
  const bulkPaths = React.useMemo(() => ({
    unversioned: actionable.filter((entry) => !entry.versioned).map((entry) => entry.path),
    revert: actionable.filter((entry) => entry.versioned).map((entry) => entry.path),
  }), [actionable])
  const toolbar = svnToolbarEl({
    filter,
    count: shown.length,
    countAll: actionable.length,
    paths: bulkPaths,
    handlers: Object.assign({}, handlers, {
      toggleUnversioned: () => applyFilter({ ...filter, unversioned: !filter.unversioned }),
      toggleIgnored: () => applyFilter({ ...filter, ignored: !filter.ignored }),
      onNameFilter: (name) => applyFilter({ ...filter, name }),
      onExportCsv: () => onExport('csv'),
      onExportHtml: () => onExport('html'),
      add: onAdd,
      revert: onRevert,
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
              ? '远端有 ' + remote.outdated.length + ' 个更新（against r' + (remote.againstRev ?? '?') + '），其中本地已改 ' + remote.outdated.filter((item) => item.path && versionedPathSet.has(item.path)).length + ' 个；更新前请先提交或还原'
              : '远端无更新（against r' + (remote.againstRev ?? '?') + '）')),
        React.createElement('button', { className: 'edrv-svn-act', title: '关闭提示条', onClick: () => setRemote(null) }, '✕'))

  // W2-5：改名配对候选超上限提示（评估范围 = FILE_SIZES_CAP，missing 优先）
  const pairCapEl = pairCapHint
    ? React.createElement('div', { className: 'edrv-svn-hintbar' },
        '改名配对候选超过 ' + FILE_SIZES_CAP + ' 个，仅评估前 ' + FILE_SIZES_CAP + ' 个（缺失文件优先）')
    : null

  // P5：行右键菜单（分区管理；ContextMenu 经 portal 挂 body，Esc/外点自动关闭）
  const menuEl = menu
    ? React.createElement(ContextMenu, {
        key: 'edrv-svn-row-menu',
        x: menu.x,
        y: menu.y,
        entries: rowMenuEntriesOf(menu.entry),
        onClose: closeMenu,
      })
    : null

  // AI 智能整理弹窗（预览 + 进度双阶段；analysis 元信息随 aiPlan 透传；source 标注通道来源）
  const aiPlanEl = aiPlan
    ? React.createElement(SvnAiPlanDialog, {
        key: 'edrv-svn-ai-plan',
        plan: aiPlan.plan,
        meta: {
          entriesCount: aiPlan.entriesCount,
          diffIncluded: aiPlan.diffIncluded,
          dropped: aiPlan.dropped,
          model: aiPlan.model,
          source: aiPlan.source,
        },
        run: aiRun,
        onExecute: onAiExecute,
        onPause: aiPause,
        onResume: aiResume,
        onCancelRest: aiCancelRest,
        onClose: closeAiPlan,
      })
    : null

  return React.createElement('div', { className: 'edrv-side-panel' },
    React.createElement('div', { className: 'edrv-side-head' },
      React.createElement('span', { className: 'edrv-side-title' }, 'SVN 变更'),
      React.createElement('span', { className: 'edrv-side-root', title: ctx?.svn?.wcRoot || '' }, rootName),
      React.createElement('span', { style: { flex: 1 } }),
      // 图标组（设计定稿：AI 功能迁至独立 dock，头部只留导航/刷新）
      React.createElement('span', { className: 'edrv-svn-head-icons' },
        React.createElement('button', {
          className: 'edrv-side-btn', title: '检查远端更新（svn status -u；约数秒，离线自动降级）',
          onClick: checkRemote,
        }, remoteBusy ? '…' : '⇅'),
        React.createElement('button', {
          className: 'edrv-side-btn', title: '刷新变更',
          onClick: () => { refreshSvnChanges(sessionId, scope); ctx?.refreshRecords?.() },
        }, refreshIconEl()))),
    aiBarEl({
      managed, busy, aiBusy, deepWaiting,
      hasRun: Boolean(aiRun),
      onQuick: runAiPlan,
      onDeep: runDeepPlan,
    }),
    remoteEl,
    pairCapEl,
    ...toolbar,
    React.createElement('div', { className: 'edrv-svn-list' }, svnListBody(listState, handlers)),
    menuEl,
    aiPlanEl)
}
