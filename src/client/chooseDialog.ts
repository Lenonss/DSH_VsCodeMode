// @ts-nocheck
/**
 * dsh-vscode-mode client — 工作区选择弹窗（深链打开规则 1）。
 * 复用与「添加 MCP」一致的 vsm-mcp-modal / vsm-mcp-dialog 模态（页面居中卡片 + 遮罩 + 主题
 * token），React portal 挂 body；Esc / 遮罩点击 / 取消 → null（中止流程不改任何状态）。
 * 作者 ddj 2026-09-07
 */
import React from 'react'
import { createRoot } from 'react-dom/client'

/** 用户选择：使用最近的工作区 / 新建工作区 / null=中止。 */
export type WorkspaceChoice = 'recent' | 'create' | null

/** 弹窗组件属性。 */
interface ChoiceModalProps {
  /** 匹配到的工作区标题。 */
  title: string
  /** 触发打开的文件夹路径。 */
  folder: string
  /** 选择回调（首次调用即卸载）。 */
  done: (choice: WorkspaceChoice) => void
}

/** 选择弹窗（vsm-mcp-modal 遮罩 + vsm-mcp-dialog 卡片，Esc/遮罩点击取消）。 */
function ChoiceModal({ title, folder, done }: ChoiceModalProps) {
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') done(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return React.createElement('div', {
    className: 'vsm-mcp-modal',
    onMouseDown: (event) => {
      if (event.target === event.currentTarget) done(null)
    },
  },
    React.createElement('div', { className: 'vsm-mcp-dialog' },
      React.createElement('h3', null, '在 DSH 中打开'),
      React.createElement('label', null, '文件夹 ' + folder + ' 位于已注册的工作区「' + title + '」内，选择打开方式：'),
      React.createElement('div', { className: 'vsm-mcp-dialog-actions' },
        React.createElement('button', { onClick: () => done(null) }, '取消'),
        React.createElement('button', { onClick: () => done('create') }, '新建工作区'),
        React.createElement('button', { className: 'vsm-primary', onClick: () => done('recent') }, '使用最近的工作区'),
      ),
    ),
  )
}

/**
 * 弹出工作区选择弹窗（深链打开规则 1）。
 * @author ddj 2026年09月07号
 * @param title 匹配到的工作区标题
 * @param folder 文件夹路径
 * @returns 用户选择；null = 取消/中止
 */
export function chooseWorkspace(title: string, folder: string): Promise<WorkspaceChoice> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const done = (choice: WorkspaceChoice) => {
      root.unmount()
      host.remove()
      resolve(choice)
    }
    root.render(React.createElement(ChoiceModal, { title, folder, done }))
  })
}
