// @ts-nocheck
/**
 * dsh-vscode-mode client — 通用弹窗外壳（居中卡片 + 遮罩 + Esc/遮罩关闭）。
 *
 * 为什么抽：仓库里已有三处「自建遮罩 + createPortal + Esc 监听」的近似实现
 * （代码片段选择器、工作区选择、以及 P3 日志与 P4 提交弹窗要新增的两处）。
 * 除样板重复外，还有三条硬约定必须处处遵守，靠各写一遍必然漏：
 * - 浮层经 createPortal 挂 body，根节点必须带 `data-edrv-view`（editor.css 的浮层样式
 *   全部以 `[data-edrv-view]` 作用域限定；见 tests/overlayScope.test.ts）
 * - 卡片复用 `.vsm-mcp-dialog`（与「添加 MCP」同一视觉语言）
 * - z-index 必须落在既有阶梯内（见 tests/overlayZOrder.test.ts）：命令栏 200 >
 *   片段二级 197 > 片段一级 195 > 命令栏遮罩 190。本外壳默认 190（不遮挡命令栏），
 *   需要更高的调用方显式传 zIndex。
 *
 * 作者 ddj 2026年09月16号
 */
import React from 'react'
import { createPortal } from 'react-dom'

/** 弹窗外壳 props。 */
export interface ModalShellProps {
  /** 卡片自定义类名（附加在 vsm-mcp-dialog 之后）。 */
  dialogClass?: string
  /** 遮罩类名（默认 edrv-modal-mask）。 */
  maskClass?: string
  /** 卡片宽度 CSS（默认 min(560px, calc(100vw - 40px))）。 */
  width?: string
  /** 卡片附加样式（P0-14：可调尺寸弹窗传入受控 height；与 width 合并，缺省不影响既有弹窗）。 */
  cardStyle?: Record<string, string>
  /** 遮罩 z-index（默认 190，落在既有阶梯内）。 */
  zIndex?: number
  /** 点击遮罩是否关闭（默认 true）。 */
  closeOnMask?: boolean
  /** Esc 是否关闭（默认 true）。 */
  closeOnEsc?: boolean
  /** 关闭回调。 */
  onClose?: () => void
  /** 卡片内容。 */
  children?: unknown
}

/**
 * 通用弹窗外壳（居中 + 遮罩 + Esc/遮罩关闭 + portal 到 body）。
 * @author ddj 2026年09月16号
 * @param props 外壳配置
 * @returns portal 元素
 */
export function ModalShell(props: ModalShellProps) {
  const {
    dialogClass, maskClass, width, cardStyle, zIndex = 190, closeOnMask = true, closeOnEsc = true, onClose, children,
  } = props || {}

  React.useEffect(() => {
    if (!closeOnEsc) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      // 阻止冒泡：避免编辑器/对话输入框同时响应 Esc
      event.stopPropagation()
      onClose?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeOnEsc, onClose])

  const mask = React.createElement('div', {
    className: maskClass || 'edrv-modal-mask',
    style: zIndex ? { zIndex } : undefined,
    onClick: () => { if (closeOnMask) onClose?.() },
  },
    React.createElement('div', {
      className: 'vsm-mcp-dialog' + (dialogClass ? ' ' + dialogClass : ''),
      style: width || cardStyle ? Object.assign({}, width ? { width } : null, cardStyle || null) : undefined,
      // 卡片内点击不冒泡到遮罩（否则点内容就关闭）
      onClick: (event) => event.stopPropagation(),
    }, children))

  // 根节点带 data-edrv-view：editor.css 的浮层样式均以此为作用域前缀
  return createPortal(React.createElement('div', { 'data-edrv-view': '1' }, mask), document.body)
}
