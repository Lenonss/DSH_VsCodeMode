// @ts-nocheck
/**
 * dsh-vscode-mode client — SVN 目录对比对话框（W2-2，任意两修订的变更列表）。
 *
 * 形态对齐日志弹窗的 Show Range 输入 + 变更面板列表：修订区间输入 → `svn.diffSum`
 * （summarize）→ 动作字母 + 相对路径列表。纯展示不做逐文件动作（与 TortoiseSVN
 * 「Compare revisions」列表一致；文件级差异走既有日志弹窗比较入口）。
 * 作者 ddj 2026年09月20号
 */
import React from 'react'
import { SVN_SUM_LETTER } from '../../shared/svn.js'
import { ModalShell } from './ModalShell.js'
import { svnDiffSum } from '../svnStatus.js'

/**
 * 目录对比对话框。
 * @author ddj 2026年09月20号
 * @param props.sessionId 会话 id
 * @param props.path 默认对比目标（工作区相对路径；'' = 工作副本根）
 * @param props.onNote 轻量反馈（缺省静默）
 * @param props.onClose 关闭回调
 * @returns 弹窗元素
 */
export function SvnSumDialog(props) {
  const { sessionId, path, onNote, onClose } = props
  const [revA, setRevA] = React.useState('')
  const [revB, setRevB] = React.useState('')
  const [entries, setEntries] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')

  /** 拉取区间 summarize（revA 必须小于 revB：svn 语义 -r 较早:较晚）。 */
  const submit = () => {
    const a = Number(revA)
    const b = Number(revB)
    if (!(a >= 1 && b >= 1)) { setError('请输入有效修订号'); return }
    if (a >= b) { setError('起始修订应小于结束修订（svn 语义 -r 较早:较晚）'); return }
    setBusy(true)
    setError('')
    void svnDiffSum(sessionId, a, b, path).then((outcome) => {
      if (!outcome.ok) setError(outcome.message)
      else setEntries(outcome.entries ?? [])
      if (!outcome.ok) onNote?.(outcome.message)
    }).finally(() => setBusy(false))
  }

  const listBody = () => {
    if (entries === null) return React.createElement('div', { className: 'edrv-tree-loading' }, '输入修订区间后点「对比」')
    if (!entries.length) return React.createElement('div', { className: 'edrv-tree-loading' }, '该区间无变更')
    return entries.map((entry) => React.createElement('div', { key: entry.path, className: 'edrv-svn-row', title: entry.path },
      React.createElement('span', { className: 'edrv-svn-ch' }, SVN_SUM_LETTER[entry.item] || ' '),
      React.createElement('span', { className: 'edrv-svn-path' }, entry.path),
      (entry.kind === 'dir' ? React.createElement('span', { className: 'edrv-svnlog-path-kind' }, '目录') : null)))
  }

  return React.createElement(ModalShell, {
    key: 'edrv-svn-sum',
    dialogClass: 'edrv-svn-sum-dialog',
    width: 'min(680px, calc(100vw - 48px))',
    onClose,
  },
    React.createElement('div', { className: 'edrv-svn-patch-head' },
      React.createElement('h3', { className: 'edrv-svnlog-title' }, 'SVN 目录对比（两修订）'),
      React.createElement('span', { className: 'edrv-svnlog-target', title: path || '（工作副本根）' }, path || '（工作副本根）'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', { className: 'edrv-svn-act', title: '关闭', onClick: onClose }, '✕')),
    React.createElement('div', { className: 'edrv-svn-sum-form' },
      React.createElement('label', { className: 'edrv-svnlog-check' }, '起始修订（较早）',
        React.createElement('input', { className: 'edrv-svnlog-range-input', type: 'number', min: 1, value: revA, onChange: (event) => setRevA(event.target.value) })),
      React.createElement('label', { className: 'edrv-svnlog-check' }, '结束修订（较晚）',
        React.createElement('input', { className: 'edrv-svnlog-range-input', type: 'number', min: 1, value: revB, onChange: (event) => setRevB(event.target.value) })),
      React.createElement('button', { className: 'edrv-svn-act', disabled: busy, onClick: submit }, busy ? '对比中…' : '对比')),
    (error ? React.createElement('div', { className: 'edrv-svn-patch-warn' }, error) : null),
    React.createElement('div', { className: 'edrv-svn-sum-list' }, listBody()),
    React.createElement('div', { className: 'edrv-svn-patch-foot' },
      React.createElement('span', { className: 'edrv-svn-count' }, entries === null ? '' : String(entries.length) + ' 项变更')))
}
