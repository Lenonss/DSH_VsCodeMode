// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏容器（活动栏常显 + 可隐藏面板区 + 拖拽调宽）。
 * 面板列表来自注册表（活动栏图标/徽标/激活态）；最左侧图标列（活动栏）常显，
 * 右侧详情面板区可拖拽调宽/隐藏：visible=false 时仅保留图标列（宽 = 图标列宽），
 * 点击任一图标重新展开面板（onShow），底部按钮在 ◀ 收起 / ▶ 展开间切换。
 * 拖拽调宽下限 = minWidth prop（通用设置 sidebarMinWidth，默认 300），低于下限直接收起面板区。
 * 作者 ddj 2026-08-26 / 2026-09-04
 */
import React from 'react'
import type { SidebarCtx } from './types.js'

const W_MAX = 560
/** 面板区隐藏时容器的宽度（= 图标列宽，与 editor.css .edrv-rail 对齐）。 */
const RAIL_ONLY_W = 44
/** 隐藏态接缝拖拽条宽度（与 editor.css .edrv-side-resize 对齐）。 */
const SEAM_W = 5
/** 隐藏态拖出面板区的触发阈值（px，拖过即展开并继续实时调宽）。 */
const PULL_OUT_THRESHOLD = 12

/**
 * 侧边栏容器。
 * @param props.registry 面板注册表（list() 提供面板顺序）
 * @param props.ctx 面板共享上下文
 * @param props.activePanel 当前激活面板 id
 * @param props.onActive 激活面板变化回调
 * @param props.visible 面板区是否可见（false = 只显示活动栏）
 * @param props.onShow 重新展开面板区回调（活动栏图标点击/底部按钮）
 * @param props.width 面板区宽度
 * @param props.onWidth 宽度变化回调
 * @param props.onHide 收起面板区回调
 * @param props.minWidth 最小宽度（通用设置 sidebarMinWidth；拖拽低于它触发隐藏）
 */
export function SidebarView(props) {
  const panels = props.registry?.list?.() ?? []
  const ctx = props.ctx
  const activePanel = props.activePanel
  const onActive = props.onActive
  const visible = props.visible !== false
  const onShow = props.onShow
  const width = props.width
  const onWidth = props.onWidth
  const onHide = props.onHide
  const wMin = Math.max(120, Math.min(W_MAX, Math.round(Number(props.minWidth) || 300)))

  const active = panels.find((p) => p.id === activePanel) || panels[0]

  const onPointerDown = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    const onUp = () => cleanup()
    const onMove = (ev) => {
      const raw = startW + (ev.clientX - startX)
      // 低于最小宽度：清理监听并直接收起面板区（不夹住）
      if (raw < wMin) {
        cleanup()
        onHide()
        return
      }
      onWidth(Math.min(W_MAX, raw))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)

  }

  /**
   * 隐藏态接缝拖拽：向右拖过阈值把面板区拉出来（以记忆宽度展开），继续拖动实时调宽。
   * @param e pointerdown 事件
   */
  const onSeamPointerDown = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const baseW = Math.max(wMin, Math.min(W_MAX, Math.round(Number(width) || wMin)))
    let expanded = false
    let expandStartX = 0
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    const onUp = () => cleanup()
    const onMove = (ev) => {
      if (!expanded) {
        if (ev.clientX - startX < PULL_OUT_THRESHOLD) return
        expanded = true
        expandStartX = ev.clientX
        onShow()
        return
      }
      onWidth(Math.max(wMin, Math.min(W_MAX, baseW + (ev.clientX - expandStartX))))
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
          className: 'edrv-rail-btn' + (visible && active && p.id === active.id ? ' edrv-rail-on' : ''),
          title: p.title,
          onClick: () => {
            onActive(p.id)
            // 面板区隐藏时点击图标 = 展开到该面板（VSCode 活动栏行为）
            if (!visible && typeof onShow === 'function') onShow()
          },
        },
          React.createElement('span', { className: 'edrv-rail-icon' }, p.icon),
          count > 0
            ? React.createElement('span', { className: 'edrv-rail-badge' }, String(count))
            : null)
      })),
    React.createElement('button', {
      className: 'edrv-rail-btn',
      title: (visible ? '隐藏面板区' : '展开面板区') + ' (Ctrl+B)',
      onClick: () => (visible ? onHide() : onShow?.()),
    }, visible ? '◀' : '▶'))

  return React.createElement('div', {
    className: 'edrv-sidebar' + (visible ? '' : ' edrv-sidebar-rail-only'),
    style: { width: visible ? width : RAIL_ONLY_W + SEAM_W },
  },
    rail,
    visible
      ? React.createElement('div', { className: 'edrv-side-body' },
          active ? active.render(ctx) : null)
      : null,
    visible
      ? React.createElement('div', { className: 'edrv-side-resize', onPointerDown: onPointerDown })
      // 隐藏态接缝：悬浮显示拖拽光标与高亮，向右拖把面板区拉出来
      : React.createElement('div', { className: 'edrv-side-resize', title: '拖拽展开面板区', onPointerDown: onSeamPointerDown }))
}
