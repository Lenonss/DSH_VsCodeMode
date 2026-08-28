// @ts-nocheck
/**
 * dsh-vscode-mode client — 「语言服务器」设置子 Tab。
 * 四视图：服务器（状态 + 每语言启用/命令/路径）｜已安装（卸载/更新）｜市场（Open VSX 搜索/安装 + 本地 vsix）｜更新。
 * 状态经 edrv.lsp.status，配置经 edrv.lsp.configGet/Update，扩展经 edrv.lsp.ext.*。
 * 作者 ddj 2026-08-27
 */
import React from 'react'
import { rpc } from '../rpc.js'
import '../styles/mcp.css'

const LANGUAGES = [
  { id: 'lua', label: 'Lua（LuaLS）', hint: 'lua-language-server，EmmyLua 注解原生支持' },
  { id: 'csharp', label: 'C#（Roslyn / OmniSharp）', hint: '需 dotnet + ms-dotnettools.csharp 的 .roslyn 服务器，或手动指定' },
]

const PHASE_LABEL = {
  idle: '未启动', starting: '启动中', ready: '就绪', indexing: '索引中', unavailable: '不可用', stopped: '已停止',
}
const SOURCE_LABEL = { extension: '扩展', discover: '自动发现', manual: '手动配置', none: '未配置' }
const TABS = [
  { id: 'servers', label: '服务器' },
  { id: 'installed', label: '已安装' },
  { id: 'market', label: '市场' },
  { id: 'updates', label: '更新' },
]

/** 语言卡片：状态 + 启用开关 + 命令/路径配置。 */
function LangCard({ lang, config, status, busy, onToggle, onSave }) {
  const [pathDraft, setPathDraft] = React.useState(config?.path ?? '')
  const [commandDraft, setCommandDraft] = React.useState(config?.command ?? '')
  React.useEffect(() => { setPathDraft(config?.path ?? ''); setCommandDraft(config?.command ?? '') }, [config?.path, config?.command])
  const phase = status?.phase ?? 'idle'
  return React.createElement('article', { className: 'vsm-mcp-card' },
    React.createElement('div', { className: 'vsm-mcp-card-head' },
      React.createElement('div', { className: 'vsm-mcp-title' },
        React.createElement('span', { className: 'vsm-mcp-dot ' + (phase === 'ready' || phase === 'indexing' ? 'connected' : phase === 'unavailable' ? 'error' : 'disabled') }),
        lang.label),
      React.createElement('div', { className: 'vsm-mcp-actions' },
        React.createElement('button', { className: 'vsm-switch ' + (config?.enabled !== false ? 'on' : ''), onClick: () => onToggle(lang.id, config?.enabled !== false ? false : true), 'aria-label': '启用/禁用' }, config?.enabled !== false ? '●' : '○'))),
    React.createElement('div', { className: 'vsm-mcp-meta' },
      PHASE_LABEL[phase] ?? phase, ' · ', SOURCE_LABEL[status?.source] ?? status?.source,
      (phase === 'ready' && status?.root) ? ' · ' + String(status.root).split(/[\\/]/).pop() : ''),
    status?.reason ? React.createElement('div', { className: 'vsm-mcp-error' }, status.reason) : null,
    React.createElement('div', { className: 'vsm-lsp-form' },
      React.createElement('label', null, React.createElement('span', null, '可执行文件路径（绝对路径，优先）'), React.createElement('input', { value: pathDraft, placeholder: '如 C:/.../lua-language-server.exe', onChange: (e) => setPathDraft(e.target.value) })),
      React.createElement('label', null, React.createElement('span', null, '命令名（PATH 内查找）'), React.createElement('input', { value: commandDraft, placeholder: '如 lua-language-server', onChange: (e) => setCommandDraft(e.target.value) })),
      React.createElement('button', { className: 'vsm-primary', disabled: busy === lang.id, onClick: () => onSave(lang.id, pathDraft, commandDraft) }, busy === lang.id ? '保存中…' : '保存配置')),
    React.createElement('div', { className: 'vsm-lsp-hint' }, lang.hint))
}

/** 已装扩展卡片：清单 + 卸载/更新。 */
function InstalledCard({ ext, busy, onUninstall, onUpdate }) {
  return React.createElement('article', { className: 'vsm-mcp-card' },
    React.createElement('div', { className: 'vsm-mcp-card-head' },
      React.createElement('div', { className: 'vsm-mcp-title' },
        React.createElement('span', { className: 'vsm-mcp-dot connected' }),
        React.createElement('span', null, ext.displayName || ext.name),
        React.createElement('span', { className: 'vsm-ext-ver' }, ext.id + ' · v' + ext.version)),
      React.createElement('div', { className: 'vsm-mcp-actions' },
        React.createElement('button', { className: 'vsm-primary vsm-small', disabled: busy === ext.id, onClick: () => onUpdate(ext) }, '更新'),
        React.createElement('button', { className: 'vsm-danger vsm-small', disabled: busy === ext.id, onClick: () => onUninstall(ext) }, '卸载'))),
    ext.description ? React.createElement('div', { className: 'vsm-lsp-hint' }, ext.description) : null)
}

