// @ts-nocheck
/**
 * dsh-vscode-mode client — 独立「快捷键」设置区（与 VSCodeMode 平级，settings.section slot）。
 * 子页一「官方快捷键」：官方 shortcuts 目录只读总览（官方 + 插件命令）+ 一键打开官方快捷键弹窗；
 * 子页二「插件快捷键」：插件命令（edrv.*）行内录键编辑，持久化经官方 edit API
 * （Desktop: userData/keybindings.json；Web: localStorage dsh.keybindings.v1），不再写插件设置。
 * 录制期间调 service.recording(true)：Desktop 原生键盘桥暂停拦截，否则录不到键。
 * 样式复用 vsm-kb-* / vsm-panel-* / vsm-mcp-subtabs（styles/mcp.css 随 client bundle 注入）。
 * 作者 ddj 2026年10月
 */
import React from 'react'
import { COMMANDS } from '../keybindings.js'
import { log } from '../log.js'
import { startRecording } from '../shortcutRecorder.js'
import { resetPluginKeys } from '../shortcutsOfficial.js'
import type { ShortcutsServiceLike, ShortcutCatalogRow } from '../shortcutsOfficial.js'

const settingsLog = log.child('shortcut-settings')

/** 目录行展示键位（keys 已按平台格式化；binding null = 未绑定）。 */
function keysText(row) {
  if (!row || row.binding === null) return '未绑定'
  return row.keys.join(' ')
}

/** 插件命令行 = COMMANDS 目录序 × 官方目录行（行缺失时占位「未注册」）。 */
function catalogRowsOf(service) {
  const byId = new Map(service.catalog.getSnapshot().map((row) => [row.id, row]))
  return COMMANDS.map((command) => ({ id: command.id, label: command.label, row: byId.get(command.id) ?? null }))
}

/**
 * 「快捷键」设置区主体：子页切换 + 服务就绪探测（晚到自愈，有界重试）。
 * @author ddj 2026年10月
 * @param props.getShortcuts 官方服务运行时探测函数（client/index.ts 注入）
 */
