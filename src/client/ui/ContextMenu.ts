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

/** 单条菜单项（展示层形状；业务侧由 buildTreeMenu / buildTabMenu 映射而来）。 */
export interface ContextMenuEntry {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  /** 前置分隔线。 */
  separator?: boolean
  /** 右侧提示文案（键位弦等；仅在真实绑定时传入，缺省不渲染）。 */
  hint?: string
  onClick?: () => void
}

export interface ContextMenuProps {
  x: number
  y: number
  entries: ContextMenuEntry[]
  onClose: () => void
}

/** 估算宽高（实测前的回退值；条目数变化大时以实测为准，见 useLayoutEffect）。 */
const MENU_W = 224
const MENU_H = 176

/** 渲染行：分隔线或菜单项。 */
export interface MenuRow {
  kind: 'sep' | 'item'
  entry: ContextMenuEntry
}

/**
 * 把条目表展开为渲染行：`separator` 是**前置分隔线**，条目本身仍然渲染。
 *
 * ⚠️ 旧实现把 `separator` 当成「本条是分隔线」而 `continue` 跳过条目本身 ——
 * 因历史调用方都没用过该字段，缺陷一直潜伏；页签菜单首次使用后表现为
 * 「关闭 / 复制路径 / 在文件资源管理器中显示 / 固定」四条主条目整条消失。
 * 首条带 separator 时不渲染分隔线（菜单顶部不应有横线，与参考图一致）。
 * @author ddj 2026年09月11号
 * @param entries 菜单项列表
 * @returns 渲染行列表
 */
export function menuRows(entries: readonly ContextMenuEntry[]): MenuRow[] {
  const rows: MenuRow[] = []
  for (const entry of entries) {
    if (entry.separator && rows.length) rows.push({ kind: 'sep', entry })
    rows.push({ kind: 'item', entry })
  }
  return rows
}

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
  // 实测菜单尺寸：页签菜单有 11 条 + 键位提示，估算常量会偏低导致底部条目越界不可达
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null)

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

  // 首帧后量一次真实尺寸并据此定位：条目数/文案长度变化都不会越出视口下边界
  React.useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    if (!w || !h) return
    setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
  }, [entries])

  const safeX = Number.isFinite(x) ? x : 4
  const safeY = Number.isFinite(y) ? y : 4
  const position = clampMenuPosition(
    safeX,
    safeY,
    window.innerWidth || 800,
    window.innerHeight || 600,
    size?.w ?? MENU_W,
    size?.h ?? MENU_H,
  )

  const children: React.ReactNode[] = []
  for (const row of menuRows(entries)) {
    if (row.kind === 'sep') {
      children.push(React.createElement('div', { key: 'sep-' + row.entry.id, className: 'edrv-ctxmenu-sep' }))
      continue
    }
    const entry = row.entry
    const cls = 'edrv-ctxmenu-item'
      + (entry.danger ? ' edrv-ctxmenu-danger' : '')
      + (entry.disabled ? ' edrv-ctxmenu-disabled' : '')
    children.push(React.createElement('button', {
      key: entry.id,
      className: cls,
      disabled: entry.disabled,
      title: entry.hint ? entry.label + ' (' + entry.hint + ')' : entry.label,
      onClick: () => {
        if (!entry.disabled) {
          entry.onClick?.()
          onClose()
        }
      },
    },
      React.createElement('span', { className: 'edrv-ctxmenu-label' }, entry.label),
      entry.hint ? React.createElement('span', { className: 'edrv-ctxmenu-hint' }, entry.hint) : null))
  }

  const overlay = React.createElement('div', { 'data-edrv-view': '1' },
    React.createElement('div', { className: 'edrv-ctxmenu', ref: menuRef, style: position }, ...children))

  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body)
}
