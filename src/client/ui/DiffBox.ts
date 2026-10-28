// @ts-nocheck
/**
 * dsh-vscode-mode client — DiffBox：差异条入口，按数据源选栏。
 * 官方记录 → OfficialDiffBar；其余（侧车历史捕获）→ SidecarDiffBar，
 * 两套栏同版式，避免用户把侧车栏误判成旧版插件。
 * 作者 ddj 2026-08-20
 */
import React from 'react'
import { diffDockText } from '../diffDock.js'
import { OfficialDiffBar } from './OfficialDiffBar.js'
import { SidecarDiffBar } from './SidecarDiffBar.js'

/**
 * 差异条：当前文件内 diff 导航、Keep/Undo、详情展开与 ⋮ 二级菜单。
 * @public
 * @author ddj 2026年08月25号
 * @param props 差异上下文（官方或侧车），由 EditorView dock 快照提供
 * @returns 会话态精简入口，或按数据源路由到的差异栏
 */
export function DiffBox(props) {
  const { fileTotal = 0, onOpenNextFile, mode = 'editor' } = props

  if (mode === 'chat' || mode === 'editor-empty') {
    return React.createElement('div', { className: 'edrv-diffbar edrv-diffbar-dock', 'data-edrv-diffbox': '1', 'data-edrv-diff-mode': mode },
      React.createElement('div', { className: 'edrv-diffbar-row edrv-diffbar-dock-row' },
        React.createElement('button', {
          type: 'button',
          className: 'edrv-diffbar-dock-button',
          title: '切换到下一个差异文件',
          'aria-label': diffDockText(fileTotal),
          onClick: onOpenNextFile,
        }, diffDockText(fileTotal))))
  }

  if (props.official) return React.createElement(OfficialDiffBar, props)
  return React.createElement(SidecarDiffBar, props)
}
