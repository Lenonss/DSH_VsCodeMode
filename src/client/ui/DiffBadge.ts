// @ts-nocheck
/**
 * dsh-vscode-mode client — DiffBadge：header 差异角标（仅工作区有差异时显示）。
 * 迁移自原 src/client/index.ts 的 DiffBadge，语义不改。
 * 作者 ddj 2026-08-20
 */
import React from 'react'
import { rpc } from '../rpc.js'
import { openEditorView, emitShowLauncher } from '../events.js'
import { summarize } from '../state/records.js'

/**
 * 会话 header 差异角标：5s 轮询 edrv.list，有差异时显示数字徽章，点击打开编辑区并拉起 DiffLauncher。
 */
export function DiffBadge(props) {
  const sessionId = props?.sessionId
  const [n, setN] = React.useState(0)
  const seq = React.useRef(0)

  const load = React.useCallback(() => {
    if (!sessionId) return
    const s = ++seq.current
    rpc('edrv.list', { sessionId }).then((res) => {
      if (s !== seq.current || !res || !res.ok || !Array.isArray(res.records)) return
      setN(summarize(res.records).totalFiles)
    }).catch(() => {})
  }, [sessionId])

  React.useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    const onRefresh = () => load()
    window.addEventListener('edrv:refresh', onRefresh)
    return () => { clearInterval(t); window.removeEventListener('edrv:refresh', onRefresh) }
  }, [load])

  if (!n) return null

  const click = () => {
    openEditorView(null)
    setTimeout(() => { emitShowLauncher() }, 120)
  }

  return React.createElement('button', {
    onClick: click,
    title: n + ' 个文件有差异，点击在编辑区查看',
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, padding: 0, background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer' },
  },
    React.createElement('img', { src: '/edrv/assets/compare-select.png', alt: '差异', style: { width: 22, height: 22, display: 'block' } }),
    React.createElement('span', { style: { position: 'absolute', top: 1, right: 0, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 8, background: 'var(--dsw-alias-state-warn-primary,#d97706)', color: '#fff', fontSize: 10, lineHeight: '15px', textAlign: 'center', fontWeight: 700, boxSizing: 'border-box' } }, String(n)))
}
