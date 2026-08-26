// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏「搜索」面板（VSCode 搜索视图形态）。
 * 内容搜索：edrv.searchContent RPC；结果按文件分组展示命中行（行号 + 高亮 + 文件计数），
 * 点击经 ctx.openFileAt 打开文件并跳转行列。
 * 选项：大小写/全词/正则；折叠区（⚙ 齿轮展开）：包含的文件（📖 toggle = 仅当前打开文件）
 * 与排除的文件（⚙ toggle = 启用排除），模式为逗号分隔 rg glob；无搜索按钮，防抖 + 回车触发。
 * 作者 ddj 2026-08-26
 */
import React from 'react'
import { rpc } from '../../rpc.js'
import type { SidebarCtx } from '../types.js'

const DEBOUNCE_MS = 250
const INCLUDE_PLACEHOLDER = '例如 *.ts, src/**/include'

/**
 * 逗号切分 glob 列表（trim + 去空）。
 * @param text 用户输入的逗号分隔模式
 * @returns glob 数组
 */
export function splitGlobs(text) {
  return String(text ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

/**
 * 命中行文本三段切分（before/命中/after，列为 1-based UTF-16）。
 * @param text 行文本
 * @param start 起始列
 * @param end 结束列
 * @returns 三段文本
 */
function splitHit(text, start, end) {
  const s = Math.max(0, (start | 0) - 1)
  const e = Math.max(s, end | 0)
  return { before: String(text).slice(0, s), hit: String(text).slice(s, e), after: String(text).slice(e) }
}

/**
 * 搜索面板主体。
 * @param props.ctx 面板共享上下文（sessionId/openFileAt/activePath）
 */
export function SearchPanel(props) {
  const ctx = props?.ctx
  const sessionId = ctx?.sessionId
  const openFileAt = ctx?.openFileAt ?? (() => {})
  const activePath = ctx?.activePath ?? null
  const [query, setQuery] = React.useState('')
  const [matchCase, setMatchCase] = React.useState(false)
  const [wholeWord, setWholeWord] = React.useState(false)
  const [regex, setRegex] = React.useState(false)
  const [includeText, setIncludeText] = React.useState('')
  const [excludeText, setExcludeText] = React.useState('')
  const [onlyActive, setOnlyActive] = React.useState(false)
  const [excludeOn, setExcludeOn] = React.useState(false)
  const [sectionOpen, setSectionOpen] = React.useState(false)
  const [status, setStatus] = React.useState('idle') // idle | searching | done | error
  const [error, setError] = React.useState('')
  const [matches, setMatches] = React.useState(null)
  const [truncated, setTruncated] = React.useState(false)
  const [collapsed, setCollapsed] = React.useState({})
  const seqRef = React.useRef(0)
  const timerRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const queryRef = React.useRef('')
  queryRef.current = query
  const activePathRef = React.useRef(activePath)
  activePathRef.current = activePath
  // 请求参数 ref：防抖/立即重搜闭包统一读最新值，避免陈旧选项
  const requestRef = React.useRef({ matchCase, wholeWord, regex, include: [], exclude: [] })
  requestRef.current = {
    matchCase, wholeWord, regex,
    include: onlyActive ? (activePath ? [activePath] : []) : splitGlobs(includeText),
    exclude: excludeOn ? splitGlobs(excludeText) : [],
  }

  // 按会话恢复上次查询、选项与过滤模式（VSCode 记忆搜索词）
  React.useEffect(() => {
    if (!sessionId) return
    try {
      const saved = JSON.parse(localStorage.getItem('edrv.search.v1.' + String(sessionId)) || 'null')
      if (saved && typeof saved === 'object') {
        if (typeof saved.query === 'string') setQuery(saved.query)
        if (typeof saved.matchCase === 'boolean') setMatchCase(saved.matchCase)
        if (typeof saved.wholeWord === 'boolean') setWholeWord(saved.wholeWord)
        if (typeof saved.regex === 'boolean') setRegex(saved.regex)
        if (typeof saved.includeText === 'string') setIncludeText(saved.includeText)
        if (typeof saved.excludeText === 'string') setExcludeText(saved.excludeText)
        if (typeof saved.onlyActive === 'boolean') setOnlyActive(saved.onlyActive)
        if (typeof saved.excludeOn === 'boolean') setExcludeOn(saved.excludeOn)
        if (typeof saved.sectionOpen === 'boolean') setSectionOpen(saved.sectionOpen)
      }
    } catch (e) { /* 损坏忽略 */ }
  }, [sessionId])

  // 查询/选项/过滤变化 → 持久化
  React.useEffect(() => {
    if (!sessionId) return
    try {
      localStorage.setItem('edrv.search.v1.' + String(sessionId), JSON.stringify({
        query, matchCase, wholeWord, regex, includeText, excludeText, onlyActive, excludeOn, sectionOpen,
      }))
    } catch (e) { /* 忽略 */ }
  }, [sessionId, query, matchCase, wholeWord, regex, includeText, excludeText, onlyActive, excludeOn, sectionOpen])

  /**
   * 执行内容搜索（请求参数从 ref 读最新值）。
   * @param text 搜索词
   */
  const runSearch = (text) => {
    const s = ++seqRef.current
    const clean = String(text ?? '').trim()
    if (clean.length < 2) { setMatches(null); setStatus('idle'); return }
    const req = requestRef.current
    setStatus('searching')
    setError('')
    rpc('edrv.searchContent', {
      sessionId, query: clean,
      matchCase: req.matchCase, wholeWord: req.wholeWord, regex: req.regex,
      include: req.include, exclude: req.exclude,
    }).then((res) => {
      if (s !== seqRef.current) return
      if (res && res.ok) {
        setMatches(Array.isArray(res.matches) ? res.matches : [])
        setTruncated(res.truncated === true)
        setStatus('done')
      } else {
        setError(res?.error ? String(res.error) : '搜索失败')
        setMatches(null)
        setStatus('error')
      }
    }).catch((e) => {
      if (s !== seqRef.current) return
      setError('搜索异常:' + String(e))
      setMatches(null)
      setStatus('error')
    })
  }

  /**
   * 输入变化：防抖触发搜索。
   * @param value 新输入
   */
  const onChange = (value) => {
    setQuery(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => runSearch(value), DEBOUNCE_MS)
  }

  /**
   * 输入框通用防抖重搜（包含/排除模式输入）。
   * @param setter 状态写入函数
   * @param value 新值
   */
  const onChangeDebounced = (setter, value) => {
    setter(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => runSearch(queryRef.current), DEBOUNCE_MS)
  }

  /**
   * 立即重搜（查询 ≥2 字符时）；先同步 ref 避免本次调用读到旧请求参数。
   * @param next 新的请求参数字段
   */
  const rerun = (next) => {
    requestRef.current = Object.assign({}, requestRef.current, next)
    if (timerRef.current) clearTimeout(timerRef.current)
    if (String(queryRef.current).trim().length >= 2) runSearch(queryRef.current)
  }

  /** 选项开关切换（大小写/全词/正则/书本/设置）：更新状态 + 立即重搜。 */
  const toggleOpt = (key, value) => {
    if (key === 'matchCase') setMatchCase(value)
    if (key === 'wholeWord') setWholeWord(value)
    if (key === 'regex') setRegex(value)
    if (key === 'onlyActive') setOnlyActive(value)
    if (key === 'excludeOn') setExcludeOn(value)
    const base = { matchCase, wholeWord, regex, onlyActive, excludeOn }
    base[key] = value
    rerun({
      matchCase: base.matchCase, wholeWord: base.wholeWord, regex: base.regex,
      include: base.onlyActive ? (activePathRef.current ? [activePathRef.current] : []) : splitGlobs(includeText),
      exclude: base.excludeOn ? splitGlobs(excludeText) : [],
    })
  }

  // Ctrl+Shift+F 重复触发时聚焦输入框（EditorView 派发 edrv:search-focus）
  React.useEffect(() => {
    const onFocus = () => inputRef.current?.focus?.()
    window.addEventListener('edrv:search-focus', onFocus)
    return () => window.removeEventListener('edrv:search-focus', onFocus)
  }, [])

  // 结果按文件分组（保持 rg 输出顺序）
  const groups = React.useMemo(() => {
    if (!Array.isArray(matches)) return []
    const map = new Map()
    for (const m of matches) {
      let list = map.get(m.path)
      if (!list) { list = []; map.set(m.path, list) }
      list.push(m)
    }
    return [...map.entries()].map(([path, list]) => ({ path, count: list.length, matches: list }))
  }, [matches])

  const totalFiles = groups.length
  const totalMatches = Array.isArray(matches) ? matches.length : 0
  const toggleGroup = (path) => setCollapsed((prev) => Object.assign({}, prev, { [path]: prev[path] === true ? false : true }))

  const optsBar = React.createElement('div', { className: 'edrv-search-opts' },
    React.createElement('button', { className: 'edrv-search-opt' + (matchCase ? ' on' : ''), title: '区分大小写', 'aria-pressed': matchCase, onClick: () => toggleOpt('matchCase', !matchCase) }, 'Aa'),
    React.createElement('button', { className: 'edrv-search-opt' + (wholeWord ? ' on' : ''), title: '全字匹配', 'aria-pressed': wholeWord, onClick: () => toggleOpt('wholeWord', !wholeWord) }, 'Ab'),
    React.createElement('button', { className: 'edrv-search-opt' + (regex ? ' on' : ''), title: '使用正则表达式', 'aria-pressed': regex, onClick: () => toggleOpt('regex', !regex) }, '.*'),
    React.createElement('span', { className: 'edrv-search-spacer' }),
    React.createElement('button', { className: 'edrv-search-opt' + (sectionOpen ? ' on' : ''), title: sectionOpen ? '收起文件过滤' : '文件过滤（包含/排除）', 'aria-pressed': sectionOpen, onClick: () => setSectionOpen((v) => !v) }, '⚙'))

  const filterRows = sectionOpen
    ? React.createElement('div', { className: 'edrv-search-rows' },
        React.createElement('div', { className: 'edrv-search-row' },
          React.createElement('input', {
            className: 'edrv-search-field' + (onlyActive ? ' dim' : ''), placeholder: INCLUDE_PLACEHOLDER,
            value: includeText, disabled: onlyActive,
            title: onlyActive ? '已启用「仅当前打开文件」，忽略此输入' : '',
            onChange: (e) => onChangeDebounced(setIncludeText, e.target.value),
          }),
          React.createElement('button', {
            className: 'edrv-search-toggle' + (onlyActive ? ' on' : ''), title: activePath ? '仅在当前打开的文件中搜索' : '无打开的文件（需先打开文件）',
            'aria-pressed': onlyActive, disabled: !activePath,
            onClick: () => toggleOpt('onlyActive', !onlyActive),
          }, '📖')),
        React.createElement('div', { className: 'edrv-search-row' },
          React.createElement('input', {
            className: 'edrv-search-field' + (excludeOn ? '' : ' dim'), placeholder: INCLUDE_PLACEHOLDER,
            value: excludeText, disabled: !excludeOn,
            title: excludeOn ? '' : '排除功能未启用，先点击右侧按钮开启',
            onChange: (e) => onChangeDebounced(setExcludeText, e.target.value),
          }),
          React.createElement('button', {
            className: 'edrv-search-toggle' + (excludeOn ? ' on' : ''), title: '启用排除文件（忽略下方模式的命中）',
            'aria-pressed': excludeOn,
            onClick: () => toggleOpt('excludeOn', !excludeOn),
          }, '⚙')))
    : null

  const summary = status === 'done'
    ? React.createElement('div', { className: 'edrv-search-summary' },
        totalFiles > 0
          ? totalFiles + ' 个文件 · ' + totalMatches + ' 处匹配' + (truncated ? '（已截断）' : '')
          : '无匹配结果')
    : null

  const body = (() => {
    if (status === 'searching') return React.createElement('div', { className: 'edrv-search-empty' }, '搜索中…')
    if (status === 'error') return React.createElement('div', { className: 'edrv-search-error' }, error)
    if (status === 'done' && !groups.length) return React.createElement('div', { className: 'edrv-search-empty' }, '无匹配结果')
    if (status !== 'done') return React.createElement('div', { className: 'edrv-search-empty' }, '输入至少 2 个字符开始搜索')
    return React.createElement('div', { className: 'edrv-search-results' },
      groups.map((group) => {
        const open = collapsed[group.path] !== true
        return React.createElement('div', { key: group.path, className: 'edrv-search-group' },
          React.createElement('div', { className: 'edrv-search-file', title: group.path, onClick: () => toggleGroup(group.path) },
            React.createElement('span', { className: 'edrv-search-chev' }, open ? '▾' : '▸'),
            React.createElement('span', { className: 'edrv-search-fname' }, String(group.path).split(/[\\/]/).pop() || group.path),
            React.createElement('span', { className: 'edrv-search-fdir' }, String(group.path).split(/[\\/]/).slice(0, -1).join('/')),
            React.createElement('span', { className: 'edrv-search-fcount' }, group.count)),
          open ? group.matches.map((m, i) => {
            const parts = splitHit(m.text, m.startColumn, m.endColumn)
            return React.createElement('div', { key: m.path + ':' + m.line + ':' + i, className: 'edrv-search-line' + (i % 2 ? ' alt' : ''), title: group.path + ':' + m.line, onClick: () => openFileAt(m.path, m.line, m.startColumn) },
              React.createElement('span', { className: 'edrv-search-ln' }, m.line),
              React.createElement('span', { className: 'edrv-search-text' },
                React.createElement('span', null, parts.before),
                React.createElement('mark', { className: 'edrv-search-hit' }, parts.hit),
                React.createElement('span', null, parts.after)))
          }) : null)
      }))
  })()

  return React.createElement('div', { className: 'edrv-search-panel' },
    React.createElement('div', { className: 'edrv-search-qrow' },
      React.createElement('input', {
        ref: inputRef, className: 'edrv-search-input', autoFocus: true, autoComplete: 'off', spellCheck: false,
        placeholder: '搜索',
        value: query,
        onChange: (e) => onChange(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter') { if (timerRef.current) clearTimeout(timerRef.current); runSearch(queryRef.current) }
          if (e.key === 'Escape') inputRef.current?.blur?.()
        },
      })),
    optsBar,
    filterRows,
    summary,
    body)
}
