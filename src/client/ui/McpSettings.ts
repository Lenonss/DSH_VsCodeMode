// @ts-nocheck
/**
 * dsh-vscode-mode client — VSCodeMode 设置区：通用 / MCP 管理 / 语言服务器 / 性能优化 / 兼容性。
 * （快捷键统一由 DSH 官方快捷键机制管理：通用页只提供「打开官方快捷键配置」跳转入口，
 *   插件不再自建录键编辑器，也不再注册独立「快捷键」设置区。）
 * MCP 管理 Tab 下含三个子页签：我的 MCP（profile 全局）/ 项目 MCP（各项目 .mcp.json）/ MCP 市场（占位）。
 * 作者 ddj 2026年08月22号 / 2026年08月26号 / 2026年08月27号 / 2026年10月
 */
import React from 'react'
import { rpc } from '../rpc.js'
import type { MpcProject, MpcServer } from '../../shared/mcp.js'
import { configOf } from '../mcpForm.js'
import { McpState } from '../mcpState.js'
import { statusOf, statusTone } from '../../shared/mcpStatus.js'
import '../styles/mcp.css'
import { availableOpeners, AUTO_OPEN_TOOL } from '../fileOpeners.js'
import { SettingsContext } from '../settingsContext.js'
import { openOfficialShortcuts } from '../shortcutsOfficial.js'
import { normalizeSidebarMinWidth, SIDEBAR_MIN_DEFAULT } from '../sidebarMin.js'
import { EDITOR_LIMIT_CEIL, EDITOR_LIMIT_DEFAULT, normalizeMaxOpenEditors } from '../../shared/editorLimit.js'
import { TORTOISE_DIR_DEFAULT } from '../../shared/svn.js'
import { DEFAULT_NATIVE_CSV } from '../../shared/nativeOpen.js'
import { LspSettings } from './LspSettings.js'
import { PerfSettings } from './PerfSettings.js'
import { IntegrationSettings } from './IntegrationSettings.js'
import { AiSettings } from './AiSettings.js'

const EMPTY = { serverName: '', transport: 'stdio', command: '', args: '', cwd: '', url: '', headers: '' }

