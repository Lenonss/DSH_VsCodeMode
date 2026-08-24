// @ts-nocheck
/**
 * dsh-vscode-mode client — VSCodeMode 设置区内的 MCP 管理。
 * 子 Tab：我的 MCP（profile 全局）/ 项目 MCP（各项目 .mcp.json）/ MCP 市场（占位）。
 * 作者 ddj 2026年08月22号
 */
import React from 'react'
import { rpc } from '../rpc.js'
import type { MpcProject, MpcServer } from '../../shared/mcp.js'
import '../styles/mcp.css'

const EMPTY = { serverName: '', transport: 'stdio', command: '', args: '', cwd: '', url: '', headers: '' }

/** 将表单草稿转换为 Host MCP 配置。 */
function configOf(draft) {
  const config = { serverName: draft.serverName.trim(), transport: draft.transport }
  if (draft.transport === 'stdio') {
    config.command = draft.command.trim()
    config.args = draft.args.split(/\r?\n|\s+/).filter(Boolean)
    if (draft.cwd.trim()) config.cwd = draft.cwd.trim()
  } else {
    config.url = draft.url.trim()
    config.headers = parsePairs(draft.headers)
  }
  return config
}

/** 解析每行 key=value 的表单字段。 */
function parsePairs(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const idx = line.indexOf('=')
    return idx > 0 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : [line, '']
  }))
}

/** 服务状态文案。 */
function statusOf(server) {
  return server.status === 'connected' ? '在线' : server.status === 'connecting' ? '连接中' : server.status === 'disabled' ? '已禁用' : '错误'
}

/** MCP 服务卡片（全局与项目共用）。 */
function ServerCard({ server, onRefresh, onToggle, onRemove }) {
  return React.createElement('article', { className: 'vsm-mcp-card' },
    React.createElement('div', { className: 'vsm-mcp-card-head' },
      React.createElement('div', { className: 'vsm-mcp-title' }, React.createElement('span', { className: 'vsm-mcp-dot ' + (server.enabled ? server.status : 'disabled') }), server.serverName),
      React.createElement('div', { className: 'vsm-mcp-actions' },
        React.createElement('button', { onClick: () => onRefresh(server.id), title: '刷新连接' }, '↻'),
        React.createElement('button', { className: 'vsm-danger', onClick: () => onRemove(server.id), title: '删除 MCP' }, '⌫'),
        React.createElement('button', { className: 'vsm-switch ' + (server.enabled ? 'on' : ''), onClick: () => onToggle(server), 'aria-label': server.enabled ? '禁用' : '启用' }, server.enabled ? '●' : '○'),
      ),
    ),
    React.createElement('div', { className: 'vsm-mcp-meta' }, statusOf(server), ' · ', server.toolCount, ' 个工具 · ', server.transport),
    server.error && React.createElement('div', { className: 'vsm-mcp-error' }, server.error),
    React.createElement('div', { className: 'vsm-mcp-tools' }, server.tools.map((tool) => React.createElement('span', { key: tool.name, className: 'vsm-mcp-chip', title: tool.description || tool.name }, tool.name))),
  )
}

/** 按项目标题或路径过滤，大小写不敏感。 */
export function filterProjects(projects, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) return projects
  return projects.filter((project) => `${project.title} ${project.workspacePath}`.toLowerCase().includes(needle))
}

