// @ts-nocheck
/**
 * dsh-vscode-mode client — DiffBox：每个文件底部紧凑差异条（per-file hunk + ⋮ 二级菜单）。
 * 迁移自原 src/client/index.ts 的 DiffBox，语义不改。
 * 作者 ddj 2026-08-20
 */
import React from 'react'
import { callIdAttr } from '../state/records.js'
import { badgeOf } from './shared.js'

/**
 * 差异条：当前文件内 diff 导航（↑↓←→）、Keep/Undo、展开 hunk 列表、⋮ 二级菜单
 * （Keep All / Undo All / 差异总览 / 归档 / 回滚 / 刷新）+ 其他差异文件小节。
 */
export function DiffBox(props) {
  const {
    pendingRegions, staleRegions, onAct, onAcceptFile, onUndoFile, onAcceptAllFiles, onUndoAllFiles,
    allPendingCount, onRollback, onJump, otherFiles, onOpenOther, onOpenLauncher, onRefresh, activePath,
    diffIdx, diffTotal, fileIdx, fileTotal, onPrevDiff, onNextDiff, onPrevFile, onNextFile,
  } = props
  const [expanded, setExpanded] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const canAct = pendingRegions.length > 0

  const base = String(activePath || '').split(/[\\/]/).pop() || ''

  let bodyEl = null
  if (expanded) {
    const rows = pendingRegions.map((r) => {
      const key = callIdAttr(r.callId, r.idx)
      return React.createElement('div', { key, className: 'edrv-diffrow', 'data-edrv-hunk': key, title: '跳转到 L' + (r.start ?? '?'), onClick: () => onJump(r) },
        React.createElement('span', { className: 'edrv-diffrow-l' }, 'L' + (r.start ?? '?') + '-' + (r.end ?? '?')),
        (r.oldLines.length ? React.createElement('span', { className: 'edrv-diffrow-o' }, '-' + r.oldLines.length) : null),
        (r.newLines.length ? React.createElement('span', { className: 'edrv-diffrow-n' }, '+' + r.newLines.length) : null),
        (r.create ? React.createElement('span', { className: 'edrv-diffrow-tag' }, '新建') : null),
        React.createElement('span', { style: { flex: 1 } }))
    })
    const stale = staleRegions.map((r) => React.createElement('div', { key: 'stale' + callIdAttr(r.callId, r.idx), className: 'edrv-diffrow edrv-diffrow-stale', title: '差异无法定位（文件可能已被手动修改）' },
      React.createElement('span', { className: 'edrv-diffrow-l' }, 'L' + (r.start ?? '?') + ' 无法定位'),
      React.createElement('span', { className: 'edrv-diffrow-tag' }, '冲突/需刷新'),
      React.createElement('span', { className: 'edrv-diffrow-tag' }, badgeOf(r.status))))
    let othersEl = null
    if (otherFiles.length) {
      othersEl = React.createElement('div', { className: 'edrv-diffbox-others' },
        React.createElement('span', { className: 'edrv-diffrow-tag' }, '其他差异文件 (' + otherFiles.length + '):'),
        otherFiles.map((f) => React.createElement('button', { key: f.path, className: 'edrv-diffrow-file', title: f.path, onClick: () => onOpenOther(f.path) },
          String(f.path).split(/[\\/]/).pop() + ' (' + f.pending + ')')))
    }
    bodyEl = React.createElement('div', { className: 'edrv-diffbar-body' }, ...rows, ...stale, othersEl)
  }

  const menu = menuOpen
    ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 44 }, onClick: () => setMenuOpen(false) }),
        React.createElement('div', { className: 'edrv-diffbar-menu' },
          React.createElement('button', { className: 'edrv-diffmenu-item', disabled: !allPendingCount, onClick: () => { onAcceptAllFiles(); setMenuOpen(false) } }, '✓ Keep All（全部文件采纳）'),
          React.createElement('button', { className: 'edrv-diffmenu-item danger', disabled: !allPendingCount, onClick: () => { onUndoAllFiles(); setMenuOpen(false) } }, '↩ Undo All（全部文件不采纳）'),
          React.createElement('div', { className: 'edrv-diffmenu-sep' }),
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onOpenLauncher('pending'); setMenuOpen(false) } }, '🗂 差异总览'),
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onOpenLauncher('archive'); setMenuOpen(false) } }, '📁 归档'),
          React.createElement('div', { className: 'edrv-diffmenu-sep' }),
          React.createElement('button', { className: 'edrv-diffmenu-item', disabled: !canAct, onClick: () => { onRollback(); setMenuOpen(false) } }, '⟲ 回滚文件'),
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onRefresh(); setMenuOpen(false) } }, '⟳ 刷新')))
    : null

  return React.createElement('div', { className: 'edrv-diffbar', 'data-edrv-diffbox': '1' },
    React.createElement('div', { className: 'edrv-diffbar-row' },
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '上一个差异', disabled: !canAct, onClick: onPrevDiff }, '↑'),
      React.createElement('span', { className: 'edrv-diffbar-count', title: '当前文件内差异位置（点击展开/收起差异列表）', onClick: () => setExpanded((v) => !v) }, diffTotal ? (diffIdx + 1) + '/' + diffTotal : '0/0'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '下一个差异', disabled: !canAct, onClick: onNextDiff }, '↓'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '上一个差异文件', disabled: !fileTotal, onClick: onPrevFile }, '←'),
      React.createElement('span', { className: 'edrv-diffbar-count edrv-count-file', title: '差异文件位置' }, fileTotal ? (fileIdx + 1) + '/' + fileTotal + ' 文件' : '0/0 文件'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '下一个差异文件', disabled: !fileTotal, onClick: onNextFile }, '→'),
      React.createElement('span', { className: 'edrv-diffbar-file', title: activePath || '' }, base),
      React.createElement('button', { className: 'edrv-pill edrv-pill-keep', title: '采纳当前文件的全部差异', disabled: !canAct, onClick: onAcceptFile }, '✓ Keep'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-undo', title: '不采纳当前文件的全部差异（回滚）', disabled: !canAct, onClick: onUndoFile }, '↩ Undo'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '更多操作', onClick: () => setMenuOpen((v) => !v) }, '⋮')),
    bodyEl,
    menu)
}
