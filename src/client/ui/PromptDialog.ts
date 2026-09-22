// @ts-nocheck
/**
 * dsh-vscode-mode client — 名称输入弹窗（新建文件/新建文件夹/重命名共用）。
 * 复用 ModalShell（.vsm-mcp-dialog 视觉 + data-edrv-view 作用域 + Esc/遮罩关闭）；
 * 确认返回输入文本（首尾空白已去），取消/Esc/遮罩/空输入返回 null。
 * 重命名时默认选中主名（不含扩展名），与 VS Code 行为一致。
 * 作者 ddj 2026年09月22号
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ModalShell } from './ModalShell.js'

/** 输入弹窗卡片（ModalShell 内容）。 */
function PromptCard({ title, initial, done }) {
  const inputRef = React.useRef(null)
  React.useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    const dot = String(initial).lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : String(initial).length)
  }, [])
  const submit = () => done(String(inputRef.current?.value ?? '').trim())
  return React.createElement(React.Fragment, null,
    React.createElement('h3', null, title),
    React.createElement('label', null, '名称',
      React.createElement('input', {
        ref: inputRef,
        defaultValue: initial,
        onKeyDown: (event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          submit()
        },
      })),
    React.createElement('div', { className: 'vsm-mcp-dialog-actions' },
      React.createElement('button', { onClick: () => done(null) }, '取消'),
      React.createElement('button', { className: 'vsm-primary', onClick: submit }, '确定')))
}

/**
 * 弹出名称输入弹窗。
 * @author ddj 2026年09月22号
 * @param title 弹窗标题
 * @param initial 初始名称（重命名预填原名；新建为空串）
 * @returns 用户输入（已去首尾空白）；取消/空输入返回 null
 */
export function promptName(title, initial) {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const done = (value) => {
      root.unmount()
      host.remove()
      resolve(value ? value : null)
    }
    root.render(React.createElement(ModalShell, {
      onClose: () => done(null),
      width: 'min(420px, calc(100vw - 40px))',
    }, React.createElement(PromptCard, { title, initial: String(initial ?? ''), done })))
  })
}
