// @ts-nocheck
/**
 * dsh-vscode-mode client — QuickOpen：顶部搜索框（Ctrl+P 打开文件）。
 * 快捷键随配置（edrv.quickOpen），占位文案同步当前键位。
 * 候选浮窗支持鼠标点击与键盘导航（↑↓ 切换高亮、Enter 打开高亮项、Esc 关闭）；
 * 输入法组词中不消费按键（中文候选词确认优先）。
 * 迁移自原 src/client/index.ts 的 QuickOpen，语义不改。
 * 作者 ddj 2026-08-20 / 2026-08-26 / 2026年09月11号
 */
import React from 'react'
import { rpc } from '../rpc.js'
import { bindingsOf, chordOf, matchEvent, useKeybindingsVersion } from '../keybindings.js'
import { stepIndex } from './searchNav.js'

/**
 * 快速打开搜索框：Ctrl+P 聚焦，输入 ≥2 字符经 edrv.searchFiles 搜索，
 * 结果列表点击 / ↑↓ 选择 + 回车打开高亮项。
 * @param props.sessionId 会话 id
 * @param props.onOpen 打开回调(path)
 */
export function QuickOpen(props) {
  const sessionId = props?.sessionId
  const onOpen = props?.onOpen
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const inputRef = React.useRef(null)
  const popRef = React.useRef(null)
  const listId = React.useId()
  const seq = React.useRef(0)
  const timer = React.useRef(null)
  useKeybindingsVersion() // 键位变化时刷新占位文案

  const list = Array.isArray(results) ? results : []
  const showPop = open && Array.isArray(results) && q.trim().length >= 2
  // 高亮下标：候选集变化（含异步结果变短）时按当前长度收敛，不再单独改状态
  const activeIdx = list.length ? Math.min(active, list.length - 1) : 0

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
    setQ(v); setActive(0); setOpen(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => search(v), 180)
  }

  const pick = (p) => {
    onOpen(p)
    setQ(''); setResults(null); setActive(0); setOpen(false)
    inputRef.current?.blur?.()
  }

  React.useEffect(() => {
    const openBox = () => {
      inputRef.current?.focus?.()
      setOpen(true)
    }
    const onKey = (e) => {
      if (matchEvent(e, bindingsOf('edrv.quickOpen'))) {
        e.preventDefault(); e.stopPropagation()
        openBox()
      } else if (e.key === 'Escape') {
        setOpen(false); inputRef.current?.blur?.()
      }
    }
    window.addEventListener('keydown', onKey, true)
    // 指令系统入口（命令栏「快速打开文件」）：与键位复用同一动作
    window.addEventListener('edrv.command.quickOpen', openBox)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('edrv.command.quickOpen', openBox)
    }
  }, [])

  // 高亮项滚入浮窗可视区（候选集或高亮变化时；nearest 避免整页跳动）
  React.useEffect(() => {
    if (!showPop) return
    const node = popRef.current?.querySelector?.('.edrv-search-item.edrv-search-sel')
    if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }, [showPop, activeIdx, list.length])

  const dirText = (p) => {
    const base = String(p).split(/[\\/]/).pop() || String(p)
    return String(p).slice(0, Math.max(0, String(p).length - base.length)).replace(/[\\/]+$/, '') || String(p)
  }

  /**
   * 输入框按键：浮窗有候选时消费 ↑↓/Enter，其余情况放行（保留原生光标行为）。
   * 输入法组词中一律放行——中文候选词的 Enter 确认不得被当成「打开文件」。
   * @author ddj 2026年09月11号
   * @param e 输入框键盘事件
   */
  const onInputKey = (e) => {
    if (e.nativeEvent?.isComposing) return
    if (e.key === 'Escape') { setOpen(false); return }
    if (!showPop || !list.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((v) => stepIndex(v, e.key === 'ArrowDown' ? 1 : -1, list.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      pick(list[activeIdx])
    }
  }

  let pop = null
  if (showPop) {
    if (list.length) {
      const items = list.map((p, i) => React.createElement('div', {
        key: p,
        id: listId + '-' + i,
        role: 'option',
        'aria-selected': i === activeIdx,
        className: 'edrv-search-item' + (i === activeIdx ? ' edrv-search-sel' : ''),
        onMouseEnter: () => setActive(i),
        onClick: () => pick(p),
      },
        React.createElement('span', { className: 'n' }, String(p).split(/[\\/]/).pop() || p),
        React.createElement('span', { className: 'd' }, dirText(p))))
      pop = React.createElement('div', { ref: popRef, id: listId + '-list', className: 'edrv-search-pop', role: 'listbox' }, ...items)
    } else {
      pop = React.createElement('div', { ref: popRef, className: 'edrv-search-pop' }, React.createElement('div', { className: 'edrv-search-empty' }, '无匹配文件'))
    }
  }

  return React.createElement('div', { className: 'edrv-search-wrap' },
    React.createElement('input', {
      ref: inputRef, className: 'edrv-search', placeholder: '搜索文件 (' + (chordOf('edrv.quickOpen') ?? 'Ctrl+P') + ')',
      value: q,
      role: 'combobox',
      'aria-expanded': showPop && list.length > 0,
      'aria-controls': showPop && list.length ? listId + '-list' : undefined,
      'aria-activedescendant': showPop && list.length ? listId + '-' + activeIdx : undefined,
      onChange: (e) => onChange(e.target.value),
      onFocus: () => { if (q.trim().length >= 2 && !results) setOpen(true) },
      onKeyDown: onInputKey,
    }),
    pop)
}