/** @private @author ddj 2026年10月08号 @param props Server snapshot, page-wide busy state and actions. @returns Lifecycle-evidence card; enabled does not imply online. */
function ServerCard({ server, busy, onRefresh, onToggle, onRemove }) {
  return React.createElement('article', { className: 'vsm-mcp-card' },
    React.createElement('div', { className: 'vsm-mcp-card-head' },
      React.createElement('div', { className: 'vsm-mcp-title' }, React.createElement('span', { className: 'vsm-mcp-dot ' + statusTone(server) }), server.serverName),
      React.createElement('div', { className: 'vsm-mcp-actions' },
        React.createElement('button', { disabled: !!busy, onClick: () => onRefresh(server.id), title: '重新装配会话实例' }, '↻'),
        React.createElement('button', { disabled: !!busy, className: 'vsm-danger', onClick: () => onRemove(server.id), title: '删除 MCP' }, '⌫'),
        React.createElement('button', { disabled: !!busy, className: 'vsm-switch ' + (server.enabled ? 'on' : ''), onClick: () => onToggle(server), title: '配置启用不代表连接在线', 'aria-label': server.enabled ? '禁用配置（不代表在线）' : '启用配置（不代表在线）', 'aria-pressed': !!server.enabled }, server.enabled ? '●' : '○'),
      ),
    ),
    React.createElement('div', { className: 'vsm-mcp-meta' }, statusOf(server), ' · ', server.toolCount, ' 个工具 · ', server.transport,
      server.instanceCount !== undefined ? ' · ' + server.instanceCount + ' 个会话实例（各自连接）' : ''),
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

/** @private @author ddj 2026年10月08号 @param props Project view, shared busy lock and actions. @returns Project cards with actions disabled for any active mutation. */
function ProjectGroup({ project, busy, onAdd, onRefresh, onToggle, onRemove }) {
  const head = React.createElement('div', { className: 'vsm-project-head' },
    React.createElement('div', { className: 'vsm-project-title' }, React.createElement('span', { className: 'vsm-project-icon' }, '▣'), React.createElement('div', null, React.createElement('span', { className: 'vsm-project-name' }, project.title), React.createElement('span', { className: 'vsm-project-path' }, project.workspacePath))),
    React.createElement('button', { className: 'vsm-primary vsm-small', disabled: !!busy, onClick: () => onAdd(project) }, '+ 添加 MCP'),
  )
  let body
  if (project.missingDir) body = React.createElement('div', { className: 'vsm-project-empty' }, '项目目录已不存在，无法管理 MCP')
  else if (project.fileError) body = React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, project.fileError)
  else if (!project.servers.length) body = React.createElement('div', { className: 'vsm-project-empty' }, '此项目未配置 MCP')
  else body = project.servers.map((server) => React.createElement(ServerCard, { key: server.serverName, server, busy, onRefresh: (id) => onRefresh(project, server, id), onToggle: () => onToggle(project, server), onRemove: (id) => onRemove(project, server, id) }))
  return React.createElement('section', { className: 'vsm-project' }, head, body)
}

/** 通用设置：选择当前对话文件链接的打开器 + 开发形态开关 + 编辑器布局（侧边栏最小宽度）+ 官方快捷键入口。 */
function GeneralSettings({ registry, getShortcuts }) {
  const [tool, setTool] = React.useState(AUTO_OPEN_TOOL)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [devForm, setDevForm] = React.useState(null)
  const [devBusy, setDevBusy] = React.useState(false)
  const [devMessage, setDevMessage] = React.useState('')
  const [minW, setMinW] = React.useState(SIDEBAR_MIN_DEFAULT)
  const [minDraft, setMinDraft] = React.useState(null) // 输入草稿（null=跟随已保存值；blur/Enter 提交）
  const [limit, setLimit] = React.useState(EDITOR_LIMIT_DEFAULT)
  const [limitDraft, setLimitDraft] = React.useState(null) // 页签上限草稿（同上提交语义）
  const [nativeSaved, setNativeSaved] = React.useState(DEFAULT_NATIVE_CSV) // 原生打开范围已保存值
  const [nativeDraft, setNativeDraft] = React.useState(null) // 原生打开范围草稿（同上提交语义）
  const [kbMessage, setKbMessage] = React.useState('') // 打开官方快捷键弹窗的失败说明（空 = 未失败）
  const settings = React.useContext(SettingsContext)
  const snapshot = settings?.getSnapshot?.()
  const loading = !snapshot || snapshot.status === 'loading'
  const unavailable = snapshot?.status === 'unavailable' || !settings
  const notReady = snapshot?.status !== 'ready'
  React.useEffect(() => {
    const onChange = () => {
      const snap = settings?.getSnapshot?.()
      const next = snap?.value?.fileOpenTool
      if (typeof next === 'string') setTool(next)
      setMinW(normalizeSidebarMinWidth(snap?.value?.sidebarMinWidth))
      setLimit(normalizeMaxOpenEditors(snap?.value?.maxOpenEditors))
      const native = snap?.value?.nativeOpenExts
      setNativeSaved(typeof native === 'string' && native.trim() ? native : DEFAULT_NATIVE_CSV)
    }
    onChange()
    return settings?.subscribe?.(onChange)
  }, [settings])
  React.useEffect(() => {
    rpc('vscode.devFormGet', {}).then((result) => {
      if (result.ok) setDevForm(result.devForm)
    }).catch(() => { /* 开发形态查询失败静默 */ })
  }, [])
  const save = (value) => {
    setTool(value); setBusy(true); setError('')
    if (!settings?.set) { setError('设置服务不可用'); setBusy(false); return }
    settings.set('fileOpenTool', value).catch((e) => setError(String(e))).finally(() => setBusy(false))
  }
  /** 提交侧边栏最小宽度（归一化夹取 180–560 后持久化）。 */
  const saveMinW = (raw) => {
    const next = normalizeSidebarMinWidth(raw)
    setMinW(next); setBusy(true); setError('')
    if (!settings?.set) { setError('设置服务不可用'); setBusy(false); return }
    settings.set('sidebarMinWidth', next).catch((e) => setError(String(e))).finally(() => setBusy(false))
  }
  /** 结束输入（blur/Enter）时提交草稿。 */
  const commitMinW = () => {
    if (minDraft === null) return
    setMinDraft(null)
    saveMinW(minDraft)
  }
  /** 提交页签数量上限（归一化夹取 0–50 后持久化；0 = 不限制）。 */
  const saveLimit = (raw) => {
    const next = normalizeMaxOpenEditors(raw)
    setLimit(next); setBusy(true); setError('')
    if (!settings?.set) { setError('设置服务不可用'); setBusy(false); return }
    settings.set('maxOpenEditors', next).catch((e) => setError(String(e))).finally(() => setBusy(false))
  }
  /** 结束输入（blur/Enter）时提交页签上限草稿。 */
  const commitLimit = () => {
    if (limitDraft === null) return
    setLimitDraft(null)
    saveLimit(limitDraft)
  }
  /** 提交原生打开范围（逗号分隔后缀；空串回落默认让位清单后持久化）。 */
  const saveNative = (raw) => {
    const next = String(raw ?? '').trim() || DEFAULT_NATIVE_CSV
    setNativeSaved(next); setNativeDraft(null); setBusy(true); setError('')
    if (!settings?.set) { setError('设置服务不可用'); setBusy(false); return }
    settings.set('nativeOpenExts', next).catch((e) => setError(String(e))).finally(() => setBusy(false))
  }
  /** 结束输入（blur/Enter）时提交原生打开范围草稿。 */
  const commitNative = () => {
    if (nativeDraft === null) return
    saveNative(nativeDraft)
  }
  const closeDevForm = () => {
    if (!window.confirm('关闭开发形态：插件将切换为正式版安装（版本依赖 + 删除工作区链接），pnpm 装配后需重启 DSH 生效。确认关闭？')) return
    setDevBusy(true)
    setDevMessage('')
    rpc('vscode.devFormSet', { enabled: false }).then((result) => {
      if (!result.ok) { setDevMessage('关闭失败：' + String(result.error)); return }
      setDevForm(result.devForm)
      setDevMessage(result.restart ? '已切换为正式版，重启 DSH 后生效。' : '已关闭开发形态。')
    }).catch((e) => setDevMessage('关闭失败：' + String(e))).finally(() => setDevBusy(false))
  }
  /**
   * 唤起官方快捷键弹窗（键位统一归官方机制；入口不可用时展示手动打开方式）。
   * @author ddj 2026年09月28号
   */
  const openShortcuts = () => {
    const probe = typeof getShortcuts === 'function' ? getShortcuts : () => null
    setKbMessage(openOfficialShortcuts(probe()))
  }
  const options = [{ id: AUTO_OPEN_TOOL, label: '自动选择', description: '按当前已注册工具自动选择' }, ...availableOpeners(registry).map((item) => ({ id: item.id, label: item.label, description: item.description }))]
  const currentOption = options.some((item) => item.id === tool) ? tool : AUTO_OPEN_TOOL
  const devFormRow = devForm?.enabled ? React.createElement('div', { className: 'vsm-general-row' },
    React.createElement('span', null, '开发形态', React.createElement('small', { className: 'vsm-devform-note' }, '工作区链接安装：' + devForm.path)),
    React.createElement('div', { className: 'vsm-devform-actions' },
      devMessage && React.createElement('small', { className: 'vsm-devform-msg' }, devMessage),
      React.createElement('button', { className: 'vsm-devform-close', disabled: devBusy, onClick: closeDevForm }, devBusy ? '切换中…' : '关闭开发形态'),
    ),
  ) : null
  return React.createElement('section', { className: 'vsm-general-page' },
    React.createElement('h2', null, '通用'),
    React.createElement('p', null, '配置 DSH 对话中文件链接的打开工具。工具由当前运行时自动扫描。'),
    unavailable && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, '设置服务暂不可用，当前使用自动选择。'),
    error && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error),
    React.createElement('section', { className: 'vsm-panel' },
      React.createElement('h3', { className: 'vsm-panel-title' }, '文件与安装'),
      React.createElement('div', { className: 'vsm-panel-body' },
        React.createElement('label', { className: 'vsm-general-row' }, React.createElement('span', null, '文件链接使用工具'), React.createElement('select', { value: currentOption, disabled: loading || unavailable || notReady || busy || snapshot?.writable === false, onChange: (event) => save(event.target.value) }, options.map((item) => React.createElement('option', { key: item.id, value: item.id }, item.label))), loading && React.createElement('small', null, '读取中…')),
        devFormRow,
      ),
    ),
    React.createElement('section', { className: 'vsm-panel' },
      React.createElement('h3', { className: 'vsm-panel-title' }, '编辑器'),
      React.createElement('div', { className: 'vsm-panel-body' },
        React.createElement('label', { className: 'vsm-general-row' },
          React.createElement('span', null, '侧边栏最小宽度'),
          React.createElement('input', {
            type: 'number', min: 180, max: 560, step: 10,
            value: minDraft ?? minW,
            disabled: loading || unavailable || notReady || busy || snapshot?.writable === false,
            title: '180–560 px；拖拽侧边栏低于该宽度时自动隐藏',
            onChange: (event) => setMinDraft(event.target.value),
            onBlur: commitMinW,
            onKeyDown: (event) => { if (event.key === 'Enter') commitMinW() },
          }),
          React.createElement('small', null, '180–560 px；拖拽低于该宽度自动隐藏')),
        React.createElement('label', { className: 'vsm-general-row' },
          React.createElement('span', null, '页签数量上限'),
          React.createElement('input', {
            type: 'number', min: 0, max: EDITOR_LIMIT_CEIL, step: 1,
            value: limitDraft ?? limit,
            disabled: loading || unavailable || notReady || busy || snapshot?.writable === false,
            title: '0 = 不限制；超出上限时自动关闭最久未使用的页签（固定页签不受影响）',
            onChange: (event) => setLimitDraft(event.target.value),
            onBlur: commitLimit,
            onKeyDown: (event) => { if (event.key === 'Enter') commitLimit() },
          }),
          React.createElement('small', null, '0 = 不限制；超限时关闭最久未使用的页签（固定页签除外）')),
        React.createElement('label', { className: 'vsm-general-row' },
          React.createElement('span', null, '原生打开范围'),
          React.createElement('input', {
            type: 'text',
            value: nativeDraft ?? nativeSaved,
            disabled: loading || unavailable || notReady || busy || snapshot?.writable === false,
            title: '逗号分隔后缀（如 doc,xlsx）：文件树点击命中时用 DSH 官方预览原生打开；留空 = 默认让位清单（Office + 不可预览二进制）',
            placeholder: 'doc,xlsx,…（留空恢复默认）',
            onChange: (event) => setNativeDraft(event.target.value),
            onBlur: commitNative,
            onKeyDown: (event) => { if (event.key === 'Enter') commitNative() },
          }),
          React.createElement('small', null, '逗号分隔；命中的文件用 DSH 原生预览打开，留空恢复默认（Office + 二进制，csv/tsv 需显式加入）')),
      ),
    ),
    React.createElement('section', { className: 'vsm-panel' },
      React.createElement('h3', { className: 'vsm-panel-title' }, '快捷键'),
      React.createElement('div', { className: 'vsm-panel-body' },
        React.createElement('label', { className: 'vsm-general-row' },
          React.createElement('span', null, '键位配置',
            React.createElement('small', { className: 'vsm-devform-note' },
              '插件命令（edrv.*）与 DSH 官方命令的键位统一由官方快捷键机制管理：录键、冲突校验、按平台默认值、恢复默认都在官方弹窗内完成；本插件不再单独提供录键编辑器。')),
          React.createElement('button', { onClick: openShortcuts }, '打开官方快捷键配置')),
        kbMessage && React.createElement('small', { className: 'vsm-devform-msg' }, kbMessage)),
    ),
    React.createElement(SvnSettingsSection, null),
    React.createElement(IntegrationSettings, null),
  )
}

