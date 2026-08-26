// @ts-nocheck
/**
 * dsh-vscode-mode client — QuickOpen：顶部搜索框（Ctrl+P 打开文件）。
 * 快捷键随配置（edrv.quickOpen），占位文案同步当前键位。
 * 迁移自原 src/client/index.ts 的 QuickOpen，语义不改。
 * 作者 ddj 2026-08-20 / 2026-08-26
 */
import React from 'react'
import { rpc } from '../rpc.js'
import { bindingOf, chordOf, matchEvent, useKeybindingsVersion } from '../keybindings.js'

/**
 * 快速打开搜索框：Ctrl+P 聚焦，输入 ≥2 字符经 edrv.searchFiles 搜索，
 * 结果列表点击/回车打开文件。
 * @param props.sessionId 会话 id
 * @param props.onOpen 打开回调(path)
 */
export function QuickOpen(props) {
  const sessionId = props?.sessionId
  const onOpen = props?.onOpen
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef(null)
  const seq = React.useRef(0)
  const timer = React.useRef(null)
  useKeybindingsVersion() // 键位变化时刷新占位文案

  const search = (query) => {
    const s = ++seq.current
    const clean = String(query || '').trim()
    if (clean.length < 2) { setResults(null); return }
    rpc('edrv.searchFiles', { sessionId, query: clean }).then((res) => {
      if (s !== seq.current) return
      setResults((res && res.ok && Array.isArray(res.files)) ? res.files : [])
    }).catch(() => { if (s === seq.current) setResults([]) })
  }

  const onChange = (v) => {
    setQ(v); setOpen(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => search(v), 180)
  }

  const pick = (p) => {
    onOpen(p)
    setQ(''); setResults(null); setOpen(false)
    inputRef.current?.blur?.()
  }

  React.useEffect(() => {
    const onKey = (e) => {
      if (matchEvent(e, bindingOf('edrv.quickOpen'))) {
        e.preventDefault(); e.stopPropagation()
        inputRef.current?.focus?.()
        setOpen(true)
      } else if (e.key === 'Escape') {
        setOpen(false); inputRef.current?.blur?.()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const dirText = (p) => {
    const base = String(p).split(/[\\/]/).pop() || String(p)
    return String(p).slice(0, Math.max(0, String(p).length - base.length)).replace(/[\\/]+$/, '') || String(p)
  }

  let pop = null
  if (open && Array.isArray(results) && q.trim().length >= 2) {
    if (results.length) {
      const items = results.map((p) => React.createElement('div', { key: p, className: 'edrv-search-item', onClick: () => pick(p) },
        React.createElement('span', { className: 'n' }, String(p).split(/[\\/]/).pop() || p),
        React.createElement('span', { className: 'd' }, dirText(p))))
      pop = React.createElement('div', { className: 'edrv-search-pop' }, ...items)
    } else {
      pop = React.createElement('div', { className: 'edrv-search-pop' }, React.createElement('div', { className: 'edrv-search-empty' }, '无匹配文件'))
    }
  }

  return React.createElement('div', { className: 'edrv-search-wrap' },
    React.createElement('input', {
      ref: inputRef, className: 'edrv-search', placeholder: '搜索文件 (' + (chordOf('edrv.quickOpen') ?? 'Ctrl+P') + ')',
      value: q,
      onChange: (e) => onChange(e.target.value),
      onFocus: () => { if (q.trim().length >= 2 && !results) setOpen(true) },
      onKeyDown: (e) => {
        if (e.key === 'Enter' && Array.isArray(results) && results.length) pick(results[0])
        if (e.key === 'Escape') setOpen(false)
      },
    }),
    pop)
}
