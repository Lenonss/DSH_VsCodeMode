// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏「文件管理」面板（懒加载目录树 + SWR 缓存）。
 * 展开目录立即渲染（dirs 内存态 → 本地条目缓存兜底），后台刷新（edrv.listDir 走
 * host 树索引，命中近乎零成本）；挂载/切会话从缓存即时恢复展开树；⟳/edrv:refresh
 * 保留旧条目强制后台重列（force）；每次用户发起加载后预取 ≤4 个子目录（排除重型
 * 目录、缓存新鲜跳过、不级联）；10s 轻量跟随已展开目录（命中索引，RPC 近零成本）。
 * 差异角标/右键菜单/展开状态持久化行为不变；行图标用官方原语（文件夹图标 + 文件类型图标）。
 * SVN 图标叠加：受控正常绿色对勾、本地修改红色感叹号；目录聚合后代状态。
 * 远端更新箭头由显式只读检查提供，与本地状态并存，不执行更新。
 * 作者 ddj 2026-08-26 / 2026-08-27 / 2026-08-31 / 2026-09-10 / 2026-09-16 / 2026-10-09
 */
import React from 'react'
import { IconFolderClose16, IconFolderOpen16, IconRefreshOutline16, fileIconEl } from '../../ui/icons.js'
import { rpc } from '../../rpc.js'
import { isSessionMissingError, sessionMissingDetail, sessionMissingTitle } from '../../sessionError.js'
import { ContextMenu } from '../../ui/ContextMenu.js'
import { buildTreeMenu } from '../contextMenu.js'
import { explorerLoad, explorerSave } from '../../state/explorerCache.js'
import { entriesCacheGet, entriesCacheIsFresh, entriesCachePut } from '../../state/explorerEntriesCache.js'
import { workspaceScopeOf } from '../../state/scopeStore.js'
import { ancestorDirsOf } from '../../tabActions.js'
import { refreshSvnChanges, refreshSvnStatus } from '../../svnStatus.js'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { emitRefresh } from '../../events.js'
import { svnOverlayEl, viewOverlayOf } from '../../ui/SvnOverlay.js'
import { useExplorerSvn } from './useExplorerSvn.js'
import { useExplorerReveal, treeRevealPath } from './useExplorerReveal.js'
import type { SidebarCtx } from '../types.js'

import { flattenTree, treeAnchorTop, treeRevealTop, treeWindow, TREE_ROW_HEIGHT } from './treeWindow.js'
const SAVE_DEBOUNCE_MS = 300
const FOLLOW_INTERVAL_MS = 10_000
const PREFETCH_MAX = 4
const PREFETCH_EXCLUDED = new Set(['node_modules', '.git', '.hg', '.svn', '.pnpm', '.pnpm-store'])
/** 外部文件变化重列去抖：一轮外部批量写入（如 agent 连写多文件）合并为一次重列。 */
const FILE_CHANGE_DEBOUNCE_MS = 400
/** 兼容 host 返回裸文案或附带路径的缺失目录错误。 */
const MISSING_DIR_PREFIX = '目录不存在'

// --region 行图标（官方原语：目录文件夹图标 + 文件类型图标；缺失时回落纯文本）

/**
 * 目录图标元素（官方 IconFolderOpen16/Close16）。
 * @author ddj 2026年09月10号
 * @param isOpen 目录是否展开
 * @returns 图标元素；原语缺失返回 null
 */
function dirIconEl(isOpen) {
  const Icon = isOpen ? IconFolderOpen16 : IconFolderClose16
  if (typeof Icon !== 'function') return null
  return React.createElement(Icon, { size: 16, className: 'edrv-tree-icon' })
}

// 文件图标元素（fileIconEl）已上移 icons.ts 共享（SVN 变更行同用），此处直接引用。

/**
 * 行图标分派：目录 → 文件夹图标，文件 → 官方类型图标。
 * @author ddj 2026年09月10号
 * @param e 目录条目（name/type）
 * @param isDir 是否目录
 * @param isOpen 目录是否展开
 * @returns 图标元素或 null
 */
function rowIconEl(e, isDir, isOpen) {
  return isDir ? dirIconEl(isOpen) : fileIconEl(e?.name)
}