/** 带搜索的项目组合框。 */
function ProjectPicker({ projects, value, onChange }) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [highlight, setHighlight] = React.useState(0)
  const rootRef = React.useRef(null)
  const selected = projects.find((project) => project.workspacePath === value)
  const filtered = React.useMemo(() => filterProjects(projects, query), [projects, query])

  React.useEffect(() => {
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const choose = (project) => {
    onChange(project.workspacePath)
    setQuery('')
    setOpen(false)
  }
  const move = (delta) => setHighlight((old) => Math.max(0, Math.min(Math.max(0, filtered.length - 1), old + delta)))
  const keyDown = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Enter' && filtered[highlight]) { event.preventDefault(); choose(filtered[highlight]) }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
  }
  return React.createElement('div', { className: 'vsm-project-picker', ref: rootRef },
    React.createElement('button', { className: 'vsm-project-picker-trigger', role: 'combobox', 'aria-expanded': open, onClick: () => setOpen((old) => !old) },
      React.createElement('span', { className: 'vsm-project-picker-label' }, selected?.title || '选择项目', selected && React.createElement('small', null, selected.workspacePath)),
      React.createElement('span', { className: 'vsm-project-picker-arrow' }, open ? '⌃' : '⌄'),
    ),
    open && React.createElement('div', { className: 'vsm-project-picker-menu' },
      React.createElement('input', { autoFocus: true, className: 'vsm-project-picker-search', value: query, placeholder: '搜索项目名称或路径…', onChange: (event) => { setQuery(event.target.value); setHighlight(0) }, onKeyDown: keyDown }),
      React.createElement('div', { className: 'vsm-project-picker-options', role: 'listbox' }, filtered.length ? filtered.map((project, index) => React.createElement('button', { key: project.workspacePath, role: 'option', 'aria-selected': project.workspacePath === value, className: 'vsm-project-option ' + (index === highlight ? 'highlight' : '') + (project.workspacePath === value ? ' selected' : ''), onMouseEnter: () => setHighlight(index), onClick: () => choose(project) }, React.createElement('span', null, project.title), React.createElement('small', null, project.workspacePath, ' · ', project.servers.length, ' 个 MCP'))) : React.createElement('div', { className: 'vsm-project-picker-empty' }, '没有匹配的项目')),
    ),
  )
}

/** 单个项目的 MCP 分组。 */
function ProjectGroup({ project, busy, onAdd, onRefresh, onToggle, onRemove }) {
  const head = React.createElement('div', { className: 'vsm-project-head' },
    React.createElement('div', { className: 'vsm-project-title' }, React.createElement('span', { className: 'vsm-project-icon' }, '▣'), React.createElement('div', null, React.createElement('span', { className: 'vsm-project-name' }, project.title), React.createElement('span', { className: 'vsm-project-path' }, project.workspacePath))),
    React.createElement('button', { className: 'vsm-primary vsm-small', onClick: () => onAdd(project) }, '+ 添加 MCP'),
  )
  let body
  if (project.missingDir) body = React.createElement('div', { className: 'vsm-project-empty' }, '项目目录已不存在，无法管理 MCP')
  else if (project.fileError) body = React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, project.fileError)
  else if (!project.servers.length) body = React.createElement('div', { className: 'vsm-project-empty' }, '此项目未配置 MCP')
  else body = project.servers.map((server) => React.createElement(ServerCard, { key: server.serverName, server, onRefresh: (id) => onRefresh(project, server, id), onToggle: () => onToggle(project, server), onRemove: (id) => onRemove(project, server, id) }))
  return React.createElement('section', { className: 'vsm-project' }, head, body)
}

