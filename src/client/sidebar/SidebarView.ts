// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏容器（活动栏常显 + 可隐藏面板区 + 拖拽调宽）。
 * 面板列表来自注册表（活动栏图标/徽标/激活态）；最左侧图标列（活动栏）常显，
 * 右侧详情面板区可拖拽调宽/隐藏：visible=false 时仅保留图标列（宽 = 图标列宽），
 * 点击任一图标重新展开面板（onShow），底部按钮在 ◀ 收起 / ▶ 展开间切换。
 * 拖拽调宽下限 = minWidth prop（通用设置 sidebarMinWidth，默认 300），低于下限直接收起面板区。
 * 面板可按 visible(ctx) 声明可用性（如「SVN 变更」仅在受 SVN 管理时出现，非 SVN 工作区零变化）。
 * 作者 ddj 2026-08-26 / 2026-09-04 / 2026-09-16
 */
import React from 'react'
import type { SidebarCtx } from './types.js'
import { inspectPanel, PanelBoundary, PanelContent } from './PanelBoundary.js'

const W_MAX = 560
/** 面板区隐藏时容器的宽度（= 图标列宽，与 editor.css .edrv-rail 对齐）。 */
const RAIL_ONLY_W = 44
/** 隐藏态接缝拖拽条宽度（与 editor.css .edrv-side-resize 对齐）。 */
const SEAM_W = 5
/** 隐藏态拖出面板区的触发阈值（px，拖过即展开并继续实时调宽）。 */
const PULL_OUT_THRESHOLD = 12

/**
 * 活动栏图标内容：面板可给官方图标组件（跟随官方主题），也可给文本/emoji（回落）。
 * @author ddj 2026年09月10号
 * @param icon 面板定义的 icon 字段（组件或文本）
 * @returns 图标元素或文本；组件渲染异常返回 null
 */
function railIconEl(icon) {
  if (typeof icon !== 'function') return icon
  try {
    return React.createElement(icon, { size: 16 })
  } catch (error) {
    return null
  }
}

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
  const ctx = props.ctx
  // 按 visible(ctx) 过滤活动栏图标与面板（能力相关面板：SVN 变更仅在受 SVN 管理时出现）
  const checked = (props.registry?.list?.() ?? []).map((panel) => inspectPanel(panel, ctx)).filter(Boolean)
  const panels = checked.map((entry) => entry.panel)
  const activePanel = props.activePanel
  const onActive = props.onActive
  const visible = props.visible !== false
  const onShow = props.onShow
  const width = props.width
  const onWidth = props.onWidth
  const onHide = props.onHide
  const wMin = Math.max(120, Math.min(W_MAX, Math.round(Number(props.minWidth) || 300)))

  const active = panels.find((p) => p.id === activePanel) || panels[0]

  const dragCleanup = React.useRef(null)
  /** @private @author ddj 2026年10月22号 @description End the active drag; safe on repeated teardown. */
  function stopDrag() { dragCleanup.current?.() }
  const seamOpening = React.useRef(false)
  const lastVisible = React.useRef(visible)
  /** @private @author ddj 2026年10月22号 @description Always release listeners on unmount, including a pending seam expansion. */
  function dragEffect() { return stopDrag }
  React.useEffect(dragEffect, [])
  /** @private @author ddj 2026年10月22号 @description Preserve only the seam's own expansion; external visibility changes cancel ownership. */
  function visibilityEffect() {
    if (lastVisible.current !== visible) {
      if (!(visible && seamOpening.current)) stopDrag()
      seamOpening.current = false
      lastVisible.current = visible
    }
  }
  React.useEffect(visibilityEffect, [visible])

  /** @private @author ddj 2026年10月22号 @param pointerId Owning pointer. @param move Pointer movement callback. @description Replace the previous drag and own every exit path. */
  function bindDrag(pointerId, move) {
    stopDrag()
    /** @author ddj 2026年10月22号 @param event Pointer event. @description Ignore another pointer's movement. */
    function onMove(event) { if (event.pointerId === pointerId) move(event) }
    /** @author ddj 2026年10月22号 @param event Pointer completion. @description Only the owning pointer ends the drag. */
    function onEnd(event) { if (event.pointerId === pointerId) cleanup() }
    /** @author ddj 2026年10月22号 @description Remove all drag listeners and release ownership. */
    function cleanup() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      window.removeEventListener('blur', cleanup)
      if (dragCleanup.current === cleanup) {
        dragCleanup.current = null
        seamOpening.current = false
      }
    }
    dragCleanup.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    window.addEventListener('blur', cleanup)
  }

  /** @private @author ddj 2026年10月22号 @param e Starting pointer. @description Resize the visible panel until completion or collapse. */
  const onPointerDown = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    /** @author ddj 2026年10月22号 @param ev Owning pointer movement. @description Apply this drag's width calculation. */
    const onMove = (ev) => {
      const raw = startW + (ev.clientX - startX)
      // 低于最小宽度：清理监听并直接收起面板区（不夹住）
      if (raw < wMin) {
        stopDrag()
        onHide()
        return
      }
      onWidth(Math.min(W_MAX, raw))
    }
    bindDrag(e.pointerId, onMove)

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
    /** @author ddj 2026年10月22号 @param ev Owning pointer movement. @description Apply this drag's width calculation. */
    const onMove = (ev) => {
      if (!expanded) {
        if (ev.clientX - startX < PULL_OUT_THRESHOLD) return
        expanded = true
        expandStartX = ev.clientX
        seamOpening.current = true
        onShow()
        return
      }
      onWidth(Math.max(wMin, Math.min(W_MAX, baseW + (ev.clientX - expandStartX))))
    }
    bindDrag(e.pointerId, onMove)
  }

  const rail = React.createElement('div', { className: 'edrv-rail' },
    React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 } },
      panels.map((p) => {
        const count = checked.find((entry) => entry.panel === p)?.badge
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
          React.createElement('span', { className: 'edrv-rail-icon' },
            React.createElement(PanelBoundary, { panel: p, scope: ctx?.scope, sessionId: ctx?.sessionId, compact: true }, railIconEl(p.icon))),
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
    // maxWidth 兜底：持久化宽度超过容器可用空间时也不允许布局宽溢出（配合 flex-shrink:1 收缩）
    style: { width: visible ? width : RAIL_ONLY_W + SEAM_W, maxWidth: '100%' },
  },
    rail,
    visible
      ? React.createElement('div', { className: 'edrv-side-body' },
          active ? React.createElement(PanelBoundary, { panel: active, scope: ctx?.scope, sessionId: ctx?.sessionId },
            React.createElement(PanelContent, { panel: active, ctx })) : null)
      : null,
    visible
      ? React.createElement('div', { className: 'edrv-side-resize', onPointerDown: onPointerDown })
      // 隐藏态接缝：悬浮显示拖拽光标与高亮，向右拖把面板区拉出来
      : React.createElement('div', { className: 'edrv-side-resize', title: '拖拽展开面板区', onPointerDown: onSeamPointerDown }))
}