/**
 * 刷新按钮图标（官方 IconRefreshOutline16；原语缺失回落文本 ⟳）。
 * @author ddj 2026年09月10号
 * @returns 图标元素或回落文本
 */
function refreshIconEl() {
  if (typeof IconRefreshOutline16 !== 'function') return '⟳'
  return React.createElement(IconRefreshOutline16, { size: 14 })
}
// --endregion

/** @private @author ddj 2026年10月10号 @param props Stable primitive row fields and compact mark. @returns Official file icon with independently fresh SVN evidence. */
function rowView(props) {
  const { path, name, type, depth, isDir, isOpen, pending, active, context, reveal, mark, remote, onSelect, onContext } = props
  /** @private @author ddj 2026年10月10号 Handle row activation. */
  function select() { onSelect(path, isDir) }
  /** @private @author ddj 2026年10月10号 @param event Context trigger. */
  function menu(event) { onContext(path, type, event) }
  return React.createElement('div', {
    className: 'edrv-tree-row' + (active ? ' edrv-tree-active' : '') + (context ? ' edrv-tree-context' : '')
      + (reveal ? ' edrv-tree-reveal' : '') + (mark?.stale ? ' edrv-tree-stale' : ''),
    title: path + (mark?.stale ? '；SVN 状态陈旧，等待确认' : ''), 'data-edrv-path': path,
    style: { paddingLeft: 6 + depth * 14 }, onClick: select, onContextMenu: menu,
  },
    React.createElement('span', { className: 'edrv-tree-chev' }, isDir ? (isOpen ? '▾' : '▸') : ''),
    React.createElement('span', { className: 'edrv-tree-iconbox' }, rowIconEl({ name }, isDir, isOpen), svnOverlayEl(viewOverlayOf(mark), remote)),
    React.createElement('span', { className: 'edrv-tree-name' + (type === 'other' ? ' edrv-tree-dim' : '') }, name),
    pending > 0 ? React.createElement('span', { className: 'edrv-tree-badge' }, String(pending)) : null)
}
const ExplorerRow = React.memo(rowView)

/**
 * 目录树面板主体（SWR：有缓存先渲染，无缓存才显示加载态；加载总在后台）。
 * @param props.ctx 面板共享上下文（sessionId/openFile/activePath/pendingByPath/fileMenuItems/notify）
 */