/** 检测快照 → 一行状态文案（未检测/未检出/能力可用性）。 */
function svnStatusText(info) {
  if (!info) return '未检测（打开编辑器后自动检测）'
  if (!info.managed) return '当前工作区不受 SVN 管理（SVN 入口隐藏）'
  const parts = [info.svnCli ? 'svn CLI 可用' : 'svn CLI 不可用（更新不可用）']
  parts.push(info.tortoise ? 'TortoiseSVN 可用' : 'TortoiseSVN 不可用（仅 Windows）')
  return '受 SVN 管理 · ' + parts.join(' · ')
}

/**
 * SVN 设置节：路径覆盖 + 检测状态行。
 * 写入经 SettingsContext（namespace dsh-vscode-mode）；状态经 svn.status 直测（force），
 * 并监听 edrv:svn-status 事件跟随编辑器侧重测结果刷新。
 * @author ddj 2026年09月16号
 */
function SvnSettingsSection() {
  const settings = React.useContext(SettingsContext)
  const snapshot = settings?.getSnapshot?.()
  const loading = !snapshot || snapshot.status === 'loading'
  const unavailable = snapshot?.status === 'unavailable' || !settings
  const notReady = snapshot?.status !== 'ready'
  const [svnPath, setSvnPath] = React.useState('')
  const [svnDraft, setSvnDraft] = React.useState(null)
  const [tortoisePath, setTortoisePath] = React.useState('')
  const [tortoiseDraft, setTortoiseDraft] = React.useState(null)
  const [svnInfo, setSvnInfo] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    const onChange = () => {
      const snap = settings?.getSnapshot?.()
      setSvnPath(typeof snap?.value?.svnPath === 'string' ? snap.value.svnPath : '')
      setTortoisePath(typeof snap?.value?.tortoisePath === 'string' ? snap.value.tortoisePath : '')
    }
    onChange()
    return settings?.subscribe?.(onChange)
  }, [settings])
  const probe = React.useCallback(() => {
    rpc('svn.status', { force: true }).then((res) => {
      if (res.ok) { setSvnInfo(res); setError('') }
      else setSvnInfo(null)
    }).catch(() => setSvnInfo(null))
  }, [])
  React.useEffect(() => { probe() }, [probe])
  React.useEffect(() => {
    const onSvnStatus = () => probe()
    window.addEventListener('edrv:svn-status', onSvnStatus)
    return () => window.removeEventListener('edrv:svn-status', onSvnStatus)
  }, [probe])
  /** 提交路径字段（blur/Enter 共用；成功后强制重测反映新路径）。 */
  const savePath = (key, value, apply) => {
    setBusy(true); setError('')
    if (!settings?.set) { setError('设置服务不可用'); setBusy(false); return }
    settings.set(key, value).then(() => { apply(); probe() }).catch((e) => setError(String(e))).finally(() => setBusy(false))
  }
  const commitSvn = () => {
    if (svnDraft === null) return
    const next = svnDraft.trim()
    setSvnDraft(null)
    savePath('svnPath', next, () => setSvnPath(next))
  }
  const commitTortoise = () => {
    if (tortoiseDraft === null) return
    const next = tortoiseDraft.trim()
    setTortoiseDraft(null)
    savePath('tortoisePath', next, () => setTortoisePath(next))
  }
  const disabled = loading || unavailable || notReady || busy || snapshot?.writable === false
  return React.createElement('section', { className: 'vsm-panel' },
    React.createElement('h3', { className: 'vsm-panel-title' }, 'SVN'),
    React.createElement('div', { className: 'vsm-panel-body' },
      React.createElement('div', { className: 'vsm-general-row' },
        React.createElement('span', null, '检测状态'),
        React.createElement('small', null, svnStatusText(svnInfo)),
        React.createElement('button', { className: 'vsm-primary vsm-small', disabled: busy, onClick: probe, title: '重新检测' }, '重测')),
      error && React.createElement('small', { className: 'vsm-mcp-error' }, error),
      React.createElement('label', { className: 'vsm-general-row' },
        React.createElement('span', null, 'svn 可执行路径'),
        React.createElement('input', {
          value: svnDraft ?? svnPath, placeholder: '空 = 使用 PATH 中的 svn', disabled,
          onChange: (event) => setSvnDraft(event.target.value),
          onBlur: commitSvn,
          onKeyDown: (event) => { if (event.key === 'Enter') commitSvn() },
        })),
      React.createElement('label', { className: 'vsm-general-row' },
        React.createElement('span', null, 'TortoiseSVN 目录'),
        React.createElement('input', {
          value: tortoiseDraft ?? tortoisePath, placeholder: TORTOISE_DIR_DEFAULT, disabled,
          onChange: (event) => setTortoiseDraft(event.target.value),
          onBlur: commitTortoise,
          onKeyDown: (event) => { if (event.key === 'Enter') commitTortoise() },
        })),
    ),
  )
}

