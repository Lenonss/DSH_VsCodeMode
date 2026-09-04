// @ts-nocheck
/**
 * dsh-vscode-mode client — SideEditorTab：betterSidebar「文件编辑」Tab 的组件包装。
 * 把 TabComponentProps（scope/tab/visible）映射为 EditorView 侧栏形态 props，
 * 并按会话 key 保证切会话状态干净重建；创建种子的初始打开在挂载后投递一次。
 * 作者 ddj 2026年08月25号
 */
import React from 'react'
import { EditorView } from './EditorView.js'
import { resolveInitialOpen, setSideEditorMounted, takePendingSideOpen } from '../sidebarBridge.js'

/**
 * 侧边栏 Tab 组件（TabDescriptor.component 装配）。
 * @param props TabComponentProps（scope.sessionId、tab.path/meta 等）
 * @returns EditorView 侧栏形态
 */
export function SideEditorTab(props) {
  const sessionId = props?.scope?.sessionId
  const initial = React.useMemo(() => resolveInitialOpen(props?.tab), [props?.tab])
  const dispatchedRef = React.useRef(false)

  React.useEffect(() => {
    setSideEditorMounted(true)
    return () => setSideEditorMounted(false)
  }, [])

  React.useEffect(() => {
    if (dispatchedRef.current) return
    dispatchedRef.current = true
    // 待消费打开（挂载前暂存的聚焦请求）优先于创建种子；两者都走同事件，EditorView 幂等处理
    const pending = takePendingSideOpen(sessionId)
    const request = pending ?? initial
    window.dispatchEvent(new CustomEvent('edrv:open-editor', {
      detail: { path: request?.path ?? null, focusDiff: request?.focusDiff === true },
    }))
  }, [initial.path, initial.focusDiff, sessionId])

  return React.createElement(EditorView, {
    key: sessionId,
    sessionId,
    layout: 'side',
    schedule: props?.schedule,
    addToConversation: props?.addToConversation,
    sidebarPanels: props?.sidebarPanels,
    outlineSources: props?.outlineSources,
    fileMenuItems: props?.fileMenuItems,
    sessions: props?.sessions,
  })
}
