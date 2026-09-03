// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏「文件管理」面板（懒加载目录树 + SWR 缓存）。
 * 展开目录立即渲染（dirs 内存态 → 本地条目缓存兜底），后台刷新（edrv.listDir 走
 * host 树索引，命中近乎零成本）；挂载/切会话从缓存即时恢复展开树；⟳/edrv:refresh
 * 保留旧条目强制后台重列（force）；每次用户发起加载后预取 ≤4 个子目录（排除重型
 * 目录、缓存新鲜跳过、不级联）；10s 轻量跟随已展开目录（命中索引，RPC 近零成本）。
 * 差异角标/右键菜单/展开状态持久化行为不变。
 * 作者 ddj 2026-08-26 / 2026-08-27 / 2026-08-31
 */
import React from 'react'
import { rpc } from '../../rpc.js'
import { ContextMenu } from '../../ui/ContextMenu.js'
import { buildTreeMenu } from '../contextMenu.js'
import { explorerLoad, explorerSave } from '../../state/explorerCache.js'
import { entriesCacheGet, entriesCacheIsFresh, entriesCachePut } from '../../state/explorerEntriesCache.js'
import type { SidebarCtx } from '../types.js'

const DIR_CAP = 4000
const SAVE_DEBOUNCE_MS = 300
const FOLLOW_INTERVAL_MS = 10_000
const PREFETCH_MAX = 4
const PREFETCH_EXCLUDED = new Set(['node_modules', '.git', '.hg', '.svn', '.pnpm', '.pnpm-store'])

/**
 * 目录树面板主体（SWR：有缓存先渲染，无缓存才显示加载态；加载总在后台）。
 * @param props.ctx 面板共享上下文（sessionId/openFile/activePath/pendingByPath/fileMenuItems/notify）
 */