/** 兼容性小节：host 报告（RPC compat）+ 客户端本地适配项。 */
function CompatSection({ getSummary }) {
  const [report, setReport] = React.useState(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let alive = true
    rpc('compat', {}).then((result) => {
      if (!alive) return
      if (!result.ok) setError(String(result.error))
      else setReport(result.report)
    }).catch((e) => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [])
  const renderItems = (list) => (list ?? []).map((item) => React.createElement('div', { key: item.name, className: 'vsm-compat-item ' + (item.active ? 'ok' : 'warn') },
    React.createElement('span', { className: 'vsm-compat-name' }, item.name),
    React.createElement('span', { className: 'vsm-compat-note' }, item.note ?? (item.active ? '正常' : '未生效')),
  ))
  /** 兼容性分组面板：标题 + 线框内容区。 */
  const group = (title, children) => React.createElement('section', { className: 'vsm-panel' },
    React.createElement('h3', { className: 'vsm-panel-title' }, title),
    React.createElement('div', { className: 'vsm-panel-body' }, children),
  )
  const warnings = report?.warnings ?? []
  const devForm = report?.devForm
  const versionText = report?.dshVersion
    ? '（DSH ' + report.dshVersion + ' · 插件 ' + (report?.pluginVersion ?? '') + '）'
    : report?.pluginVersion ? '（插件版本 ' + report.pluginVersion + '）' : ''
  return React.createElement('section', { className: 'vsm-general-page' },
    React.createElement('h2', null, '兼容性'),
    React.createElement('p', null, '检测与其他插件 / DSH 版本的适配状态与已知问题。' + versionText),
    error && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error),
    devForm?.enabled && group('开发形态', React.createElement('div', { className: 'vsm-compat-item ok' }, React.createElement('span', { className: 'vsm-compat-name' }, '开发形态开启（工作区链接安装）'), React.createElement('span', { className: 'vsm-compat-note' }, devForm.path))),
    group('版本适配', renderItems(report?.adapters)),
    group('外部插件与服务', renderItems(report?.external)),
    group('客户端适配', renderItems(getSummary?.() ?? [])),
    group('护栏', renderItems(report?.guards)),
    group('警告', warnings.length ? warnings.map((w, index) => React.createElement('div', { key: index, className: 'vsm-mcp-error vsm-mcp-banner' }, w)) : React.createElement('div', { className: 'vsm-compat-item ok' }, React.createElement('span', { className: 'vsm-compat-name' }, '未检测到兼容性问题'), React.createElement('span', { className: 'vsm-compat-note' }, ''))),
  )
}

