// @ts-nocheck
/**
 * dsh-vscode-mode client — AI 智能整理弹窗（11-ai-changelist-triage）。
 *
 * 双阶段单弹窗：
 * - 预览（run = null）：按**整理功能**划分三个分组卡（建议分组 changelist / 建议还原 revert /
 *   建议忽略 svn:ignore），每段段级全选 + 逐项勾选确认；默认「分组勾选（可逆无副作用）、
 *   还原/忽略不勾（有副作用）」，未勾选项一律不动。
 * - 执行（run 非空）：弹窗不关闭，切换为进度视图——阶段徽标 + 步骤计数 + 总进度条 +
 *   逐步日志（✓/✗，失败红字）；「暂停」在当前 RPC 返回后的步骤边界生效（svn 子进程不可
 *   安全中断，如实标注「等待当前步骤完成…」），「继续」从断点续跑，「取消剩余」终止未执行
 *   步骤（已执行不回滚）。
 * Esc/遮罩仅在预览阶段生效（= 取消零副作用）；执行阶段防误关。
 * 作者 ddj 2026年09月23号
 */
import React from 'react'
import { ModalShell } from './ModalShell.js'

/**
 * 预览勾选初值：分组默认全勾（changelist 可逆），还原/忽略默认不勾（有副作用）。
 * @author ddj 2026年09月23号
 * @param plan 三段方案
 * @returns 勾选态（组级 + 逐项）
 */
function initPlanSel(plan) {
  return {
    groups: (plan.groups || []).map((group) => ({
      name: group.name,
      reason: group.reason || '',
      checked: true,
      paths: (group.paths || []).map((path) => ({ path, checked: true })),
    })),
    reverts: (plan.reverts || []).map((item) => ({ path: item.path, reason: item.reason || '', checked: false })),
    ignores: (plan.ignores || []).map((item) => ({ path: item.path, reason: item.reason || '', checked: false })),
  }
}

/**
 * 勾选态 → 执行载荷（空段/空组剔除；保持勾选顺序）。
 * @author ddj 2026年09月23号
 * @param sel 勾选态
 * @returns 执行载荷 { groups, reverts, ignores }
 */
function selectedOf(sel) {
  const groups = []
  for (const group of sel.groups) {
    const paths = group.paths.filter((p) => p.checked).map((p) => p.path)
    if (group.checked && paths.length) groups.push({ name: group.name, paths })
  }
  return {
    groups,
    reverts: sel.reverts.filter((item) => item.checked).map((item) => item.path),
    ignores: sel.ignores.filter((item) => item.checked).map((item) => item.path),
  }
}

/** 执行载荷 → 已选动作总数（「执行所选」禁用判定）。 */
function selectedCount(selected) {
  let n = selected.reverts.length + selected.ignores.length
  for (const group of selected.groups) n += group.paths.length
  return n
}

/** 复选框元素（原生 input；仓库 UI 原语无 Checkbox，此处沿用补丁对话框的原生控件口径）。 */
function checkBoxEl(checked, onToggle, title) {
  return React.createElement('input', {
    type: 'checkbox',
    checked,
    title,
    onChange: () => onToggle(),
    onClick: (event) => event.stopPropagation(),
  })
}

/** 段头（全选框 + 标题 + 计数 + 副标题）。 */
function sectionHeadEl(title, note, allChecked, onToggleAll, countText) {
  return React.createElement('div', { className: 'edrv-svnplan-sechead' },
    checkBoxEl(allChecked, onToggleAll, '全选/全不选'),
    React.createElement('span', { className: 'edrv-svnplan-sectitle' }, title),
    React.createElement('span', { className: 'edrv-svn-count' }, countText),
    (note ? React.createElement('span', { className: 'edrv-svnplan-note' }, note) : null))
}

/**
 * 阶段一 · 预览确认（按整理功能三分组）。
 * @author ddj 2026年09月23号
 * @param sel 勾选态
 * @param setSel 勾选态更新
 * @param open 组卡展开集合（组名）
 * @param toggleOpen 组卡展开切换
 * @returns 预览主体元素
 */
