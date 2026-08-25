/**
 * dsh-vscode-mode client — 通用浮动右键菜单（createElement 风格、类型化）。
 * 全屏 backdrop（点击/右键/Esc 关闭）+ 固定定位（viewport clamp 防越界），
 * 条目支持 danger/disabled/separator，复用既有 edrv-ctxmenu* 样式类。
 * 作者 ddj 2026-08-27
 */
import React from 'react'

/** 单条菜单项（展示层形状；业务侧由 buildTreeMenu 映射而来）。 */
export interface ContextMenuEntry {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  /** 前置分隔线。 */
  separator?: boolean
  onClick?: () => void
}

export interface ContextMenuProps {
  x: number
  y: number
  entries: ContextMenuEntry[]
  onClose: () => void
}

/** 菜单估算宽高（clamp 防越出视口，与 EditorView menuPos 常量对齐）。 */
const MENU_W = 224
const MENU_H = 176

/**
 * 浮动右键菜单。
 * @param props.x 视口 x 坐标
 * @param props.y 视口 y 坐标
 * @param props.entries 菜单项列表
 * @param props.onClose 关闭回调（backdrop 点击/右键/Esc/点击项后触发）
 */
export function ContextMenu(props: ContextMenuProps): React.ReactElement {
  const { x, y, entries, onClose } = props

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const left = Math.max(4, Math.min(x, (window.innerWidth || 800) - MENU_W))
  const top = Math.max(4, Math.min(y, (window.innerHeight || 600) - MENU_H))

  const children: React.ReactNode[] = []
  for (const entry of entries) {
    if (entry.separator) {
      children.push(React.createElement('div', { key: 'sep-' + entry.id, className: 'edrv-ctxmenu-sep' }))
      continue
    }
    const cls = 'edrv-ctxmenu-item'
      + (entry.danger ? ' edrv-ctxmenu-danger' : '')
      + (entry.disabled ? ' edrv-ctxmenu-disabled' : '')
    children.push(React.createElement('button', {
      key: entry.id,
      className: cls,
      disabled: entry.disabled,
      onClick: () => {
        if (!entry.disabled) {
          entry.onClick?.()
          onClose()
        }
      },
    }, entry.label))
  }

  return React.createElement(React.Fragment, null,
    React.createElement('div', {
      className: 'edrv-ctxmenu-backdrop',
      style: { position: 'fixed', inset: 0, zIndex: 70 },
      onClick: onClose,
      onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onClose() },
    }),
    React.createElement('div', { className: 'edrv-ctxmenu', style: { left, top } }, ...children))
}