export function ShortcutSettings(props) {
  const getShortcuts = props?.getShortcuts
  const [service, setService] = React.useState(() => (typeof getShortcuts === 'function' ? getShortcuts() : null))
  const [tab, setTab] = React.useState('official')
  const [, setVersion] = React.useState(0)

  // 服务就绪有界重试（服务晚到自愈；用尽保持提示文案）
  React.useEffect(() => {
    if (service) return undefined
    let attempts = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      const found = typeof getShortcuts === 'function' ? getShortcuts() : null
      if (found) {
        setService(found)
        return
      }
      if (attempts >= 15) return
      attempts += 1
      setTimeout(tick, 2000)
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [service])

  // 目录/配置变化即重渲染（官方 catalog/config 快照存储订阅）
  React.useEffect(() => {
    if (!service) return undefined
    const bump = () => setVersion((v) => v + 1)
    const offCatalog = service.catalog.subscribe(bump)
    const offConfig = service.config.subscribe(bump)
    return () => {
      offCatalog()
      offConfig()
    }
  }, [service])

  let body
  if (!service) {
    body = React.createElement('div', { className: 'vsm-mcp-empty' },
      '官方快捷键服务未就绪（正在探测；若长期无响应，说明当前 DSH 版本不含官方快捷键机制）。')
  } else if (tab === 'plugin') {
    body = React.createElement(PluginShortcutEditor, { service })
  } else {
    body = React.createElement(OfficialShortcutsPane, { service })
  }

  return React.createElement('section', { className: 'vsm-general-page' },
    React.createElement('header', { className: 'vsm-mcp-header' }, React.createElement('div', null,
      React.createElement('h2', null, '快捷键'),
      React.createElement('p', null, '基于官方 shortcuts 机制：统一注册、冲突校验、按平台差异化默认值；Desktop 持久化到 userData/keybindings.json，Web 持久化到 localStorage（dsh.keybindings.v1）。'))),
    React.createElement('nav', { className: 'vsm-mcp-subtabs' },
      React.createElement('button', { className: tab === 'official' ? 'active' : '', onClick: () => setTab('official') }, '官方快捷键'),
      React.createElement('button', { className: tab === 'plugin' ? 'active' : '', onClick: () => setTab('plugin') }, '插件快捷键')),
    body,
  )
}

/** 官方目录行（只读总览行）。 */
function OfficialRow({ row }) {
  return React.createElement('div', { className: 'vsm-kb-row' },
    React.createElement('div', { className: 'vsm-kb-label' },
      React.createElement('span', null, row.label),
      React.createElement('small', null, row.id),
      row.modified && React.createElement('small', { className: 'vsm-kb-warn' }, '已自定义'),
      row.issue && React.createElement('small', { className: 'vsm-kb-warn' }, '键位不受当前环境支持'),
      row.conflicts.length > 0 && React.createElement('small', { className: 'vsm-kb-warn' }, '与 ' + row.conflicts.join('、') + ' 冲突')),
    React.createElement('kbd', { 'aria-label': row?.aria, className: 'vsm-kb-key' + (row.conflicts.length ? ' warn' : '') }, keysText(row)),
  )
}

/** 子页一：官方快捷键（弹窗入口 + 目录总览）。 */
function OfficialShortcutsPane({ service }) {
  const [error, setError] = React.useState('')
  const rows = service.catalog.getSnapshot()
  const shortcut = rows.find((row) => row.id === 'shortcuts.open')
  const hint = shortcut?.keys?.length ? '（' + shortcut.keys.join(' ') + '）' : ''
  const config = service.config.getSnapshot()
  const openOfficial = () => {
    setError('')
    if (!service.registry || typeof service.registry.invoke !== 'function') {
      setError('官方弹窗入口不可用；可到 设置 → 通用 → 快捷键 打开')
      return
    }
    try {
      service.registry.invoke('shortcuts.open', {
        region: 'page',
        modal: null,
        target: typeof document !== 'undefined' ? document.activeElement : null,
      })
    } catch (e) {
      settingsLog.warn('打开官方快捷键弹窗失败：' + String(e))
      setError('打开官方弹窗失败：' + String(e) + '；可到 设置 → 通用 → 快捷键 打开')
    }
  }
  return React.createElement(React.Fragment, null,
    React.createElement('section', { className: 'vsm-panel' },
      React.createElement('h3', { className: 'vsm-panel-title' }, '官方快捷键配置'),
      React.createElement('div', { className: 'vsm-panel-body' },
        React.createElement('p', null, '官方快捷键弹窗提供全部命令的查看、录键与恢复默认；也可从 设置 → 通用 → 快捷键 打开。下方为当前目录只读总览（含插件注册的命令）。'),
        React.createElement('button', { className: 'vsm-primary vsm-small', onClick: openOfficial, 'aria-keyshortcuts': shortcut?.aria }, '打开官方快捷键设置' + hint),
        error && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error),
        config?.status === 'unreadable' && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' },
          '快捷键配置读取失败（内容损坏或由更新版本写入），当前使用默认键位；请备份后清理配置，或升级 DSH。')),
    ),
    React.createElement('section', { className: 'vsm-panel' },
      React.createElement('h3', { className: 'vsm-panel-title' }, '命令目录（只读总览）'),
      React.createElement('div', { className: 'vsm-panel-body' },
        React.createElement('div', { className: 'vsm-kb-list' }, rows.map((row) => React.createElement(OfficialRow, { key: row.id, row }))),
      ),
    ),
  )
}