/** 市场条目卡片：安装/已装态。 */
function MarketCard({ item, installed, busy, onInstall }) {
  const has = installed.some((e) => e.id === item.id)
  return React.createElement('article', { className: 'vsm-mcp-card' },
    React.createElement('div', { className: 'vsm-mcp-card-head' },
      React.createElement('div', { className: 'vsm-mcp-title' },
        React.createElement('span', { className: 'vsm-mcp-dot ' + (has ? 'connected' : 'disabled') }),
        React.createElement('span', null, item.displayName || item.name),
        React.createElement('span', { className: 'vsm-ext-ver' }, item.id + ' · v' + item.version)),
      React.createElement('div', { className: 'vsm-mcp-actions' },
        React.createElement('button', { className: 'vsm-primary vsm-small', disabled: has || busy === item.id, onClick: () => onInstall(item) }, has ? '已安装' : '安装'))),
    item.description ? React.createElement('div', { className: 'vsm-lsp-hint' }, item.description) : null)
}

/**
 * 语言服务器设置页：服务器状态/配置 + VSIX 扩展（安装/更新/卸载三视图）。
 * @author ddj 2026年08月27号
 */
export function LspSettings() {
  const [tab, setTab] = React.useState('servers')
  const [config, setConfig] = React.useState({})
  const [servers, setServers] = React.useState([])
  const [installed, setInstalled] = React.useState([])
  const [updates, setUpdates] = React.useState([])
  const [market, setMarket] = React.useState([])
  const [query, setQuery] = React.useState('')
  const [vsixPath, setVsixPath] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [error, setError] = React.useState('')
  const [loading, setLoading] = React.useState(true)

  const refreshServers = React.useCallback(() => {
    Promise.all([rpc('edrv.lsp.configGet', {}), rpc('edrv.lsp.status', {})])
      .then(([cfg, st]) => {
        if (cfg?.ok) setConfig(cfg.config ?? {})
        if (st?.ok) setServers(st.servers ?? [])
        setError('')
      })
      .catch((e) => setError(String(e)))
  }, [])

  const refreshExt = React.useCallback(() => {
    Promise.all([rpc('edrv.lsp.ext.list', {}), rpc('edrv.lsp.ext.updates', {})])
      .then(([l, u]) => {
        if (l?.ok) setInstalled(l.extensions ?? [])
        if (u?.ok) setUpdates(u.updates ?? [])
        setError('')
      })
      .catch((e) => setError(String(e)))
  }, [])

  const refresh = React.useCallback(() => {
    setLoading(true)
    Promise.all([refreshServers(), refreshExt()]).finally(() => setLoading(false))
  }, [refreshServers, refreshExt])

  React.useEffect(() => { refresh() }, [refresh])

  const switchTab = (next) => {
    setTab(next)
    setError('')
    if (next === 'market' && !query) setQuery('lua language server')
    if (next === 'installed' || next === 'updates') void refreshExt()
    if (next === 'servers') void refreshServers()
  }

  const saveLang = (languageId, path, command) => {
    setBusy(languageId)
    setError('')
    rpc('edrv.lsp.configUpdate', { languageId, path, command })
      .then((res) => {
        if (!res?.ok) { setError(res?.error ?? '保存失败'); return }
        setConfig(res.config ?? {})
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(''))
  }

  const toggleLang = (languageId, enabled) => {
    setBusy(languageId)
    rpc('edrv.lsp.configUpdate', { languageId, enabled })
      .then((res) => {
        if (res?.ok) { setConfig(res.config ?? {}); void refreshServers() }
        else setError(res?.error ?? '切换失败')
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(''))
  }

  const searchMarket = () => {
    if (!query.trim()) return
    setBusy('__market')
    setError('')
    rpc('edrv.lsp.ext.market', { query: query.trim(), size: 12 })
      .then((res) => {
        if (res?.ok) setMarket(res.extensions ?? [])
        else setError(res?.error ?? '搜索失败')
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(''))
  }

  const installMarket = (item) => {
    setBusy(item.id)
    setError('')
    rpc('edrv.lsp.ext.install', { namespace: item.namespace, name: item.name })
      .then((res) => {
        if (!res?.ok) { setError(res?.error ?? '安装失败'); return }
        void refreshExt()
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(''))
  }

  const installLocal = () => {
    if (!vsixPath.trim()) return
    setBusy('__vsix')
    setError('')
    rpc('edrv.lsp.ext.install', { vsixPath: vsixPath.trim() })
      .then((res) => {
        if (!res?.ok) { setError(res?.error ?? '安装失败'); return }
        setVsixPath('')
        void refreshExt()
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(''))
  }

  const uninstallExt = (ext) => {
    if (!window.confirm('卸载扩展 ' + ext.id + '？')) return
    setBusy(ext.id)
    setError('')
    rpc('edrv.lsp.ext.uninstall', { id: ext.id })
      .then((res) => {
        if (!res?.ok) setError(res?.error ?? '卸载失败')
        void refreshExt()
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(''))
  }

  const updateExt = (ext) => {
    setBusy(ext.id)
    setError('')
    rpc('edrv.lsp.ext.update', { id: ext.id })
      .then((res) => {
        if (!res?.ok) setError(res?.error ?? '更新失败')
        void refreshExt()
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(''))
  }

  if (loading) return React.createElement('div', { className: 'vsm-mcp-empty' }, '正在读取语言服务器状态…')
  const nav = React.createElement('nav', { className: 'vsm-mcp-tabs' },
    TABS.map((t) => React.createElement('button', { key: t.id, className: tab === t.id ? 'active' : '', onClick: () => switchTab(t.id) }, t.label)))
  const header = React.createElement('div', { className: 'vsm-mcp-header' },
    React.createElement('div', null,
      React.createElement('h2', null, '语言服务器（LSP）'),
      React.createElement('p', null, '代码索引 / 引用查找 / 动态跳转；可安装 VSIX 语言服务器扩展（Open VSX 市场 / 本地 .vsix）。')),
    React.createElement('button', { className: 'vsm-primary', onClick: refresh }, '↻ 刷新'))
  const banner = error ? React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error) : null

  let body = null
  if (tab === 'servers') {
    body = React.createElement('div', null,
      LANGUAGES.map((lang) => React.createElement(LangCard, {
        key: lang.id, lang,
        config: config[lang.id] ?? {},
        status: servers.find((s) => s.languageId === lang.id),
        busy, onToggle: toggleLang, onSave: saveLang,
      })),
      React.createElement('div', { className: 'vsm-lsp-hint' }, '提示：打开 Lua/C# 文件即自动（惰性）启动对应语言服务器；未配置时编辑器功能不受影响，大纲回退内置解析。'))
  } else if (tab === 'installed') {
    body = React.createElement('div', null,
      React.createElement('div', { className: 'vsm-lsp-hint' }, '已安装的语言服务器扩展（存于 ~/.dsh/dsh-vscode-mode/extensions/）。语言服务器被自动发现为「扩展」源。'),
      installed.length ? installed.map((ext) => React.createElement(InstalledCard, { key: ext.id, ext, busy, onUninstall: uninstallExt, onUpdate: updateExt }))
        : React.createElement('div', { className: 'vsm-mcp-empty' }, '还没有安装扩展（去「市场」或指定本地 .vsix）'))
  } else if (tab === 'market') {
    body = React.createElement('div', null,
      React.createElement('div', { className: 'vsm-lsp-form' },
        React.createElement('label', null, React.createElement('span', null, '搜索 Open VSX 市场'), React.createElement('input', { value: query, placeholder: '如 sumneko.lua / lua language server', onChange: (e) => setQuery(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') searchMarket() } })),
        React.createElement('button', { className: 'vsm-primary', disabled: busy === '__market', onClick: searchMarket }, busy === '__market' ? '搜索中…' : '搜索')),
      React.createElement('div', { className: 'vsm-lsp-form' },
        React.createElement('label', null, React.createElement('span', null, '安装本地 .vsix 文件（服务器绝对路径）'), React.createElement('input', { value: vsixPath, placeholder: '如 C:/Downloads/sumneko.lua-3.19.1.vsix', onChange: (e) => setVsixPath(e.target.value) })),
        React.createElement('button', { className: 'vsm-primary', disabled: busy === '__vsix', onClick: installLocal }, busy === '__vsix' ? '安装中…' : '安装本地 .vsix')),
      React.createElement('div', { className: 'vsm-lsp-hint' }, '市场安装会下载并解包 VSIX 到扩展目录；含语言服务器（如 sumneko.lua）的扩展会被自动发现。'),
      market.map((item) => React.createElement(MarketCard, { key: item.id, item, installed, busy, onInstall: installMarket })))
  } else {
    body = React.createElement('div', null,
      React.createElement('div', { className: 'vsm-lsp-hint' }, '已装扩展与 Open VSX 最新版的差异。'),
      updates.length ? updates.map((u) => React.createElement('article', { key: u.id, className: 'vsm-mcp-card' },
        React.createElement('div', { className: 'vsm-mcp-card-head' },
          React.createElement('div', { className: 'vsm-mcp-title' },
            React.createElement('span', { className: 'vsm-mcp-dot error' }),
            React.createElement('span', null, u.displayName || u.id),
            React.createElement('span', { className: 'vsm-ext-ver' }, 'v' + u.current + ' → v' + u.latest)),
          React.createElement('div', { className: 'vsm-mcp-actions' },
            React.createElement('button', { className: 'vsm-primary vsm-small', disabled: busy === u.id, onClick: () => updateExt(u) }, busy === u.id ? '更新中…' : '更新')))))
        : React.createElement('div', { className: 'vsm-mcp-empty' }, '全部已是最新'))
  }
  return React.createElement('div', null, header, nav, banner, body)
}