export function FileExplorer(props) {
  const ctx = props?.ctx
  const sessionId = ctx?.sessionId
  const openFile = ctx?.openFile
  const activePath = ctx?.activePath ?? null
  const pendingByPath = ctx?.pendingByPath ?? {}
  const [root, setRoot] = React.useState(null)
  const [dirs, setDirs] = React.useState({}) // rel → 最新条目（本会话内存态）
  const [expanded, setExpanded] = React.useState({})
  const [loading, setLoading] = React.useState({})
  const [errors, setErrors] = React.useState({}) // rel → 错误文案（仅无任何数据时展示）
  const [menu, setMenu] = React.useState(null) // 右键菜单 { x, y, target }
  // 各状态 ref 镜像：定时器/监听用最新闭包
  const tokensRef = React.useRef({})
  const expandedRef = React.useRef({})
  expandedRef.current = expanded
  const loadingRef = React.useRef({})
  loadingRef.current = loading
  const dirsRef = React.useRef({})
  dirsRef.current = dirs
  const saveTimerRef = React.useRef(null)
  const loadDirRef = React.useRef(null)
  const refreshRef = React.useRef(null)

  /** 渲染取数：内存态 → 本地条目缓存 → null（显示加载态）。 */
  const entriesOf = (rel) => dirsRef.current[rel] ?? entriesCacheGet(sessionId, rel) ?? null

  /** 预取子目录：≤4 个、排除重型目录、缓存新鲜跳过、已加载跳过、不级联。 */
  const prefetchDirs = (rel, entries) => {
    const want = []
    for (const e of entries) {
      if (e.type !== 'directory') continue
      if (PREFETCH_EXCLUDED.has(e.name)) continue
      if (entriesCacheIsFresh(sessionId, e.path)) continue
      if (dirsRef.current[e.path] !== undefined) continue
      want.push(e.path)
      if (want.length >= PREFETCH_MAX) break
    }
    for (const sub of want) void loadDir(sub, {})
  }

  /**
   * 后台加载目录：token 守卫防乱序；force 跳过索引命中强制实列；
   * 非 force 且已在途时跳过（避免轮询打断用户展开的响应）。
   */
  const loadDir = (rel, opts) => {
    const force = opts?.force === true
    const doPrefetch = opts?.prefetch === true
    if (!force && loadingRef.current[rel]) return
    const token = (tokensRef.current[rel] || 0) + 1
    tokensRef.current[rel] = token
    setLoading((prev) => Object.assign({}, prev, { [rel]: true }))
    setErrors((prev) => {
      const next = Object.assign({}, prev)
      delete next[rel]
      return next
    })
    const args = { sessionId, path: rel }
    if (force) args.force = true
    rpc('edrv.listDir', args).then((res) => {
      if (tokensRef.current[rel] !== token) return
      if (res && res.ok && Array.isArray(res.entries)) {
        setDirs((prev) => Object.assign({}, prev, { [rel]: res.entries }))
        if (res.root) setRoot((prev) => prev || res.root)
        entriesCachePut(sessionId, rel, res.entries)
        if (doPrefetch) prefetchDirs(rel, res.entries)
      } else {
        // 有可渲染数据时静默（旧数据可能过期但可用）；全无数据才报错
        if (!entriesOf(rel)) {
          setErrors((prev) => Object.assign({}, prev, { [rel]: res?.error ? String(res.error) : '读取目录失败' }))
        }
      }
    }).catch((e) => {
      if (tokensRef.current[rel] !== token) return
      if (!entriesOf(rel)) {
        setErrors((prev) => Object.assign({}, prev, { [rel]: '读取目录异常:' + String(e) }))
      }
    }).finally(() => {
      if (tokensRef.current[rel] !== token) return
      setLoading((prev) => {
        const next = Object.assign({}, prev)
        delete next[rel]
        return next
      })
    })
  }
  loadDirRef.current = loadDir

  const toggle = (rel) => {
    if (expanded[rel] === true) {
      setExpanded((prev) => Object.assign({}, prev, { [rel]: false }))
      return
    }
    setExpanded((prev) => Object.assign({}, prev, { [rel]: true }))
    void loadDir(rel, { prefetch: true })
  }

  const refresh = () => {
    const keep = Object.keys(expandedRef.current).filter((k) => expandedRef.current[k] === true)
    tokensRef.current = {}
    setMenu(null)
    setErrors({})
    // SWR：保留旧条目不清空，后台强制重列（force 跳过索引）
    setLoading({})
    if (keep.length) {
      const next = {}
      for (const rel of keep) next[rel] = true
      setExpanded(next)
      for (const rel of keep) void loadDir(rel, { force: true, prefetch: true })
    } else {
      setExpanded({})
    }
    void loadDir('', { force: true, prefetch: true })
  }
  refreshRef.current = refresh

  React.useEffect(() => {
    tokensRef.current = {}
    setDirs({})
    setExpanded({})
    setLoading({})
    setErrors({})
    setMenu(null)
    setRoot(null)
    // 恢复上次展开状态（对齐 VSCode：持久化展开路径，条目缓存即时渲染、后台刷新）
    const cached = sessionId ? explorerLoad(sessionId) : null
    const restored = cached?.expanded ?? []
    if (cached?.root) setRoot(cached.root)
    if (restored.length) {
      const next = {}
      for (const rel of restored) next[rel] = true
      setExpanded(next)
    }
    void loadDir('', { prefetch: true })
    for (const rel of restored) {
      if (rel) void loadDir(rel, { prefetch: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 展开状态防抖写回 localStorage（重启后恢复展开结构）
  React.useEffect(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    if (!sessionId) return
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const expandedList = Object.keys(expanded).filter((k) => expanded[k] === true)
      explorerSave(sessionId, { root, expanded: expandedList })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    }
  }, [expanded, root, sessionId])

  // edrv:refresh（差异决策/回滚后）：保留旧条目，强制后台重列
  React.useEffect(() => {
    const onRefresh = () => refreshRef.current?.()
    window.addEventListener('edrv:refresh', onRefresh)
    return () => window.removeEventListener('edrv:refresh', onRefresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 10s 轻量跟随：已展开目录后台刷新（命中 host 索引，近零成本），树跟随 agent 写入
  React.useEffect(() => {
    if (!sessionId) return
    const timer = setInterval(() => {
      const open = Object.keys(expandedRef.current).filter((k) => expandedRef.current[k] === true)
      if (!open.length) return
      for (const rel of open) loadDirRef.current?.(rel, {})
    }, FOLLOW_INTERVAL_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const rootName = root ? String(root).split(/[\\/]/).pop() || root : ''

  const rowEl = (e, depth, isDir, isOpen) => {
    const pending = isDir ? 0 : (pendingByPath[e.path] ?? 0)
    const active = !isDir && e.path === activePath
    const contextTarget = Boolean(menu && menuEntries.length && menu.target.path === e.path)
    const dim = e.type === 'other'
    return React.createElement('div', {
      key: e.path,
      className: 'edrv-tree-row'
        + (active ? ' edrv-tree-active' : '')
        + (contextTarget ? ' edrv-tree-context' : ''),
      title: e.path,
      style: { paddingLeft: 6 + depth * 14 },
      onClick: () => { if (isDir) toggle(e.path); else openFile(e.path) },
      onContextMenu: (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        // 菜单左上角对齐鼠标点击位置（视口坐标，ContextMenu 内再做 viewport clamp）
        setMenu({ x: ev.clientX, y: ev.clientY, target: { path: e.path, type: e.type } })
      },
    },
      React.createElement('span', { className: 'edrv-tree-chev' },
        isDir ? (isOpen ? '▾' : '▸') : ''),
      React.createElement('span', { className: 'edrv-tree-name' + (dim ? ' edrv-tree-dim' : '') },
        isDir ? (isOpen ? '📂' : '📁') : '📄', ' ', e.name),
      (pending > 0
        ? React.createElement('span', { className: 'edrv-tree-badge' }, String(pending))
        : null))
  }

  const rowsOf = (rel, depth) => {
    const entries = entriesOf(rel)
    if (!entries) {
      return [React.createElement('div', { key: rel + ':loading', className: 'edrv-tree-loading', style: { paddingLeft: 6 + depth * 14 } },
        loading[rel] ? '加载中…' : '无法加载')]
    }
    const rows = []
    const cap = entries.length
    for (let i = 0; i < cap; i++) {
      const e = entries[i]
      const isDir = e.type === 'directory'
      const isOpen = expanded[e.path] === true
      rows.push(rowEl(e, depth, isDir, isOpen))
      if (isDir && isOpen) rows.push(...rowsOf(e.path, depth + 1))
    }
    if (cap >= DIR_CAP) {
      rows.push(React.createElement('div', { key: rel + ':cap', className: 'edrv-tree-loading', style: { paddingLeft: 6 + depth * 14 } },
        '目录条目过多，仅显示前 ' + DIR_CAP + ' 项'))
    }
    return rows
  }

  // 面板区右键（空白处）→ 工作区根目录菜单；行内右键已在 rowEl 阻止冒泡。
  const onPanelContext = (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    if (!ev.currentTarget.contains(ev.target)) return
    setMenu({ x: ev.clientX, y: ev.clientY, target: { path: '', type: 'directory' } })
  }
  // 当前右键目标的可视菜单项（构建时过滤/排序，registry 变化下次打开生效）。
  const menuEntries = menu
    ? buildTreeMenu(ctx?.fileMenuItems, menu.target, ctx).map((item) => ({
        id: item.id,
        label: item.label,
        danger: item.danger,
        disabled: item.disabled,
        separator: item.separator,
        onClick: () => item.run(menu.target, ctx),
      }))
    : []

  const errorList = Object.entries(errors)
  const errorText = errorList.length ? errorList[0][1] : null

  return React.createElement('div', { className: 'edrv-side-panel', onContextMenu: onPanelContext },
    React.createElement('div', { className: 'edrv-side-head' },
      React.createElement('span', { className: 'edrv-side-title' }, '资源管理器'),
      React.createElement('span', { className: 'edrv-side-root', title: root || '' }, rootName),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', { className: 'edrv-side-btn', title: '刷新目录树', onClick: refresh }, '⟳')),
    React.createElement('div', { className: 'edrv-tree' },
      (errorText
        ? React.createElement('div', { className: 'edrv-tree-error' },
            React.createElement('span', null, String(errorText)),
            React.createElement('button', { className: 'edrv-side-btn', onClick: () => refresh() }, '重试'))
        : null),
      rowsOf('', 0)),
    (menu && menuEntries.length
      ? React.createElement(ContextMenu, { x: menu.x, y: menu.y, entries: menuEntries, onClose: () => setMenu(null) })
      : null))
}
