// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏「文件管理」面板（懒加载目录树）。
 * 点目录展开/收起（首次经 edrv.listDir 拉取并缓存），点文件经 ctx.openFile 打开；
 * 差异角标取 pendingByPath，活动文件高亮；edrv:refresh 事件与手动刷新重载树。
 * 右键行/空白弹出菜单：项来自 ctx.fileMenuItems 注册表（可拓展），
 * 内置「在文件浏览器中打开」经 edrv.revealInExplorer 定位/打开。
 * 作者 ddj 2026-08-26 / 2026-08-27
 */
import React from 'react'
import { rpc } from '../../rpc.js'
import { ContextMenu } from '../../ui/ContextMenu.js'
import { buildTreeMenu } from '../contextMenu.js'
import type { SidebarCtx } from '../types.js'

const DIR_CAP = 4000

/**
 * 目录树面板主体。
 * @param props.ctx 面板共享上下文（sessionId/openFile/activePath/pendingByPath/fileMenuItems/notify）
 */
export function FileExplorer(props) {
  const ctx = props?.ctx
  const sessionId = ctx?.sessionId
  const openFile = ctx?.openFile
  const activePath = ctx?.activePath ?? null
  const pendingByPath = ctx?.pendingByPath ?? {}
  const [root, setRoot] = React.useState(null)
  const [dirs, setDirs] = React.useState({})
  const [expanded, setExpanded] = React.useState({})
  const [loading, setLoading] = React.useState({})
  const [error, setError] = React.useState(null)
  const [menu, setMenu] = React.useState(null) // 右键菜单 { x, y, target }
  const tokensRef = React.useRef({})
  // expanded 的 ref 镜像：edrv:refresh 监听用首次渲染闭包，但需读到最新展开态
  const expandedRef = React.useRef({})
  expandedRef.current = expanded

  const loadDir = (rel) => {
    const token = (tokensRef.current[rel] || 0) + 1
    tokensRef.current[rel] = token
    setLoading((prev) => Object.assign({}, prev, { [rel]: true }))
    setError(null)
    rpc('edrv.listDir', { sessionId, path: rel }).then((res) => {
      if (tokensRef.current[rel] !== token) return
      if (res && res.ok && Array.isArray(res.entries)) {
        setDirs((prev) => Object.assign({}, prev, { [rel]: res.entries }))
        if (res.root && !root) setRoot(res.root)
      } else {
        setError(res?.error ? String(res.error) : '读取目录失败')
      }
    }).catch((e) => {
      if (tokensRef.current[rel] !== token) return
      setError('读取目录异常:' + String(e))
    }).finally(() => {
      if (tokensRef.current[rel] !== token) return
      setLoading((prev) => {
        const next = Object.assign({}, prev)
        delete next[rel]
        return next
      })
    })
  }

  const toggle = (rel) => {
    if (expanded[rel] === true) {
      setExpanded((prev) => Object.assign({}, prev, { [rel]: false }))
      return
    }
    if (!dirs[rel]) void loadDir(rel)
    setExpanded((prev) => Object.assign({}, prev, { [rel]: true }))
  }

  const refresh = () => {
    const keep = Object.keys(expandedRef.current).filter((k) => expandedRef.current[k] === true)
    tokensRef.current = {}
    setDirs({})
    setLoading({})
    setError(null)
    if (keep.length) {
      const next = {}
      for (const rel of keep) next[rel] = true
      setExpanded(next)
      for (const rel of keep) void loadDir(rel)
    } else {
      setExpanded({})
    }
    void loadDir('')
  }

  React.useEffect(() => {
    tokensRef.current = {}
    setDirs({})
    setExpanded({})
    setLoading({})
    setError(null)
    setRoot(null)
    void loadDir('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  React.useEffect(() => {
    const onRefresh = () => refresh()
    window.addEventListener('edrv:refresh', onRefresh)
    return () => window.removeEventListener('edrv:refresh', onRefresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rootName = root ? String(root).split(/[\\/]/).pop() || root : ''

  const rowEl = (e, depth, isDir, isOpen) => {
    const pending = isDir ? 0 : (pendingByPath[e.path] ?? 0)
    const active = !isDir && e.path === activePath
    const dim = e.type === 'other'
    return React.createElement('div', {
      key: e.path,
      className: 'edrv-tree-row' + (active ? ' edrv-tree-active' : ''),
      title: e.path,
      style: { paddingLeft: 6 + depth * 14 },
      onClick: () => { if (isDir) toggle(e.path); else openFile(e.path) },
      onContextMenu: (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
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
    const entries = dirs[rel]
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

  return React.createElement('div', { className: 'edrv-side-panel', onContextMenu: onPanelContext },
    React.createElement('div', { className: 'edrv-side-head' },
      React.createElement('span', { className: 'edrv-side-title' }, '资源管理器'),
      React.createElement('span', { className: 'edrv-side-root', title: root || '' }, rootName),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', { className: 'edrv-side-btn', title: '刷新目录树', onClick: refresh }, '⟳')),
    React.createElement('div', { className: 'edrv-tree' },
      (error
        ? React.createElement('div', { className: 'edrv-tree-error' },
            React.createElement('span', null, String(error)),
            React.createElement('button', { className: 'edrv-side-btn', onClick: () => refresh() }, '重试'))
        : null),
      rowsOf('', 0)),
    (menu && menuEntries.length
      ? React.createElement(ContextMenu, { x: menu.x, y: menu.y, entries: menuEntries, onClose: () => setMenu(null) })
      : null))
}