/** MCP 管理主面板。 */
export function McpSettings() {
  const [servers, setServers] = React.useState<MpcServer[]>([])
  const [projects, setProjects] = React.useState<MpcProject[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [tab, setTab] = React.useState('mine')
  const [draft, setDraft] = React.useState(EMPTY)
  const [showForm, setShowForm] = React.useState(false)
  const [projectForm, setProjectForm] = React.useState(null)
  const [selectedPath, setSelectedPath] = React.useState('')

  React.useEffect(() => {
    if (!projects.length) {
      setSelectedPath('')
      return
    }
    if (!projects.some((project) => project.workspacePath === selectedPath)) setSelectedPath(projects[0].workspacePath)
  }, [projects, selectedPath])

  const loadAll = React.useCallback(() => {
    setLoading(true)
    setError('')
    Promise.all([rpc('mcp.list', {}), rpc('mcp.projects', {})]).then(([list, prj]) => {
      if (!list.ok) throw new Error(list.error)
      if (!prj.ok) throw new Error(prj.error)
      setServers(list.servers)
      setProjects(prj.projects)
    }).catch((e) => setError(String(e))).finally(() => setLoading(false))
  }, [])

  React.useEffect(loadAll, [loadAll])

  const finish = (result) => {
    if (!result.ok) throw new Error(result.error)
    return result
  }

  const action = (label, id, method, args, patch) => {
    setBusy(id)
    setError('')
    return rpc(method, args).then(finish).then((result) => {
      if (patch) patch(result)
    }).catch((e) => setError(String(e))).finally(() => setBusy('')).then(() => label)
  }

  const refreshGlobal = (id) => action('refresh', id, 'mcp.refresh', { id }, (r) => setServers((old) => old.map((s) => s.id === id ? r.server : s)))
  const toggleGlobal = (s) => action('toggle', s.id, 'mcp.toggle', { id: s.id, enabled: !s.enabled }, (r) => setServers((old) => old.map((x) => x.id === s.id ? r.server : x)))
  const removeGlobal = (s) => window.confirm('确认删除此 MCP 服务？') && action('remove', s.id, 'mcp.remove', { id: s.id }, (r) => setServers((old) => old.filter((x) => x.id !== s.id)))

  const replaceProject = (workspacePath) => (result) => setProjects((old) => old.map((p) => p.workspacePath === workspacePath ? result.project : p))
  const projectAction = (workspacePath, serverName, method, args, patch) => {
    setBusy(workspacePath + ':' + serverName)
    setError('')
    return rpc(method, args).then(finish).then((result) => {
      if (patch) patch(result)
    }).catch((e) => setError(String(e))).finally(() => setBusy(''))
  }

  const refreshProject = (p, s) => projectAction(p.workspacePath, s.serverName, 'mcp.projectRefresh', { workspacePath: p.workspacePath, serverName: s.serverName }, replaceProject(p.workspacePath))
  const toggleProject = (p, s) => projectAction(p.workspacePath, s.serverName, 'mcp.projectToggle', { workspacePath: p.workspacePath, serverName: s.serverName, enabled: !s.enabled }, replaceProject(p.workspacePath))
  const removeProject = (p, s) => window.confirm('确认删除此项目的 MCP「' + s.serverName + '」？') && projectAction(p.workspacePath, s.serverName, 'mcp.projectRemove', { workspacePath: p.workspacePath, serverName: s.serverName }, replaceProject(p.workspacePath))

  const saveGlobal = () => {
    setBusy('save')
    setError('')
    rpc('mcp.save', { config: configOf(draft) }).then(finish).then((result) => {
      setServers((old) => old.some((s) => s.id === result.server.id) ? old.map((s) => s.id === result.server.id ? result.server : s) : old.concat(result.server))
      setDraft(EMPTY)
      setShowForm(false)
    }).catch((e) => setError(String(e))).finally(() => setBusy(''))
  }

  const saveProject = () => {
    if (!projectForm) return
    setBusy('project-save')
    setError('')
    const config = configOf(draft)
    rpc('mcp.projectSave', { workspacePath: projectForm.workspacePath, serverName: config.serverName, config }).then(finish).then((result) => {
      setProjects((old) => old.map((p) => p.workspacePath === projectForm.workspacePath ? result.project : p))
      setDraft(EMPTY)
      setProjectForm(null)
    }).catch((e) => setError(String(e))).finally(() => setBusy(''))
  }

  const edit = (key, value) => setDraft((old) => ({ ...old, [key]: value }))
  const marketBody = React.createElement('div', { className: 'vsm-mcp-empty' }, 'MCP 市场暂未接入')
  const selectedProject = projects.find((project) => project.workspacePath === selectedPath)
  const projectBody = projects.length ? React.createElement(React.Fragment, null,
    React.createElement(ProjectPicker, { projects, value: selectedPath, onChange: setSelectedPath }),
    selectedProject ? React.createElement(ProjectGroup, { project: selectedProject, busy, onAdd: (project) => { setDraft(EMPTY); setProjectForm({ workspacePath: project.workspacePath, title: project.title }) }, onRefresh: refreshProject, onToggle: toggleProject, onRemove: removeProject }) : React.createElement('div', { className: 'vsm-mcp-empty' }, '请选择项目'),
  ) : React.createElement('div', { className: 'vsm-mcp-empty' }, '还没有项目')
  let body
  if (loading) body = React.createElement('div', { className: 'vsm-mcp-empty' }, '正在读取 MCP 服务…')
  else if (tab === 'mine') body = React.createElement('div', null, servers.length ? servers.map((s) => React.createElement(ServerCard, { key: s.id, server: s, onRefresh: refreshGlobal, onToggle: toggleGlobal, onRemove: removeGlobal })) : React.createElement('div', { className: 'vsm-mcp-empty' }, '还没有配置全局 MCP'))
  else if (tab === 'projects') body = projectBody
  else body = marketBody
  const form = showForm ? React.createElement(McpForm, { title: '添加全局 MCP', draft, busy, edit, save: saveGlobal, close: () => setShowForm(false) }) : projectForm ? React.createElement(McpForm, { title: '添加项目 MCP · ' + projectForm.title, draft, busy, edit, save: saveProject, close: () => setProjectForm(null) }) : null
  return React.createElement('section', { className: 'vsm-mcp-page' },
    React.createElement('header', { className: 'vsm-mcp-header' }, React.createElement('div', null, React.createElement('h2', null, 'VSCodeMode'), React.createElement('p', null, '管理当前 profile 与各项目的 Model Context Protocol 服务。')), React.createElement('button', { className: 'vsm-primary', onClick: () => { setDraft(EMPTY); setShowForm(true) } }, '+ 添加全局 MCP')),
    React.createElement('nav', { className: 'vsm-mcp-tabs' }, React.createElement('button', { className: tab === 'mine' ? 'active' : '', onClick: () => setTab('mine') }, '我的 MCP'), React.createElement('button', { className: tab === 'projects' ? 'active' : '', onClick: () => setTab('projects') }, '项目 MCP'), React.createElement('button', { className: tab === 'market' ? 'active' : '', onClick: () => setTab('market') }, 'MCP 市场')),
    error && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error),
    body,
    form,
  )
}

