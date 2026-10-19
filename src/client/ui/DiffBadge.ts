// @ts-nocheck
/**
 * dsh-vscode-mode client — DiffBadge：header 差异角标（仅工作区有差异时显示）。
 * 轮询已收敛到 state/recordsFeed.ts 的会话级共享订阅，本组件不再自建定时器。
 * 作者 ddj 2026-08-20
 */
import React from 'react'
import { appUrl } from '../../shared/appUrl.js'
import { openEditorView, emitShowLauncher } from '../events.js'
import { summarize } from '../state/records.js'
import { subscribeRecords } from '../state/recordsFeed.js'

/**
 * 会话 header 差异角标：订阅会话差异记录，有差异时显示数字徽章，点击打开编辑区并拉起 DiffLauncher。
 */
export function DiffBadge(props) {
  const sessionId = props?.sessionId
  const [summary, setSummary] = React.useState(null)

  React.useEffect(() => {
    if (!sessionId) {
      setSummary(null)
      return undefined
    }

    return subscribeRecords(sessionId, (records) => {
      setSummary(summarize(records))
    })
  }, [sessionId])

  const n = summary?.totalFiles ?? 0
  if (!n) return null

  const click = () => {
    // 侧栏形态：带首个待处理文件路径（内容打开自动展开面板）；旧形态行为不变
    openEditorView(summary?.pendingFiles?.[0]?.path ?? null)
    setTimeout(() => { emitShowLauncher() }, 120)
  }

  return React.createElement('button', {
    onClick: click,
    title: n + ' 个文件有差异，点击在编辑区查看',
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, padding: 0, background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer' },
  },
    React.createElement('img', { src: appUrl('/edrv/assets/compare-select.png'), alt: '差异', style: { width: 22, height: 22, display: 'block' } }),
    React.createElement('span', { style: { position: 'absolute', top: 1, right: 0, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 8, background: 'var(--dsw-alias-state-warn-primary,#d97706)', color: '#fff', fontSize: 10, lineHeight: '15px', textAlign: 'center', fontWeight: 700, boxSizing: 'border-box' } }, String(n)))
}
