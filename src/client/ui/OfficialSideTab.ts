// @ts-nocheck
/**
 * dsh-vscode-mode client — OfficialSideTab：DSH 官方右侧 Sidebar「文件编辑」Tab 正文包装。
 * 双用途：页类型 Tab（edrvEditor）经 navigation.params（openPath/focusDiff）打开；
 * file 资源类型 Tab（edrvEditorFile，认领 dsh-resource://file/**）经 navigation.address
 * 解码出真实路径并透传 params.line 行号定位。派发既有 edrv:open-editor 事件复用
 * EditorView 打开流；按会话 key 保证切会话干净重建。
 * Tab 正文切换后重挂载时按最新导航恢复打开（对齐 better-sidebar 形态的种子行为）。
 * 作者 ddj 2026年09月09号
 */
import React from 'react'
import { EditorView } from './EditorView.js'
import { setSideEditorMounted } from '../sidebarBridge.js'
import { parseOfficialFileAddress, resolveNavOpen } from '../officialSidebar.js'

/**
 * 官方侧边栏 Tab 正文组件（keyed slot sidebar.right.pane.tab 装配）。
 * @param props slot 框架注入（useTabInfo/sessionId）+ 装配依赖（schedule 等）
 * @returns EditorView 侧栏形态
 */
export function OfficialSideTab(props) {
  const sessionId = props?.sessionId
  const useTabInfo = props?.useTabInfo
  let navigation
  // useTabInfo 是 slot 框架按组件实例生成的 hook，须在组件顶层无条件调用
  if (typeof useTabInfo === 'function') {
    try {
      navigation = useTabInfo()?.tab?.navigation
    } catch {
      navigation = undefined
    }
  }
  const revision = typeof navigation?.revision === 'number' ? navigation.revision : -1
  const revisionRef = React.useRef(-1)

  React.useEffect(() => {
    setSideEditorMounted(true)
    return () => setSideEditorMounted(false)
  }, [])

  React.useEffect(() => {
    if (revision === revisionRef.current) return
    revisionRef.current = revision
    // revision 0 = 无地址打开（种子/撤销恢复），没有可执行的打开请求
    if (revision <= 0) return
    // file 资源 Tab：地址即文件（解码出真实路径，透传 params.line 行号定位）
    const fileHit = parseOfficialFileAddress(navigation?.address)
    if (fileHit) {
      const line = navigation?.params?.line
      window.dispatchEvent(new CustomEvent('edrv:open-editor', {
        detail: { path: fileHit.path, line: typeof line === 'number' ? line : undefined },
      }))
      return
    }
    // 页类型 Tab：params 携带打开请求
    const request = resolveNavOpen(navigation?.params)
    window.dispatchEvent(new CustomEvent('edrv:open-editor', {
      detail: { path: request.path, focusDiff: request.focusDiff },
    }))
  })

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
