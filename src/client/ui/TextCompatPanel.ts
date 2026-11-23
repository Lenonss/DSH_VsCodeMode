/**
 * dsh-vscode-mode client — 非 UTF-8 文件兼容面板：诊断、只读打开、按推荐方式修复、撤销。
 * 只读打开把「看得见」和「不许写回」分开：浏览交给只读查看器，写盘只走明确的修复动作。
 * 作者 ddj 2026-11-21
 */
import React from 'react'
import type { TextCompatState } from '../textCompat.js'
import { canRepairOf, refusalOfSel, summaryOf } from '../textCompat.js'

/** 面板属性。 */
export interface TextCompatPanelProps {
  state: TextCompatState
  onOpen: () => void
  onRepair: () => void
  onUndo: () => void
  onReload: () => void
  onCancel: () => void
}

/**
 * 兼容面板：先给诊断与选项，写盘只在用户点「修复」后发生。
 * @public @author ddj 2026年11月21号
 * @param props 状态与回调
 * @returns 面板元素
 */
export function TextCompatPanel(props: TextCompatPanelProps) {
  const { state } = props
  const repairable = canRepairOf(state.verdict)
  const parts = [
    headingOf(),
    summaryLine(state),
    state.verdict.kind === 'mixed' ? sampleList(state) : null,
    repairable ? null : noteLine(refusalOfSel(state.verdict), 'var(--dsw-alias-fg-secondary, #6b7280)'),
    state.error ? noteLine(state.error, '#dc2626') : null,
    state.backup ? repairedRow(props) : actionRow(props, repairable),
  ]

  return React.createElement('div', { className: 'edrv-compat-panel' },
    React.createElement('div', { className: 'edrv-compat-panel-inner' }, ...parts.filter((part) => part !== null)))
}

/** @private @author ddj 2026年11月21号 @returns 标题行 */
function headingOf() {
  return React.createElement('div', { style: { fontSize: 15, fontWeight: 600 } }, '这个文件不是 UTF-8 文本')
}

/** @private @author ddj 2026年11月21号 @param state 面板状态 @returns 诊断行 */
function summaryLine(state: TextCompatState) {
  return React.createElement('div', { style: { color: 'var(--dsw-alias-fg-secondary, #6b7280)' } }, summaryOf(state.verdict))
}

/** @private @author ddj 2026年11月21号 @param state 面板状态 @returns 坏字节清单（最多 8 处） */
function sampleList(state: TextCompatState) {
  const rows = state.verdict.samples.slice(0, 8).map((run) =>
    React.createElement('li', { key: run.offset, style: { marginBottom: 2 } },
      '第 ' + run.line + ' 行 · ' + run.bytes + ' · ' + run.context))
  return React.createElement('ul', { style: { margin: '2px 0 0', paddingLeft: 18, color: 'var(--dsw-alias-fg-secondary, #6b7280)' } }, ...rows)
}

/** @private @author ddj 2026年11月21号 @param text 文案 @param color 颜色 @returns 说明行 */
function noteLine(text: string, color: string) {
  return React.createElement('div', { style: { color } }, text)
}

/** @private @author ddj 2026年11月21号 @param props 面板属性 @param repairable 是否可修复 @returns 选项按钮行 */
function actionRow(props: TextCompatPanelProps, repairable: boolean) {
  const { state } = props
  const buttons: React.ReactNode[] = [buttonOf('只读打开（不写盘）', props.onOpen, state.busy, 'edrv-pill edrv-pill-ghost')]
  if (repairable) buttons.unshift(buttonOf('按推荐方式修复：转成 UTF-8', props.onRepair, state.busy, 'edrv-pill'))
  buttons.push(buttonOf('重新读取', props.onReload, state.busy, 'edrv-pill edrv-pill-ghost'))
  buttons.push(buttonOf('暂不处理', props.onCancel, state.busy, 'edrv-pill edrv-pill-ghost'))

  return React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 } }, ...buttons)
}

/** @private @author ddj 2026年11月21号 @param label 文案 @param onClick 回调 @param disabled 是否禁用 @param className 类名 @returns 按钮 */
function buttonOf(label: string, onClick: () => void, disabled: boolean, className: string) {
  return React.createElement('button', { key: label, className, disabled, onClick, style: { cursor: disabled ? 'default' : 'pointer' } }, label)
}

/** @private @author ddj 2026年11月21号 @param props 面板属性 @returns 已修复行（含撤销与备份路径） */
function repairedRow(props: TextCompatPanelProps) {
  const { state } = props
  return React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
    React.createElement('span', { style: { color: 'var(--dsw-alias-state-success, #0a7)' } }, '已转为 UTF-8 · 备份 ' + String(state.backup)),
    buttonOf('撤销修复', props.onUndo, state.busy, 'edrv-pill edrv-pill-undo'),
    buttonOf('打开文件', props.onReload, state.busy, 'edrv-pill edrv-pill-ghost'))
}
