// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏「大纲」面板。
 * 数据源经 resolveOutline（源注册表，优先级降序、首个非空生效）解析当前活动文件符号：
 * monaco 源吃原生 document symbol provider，fallback 源兜底无内置提供方的语言。
 * 交互：点击符号跳转编辑器、▸/▾ 折叠、光标所在符号高亮、空/加载/错误态。
 * 作者 ddj 2026-08-27
 */
import React from 'react'
import { resolveOutline } from './sources.js'
import type { SidebarCtx } from '../sidebar/types.js'

/** 渲染符号数上限（防超大文件卡顿，超出显示截断提示）。 */
const RENDER_CAP = 800

/** kind 分组元信息（字形 + 样式类）。 */
const KIND_GROUPS = {
  func: { glyph: 'ƒ', cls: 'edrv-ol-func' },
  type: { glyph: 'C', cls: 'edrv-ol-type' },
  data: { glyph: '•', cls: 'edrv-ol-data' },
  ns: { glyph: '▤', cls: 'edrv-ol-ns' },
  key: { glyph: '·', cls: 'edrv-ol-key' },
}

/** SymbolKind 数值 → 分组（File0..Package3=ns；Class4/Enum9/Interface10/Struct22/TypeParameter25=type；Method5/Constructor8/Function11=func；Key19/EnumMember21=key）。 */
function kindMeta(kind) {
  const k = kind | 0
  if (k <= 3) return KIND_GROUPS.ns
  if (k === 4 || k === 9 || k === 10 || k === 22 || k === 25) return KIND_GROUPS.type
  if (k === 5 || k === 8 || k === 11) return KIND_GROUPS.func
  if (k === 19 || k === 21) return KIND_GROUPS.key
  return KIND_GROUPS.data
}

/**
 * 大纲面板主体。
 * @param props.ctx 面板共享上下文（editor/outlineSources/activePath）
 */