/** MCP 新增表单（全局/项目共用）。 */
function McpForm({ title, draft, busy, edit, save, close }) {
  const input = (key, placeholder) => React.createElement('input', { value: draft[key], onChange: (e) => edit(key, e.target.value), placeholder })
  const fields = draft.transport === 'stdio' ? React.createElement(React.Fragment, null, React.createElement('label', null, '命令', input('command', 'npx')), React.createElement('label', null, '参数（空格或换行分隔）', React.createElement('textarea', { value: draft.args, onChange: (e) => edit('args', e.target.value) })), React.createElement('label', null, '工作目录（可选）', input('cwd', ''))) : React.createElement(React.Fragment, null, React.createElement('label', null, 'URL', input('url', 'http://localhost:3000/mcp')), React.createElement('label', null, '请求头（每行 key=value）', React.createElement('textarea', { value: draft.headers, onChange: (e) => edit('headers', e.target.value) })))
  return React.createElement('div', { className: 'vsm-mcp-modal' }, React.createElement('div', { className: 'vsm-mcp-dialog' }, React.createElement('h3', null, title), React.createElement('label', null, '名称', input('serverName', '例如 codegraph')), React.createElement('label', null, '传输方式', React.createElement('select', { value: draft.transport, onChange: (e) => edit('transport', e.target.value) }, React.createElement('option', { value: 'stdio' }, 'stdio'), React.createElement('option', { value: 'streamable-http' }, 'streamable-http'))), fields, React.createElement('div', { className: 'vsm-mcp-dialog-actions' }, React.createElement('button', { onClick: close }, '取消'), React.createElement('button', { className: 'vsm-primary', disabled: busy === 'save' || busy === 'project-save', onClick: save }, '保存并连接'))))
}
