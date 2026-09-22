// @ts-nocheck
/**
 * dsh-vscode-mode client — 「打开方式…」选择弹窗（资源管理器右键、文件目标专属）。
 * 列出 fileOpeners 注册表中当前可用的打开器（本插件/官方侧栏/系统等），
 * 选中即调用该打开器 open()；复用 ModalShell 视觉，Esc/遮罩/取消 = 不打开。
 * 作者 ddj 2026年09月22号
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { availableOpeners, isAvailable } from './fileOpeners.js'
import { ModalShell } from './ui/ModalShell.js'

/** 打开器列表行样式（列表为一次性选择器，不进 editor.css 的常驻样式表）。 */
const ITEM_STYLE = {
  display: 'flex', flexDirection: 'column', gap: 2, width: '100%', textAlign: 'left',
  padding: '8px 10px', marginBottom: 6, borderRadius: 6, cursor: 'pointer',
}

/** 打开器选择卡片（ModalShell 内容）。 */
function OpenWithCard({ openers, onPick, onCancel }) {
  return React.createElement(React.Fragment, null,
    React.createElement('h3', null, '打开方式…'),
    openers.map((opener) => React.createElement('button', {
      key: opener.id,
      style: ITEM_STYLE,
      title: opener.description || opener.label,
      onClick: () => onPick(opener),
    },
      React.createElement('span', null, opener.label),
      opener.description ? React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, opener.description) : null)),
    React.createElement('div', { className: 'vsm-mcp-dialog-actions' },
      React.createElement('button', { onClick: onCancel }, '取消')))
}

/**
 * 弹出打开器选择弹窗；选中后立即以该打开器打开目标文件。
 * @author ddj 2026年09月22号
 * @param registry 文件打开器注册表
 * @param context 打开上下文（会话/工作区）
 * @param path 目标文件（工作区相对）
 * @param onDone 结果回调（opened = 实际使用的打开器；null = 取消/未打开），反馈文案由调用方接线
 */
export function openWithDialog(registry, context, path, onDone) {
  const openers = availableOpeners(registry)
  if (!openers.length) {
    onDone?.(null)
    return
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const close = () => {
    root.unmount()
    host.remove()
  }
  const pick = (opener) => {
    close()
    if (!isAvailable(opener)) {
      onDone?.(null)
      return
    }
    Promise.resolve(opener.open(path, context)).then(() => onDone?.(opener)).catch(() => onDone?.(null))
  }
  root.render(React.createElement(ModalShell, { onClose: () => { close(); onDone?.(null) } },
    React.createElement(OpenWithCard, { openers, onPick: pick, onCancel: () => { close(); onDone?.(null) } })))
}
