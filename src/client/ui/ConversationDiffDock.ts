// @ts-nocheck
/**
 * dsh-vscode-mode client — 会话级差异 dock。
 * conversation.input.dock 是唯一实例：普通对话显示摘要，文件编辑页显示完整操作条。
 * 作者 ddj 2026-08-26
 */
import React from 'react'
import { rpc } from '../rpc.js'
import { openDiffView } from '../events.js'
import { summarize } from '../state/records.js'
import { nextDiffPath } from '../diffDock.js'
import { readDiffDock, subscribeDiffDock } from '../diffDockStore.js'
import { DiffBox } from './DiffBox.js'

const nextIndexBySession = new Map()

/**
 * 对话输入框上方的唯一差异 dock。
 * @author ddj 2026年08月26号
 * @param props DSH 注入的会话属性
 * @returns 差异 dock React 元素或 null
 */
export function ConversationDiffDock(props) {
  const sessionId = props?.sessionId
  const [summary, setSummary] = React.useState(null)
  const [, setStoreRevision] = React.useState(0)
  const seq = React.useRef(0)

  const load = React.useCallback(() => {
    if (!sessionId) return
    const current = ++seq.current
    rpc('edrv.list', { sessionId }).then((res) => {
      if (current !== seq.current || !res || !res.ok || !Array.isArray(res.records)) return
      setSummary(summarize(res.records))
    }).catch(() => {})
  }, [sessionId])

  React.useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    const onRefresh = () => load()
    window.addEventListener('edrv:refresh', onRefresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('edrv:refresh', onRefresh)
    }
  }, [load])

  React.useEffect(() => {
    if (!sessionId) return undefined
    const sync = () => setStoreRevision((value) => value + 1)
    sync()
    return subscribeDiffDock(sessionId, sync)
  }, [sessionId])

  const renderDock = (content, key) => React.createElement('div', {
    key,
    className: 'edrv-diff-dock-shell',
    'data-edrv-diff-dock-shell': '1',
  }, content)

  const editorSnapshot = readDiffDock(sessionId)
  if (editorSnapshot) {
    if (editorSnapshot.mode === 'editor-empty' && !editorSnapshot.fileTotal) return null
    return renderDock(React.createElement(DiffBox, Object.assign({}, editorSnapshot, { dock: true })), sessionId)
  }

  if (!sessionId || !summary?.pendingFiles?.length) return null

  const paths = summary.pendingFiles.map((file) => file.path)
  const click = () => {
    const current = nextIndexBySession.get(sessionId) ?? 0
    const next = nextDiffPath(paths, current)
    nextIndexBySession.set(sessionId, next.index)
    if (next.path) openDiffView(next.path)
  }

  return renderDock(React.createElement(DiffBox, {
    mode: 'chat',
    dock: true,
    fileTotal: paths.length,
    onOpenNextFile: click,
  }), sessionId || 'chat')
}
