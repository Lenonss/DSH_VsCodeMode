// @ts-nocheck
/**
 * dsh-vscode-mode client — DiffBarEmpty：无文件打开 / 当前文件无差异但有差异文件时的空态浮窗。
 * 迁移自原 src/client/index.ts 的 DiffBarEmpty，语义不改。
 * 作者 ddj 2026-08-20
 */
import React from 'react'

/**
 * 空态差异条：提示当前状态 + 查看下一个差异文件 + ⋮（总览/归档/刷新）。
 */
export function DiffBarEmpty(props) {
  const { sum, active, staleCount, onNextFile, onOpenLauncher, onRefresh } = props
  const [menuOpen, setMenuOpen] = React.useState(false)
  const n = sum?.totalFiles ?? 0
  const tip = active
    ? (staleCount > 0 ? '当前文件有 ' + staleCount + ' 处差异无法定位（可能已被后续修改影响）' : '当前文件无待处理差异')
    : '未打开文件'

  const menu = menuOpen
    ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 44 }, onClick: () => setMenuOpen(false) }),
        React.createElement('div', { className: 'edrv-diffbar-menu' },
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onOpenLauncher('pending'); setMenuOpen(false) } }, '🗂 差异总览'),
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onOpenLauncher('archive'); setMenuOpen(false) } }, '📁 归档'),
          React.createElement('div', { className: 'edrv-diffmenu-sep' }),
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onRefresh(); setMenuOpen(false) } }, '⟳ 刷新')))
    : null

  return React.createElement('div', { className: 'edrv-diffbar', 'data-edrv-diffbox': '1' },
    React.createElement('div', { className: 'edrv-diffbar-row' },
      React.createElement('span', { className: 'edrv-diffbar-count' }, '⚠ 差异 ' + n + ' 文件'),
      React.createElement('span', { className: 'edrv-diffbar-file' }, tip),
      React.createElement('button', { className: 'edrv-pill edrv-pill-keep', title: '打开并跳转到下一个差异文件', onClick: onNextFile }, '查看下一个差异文件'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '更多操作', onClick: () => setMenuOpen((v) => !v) }, '⋮')),
    menu)
}