export function OutlinePanel(props) {
  const ctx = props?.ctx
  const activePath = ctx?.activePath ?? null
  const [symbols, setSymbols] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [collapsed, setCollapsed] = React.useState({})
  const [cursorLine, setCursorLine] = React.useState(null)
  const seqRef = React.useRef(0)
  // ref 镜像：refresh 稳定（[]），监听器只挂一次，避免 EditorView 每渲染重建 ctx 造成抖动
  const ctxRef = React.useRef(ctx)
  ctxRef.current = ctx
  const activeRef = React.useRef(activePath)
  activeRef.current = activePath
  const sourcesRef = React.useRef(ctx?.outlineSources)
  sourcesRef.current = ctx?.outlineSources

  const refresh = React.useCallback(() => {
    const c = ctxRef.current
    const ed = c?.editor?.()
    const model = ed?.getModel?.()
    const seq = ++seqRef.current
    if (!ed || !model) { setSymbols(null); setError(null); return }
    const uriPath = model?.uri?.path
    const modelPath = uriPath ? decodeURIComponent(String(uriPath).replace(/^\//, '')) : null
    const active = activeRef.current
    if (active && modelPath !== active) { setSymbols(null); setError(null); return }
    const sources = sourcesRef.current
    if (!sources) { setSymbols([]); setError(null); return }
    setError(null)
    resolveOutline(sources, { languageId: model.getLanguageId(), model, editor: ed, monaco: window.monaco })
      .then((list) => { if (seq === seqRef.current) setSymbols(list || []) })
      .catch((e) => { if (seq === seqRef.current) { setError(String(e?.message ?? e)); setSymbols(null) } })
  }, [])

  // 编辑器监听：模型切换/内容编辑（防抖）/光标移动 + edrv:refresh；
  // 编辑器未就绪时轮询等待（避免面板先于 Monaco 挂载后永久停在加载态）
  React.useEffect(() => {
    const disposers = []
    let debounceTimer = null
    let waitTimer = null
    const attach = () => {
      const ed = ctxRef.current?.editor?.()
      if (!ed) return false
      let contentDisposable = null
      const subContent = (model) => {
        if (contentDisposable) { contentDisposable.dispose(); contentDisposable = null }
        contentDisposable = model?.onDidChangeContent?.(() => {
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => { debounceTimer = null; refresh() }, 300)
        }) ?? null
      }
      const onModel = () => { subContent(ed.getModel?.()); refresh() }
      const onCursor = (e) => setCursorLine(e?.position?.lineNumber ?? null)
      subContent(ed.getModel?.())
      const subs = [
        ed.onDidChangeModel?.(onModel),
        ed.onDidChangeCursorPosition?.(onCursor),
        { dispose: () => { if (contentDisposable) contentDisposable.dispose() } },
      ]
      for (const s of subs) if (s) disposers.push(s)
      refresh()
      return true
    }
    const onRefresh = () => refresh()
    window.addEventListener('edrv:refresh', onRefresh)
    if (!attach()) {
      waitTimer = setInterval(() => { if (attach()) { clearInterval(waitTimer); waitTimer = null } }, 400)
    }
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      if (waitTimer) clearInterval(waitTimer)
      for (const d of disposers) if (d?.dispose) d.dispose()
      window.removeEventListener('edrv:refresh', onRefresh)
    }
  }, [refresh])

  // 活动文件变化 → 重拉
  React.useEffect(() => { refresh() }, [refresh, activePath])

  const jump = (sym) => {
    const ed = ctxRef.current?.editor?.()
    if (!ed) return
    const line = Math.max(1, sym?.selectLine ?? sym?.startLine ?? 1)
    ed.revealLineInCenter(line)
    ed.setPosition({ lineNumber: line, column: 1 })
    ed.focus()
  }

  const toggleCollapse = (key) => {
    setCollapsed((prev) => Object.assign({}, prev, { [key]: prev[key] === true ? false : true }))
  }

  const allKeys = React.useMemo(() => {
    const keys = []
    const walk = (list, prefix) => {
      for (let i = 0; i < list.length; i++) {
        const key = prefix ? prefix + '/' + i : String(i)
        const sym = list[i]
        if (sym.children && sym.children.length) { keys.push(key); walk(sym.children, key) }
      }
    }
    walk(symbols || [], '')
    return keys
  }, [symbols])

  const setAll = (value) => {
    const next = {}
    for (const key of allKeys) next[key] = value
    setCollapsed(next)
  }

  const renderTree = (list, depth, prefix) => {
    const rows = []
    const cap = Math.min(list.length, RENDER_CAP)
    for (let i = 0; i < cap; i++) {
      const sym = list[i]
      const key = prefix ? prefix + '/' + i : String(i)
      const kids = sym.children && sym.children.length ? sym.children : null
      const isCollapsed = collapsed[key] === true
      const meta = kindMeta(sym.kind)
      const active = cursorLine != null && sym.startLine <= cursorLine && cursorLine <= sym.endLine
      rows.push(React.createElement('div', {
        key,
        className: 'edrv-tree-row' + (active ? ' edrv-tree-active' : ''),
        title: sym.detail || sym.name,
        style: { paddingLeft: 6 + depth * 14 },
        onClick: () => jump(sym),
      },
        React.createElement('span', {
          className: 'edrv-tree-chev',
          onClick: (e) => { e.stopPropagation(); toggleCollapse(key) },
        }, kids ? (isCollapsed ? '▸' : '▾') : ''),
        React.createElement('span', { className: 'edrv-outline-kind ' + meta.cls }, meta.glyph),
        React.createElement('span', { className: 'edrv-tree-name' }, sym.name),
        (sym.detail ? React.createElement('span', { className: 'edrv-outline-detail' }, sym.detail) : null),
        React.createElement('span', { className: 'edrv-outline-ln' }, String(sym.selectLine ?? sym.startLine ?? ''))))
      if (kids && !isCollapsed) rows.push(...renderTree(kids, depth + 1, key))
    }
    if (list.length > RENDER_CAP) {
      rows.push(React.createElement('div', { key: 'cap', className: 'edrv-tree-loading' }, '符号过多，仅显示前 ' + RENDER_CAP + ' 个'))
    }
    return rows
  }

  const basename = activePath ? String(activePath).split(/[\\/]/).pop() || activePath : ''

  let body
  if (error) {
    body = React.createElement('div', { className: 'edrv-tree' },
      React.createElement('div', { className: 'edrv-tree-error' },
        React.createElement('span', null, String(error)),
        React.createElement('button', { className: 'edrv-side-btn', onClick: refresh }, '重试')))
  } else if (!activePath) {
    body = React.createElement('div', { className: 'edrv-tree' },
      React.createElement('div', { className: 'edrv-tree-loading' }, '未打开文件'))
  } else if (symbols === null) {
    body = React.createElement('div', { className: 'edrv-tree' },
      React.createElement('div', { className: 'edrv-tree-loading' }, '加载中…'))
  } else if (symbols.length === 0) {
    body = React.createElement('div', { className: 'edrv-tree' },
      React.createElement('div', { className: 'edrv-tree-loading' }, '该语言暂不支持大纲或文件无符号'))
  } else {
    body = React.createElement('div', { className: 'edrv-tree' }, ...renderTree(symbols, 0, ''))
  }

  return React.createElement('div', { className: 'edrv-side-panel' },
    React.createElement('div', { className: 'edrv-side-head' },
      React.createElement('span', { className: 'edrv-side-title' }, '大纲'),
      React.createElement('span', { className: 'edrv-side-root', title: activePath || '' }, basename),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', { className: 'edrv-side-btn', title: '折叠全部', disabled: !(symbols && symbols.length), onClick: () => setAll(true) }, '−'),
      React.createElement('button', { className: 'edrv-side-btn', title: '展开全部', disabled: !(symbols && symbols.length), onClick: () => setAll(false) }, '+'),
      React.createElement('button', { className: 'edrv-side-btn', title: '刷新大纲', onClick: refresh }, '⟳')),
    body)
}