/** MCP 管理子页签定义（我的 / 项目 / 市场）。 */
const MCP_TABS = [
  { id: 'mine', label: '我的 MCP' },
  { id: 'projects', label: '项目 MCP' },
  { id: 'market', label: 'MCP 市场' },
]

/**
 * MCP 管理面板：顶层「MCP 管理」Tab 下的三个子页签容器。
 * 作者 ddj 2026年08月27号
 * @param {object[]} servers 全局 MCP 服务列表
 * @param {object[]} projects 项目及其项目级 MCP 列表
 * @param {string} busy 正在执行的操作标识
 * @param {object} draft 新增表单草稿
 * @param {Function} edit 草稿字段变更回调
 * @param {Function} resetDraft 清空草稿回调
 * @author ddj 2026年10月08号
 */
function McpManagePanel(props) {
  const { projects, busy, draft, edit, resetDraft, saveGlobal, saveProject } = props
  const [mcpTab, setMcpTab] = React.useState('mine')
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

  /** @author ddj 2026年10月08号 @description Close the successful global form. */
  const closeGlobalForm = () => setShowForm(false)
  /** @author ddj 2026年10月08号 @description Close the successful project form. */
  const closeProjectForm = () => setProjectForm(null)
  /** @author ddj 2026年10月08号 @param project Target project. @description Open a project draft only when idle. */
  const addProject = (project) => {
    if (busy) return
    resetDraft?.()
    setShowForm(false)
    setProjectForm({ workspacePath: project.workspacePath, title: project.title })
  }
  /** @author ddj 2026年10月08号 @description Open a global draft only when idle. */
  const addGlobal = () => {
    if (busy) return
    resetDraft?.()
    setProjectForm(null)
    setShowForm(true)
  }

  const body = manageBody(props, mcpTab, selectedPath, setSelectedPath, addProject)

  const form = showForm
    ? React.createElement(McpForm, { title: '添加全局 MCP', draft, busy, edit, save: () => saveGlobal(closeGlobalForm), close: closeGlobalForm })
    : projectForm
      ? React.createElement(McpForm, { title: '添加项目 MCP · ' + projectForm.title, draft, busy, edit, save: () => saveProject(projectForm.workspacePath, closeProjectForm), close: closeProjectForm })
      : null
  return React.createElement(React.Fragment, null,
    React.createElement('div', { className: 'vsm-mcp-subhead' },
      React.createElement('nav', { className: 'vsm-mcp-subtabs' }, MCP_TABS.map((item) => React.createElement('button', { key: item.id, className: mcpTab === item.id ? 'active' : '', onClick: () => setMcpTab(item.id) }, item.label))),
      React.createElement('button', { className: 'vsm-primary vsm-small', disabled: !!busy, onClick: addGlobal }, '+ 添加全局 MCP'),
    ),
    body,
    form,
  )
}

