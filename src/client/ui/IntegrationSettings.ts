// @ts-nocheck
/**
 * dsh-vscode-mode client — 「系统集成」设置面板（跨平台）。
 * 右键菜单：Windows=HKCU 三类键（reg）/ Linux=Nautilus 脚本 + Dolphin 服务菜单（文件写入）/
 * macOS=Automator 快速操作（一键复制配方手动创建，自动检测/移除）。
 * 深链基址来自设置 integrationBaseUrl（settings.set 持久化）。
 * Unity 集成：登记项目根 + 一键安装/更新内嵌包到 <项目>/Packages/com.dsh.editor。
 * 作者 ddj 2026-09-07
 */
import React from 'react'
import { rpc } from '../rpc.js'
import { SettingsContext } from '../settingsContext.js'

/** launcher 状态文案。 */
function launcherText(launcher) {
  if (!launcher?.present) return '未安装'
  return launcher.compiled ? '已编译 exe（无闪窗）' : '已安装'
}

/** 注册条目状态文案（跨平台 entries）。 */
function entriesText(entries) {
  if (!entries?.length) return '本平台无自动注册入口'
  return entries.map((entry) => entry.label + (entry.registered ? ' ✓' : ' ✗')).join(' · ')
}

/** macOS Automator 快速操作配方（复制到剪贴板，用户按步骤创建）。 */
function automatorRecipe(launcherPath) {
  return [
    'macOS Finder 快速操作（Automator）配置步骤：',
    '1. Automator → 新建 → 快速操作',
    '2. 「工作流程接收当前」选：文件或文件夹；位于：任何应用程序',
    '3. 添加动作「运行 Shell 脚本」，Shell 选 /bin/bash，传递输入选「作为参数」',
    '4. 脚本内容替换为：',
    '   exec "' + launcherPath + '" "$@"',
    '5. 保存为：在 DSH 文件编辑中打开',
    '完成后在 Finder 右键 → 快速操作/服务 中出现「在 DSH 文件编辑中打开」。',
  ].join('\n')
}

/** 单个 Unity 项目行。 */
function ProjectRow({ project, busy, onInstall, onRemove }) {
  const versionText = project.missingDir
    ? '目录不存在'
    : project.error
      ? project.error
      : project.installedVersion
        ? '已装 v' + project.installedVersion + (project.upToDate ? '（最新）' : '（可更新）')
        : '未安装'
  const installable = !project.missingDir && !project.error
  return React.createElement('div', { className: 'vsm-general-row', key: project.path },
    React.createElement('span', null,
      project.title,
      React.createElement('small', { className: 'vsm-devform-note' }, ' ' + project.path + ' · ' + versionText)),
    React.createElement('div', { className: 'vsm-devform-actions' },
      React.createElement('button', {
        className: 'vsm-primary vsm-small',
        disabled: !installable || busy === 'install:' + project.path,
        title: project.upToDate ? '重新安装（整目录替换）' : '安装/更新到该 Unity 项目',
        onClick: () => onInstall(project.path),
      }, busy === 'install:' + project.path ? '安装中…' : project.installedVersion ? (project.upToDate ? '重装' : '更新') : '安装'),
      React.createElement('button', { disabled: busy === 'remove:' + project.path, onClick: () => onRemove(project.path) }, '移除登记'),
    ),
  )
}

/** 平台提示条（注册语义差异说明）。 */
function PlatformNote({ platform, registered }) {
  if (platform === 'win32') return null
  const text = platform === 'linux'
    ? 'Linux 注册覆盖 GNOME Files（Nautilus）与 KDE Dolphin 两个主流文件管理器（文件写入即注册，无需管理员）；其他文件管理器暂未支持。'
    : 'macOS：点「复制 Automator 配方」按提示创建快速操作（约 1 分钟），创建后此处自动显示 ✓；「移除注册」仅删除引用本插件 launcher 的快速操作。'
  return React.createElement('small', { className: 'vsm-devform-msg' }, text)
}

/**
 * 系统集成面板（挂在 VSCodeMode 设置「通用」页底部）。
 * @author ddj 2026年09月07号
 */