function previewBodyEl(sel, setSel, open, toggleOpen) {
  /** 通用段更新（reverts/ignores 共用）。 */
  const patchItems = (key, index, checked) => setSel((old) => ({
    ...old,
    [key]: old[key].map((item, i) => (i === index ? { ...item, checked } : item)),
  }))
  const toggleItemsAll = (key, checked) => setSel((old) => ({
    ...old,
    [key]: old[key].map((item) => ({ ...item, checked })),
  }))
  /** 组级/组内更新。 */
  const patchGroup = (index, patch) => setSel((old) => ({
    ...old,
    groups: old.groups.map((group, i) => (i === index ? { ...group, ...patch } : group)),
  }))
  const toggleGroupAll = (index, checked) => setSel((old) => ({
    ...old,
    groups: old.groups.map((group, i) => (i === index
      ? { ...group, checked, paths: group.paths.map((p) => ({ ...p, checked })) }
      : group)),
  }))

  const groupCards = sel.groups.map((group, index) => {
    const done = group.paths.filter((p) => p.checked).length
    const isOpen = open.has(group.name)
    const fileRows = isOpen
      ? group.paths.map((item, pi) => React.createElement('div', { key: item.path, className: 'edrv-svnplan-item' },
          checkBoxEl(item.checked, () => patchGroup(index, {
            paths: group.paths.map((p, j) => (j === pi ? { ...p, checked: !p.checked } : p)),
          }), item.path),
          React.createElement('span', { className: 'edrv-svnplan-path', title: item.path }, item.path)))
      : null
    return React.createElement('div', { key: group.name, className: 'edrv-svnplan-card' },
      React.createElement('div', { className: 'edrv-svnplan-row' },
        checkBoxEl(group.checked, () => toggleGroupAll(index, !group.checked), '全选该组'),
        React.createElement('span', {
          className: 'edrv-svnplan-groupname',
          title: '点击展开/收起成员',
          onClick: () => toggleOpen(group.name),
        }, (isOpen ? '▾ ' : '▸ ') + group.name),
        React.createElement('span', { className: 'edrv-svn-count' }, done + '/' + group.paths.length + ' 项'),
        (group.reason ? React.createElement('span', { className: 'edrv-svnplan-reason', title: group.reason }, group.reason) : null)),
      fileRows)
  })

  const itemRowsOf = (key) => sel[key].map((item, index) => React.createElement('div', { key: item.path, className: 'edrv-svnplan-item' },
    checkBoxEl(item.checked, () => patchItems(key, index, !item.checked), item.path),
    React.createElement('span', { className: 'edrv-svnplan-path', title: item.path }, item.path),
    (item.reason ? React.createElement('span', { className: 'edrv-svnplan-reason', title: item.reason }, item.reason) : null)))

  // 段级全选：取反当前全选态（checkBoxEl 的 onToggle 不回传状态，须闭包捕获）
  const groupsAll = sel.groups.length > 0 && sel.groups.every((g) => g.checked && g.paths.every((p) => p.checked))
  const revertsAll = sel.reverts.length > 0 && sel.reverts.every((i) => i.checked)
  const ignoresAll = sel.ignores.length > 0 && sel.ignores.every((i) => i.checked)

  return React.createElement(React.Fragment, null,
    React.createElement('div', { className: 'edrv-svnplan-sec' },
      sectionHeadEl('建议分组（changelist）', '无副作用、可逆', groupsAll,
        () => setSel((old) => ({
          ...old,
          groups: old.groups.map((group) => ({ ...group, checked: !groupsAll, paths: group.paths.map((p) => ({ ...p, checked: !groupsAll })) })),
        })), sel.groups.length + ' 组'),
      React.createElement('div', { className: 'edrv-svnplan-list' }, groupCards)),
    React.createElement('div', { className: 'edrv-svnplan-sec' },
      sectionHeadEl('建议还原（revert）', '放弃本地改动，默认不勾', revertsAll,
        () => toggleItemsAll('reverts', !revertsAll), sel.reverts.length + ' 项'),
      React.createElement('div', { className: 'edrv-svnplan-list' }, itemRowsOf('reverts'))),
    React.createElement('div', { className: 'edrv-svnplan-sec' },
      sectionHeadEl('建议忽略（svn:ignore）', '将写入 svn:ignore 属性，随提交进仓库，默认不勾', ignoresAll,
        () => toggleItemsAll('ignores', !ignoresAll), sel.ignores.length + ' 项'),
      React.createElement('div', { className: 'edrv-svnplan-list' }, itemRowsOf('ignores'))))
}

/**
 * 阶段二 · 执行进度（阶段徽标 + 计数 + 进度条 + 逐步日志）。
 * @author ddj 2026年09月23号
 * @param run 执行状态
 * @returns 进度主体元素
 */
function progressBodyEl(run) {
  const pct = run.total > 0 ? Math.floor((run.index / run.total) * 100) : 0
  const statusText = run.status === 'pausing' ? '等待当前步骤完成…（暂停在步骤边界生效）'
    : run.status === 'paused' ? '已暂停'
    : run.status === 'cancelling' ? '正在取消剩余步骤…'
    : run.status === 'done' ? (run.cancelled ? '已取消剩余步骤' : '执行完毕')
    : '执行中…'
  const logRows = run.log.map((entry, index) => React.createElement('div', {
    key: index,
    className: 'edrv-svnplan-log' + (entry.ok ? '' : ' edrv-svnplan-log-bad'),
  }, (entry.ok ? '✓ ' : '✗ ') + entry.text))
  return React.createElement(React.Fragment, null,
    React.createElement('div', { className: 'edrv-svnplan-stage' },
      React.createElement('span', { className: 'edrv-svnplan-badge' }, statusText),
      (run.cur ? React.createElement('span', { className: 'edrv-svnplan-badge edrv-svnplan-badge-cur' }, run.cur) : null),
      React.createElement('span', { className: 'edrv-svn-count' }, run.index + '/' + run.total + ' 步')),
    React.createElement('div', { className: 'edrv-svnplan-bar' },
      React.createElement('div', { className: 'edrv-svnplan-bar-in', style: { width: pct + '%' } })),
    React.createElement('div', { className: 'edrv-svnplan-logwrap' }, logRows))
}