export function FileExplorer(props) {
  const ctx = props?.ctx
  const sessionId = ctx?.sessionId
  // 状态作用域：展开树/条目缓存按工作区隔离（同工作区切对话恢复同一份），无 cwd 回退会话
  const scope = ctx?.scope ?? workspaceScopeOf(null, sessionId)
  const scopeRef = React.useRef(scope)
  scopeRef.current = scope
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
  const treeRef = React.useRef(null) // 唯一目录树滚动容器
  const [viewport, setViewport] = React.useState({ scope, top: 0, height: 0 })
  const reloadDirRef = React.useRef(null) // loadDir 最新闭包（文件变化监听读取，防陈旧闭包）
  const changedTimerRef = React.useRef(null) // 文件变化合并去抖计时器
  const changedRelRef = React.useRef(new Set()) // 待重列的相对目录集合（去抖窗口内合并）

  /** 渲染取数：内存态 → 本地条目缓存 → null（显示加载态）。 */
  const entriesOf = (rel) => dirsRef.current[rel] ?? entriesCacheGet(scope, rel) ?? null

  /**
   * @private
   * @author ddj 2026年10月23号
   * @description 移除已删除目录的展开记录，经现有防抖持久化自愈；不改请求 token，保留 finally 的加载态清理。
   * @param rel 已确认缺失的非根相对目录
   */
  function dropDeadDir(rel) {
    setExpanded(removeExpansion)

    /** @private @author ddj 2026年10月23号 @param prev 当前展开映射。 @returns 移除失效目录后的展开映射。 */
    function removeExpansion(prev) {
      if (prev[rel] !== true) return prev
      const next = Object.assign({}, prev)
      delete next[rel]
      return next
    }
  }

  /** 预取子目录：≤4 个、排除重型目录、缓存新鲜跳过、已加载跳过、不级联。 */
  const prefetchDirs = (rel, entries) => {
    const want = []
    for (const e of entries) {
      if (e.type !== 'directory') continue
      if (PREFETCH_EXCLUDED.has(e.name)) continue
      if (entriesCacheIsFresh(scope, e.path)) continue
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
    const tokens = tokensRef.current
    const token = (tokens[rel] || 0) + 1
    tokens[rel] = token
    loadingRef.current = Object.assign({}, loadingRef.current, { [rel]: true })
    setLoading((prev) => Object.assign({}, prev, { [rel]: true }))
    setErrors((prev) => {
      const next = Object.assign({}, prev)
      delete next[rel]
      return next
    })
    const args = { sessionId, path: rel }
    if (force) args.force = true
    rpc('edrv.listDir', args).then((res) => {
      if (scopeRef.current !== scope || tokensRef.current !== tokens || tokens[rel] !== token) return
      if (res && res.ok && Array.isArray(res.entries)) {
        setDirs((prev) => Object.assign({}, prev, { [rel]: res.entries }))
        if (res.root) setRoot((prev) => prev || res.root)
        entriesCachePut(scope, rel, res.entries)
        if (doPrefetch) prefetchDirs(rel, res.entries)
      } else if (!entriesOf(rel)) {
        // 保留有缓存时的 SWR 降级；仅缺失的子目录自愈，根目录错误必须继续展示。
        const message = res?.error ? String(res.error) : '读取目录失败'
        if (rel && message.startsWith(MISSING_DIR_PREFIX)) {
          dropDeadDir(rel)
          return
        }
        setErrors((prev) => Object.assign({}, prev, { [rel]: message }))
      }
    }).catch((e) => {
      if (scopeRef.current !== scope || tokensRef.current !== tokens || tokens[rel] !== token) return
      if (!entriesOf(rel)) {
        setErrors((prev) => Object.assign({}, prev, { [rel]: '读取目录异常:' + String(e) }))
      }
    }).finally(() => {
      if (scopeRef.current !== scope || tokensRef.current !== tokens || tokens[rel] !== token) return
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

  /** @private @author ddj 2026年10月14号 @param path Safe relative file path. Expands only the ancestor chain and reuses available directory entries. */
  function prepareReveal(path) {
    const ancestors = ancestorDirsOf(path)
    setExpanded(expandParents)
    for (const dir of ['', ...ancestors]) {
      if (entriesOf(dir)) continue
      void loadDir(dir, { prefetch: false })
    }
    /** @private @author ddj 2026年10月14号 @param prev Current expansion map. @returns Expanded ancestor map. */
    function expandParents(prev) {
      const next = Object.assign({}, prev)
      for (const dir of ancestors) next[dir] = true
      return next
    }
  }

  const refresh = (event) => {
    if (event?.detail?.scope && event.detail.scope !== scope) return
    if (event?.detail?.paths?.length) { for (const path of event.detail.paths) onFileChanged(path); return }
    const keep = Object.keys(expandedRef.current).filter((k) => expandedRef.current[k] === true)
    tokensRef.current = {}
    loadingRef.current = {}
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
    // SVN 状态一并强制重测（检出 .svn / 卸载 svn 后可恢复菜单显隐）
    refreshSvnStatus(sessionId, scope)
    // 变更清单同样重查（目录重列后徽标要跟上；host 侧 TTL 内会被 force 绕过）
    refreshSvnChanges(sessionId, scope)
  }
  refreshRef.current = refresh
  reloadDirRef.current = loadDir

  /**
   * 磁盘文件变化（外部写入/删除/改名）：把变化路径的父目录并入待重列集合，
   * 去抖合并后对「已展开且存在」的目录强制重列（force 跳过 host 索引命中）。
   * host 侧 fileVersions 已顺手失效目录树缓存，这里补上「已渲染行」的即时刷新。
   * @author ddj 2026年09月15号
   * @param path 发生变化的文件路径（工作区相对；绝对路径按最长已展开祖先匹配）
   */
  const onFileChanged = (path) => {
    if (typeof path !== 'string' || !path) return
    const rel = path.replace(/\\/g, '/').replace(/^\.\//, '')
    const parts = rel.split('/').filter(Boolean)
    changedRelRef.current.add(parts.slice(0, -1).join('/'))
    // 绝对路径（或已在更深层目录）：补上所有已展开的祖先目录
    for (const dir of ancestorDirsOf(rel)) {
      if (expandedRef.current[dir] === true) changedRelRef.current.add(dir)
    }
    if (changedTimerRef.current) return
    changedTimerRef.current = window.setTimeout(() => {
      changedTimerRef.current = null
      const targets = [...changedRelRef.current]
      changedRelRef.current.clear()
      for (const dir of targets) {
        if (dir !== '' && expandedRef.current[dir] !== true) continue
        void reloadDirRef.current?.(dir, { force: true, prefetch: false })
      }
    }, FILE_CHANGE_DEBOUNCE_MS)
  }

  // edrv:file-changed（外部改动同步）：按变化路径强制重列对应目录（去抖合并）
  React.useEffect(() => {
    const handler = (event) => {
      if (event?.detail?.scope && event.detail.scope !== scopeRef.current) return
      for (const path of event?.detail?.paths ?? [event?.detail?.path]) onFileChanged(path)
    }
    window.addEventListener('edrv:file-changed', handler)
    return () => {
      window.removeEventListener('edrv:file-changed', handler)
      if (changedTimerRef.current) { clearTimeout(changedTimerRef.current); changedTimerRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    tokensRef.current = {}
    loadingRef.current = {}
    setDirs({})
    setExpanded({})
    setLoading({})
    setErrors({})
    setMenu(null)
    setRoot(null)
    // 恢复上次展开状态（对齐 VSCode：持久化展开路径，条目缓存即时渲染、后台刷新）
    const cached = scope ? explorerLoad(scope) : null
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
  }, [scope])

  // 展开状态防抖写回 localStorage（重启后恢复展开结构；按工作区作用域隔离）
  React.useEffect(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    if (!scope) return
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const expandedList = Object.keys(expanded).filter((k) => expanded[k] === true)
      explorerSave(scope, { root, expanded: expandedList })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    }
  }, [expanded, root, scope])

  // edrv:refresh（差异决策/回滚后）：保留旧条目，强制后台重列
  React.useEffect(() => {
    const onRefresh = (event) => refreshRef.current?.(event)
    window.addEventListener('edrv:refresh', onRefresh)
    return () => window.removeEventListener('edrv:refresh', onRefresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeTreePath = treeRevealPath(activePath)

  // 10s 轻量跟随：已展开目录后台刷新（命中 host 索引，近零成本），树跟随 agent 写入
  React.useEffect(() => {
    if (!scope) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      const open = Object.keys(expandedRef.current).filter((k) => expandedRef.current[k] === true)
      if (!open.length) return
      for (const rel of open) loadDirRef.current?.(rel, {})
    }, FOLLOW_INTERVAL_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  /** @private @author ddj 2026年10月22号 @returns Complete expanded model; icon-only updates do not flatten again. */
  function flatten() { return flattenTree(entriesOf, expanded, loading) }
  const treeRows = React.useMemo(flatten, [dirs, expanded, loading, scope])
  const previousRows = React.useRef({ scope, rows: treeRows })
  let anchoredTop = 0
  if (viewport.scope === scope) {
    anchoredTop = viewport.top
    if (previousRows.current.scope === scope && previousRows.current.rows !== treeRows) {
      anchoredTop = treeAnchorTop(previousRows.current.rows, treeRows, viewport.top)
    }
  }
  const currentViewport = { top: anchoredTop, height: viewport.height }
  const windowRows = treeWindow(treeRows.length, currentViewport)

  /** @private @author ddj 2026年10月22号 Read current geometry after scroll, resize or scope restoration. */
  function measureTree() {
    const host = treeRef.current
    if (!host || host.clientHeight <= 0) return
    setViewport({ scope, top: host.scrollTop, height: host.clientHeight })
  }
  const scrollFrame = React.useRef(null)
  /** @private @author ddj 2026年10月22号 Coalesce high-frequency scrolling into one measured render per frame. */
  function scrollTree() {
    if (scrollFrame.current !== null) return
    scrollFrame.current = requestAnimationFrame(readScroll)
  }
  /** @private @author ddj 2026年10月22号 Read only after the pending animation frame fires. */
  function readScroll() { scrollFrame.current = null; measureTree() }
  /** @private @author ddj 2026年10月22号 @returns Resize observer and pending frame cleanup. Keep hidden trees measurable when shown. */
  function watchTree() {
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measureTree) : null
    if (treeRef.current) observer?.observe(treeRef.current)
    measureTree()
    /** @private @author ddj 2026年10月22号 Stop all viewport callbacks owned by this scope. */
    function cleanup() {
      observer?.disconnect()
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
      scrollFrame.current = null
    }
    return cleanup
  }
  React.useLayoutEffect(watchTree, [scope])
  /** @private @author ddj 2026年10月22号 Clamp actual scroll after collapse, filtering, or workspace switch. */
  function clampTree() {
    const host = treeRef.current
    previousRows.current = { scope, rows: treeRows }
    if (!host || host.clientHeight <= 0) return
    if (host.scrollTop !== windowRows.top) host.scrollTop = windowRows.top
    if (viewport.scope !== scope || viewport.top !== windowRows.top) {
      setViewport({ scope, top: windowRows.top, height: host.clientHeight })
    }
  }
  React.useLayoutEffect(clampTree, [scope, windowRows.top, treeRows])
  /** @private @author ddj 2026年10月22号 @param path Requested file. @returns Whether its complete model row is available. */
  function locateTree(path) {
    const host = treeRef.current
    if (!host) return false
    const top = treeRevealTop(treeRows, path, { top: host.scrollTop, height: host.clientHeight })
    if (top === null) return false
    host.scrollTop = top
    setViewport({ scope, top, height: host.clientHeight })
    return true
  }
  // 定位由完整数据索引兑现，目标无需预先挂载 DOM；异步祖先加载后 hook 会重试。
  const { revealPath } = useExplorerReveal({ scope, activePath, treeRef, prepare: prepareReveal, locate: locateTree })
  /** @private @author ddj 2026年10月10号 @returns Stable RPC row projection, independent of icon-only renders. */
  function projectRows() { return treeRows.filter((row) => row.e).map((row) => ({ path: row.e.path, isDir: row.isDir })) }
  const svnRows = React.useMemo(projectRows, [treeRows])
  const svn = useExplorerSvn(ctx, svnRows)
  /** @private @author ddj 2026年10月10号 @param path Row path. @param isDir Row kind. Routes selection through latest callback. */
  function selectRow(path, isDir) { if (isDir) toggle(path); else openFile?.(path) }
  const selectRef = React.useRef(selectRow)
  selectRef.current = selectRow
  /** @private @author ddj 2026年10月10号 @param path Row path. @param type Entry type. @param event Context trigger. */
  function contextRow(path, type, event) {
    event.preventDefault(); event.stopPropagation()
    setMenu({ scope, x: event.clientX, y: event.clientY, target: { path, type } })
  }
  const onSelect = React.useCallback((path, isDir) => selectRef.current(path, isDir), [])
  const onContext = React.useCallback(contextRow, [scope])
  const rootName = root ? String(root).split(/[\\/]/).pop() || root : ''

  /** @private @author ddj 2026年10月10号 @param row Flat descriptor. @returns Memo row; unaffected status objects retain identity. */
  function renderRow(row) {
    if (!row.e) return React.createElement('div', { key: row.key, className: 'edrv-tree-loading', style: { paddingLeft: 6 + row.depth * 14 } }, row.text)
    const { e, depth, isDir, isOpen } = row
    return React.createElement(ExplorerRow, { key: e.path, path: e.path, name: e.name, type: e.type, depth, isDir, isOpen,
      pending: isDir ? 0 : pendingByPath[e.path] ?? 0, active: !isDir && e.path === activeTreePath,
      context: Boolean(menu && menuEntries.length && menu.target.path === e.path), reveal: revealPath === e.path,
      mark: svn.local?.get(e.path), remote: svn.remote?.get(e.path) ?? 0, onSelect, onContext })
  }

  // 面板区右键（空白处）→ 工作区根目录菜单；行内右键已在 rowEl 阻止冒泡。
  const onPanelContext = (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    if (!ev.currentTarget.contains(ev.target)) return
    setMenu({ scope, x: ev.clientX, y: ev.clientY, target: { path: '', type: 'directory' } })
  }
  const menuValid = menu?.scope === scope && (menu.target.path === '' || treeRows.some((row) => row.e?.path === menu.target.path))
  /** @private @author ddj 2026年10月22号 Close stale path menus instead of rebinding recycled rows. */
  function closeLostMenu() { if (menu && !menuValid) setMenu(null) }
  React.useEffect(closeLostMenu, [menu, menuValid])
  // 当前右键目标的可视菜单项（构建时过滤/排序，registry 变化下次打开生效）。
  const menuEntries = menuValid
    ? buildTreeMenu(ctx?.fileMenuItems, menu.target, ctx).map((item) => ({
        id: item.id,
        label: item.label,
        danger: item.danger,
        disabled: item.disabled,
        separator: item.separator,
        onClick: () => item.run(menu.target, ctx),
      }))
    : []

  /** @private @author ddj 2026年10月15号 Open the existing update window for the current project root. */
  function updateProject() { ctx?.openSvnUpdate?.('') }
  const updateHint = !ctx?.svn?.svnCli ? 'SVN CLI 不可用' : !ctx?.openSvnUpdate ? 'SVN 更新窗口不可用' : '更新项目（打开 SVN 更新窗口）'

  const errorList = Object.entries(errors)
  // 跨端会话缺失：裸错误替换为友好标题 + 详情（重试仍保留，会话在本端可用后即恢复）
  let rawErrorText = null
  if (errorList.length) {
    const [errorRel, message] = errorList[0]
    rawErrorText = message
    // 路径只在展示层追加，RPC 业务错误与异常均可定位；兼容已带路径的 host。
    if (errorRel && !message.endsWith('：' + errorRel)) rawErrorText += '：' + errorRel
  }
  const sessionMissing = isSessionMissingError(rawErrorText)
  const errorText = rawErrorText === null
    ? null
    : sessionMissing ? sessionMissingTitle() + '：' + sessionMissingDetail() : rawErrorText

  return React.createElement('div', { className: 'edrv-side-panel', onContextMenu: onPanelContext },
    React.createElement('div', { className: 'edrv-side-head' },
      React.createElement('span', { className: 'edrv-side-title' }, '资源管理器'),
      React.createElement('span', { className: 'edrv-side-root', title: root || '' }, rootName),
      React.createElement('span', { style: { flex: 1 } }),
      ctx?.svn?.managed ? React.createElement(Button, {
        variant: 'toolbar', size: 'sm', disabled: !ctx.svn.svnCli || !ctx.openSvnUpdate,
        title: updateHint, onClick: updateProject,
        'aria-label': '更新项目',
      }, '↓') : null,
      React.createElement('button', { className: 'edrv-side-btn', title: '刷新目录树', onClick: () => emitRefresh({ scope, kind: 'unknown' }) }, refreshIconEl())),
    svn.message ? React.createElement('div', { className: 'edrv-tree-status', role: 'status' }, svn.message) : null,
    (errorText
        ? React.createElement('div', { className: 'edrv-tree-error' },
            React.createElement('span', null, String(errorText)),
            React.createElement('button', { className: 'edrv-side-btn', onClick: () => emitRefresh({ scope, kind: 'unknown' }) }, '重试'))
        : null),
    React.createElement('div', { className: 'edrv-tree edrv-tree-virtual', ref: treeRef, onScroll: scrollTree },
      React.createElement('div', { 'aria-hidden': true, style: { height: windowRows.start * TREE_ROW_HEIGHT } }),
      treeRows.slice(windowRows.start, windowRows.end).map(renderRow),
      React.createElement('div', { 'aria-hidden': true, style: { height: (treeRows.length - windowRows.end) * TREE_ROW_HEIGHT } })),

    (menu && menuEntries.length
      ? React.createElement(ContextMenu, { x: menu.x, y: menu.y, entries: menuEntries, onClose: () => setMenu(null) })
      : null))
}