/** @private @author ddj 2026年10月08号 @param props Current view and actions. @param tab Selected MCP subtab. @param path Selected project. @param select Project setter. @param add Project form opener. @returns Selected global/project/market content. */
function manageBody(props, tab, path, select, add) {
  const { servers, projects, busy, refreshGlobal, toggleGlobal, removeGlobal, refreshProject, toggleProject, removeProject } = props
  if (tab === 'market') return React.createElement('div', { className: 'vsm-mcp-empty' }, 'MCP 市场暂未接入')
  if (tab !== 'projects') {
    return servers.length
      ? servers.map((server) => React.createElement(ServerCard, { key: server.id, server, busy, onRefresh: refreshGlobal, onToggle: toggleGlobal, onRemove: removeGlobal }))
      : React.createElement('div', { className: 'vsm-mcp-empty' }, '还没有配置全局 MCP')
  }
  if (!projects.length) return React.createElement('div', { className: 'vsm-mcp-empty' }, '还没有项目')
  const project = projects.find((item) => item.workspacePath === path)
  return React.createElement(React.Fragment, null,
    React.createElement(ProjectPicker, { projects, value: path, onChange: select }),
    project ? React.createElement(ProjectGroup, { project, busy, onAdd: add, onRefresh: refreshProject, onToggle: toggleProject, onRemove: removeProject }) : React.createElement('div', { className: 'vsm-mcp-empty' }, '请选择项目'),
  )
}

//region MCP page state and locked actions
/** @private @author ddj 2026年10月08号 @returns Mounted controller reference and its published view. */
function useMcpState() {
  const ref = React.useRef(null)
  const [view, setView] = React.useState({ servers: [], projects: [], loading: true, busy: '', error: '' })
  /** @author ddj 2026年10月08号 @description Subscribe to document visibility and initialize MCP data. @returns Unmount cleanup. */
  const mount = () => {
    const state = new McpState(rpc, setView)
    ref.current = state
    /** @author ddj 2026年10月08号 @description Gate snapshots on actual document visibility. */
    const visibility = () => state.setVisible(document.visibilityState === 'visible')
    /** @author ddj 2026年10月08号 @description Stop controller and remove page listener. */
    const cleanup = () => {
      document.removeEventListener('visibilitychange', visibility)
      state.dispose()
      if (ref.current === state) ref.current = null
    }
    visibility()
    document.addEventListener('visibilitychange', visibility)
    void state.load()
    return cleanup
  }
  React.useEffect(mount, [])
  return { ref, view }
}

/** @private @author ddj 2026年10月08号 @param state Mounted controller. @param id Server identity. @param method Mutation RPC. @param args Request fields. @returns Locked completion. */
function globalAction(state, id, method, args) {
  /** @author ddj 2026年10月08号 @returns Global mutation result. */
  const request = () => rpc(method, args)
  /** @author ddj 2026年10月08号 @param result Global mutation result. @description Apply only successful mutation to the latest controller view. */
  const commit = (result) => {
    state.view.servers = method === 'mcp.remove'
      ? state.view.servers.filter((server) => server.id !== id)
      : state.view.servers.map((server) => server.id === id ? result.server : server)
  }
  return state?.mutate(id, request, commit)
}

