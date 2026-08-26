/**
 * dsh-vscode-mode client — 通用浮动右键菜单（createElement 风格、类型化）。
 * 非阻塞式关闭：window capture 监听（点击菜单外/右键菜单外/Esc 关闭），
 * 不拦截菜单外事件，允许同一事件内由发起方切换/重开菜单。
 * 条目支持 danger/disabled/separator，复用既有 edrv-ctxmenu* 样式类。
 * 作者 ddj 2026-08-27
 */
import React from 'react'
import { createPortal } from 'react-dom'
import { clampMenuPosition } from './menuPosition.js'

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
  const menuRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return
      onClose()
    }
    const onContextMenu = (e: MouseEvent): void => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) {
        e.preventDefault()
      }
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('contextmenu', onContextMenu, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('contextmenu', onContextMenu, true)
    }
  }, [onClose])

  const safeX = Number.isFinite(x) ? x : 4
  const safeY = Number.isFinite(y) ? y : 4
  const position = clampMenuPosition(
    safeX,
    safeY,
    window.innerWidth || 800,
    window.innerHeight || 600,
    MENU_W,
    MENU_H,
  )

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

  const overlay = React.createElement('div', { 'data-edrv-view': '1' },
    React.createElement('div', { className: 'edrv-ctxmenu', ref: menuRef, style: position }, ...children))

  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)
}