/**
 * AI 智能整理弹窗（预览 + 进度双阶段）。
 * @author ddj 2026年09月23号
 * @param props.plan 三段方案（host 已归一）
 * @param props.meta 分析元信息 { entriesCount, diffIncluded, dropped, model, source? }（source='agent' = 混合通道）
 * @param props.run 执行状态；null = 预览阶段（shape 见 SvnPanel runPlanSteps）
 * @param props.onExecute 预览确认（选中载荷 → 启动执行引擎）
 * @param props.onPause 暂停（步骤边界生效）
 * @param props.onResume 继续
 * @param props.onCancelRest 取消剩余
 * @param props.onClose 关闭（预览 = 取消零副作用；执行阶段按钮仅在结束后可用）
 * @returns 弹窗元素
 */
export function SvnAiPlanDialog(props) {
  const { plan, meta, run, onExecute, onPause, onResume, onCancelRest, onClose } = props
  const [sel, setSel] = React.useState(() => initPlanSel(plan))
  const [open, setOpen] = React.useState(() => new Set())
  const selected = selectedOf(sel)
  const count = selectedCount(selected)

  /** 组卡展开切换（纯 UI 态）。 */
  const toggleOpen = (name) => {
    const next = new Set(open)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setOpen(next)
  }

  const running = run !== null && run.status !== 'done'
  const header = React.createElement('div', { className: 'edrv-svnplan-head' },
    React.createElement('h3', { className: 'edrv-svnlog-title' }, 'AI 智能整理 SVN 变更'),
    // 混合通道来源标注（agent 深度分析 vs 快速通道直调）
    (meta?.source === 'agent'
      ? React.createElement('span', { className: 'edrv-svnplan-badge', title: '会话 AI 助手深度分析（codegraph/读文件）产出' }, 'AI 助手深度分析')
      : null),
    (meta?.model ? React.createElement('span', { className: 'edrv-svn-count', title: '分析模型' }, meta.model) : null),
    React.createElement('span', { style: { flex: 1 } }),
    React.createElement('button', {
      className: 'edrv-svn-act',
      title: running ? '执行中不可关闭（可取消剩余）' : '关闭',
      disabled: running,
      onClick: onClose,
    }, '✕'))

  const metaEl = React.createElement('div', { className: 'edrv-svnplan-meta' },
    React.createElement('span', { className: 'edrv-svn-count' }, '分析条目 ' + (meta?.entriesCount ?? 0) + ' 项'),
    ((meta?.dropped ?? 0) > 0 ? React.createElement('span', { className: 'edrv-svn-count' }, '已丢弃 AI 无效建议 ' + meta.dropped + ' 项') : null),
    (meta?.diffIncluded === false
      ? React.createElement('span', { className: 'edrv-svnplan-note' }, '未含 diff 上下文，分析精度有限')
      : null))

  let body = null
  let footer = null
  if (run === null) {
    body = previewBodyEl(sel, setSel, open, toggleOpen)
    footer = React.createElement('div', { className: 'edrv-svnplan-foot' },
      React.createElement('span', { className: 'edrv-svn-count' }, '已选 ' + count + ' 项'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', { className: 'edrv-svn-act', title: '不执行任何动作', onClick: onClose }, '取消'),
      React.createElement('button', {
        className: 'edrv-svn-act edrv-svnplan-primary',
        title: '执行全部勾选项（未勾选不动）',
        disabled: count === 0,
        onClick: () => onExecute(selected),
      }, '执行所选（' + count + ' 项）'))
  } else {
    body = progressBodyEl(run)
    footer = React.createElement('div', { className: 'edrv-svnplan-foot' },
      React.createElement('span', { style: { flex: 1 } }),
      (run.status === 'done'
        ? React.createElement('button', {
            className: 'edrv-svn-act edrv-svnplan-primary',
            title: '关闭弹窗并刷新变更列表',
            onClick: onClose,
          }, '关闭并刷新')
        : React.createElement(React.Fragment, null,
            React.createElement('button', {
              className: 'edrv-svn-act',
              title: run.status === 'running' || run.status === 'pausing'
                ? '暂停（当前步骤完成后生效）'
                : '从断点继续执行',
              disabled: run.status === 'pausing' || run.status === 'cancelling',
              onClick: run.status === 'paused' ? onResume : onPause,
            }, run.status === 'paused' ? '继续' : '暂停'),
            React.createElement('button', {
              className: 'edrv-svn-act edrv-svn-act-danger',
              title: '终止未执行步骤（已执行部分不回滚）',
              disabled: run.status === 'cancelling',
              onClick: onCancelRest,
            }, '取消剩余'))))
  }

  return React.createElement(ModalShell, {
    key: 'edrv-svn-plan',
    dialogClass: 'edrv-svnplan-dialog',
    width: 'min(680px, calc(100vw - 48px))',
    closeOnMask: !running,
    closeOnEsc: !running,
    onClose,
  }, header, metaEl, body, footer)
}