/** @private @author ddj 2026年10月08号 @param state Mounted controller. @param path Project path. @param name Server identity. @param method Mutation RPC. @param extra Optional request fields. @returns Locked completion. */
function projectAction(state, path, name, method, extra = {}) {
  /** @author ddj 2026年10月08号 @returns Project mutation result. */
  const request = () => rpc(method, { workspacePath: path, serverName: name, ...extra })
  /** @author ddj 2026年10月08号 @param result Project mutation result. @description Replace project in the current view. */
  const commit = (result) => {
    state.view.projects = state.view.projects.map((project) => project.workspacePath === path ? result.project : project)
  }
  return state?.mutate(path + ':' + name, request, commit)
}

/** @private @author ddj 2026年10月08号 @param ref Mounted controller reference. @returns Global/project card actions sharing a synchronous lock. */
function cardActions(ref) {
  /** @author ddj 2026年10月08号 @param id Global identity. @returns Locked refresh. */
  const refreshGlobal = (id) => globalAction(ref.current, id, 'mcp.refresh', { id })
  /** @author ddj 2026年10月08号 @param server Current configuration. @returns Locked enable change. */
  const toggleGlobal = (server) => globalAction(ref.current, server.id, 'mcp.toggle', { id: server.id, enabled: !server.enabled })
  /** @author ddj 2026年10月08号 @param id Global identity from ServerCard. @returns Confirmed locked deletion. */
  const removeGlobal = (id) => !ref.current?.view.busy && window.confirm('确认删除此 MCP 服务？') && globalAction(ref.current, id, 'mcp.remove', { id })
  /** @author ddj 2026年10月08号 @param project Project. @param server Configuration. @returns Locked refresh. */
  const refreshProject = (project, server) => projectAction(ref.current, project.workspacePath, server.serverName, 'mcp.projectRefresh')
  /** @author ddj 2026年10月08号 @param project Project. @param server Configuration. @returns Locked enable change. */
  const toggleProject = (project, server) => projectAction(ref.current, project.workspacePath, server.serverName, 'mcp.projectToggle', { enabled: !server.enabled })
  /** @author ddj 2026年10月08号 @param project Project. @param server Configuration. @returns Confirmed locked deletion. */
  const removeProject = (project, server) => !ref.current?.view.busy && window.confirm('确认删除此项目的 MCP「' + server.serverName + '」？') && projectAction(ref.current, project.workspacePath, server.serverName, 'mcp.projectRemove')
  return { refreshGlobal, toggleGlobal, removeGlobal, refreshProject, toggleProject, removeProject }
}

/** @private @author ddj 2026年10月08号 @param state Controller. @param draft Editable fields. @param setDraft Draft setter. @param path Optional project target. @param close Success-only close callback. @returns Locked save, validation included. */
function saveDraft(state, draft, setDraft, path, close) {
  /** @author ddj 2026年10月08号 @returns Validated save result. @throws Malformed arguments/headers. */
  const request = () => {
    const config = configOf(draft)
    return path === null ? rpc('mcp.save', { config }) : rpc('mcp.projectSave', { workspacePath: path, serverName: config.serverName, config })
  }
  /** @author ddj 2026年10月08号 @param result Save result. @description Update current view and only then reset/close the form. */
  const commit = (result) => {
    if (path !== null) state.view.projects = state.view.projects.map((project) => project.workspacePath === path ? result.project : project)
    else {
      const servers = state.view.servers
      state.view.servers = servers.some((server) => server.id === result.server.id)
        ? servers.map((server) => server.id === result.server.id ? result.server : server) : servers.concat(result.server)
    }
    setDraft(EMPTY)
    close()
  }
  return state?.mutate(path === null ? 'save' : 'project-save', request, commit)
}
//endregion

