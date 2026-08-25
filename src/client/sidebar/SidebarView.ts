// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏容器（活动栏 + 面板区 + 拖拽调宽）。
 * 面板列表来自注册表（活动栏图标/徽标/激活态），渲染当前激活面板的 render(ctx)；
 * 右侧手柄拖拽调宽（clamp 180–560），底部按钮收起侧边栏。
 * 作者 ddj 2026-08-26
 */
import React from 'react'
import type { SidebarCtx } from './types.js'

const W_MIN = 180
const W_MAX = 560

/**
 * 侧边栏容器。
 * @param props.registry 面板注册表（list() 提供面板顺序）
 * @param props.ctx 面板共享上下文
 * @param props.activePanel 当前激活面板 id
 * @param props.onActive 激活面板变化回调
 * @param props.width 面板区宽度
 * @param props.onWidth 宽度变化回调
 * @param props.onHide 收起侧边栏回调
 */
export function SidebarView(props) {
  const panels = props.registry?.list?.() ?? []
  const ctx = props.ctx
  const activePanel = props.activePanel
  const onActive = props.onActive
  const width = props.width
  const onWidth = props.onWidth
  const onHide = props.onHide

  const active = panels.find((p) => p.id === activePanel) || panels[0]

  const onPointerDown = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev) => {
      const w = Math.max(W_MIN, Math.min(W_MAX, startW + (ev.clientX - startX)))
      onWidth(w)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const rail = React.createElement('div', { className: 'edrv-rail' },
    React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 } },
      panels.map((p) => {
        const count = typeof p.badge === 'function' ? p.badge(ctx) : null
        return React.createElement('button', {
          key: p.id,
          className: 'edrv-rail-btn' + (active && p.id === active.id ? ' edrv-rail-on' : ''),
          title: p.title,
          onClick: () => onActive(p.id),
        },
          React.createElement('span', { className: 'edrv-rail-icon' }, p.icon),
          count > 0
            ? React.createElement('span', { className: 'edrv-rail-badge' }, String(count))
            : null)
      })),
    React.createElement('button', { className: 'edrv-rail-btn', title: '隐藏侧边栏 (Ctrl+B)', onClick: onHide }, '◀'))

  return React.createElement('div', { className: 'edrv-sidebar', style: { width } },
    rail,
    React.createElement('div', { className: 'edrv-side-body' },
      active ? active.render(ctx) : null),
    React.createElement('div', { className: 'edrv-side-resize', onPointerDown: onPointerDown }))
}