export function IntegrationSettings() {
  const settings = React.useContext(SettingsContext)
  const [status, setStatus] = React.useState(null)
  const [statusError, setStatusError] = React.useState('')
  const [unity, setUnity] = React.useState(null)
  const [error, setError] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [baseDraft, setBaseDraft] = React.useState(null)
  const [rootDraft, setRootDraft] = React.useState('')

  React.useEffect(() => {
    let alive = true
    Promise.all([rpc('edrv.integration.status', {}), rpc('edrv.unity.list', {})]).then(([st, ul]) => {
      if (!alive) return
      if (st.ok) { setStatus(st); setBaseUrl(st.baseUrl); setStatusError('') } else setStatusError(String(st.error))
      if (ul.ok) setUnity(ul)
    }).catch((e) => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [])

  const platform = status?.platform ?? ''
  const onWin = platform === 'win32'
  const onLinux = platform === 'linux'
  const onMac = platform === 'darwin'
  const anyRegistered = (status?.entries ?? []).some((entry) => entry.registered && !entry.manual)

  const refreshUnity = () => rpc('edrv.unity.list', {}).then((result) => { if (result.ok) setUnity(result) })

  /** 注册/移除右键菜单（Windows/Linux；macOS 注册按钮替换为配方复制）。 */
  const runMenu = (key, method, done) => {
    setBusy(key); setError(''); setMessage('')
    rpc(method, {}).then((result) => {
      if (!result.ok) throw new Error(result.error)
      setStatus(result)
      setMessage(done)
    }).catch((e) => setError(String(e?.message ?? e))).finally(() => setBusy(''))
  }
  const register = () => runMenu('register', 'edrv.integration.register',
    onLinux ? '已注册：在 Nautilus / Dolphin 中右键文件或文件夹即可看到「在 DSH 文件编辑中打开」（首次出现可能需重启文件管理器）。' : '右键菜单已注册：右键文件/文件夹 →「在 DSH 文件编辑中打开」。')
  const unregister = () => runMenu('unregister', 'edrv.integration.unregister', '右键菜单注册已移除。')

  /** 复制 macOS Automator 配方（含 launcher 实际路径）。 */
  const copyRecipe = () => {
    const text = automatorRecipe(status?.launcher?.path ?? '$HOME/.dsh/dsh-vscode-mode/shell/dsh-open.sh')
    navigator.clipboard?.writeText(text)
      .then(() => setMessage('配方已复制，粘贴到备忘录按步骤操作即可。'))
      .catch(() => setMessage(text))
  }

  /** 保存深链基址（settings.set 持久化；已注册时提示重新注册刷新 launcher ini）。 */
  const saveBase = () => {
    const next = String(baseDraft ?? '').trim()
    if (!next) return
    if (!settings?.set) { setError('设置服务不可用'); return }
    setBusy('base'); setError(''); setMessage('')
    settings.set('integrationBaseUrl', next)
      .then(() => { setBaseUrl(next); setMessage('深链基址已保存；如已注册右键菜单，请点「注册」刷新 launcher 配置。') })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(''))
  }

  /** 登记 Unity 项目（校验 Assets/ProjectSettings）。 */
  const addProject = () => {
    setBusy('add'); setError(''); setMessage('')
    rpc('edrv.unity.add', { path: rootDraft.trim() }).then((result) => {
      if (!result.ok) throw new Error(result.error)
      setRootDraft('')
      setMessage('项目已登记，点「安装」把包复制进项目 Packages/ 目录。')
      return refreshUnity()
    }).catch((e) => setError(String(e?.message ?? e))).finally(() => setBusy(''))
  }

  /** 一键安装/更新（整目录替换内嵌包）。 */
  const installProject = (path) => {
    setBusy('install:' + path); setError(''); setMessage('')
    rpc('edrv.unity.install', { path }).then((result) => {
      if (!result.ok) throw new Error(result.error)
      const project = result.project
      setMessage('已安装/更新：' + project.title + '（v' + project.installedVersion + '）。Unity 已打开时切回窗口即生效。')
      return refreshUnity()
    }).catch((e) => setError(String(e?.message ?? e))).finally(() => setBusy(''))
  }

  /** 移除登记（不删除已安装的包目录）。 */
  const removeProject = (path) => {
    if (!window.confirm('移除该项目的登记？（不删除已安装的包目录）')) return
    setBusy('remove:' + path); setError(''); setMessage('')
    rpc('edrv.unity.remove', { path })
      .then(refreshUnity)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(''))
  }

  /** 复制包源路径（手动 Add package from disk 兜底）。 */
  const copySource = () => {
    const text = unity?.sourcePath ?? ''
    if (!text) return
    navigator.clipboard?.writeText(text)
      .then(() => setMessage('已复制包源路径：' + text))
      .catch(() => setMessage('包源路径：' + text))
  }

  return React.createElement('section', { className: 'vsm-panel' },
    React.createElement('h3', { className: 'vsm-panel-title' }, '系统集成'),
    React.createElement('div', { className: 'vsm-panel-body' },
      React.createElement('p', { style: { margin: '0 0 8px' } },
        '把 DSH 编辑器接入系统入口：文件管理器右键菜单（Windows/Linux/macOS）+ Unity 外部脚本编辑器（UPM 内嵌包，自动发现，无需改 manifest.json）。'),
      error && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error),
      message && React.createElement('small', { className: 'vsm-devform-msg' }, message),
      status && !onWin && React.createElement(PlatformNote, { platform, registered: anyRegistered }),
      React.createElement('label', { className: 'vsm-general-row' },
        React.createElement('span', null, 'DSH 服务地址'),
        React.createElement('input', {
          value: baseDraft ?? baseUrl,
          placeholder: 'http://127.0.0.1:3080',
          onChange: (event) => setBaseDraft(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') saveBase() },
        }),
        React.createElement('button', { disabled: busy === 'base' || baseDraft === null, onClick: saveBase }, '保存'),
      ),
      React.createElement('label', { className: 'vsm-general-row' },
        React.createElement('span', null,
          '右键菜单 ',
          React.createElement('small', { className: 'vsm-devform-note' },
            status
              ? entriesText(status.entries) + ' · launcher：' + launcherText(status.launcher)
              : statusError ? '状态获取失败：' + statusError : '读取中…')),
        React.createElement('div', { className: 'vsm-devform-actions' },
          (onWin || onLinux) && React.createElement('button', { className: 'vsm-primary vsm-small', disabled: busy === 'register', onClick: register }, busy === 'register' ? '注册中…' : '注册'),
          onMac && React.createElement('button', { className: 'vsm-primary vsm-small', onClick: copyRecipe }, '复制 Automator 配方'),
          status && React.createElement('button', { disabled: busy === 'unregister' || (!anyRegistered && !onMac), onClick: unregister }, '移除注册'),
        ),
      ),
      React.createElement('div', { className: 'vsm-general-row', style: { alignItems: 'flex-start' } },
        React.createElement('span', null,
          'Unity 一键安装 ',
          React.createElement('small', { className: 'vsm-devform-note' },
            unity ? '包 v' + (unity.sourceVersion ?? '?') + ' · ' + unity.sourcePath : '读取中…')),
        React.createElement('div', { className: 'vsm-devform-actions' },
          React.createElement('button', { onClick: copySource }, '复制包源路径'),
        ),
      ),
      (unity?.projects ?? []).map((project) => React.createElement(ProjectRow, {
        key: project.path,
        project,
        busy,
        onInstall: installProject,
        onRemove: removeProject,
      })),
      React.createElement('label', { className: 'vsm-general-row' },
        React.createElement('span', null, '添加 Unity 项目'),
        React.createElement('input', {
          value: rootDraft,
          placeholder: '项目根目录（含 Assets 与 ProjectSettings）',
          onChange: (event) => setRootDraft(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') addProject() },
        }),
        React.createElement('button', { className: 'vsm-primary vsm-small', disabled: busy === 'add' || !rootDraft.trim(), onClick: addProject }, busy === 'add' ? '校验中…' : '添加'),
      ),
      React.createElement('small', null, '安装 = 复制到 <项目>/Packages/com.dsh.editor（内嵌包）；更新 = 整目录替换；卸载 = 删除该目录。Unity 打开时切回窗口自动刷新生效。插件卸载/重载时会自动清理并恢复右键菜单注册（「移除注册」后不再恢复）。'),
    ),
  )
}