/** @public @author ddj 2026年10月08号 @param props Settings integrations. @returns MCP management page with visible-tab-only snapshot polling. */
export function McpSettings(props) {
  const openerRegistry = props?.openerRegistry ?? { list: () => [] }
  const compatSummary = props?.compatSummary ?? (() => [])
  const getShortcuts = props?.getShortcuts ?? (() => null)
  const { ref, view } = useMcpState()
  const { servers, projects, loading, busy, error } = view
  const [tab, setTab] = React.useState('general')
  const [draft, setDraft] = React.useState(EMPTY)
  /** @author ddj 2026年10月08号 @description Select polling scope and invalidate late responses on tab leave. @returns Tab cleanup. */
  const selectTab = () => {
    const state = ref.current
    state?.setActive(tab === 'mcp')
    /** @author ddj 2026年10月08号 @description Cancel reads on tab switch. */
    const cleanup = () => state?.setActive(false)
    return cleanup
  }
  React.useEffect(selectTab, [tab])
  const { refreshGlobal, toggleGlobal, removeGlobal, refreshProject, toggleProject, removeProject } = cardActions(ref)
  /** @author ddj 2026年10月08号 @param close Success-only close callback. @returns Global save completion. */
  const saveGlobal = (close) => saveDraft(ref.current, draft, setDraft, null, close)
  /** @author ddj 2026年10月08号 @param path Target project. @param close Success-only close callback. @returns Project save completion. */
  const saveProject = (path, close) => saveDraft(ref.current, draft, setDraft, path, close)
  /** @author ddj 2026年10月08号 @param key Draft field. @param value User input. @description Keep draft edits unavailable during a save. */
  const edit = (key, value) => { if (!ref.current?.view.busy) setDraft((old) => ({ ...old, [key]: value })) }
  /** @author ddj 2026年10月08号 @description Reset the draft when no mutation is pending. */
  const resetDraft = () => { if (!ref.current?.view.busy) setDraft(EMPTY) }
  let body
  if (loading) body = React.createElement('div', { className: 'vsm-mcp-empty' }, '正在读取 MCP 服务…')
  else if (tab === 'general') body = React.createElement(GeneralSettings, { registry: openerRegistry, getShortcuts })
  else if (tab === 'mcp') body = React.createElement(McpManagePanel, { servers, projects, busy, draft, edit, resetDraft,
    saveGlobal, saveProject,
    refreshGlobal, toggleGlobal, removeGlobal, refreshProject, toggleProject, removeProject })
  else if (tab === 'compat') body = React.createElement(CompatSection, { getSummary: compatSummary })
  else if (tab === 'lsp') body = React.createElement(LspSettings, null)
  else if (tab === 'ai') body = React.createElement(AiSettings, null)
  else body = React.createElement(PerfSettings, null)
  return React.createElement('section', { className: 'vsm-mcp-page' },
    React.createElement('header', { className: 'vsm-mcp-header' }, React.createElement('div', null, React.createElement('h2', null, 'VSCodeMode'), React.createElement('p', null, '管理当前 profile 与各项目的 Model Context Protocol 服务。'))),
    React.createElement('nav', { className: 'vsm-mcp-tabs' }, React.createElement('button', { className: tab === 'general' ? 'active' : '', onClick: () => setTab('general') }, '通用'), React.createElement('button', { className: tab === 'mcp' ? 'active' : '', onClick: () => setTab('mcp') }, 'MCP 管理'), React.createElement('button', { className: tab === 'lsp' ? 'active' : '', onClick: () => setTab('lsp') }, '语言服务器'), React.createElement('button', { className: tab === 'ai' ? 'active' : '', onClick: () => setTab('ai') }, 'AI 补全'), React.createElement('button', { className: tab === 'perf' ? 'active' : '', onClick: () => setTab('perf') }, '性能优化'), React.createElement('button', { className: tab === 'compat' ? 'active' : '', onClick: () => setTab('compat') }, '兼容性')),
    error && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error),
    body,
  )
}

/** @private @author ddj 2026年10月08号 @param props Draft, shared busy lock, edit/save/close callbacks. @returns Lossless argument/header form; failed save stays open. */
function McpForm({ title, draft, busy, edit, save, close }) {
  /** @author ddj 2026年10月08号 @param key Draft field. @returns Short input change callback. */
  const change = (key) => (event) => edit(key, event.target.value)
  /** @author ddj 2026年10月08号 @param key Draft field. @param placeholder Input hint. @returns Disabled-while-busy input. */
  const input = (key, placeholder) => React.createElement('input', { disabled: !!busy, value: draft[key], onChange: change(key), placeholder })
  /** @author ddj 2026年10月08号 @param key Draft field. @returns Disabled-while-busy text area. */
  const textarea = (key) => React.createElement('textarea', { disabled: !!busy, value: draft[key], onChange: change(key) })
  const fields = draft.transport === 'stdio' ? React.createElement(React.Fragment, null,
    React.createElement('label', null, '命令', input('command', 'npx')),
    React.createElement('label', null, '参数（JSON string[] 或每行一个；保留空格，空参数用 JSON）', textarea('args')),
    React.createElement('label', null, '工作目录（可选）', input('cwd', '')),
  ) : React.createElement(React.Fragment, null,
    React.createElement('label', null, 'URL', input('url', 'http://localhost:3000/mcp')),
    React.createElement('label', null, '请求头（每行 key=value，键不可重复）', textarea('headers')),
  )
  return React.createElement('div', { className: 'vsm-mcp-modal' }, React.createElement('div', { className: 'vsm-mcp-dialog' },
    React.createElement('h3', null, title),
    React.createElement('label', null, '名称', input('serverName', '例如 codegraph')),
    React.createElement('label', null, '传输方式', React.createElement('select', { disabled: !!busy, value: draft.transport, onChange: change('transport') }, React.createElement('option', { value: 'stdio' }, 'stdio'), React.createElement('option', { value: 'streamable-http' }, 'streamable-http'))),
    fields,
    React.createElement('div', { className: 'vsm-mcp-dialog-actions' }, React.createElement('button', { disabled: !!busy, onClick: close }, '取消'), React.createElement('button', { className: 'vsm-primary', disabled: !!busy, onClick: save }, '保存配置')),
  ))
}