/** 子页二：插件命令键位（行内录键 + 行级清除 + 恢复默认；写入走官方 edit API）。 */
function PluginShortcutEditor({ service }) {
  const [nativeReady, setNativeReady] = React.useState(false)
  const [recording, setRecording] = React.useState(null) // 正在录制的命令 id
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')
  const rows = catalogRowsOf(service)
  const config = service.config.getSnapshot()

  const saveBinding = async (id, binding) => {
    setBusy(true)
    setError('')
    setMessage('')
    const buildEdit = () => (binding === null ? { type: 'reset', id } : { type: 'set', id, binding })
    try {
      const result = await service.edit(buildEdit(), service.config.getSnapshot().revision)
      if (result.status === 'saved') {
        setMessage('已保存')
      } else if (result.status === 'stale') {
        setError('快捷键配置已在其他窗口更新，请检查当前键位后重新录制')
      } else if (result.status === 'conflict') {
        // 官方按原因分类拒绝：issue = 键位本身不合法（如 web 白名单外），conflicts = 与其他命令撞键
        if (result.issue) {
          const reasons = {
            'unsupported-browser': 'web 模式白名单外的组合（单修饰符组合在浏览器环境不可靠）',
            'reserved': '官方保留键',
            'unsupported-key': '官方不支持的键',
            'modifier-required': '至少需要一个修饰键',
          }
          setError('键位被官方拒绝：' + (reasons[result.issue] ?? result.issue)
            + '。web 模式可用 Ctrl+Alt+X 风格组合；升级桌面外壳进入桌面模式后不受此限。')
        } else {
          setError('键位冲突：与 ' + (result.conflicts?.join('、') ?? '其他命令') + ' 冲突，请换一个组合')
        }
      } else if (result.status === 'not-ready') {
        setError('快捷键配置尚未就绪，请稍后重试')
      } else if (result.status === 'unreadable') {
        setError('快捷键配置读取失败，编辑已禁用（见官方提示）')
      } else {
        setError('写入失败，请重试')
      }
    } catch (e) {
      settingsLog.warn('快捷键保存失败：' + String(e))
      setError('保存失败：' + String(e))
    } finally {
      setBusy(false)
    }
  }

  const resetAll = async () => {
    if (!window.confirm('恢复全部插件快捷键为默认值？（只影响本插件命令的键位覆盖）')) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await resetPluginKeys(service)
      if (result.failed) setError('已恢复 ' + result.reset + ' 条，' + result.failed + ' 恢复失败；请重试')
      else setMessage('已恢复 ' + result.reset + ' 条插件快捷键')
    } catch (e) {
      settingsLog.warn('快捷键恢复默认失败：' + String(e))
      setError('恢复失败：' + String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Own capture and native suspension for the selected command's entire lifetime.
   * @author ddj 2026年09月28号
   * @returns Cleanup on cancel, save, failure, service change and unmount.
   */
  const recordEffect = () => {
    if (!recording) return undefined
    let mounted = true
    setNativeReady(false)
    /** @author ddj 2026年09月28号 Mark the native bridge ready to collect physical keys. */
    const ready = () => { if (mounted) setNativeReady(true) }
    /** @author ddj 2026年09月28号 Cancel capture without modifying preferences. */
    const cancel = () => { if (mounted) setRecording(null) }
    /** @author ddj 2026年09月28号 @param binding Accepted physical binding or reset. */
    const save = (binding) => { if (mounted) { setRecording(null); void saveBinding(recording, binding) } }
    /** @author ddj 2026年09月28号 @param reason Recorder failure to show while mounted. */
    const fail = (reason) => { if (mounted) { setRecording(null); setError('录制失败：' + String(reason)) } }
    const dispose = startRecording(service, window, { ready, cancel, save, error: fail })
    return () => { mounted = false; dispose() }
  }
  React.useEffect(recordEffect, [recording, service])

  const rowsView = rows.map(({ id, label, row }) => {
    const recordingRow = recording === id
    const display = recordingRow
      ? React.createElement('span', { className: 'vsm-kb-rec' }, nativeReady ? '按下组合键…（Esc 取消 / Backspace 恢复默认）' : '正在准备录制…')
      : React.createElement('kbd', { 'aria-label': row?.aria, className: 'vsm-kb-key' + (row && row.conflicts.length ? ' warn' : '') }, keysText(row))
    return React.createElement('div', { key: id, className: 'vsm-kb-row' + (recordingRow ? ' rec' : '') },
      React.createElement('div', { className: 'vsm-kb-label' },
        React.createElement('span', null, label),
        row === null && React.createElement('small', { className: 'vsm-kb-warn' }, '未注册（官方服务未同步）'),
        row && row.modified && React.createElement('small', { className: 'vsm-kb-warn' }, '已自定义'),
        row && row.conflicts.length > 0 && React.createElement('small', { className: 'vsm-kb-warn' }, '与 ' + row.conflicts.join('、') + ' 冲突')),
      display,
      React.createElement('div', { className: 'vsm-kb-actions' },
        recordingRow
          ? React.createElement('button', { onClick: () => setRecording(null) }, '取消')
          : React.createElement(React.Fragment, null,
              React.createElement('button', { disabled: busy || Boolean(recording) || config?.status !== 'ready', onClick: () => { setRecording(id); setMessage('') } }, '编辑'),
              React.createElement('button', { disabled: busy || Boolean(recording) || config?.status !== 'ready', title: '清除该命令的键位（恢复默认）', onClick: () => void saveBinding(id, null) }, '清除'))),
    )
  })

  return React.createElement('section', { className: 'vsm-panel' },
    React.createElement('h3', { className: 'vsm-panel-title' }, '插件命令键位'),
    React.createElement('div', { className: 'vsm-panel-body' },
      React.createElement('div', { className: 'vsm-kb-list' }, rowsView)),
    React.createElement('div', { className: 'vsm-panel-body vsm-kb-actionsbar' },
      React.createElement('span', { className: 'vsm-kb-dirty' }, recording ? '录制中…' : ''),
      message && React.createElement('span', { className: 'vsm-kb-message' }, message),
      error && React.createElement('span', { className: 'vsm-kb-warn' }, error),
      React.createElement('button', { className: 'vsm-small', disabled: busy || Boolean(recording) || config?.status !== 'ready', onClick: () => void resetAll() }, '恢复默认')),
  )
}
