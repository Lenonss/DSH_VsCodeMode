// @ts-nocheck
/**
 * dsh-vscode-mode client — PerfSizeBadge：对话 header 会话体积指示器。
 * 5s 轮询当前会话持久化体积（host 仅 stat，近零成本），≥1MB 显示、超阈值变色，
 * 引导"一次任务一个短会话"：会话过大时建议 /compact 或新开会话。
 * 作者 ddj 2026-09-02
 */
import React from 'react'
import { rpc } from '../rpc.js'

/** 软阈值：≥ 此值琥珀色（默认 2MB）。 */
const SOFT = 2 * 1024 * 1024
/** 硬阈值：≥ 此值红色（默认 8MB）。 */
const HARD = 8 * 1024 * 1024
/** 显示下限：≥ 1MB 才显示（太小无提示价值）。 */
const SHOW_MIN = 1024 * 1024

/**
 * 会话 header 体积徽章（挂 conversation.session.header.utilities）。
 * @author ddj 2026年09月02号
 * @param props { sessionId, sessions }（sessions 供 cwd 解析）
 */
export function PerfSizeBadge(props) {
  const sessionId = props?.sessionId
  const sessions = props?.sessions
  const [size, setSize] = React.useState(null)
  const seq = React.useRef(0)

  const load = React.useCallback(() => {
    if (!sessionId) return
    const cwd = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd
    if (!cwd) return
    const s = ++seq.current
    rpc('edrv.perf.sessionSize', { sessionId, cwd }).then((res) => {
      if (s !== seq.current || !res || !res.ok) return
      setSize(res.exists ? res.bytes : 0)
    }).catch(() => {})
  }, [sessionId, sessions])

  React.useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => { clearInterval(t) }
  }, [load])

  if (!size || size < SHOW_MIN) return null
  const label = size >= 1024 * 1024 ? (size / (1024 * 1024)).toFixed(1) + 'MB' : Math.round(size / 1024) + 'KB'
  const color = size >= HARD ? '#dc2626' : size >= SOFT ? '#d97706' : 'var(--dsw-text-3,#6b7280)'
  const tip = '当前会话已持久化 ' + label + '（启动回放约放大 10×，占内存）。过大建议 /compact 或新开会话。'
  return React.createElement('span', {
    style: { display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 8px', fontSize: 11, color, borderRadius: 6, cursor: 'default', whiteSpace: 'nowrap', gap: 4, lineHeight: '30px' },
    title: tip,
  }, '会话 ' + label)
}
