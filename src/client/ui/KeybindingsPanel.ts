// @ts-nocheck
/**
 * dsh-vscode-mode client — VSCodeMode 设置区「快捷键」管理页。
 * 命令目录来自 client/keybindings 的 COMMANDS；当前键位读 SettingsContext scope；
 * 编辑：行内录制（捕获下一次组合键），Esc 取消、Backspace/Delete 清空（未绑定）；
 * 草稿 + 显式保存（scope.set('keybindings', draft)）；行级恢复 + 页级「恢复默认」；
 * 冲突键位（两命令同键位）标红警告；scope 外部变更且无未保存修改时回同步草稿。
 * 作者 ddj 2026-08-26
 */
import React from 'react'
import { SettingsContext } from '../settingsContext.js'
import { COMMANDS, chordFromEvent, parseChord } from '../keybindings.js'
import { defaultKeybindings, KEYBINDING_DEFAULTS, normalizeKeybindings } from '../../shared/keybindings.js'

/**
 * 草稿化：默认值 + 设置值合并，空串归一为 null（未绑定）。
 * @param raw 设置 scope 的 keybindings 字段
 * @returns 草稿映射（id → 键位弦或 null）
 */
export function draftOf(raw) {
  const merged = { ...defaultKeybindings(), ...normalizeKeybindings(raw) }
  const out = {}
  for (const [id, chord] of Object.entries(merged)) out[id] = chord === '' ? null : chord
  return out
}

/**
 * 存库化：null（未绑定）转空串。
 * @param draft 草稿映射
 * @returns 可存储的键位映射
 */
export function storeOf(draft) {
  const out = {}
  for (const [id, chord] of Object.entries(draft)) out[id] = chord === null ? '' : chord
  return out
}

/**
 * 冲突检测：同一键位被多个命令占用 → 返回冲突命令 id 集合。
 * @param draft 草稿映射
 * @returns 冲突命令 id 集合
 */
export function conflictsOf(draft) {
  const byChord = new Map()
  for (const [id, chord] of Object.entries(draft)) {
    if (!chord) continue
    const list = byChord.get(chord) ?? []
    list.push(id)
    byChord.set(chord, list)
  }
  const out = new Set()
  for (const list of byChord.values()) {
    if (list.length > 1) for (const id of list) out.add(id)
  }
  return out
}

/**
 * 快捷键管理页主体。
 */
export function KeybindingsPanel() {
  const settings = React.useContext(SettingsContext)
  const snapshot = settings?.getSnapshot?.()
  const unavailable = !settings || snapshot?.status === 'unavailable'
  const notReady = snapshot?.status !== 'ready'
  const [draft, setDraft] = React.useState(() => draftOf(snapshot?.value?.keybindings))
  const [recording, setRecording] = React.useState(null) // 正在录制的命令 id
  const [dirty, setDirty] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [message, setMessage] = React.useState('')
  const dirtyRef = React.useRef(false)
  dirtyRef.current = dirty
  const lastKeyRef = React.useRef(JSON.stringify(draft)) // 草稿内容指纹（内容未变不 setState，防外部快照引用不稳导致循环）
  const snapshotValue = snapshot?.value?.keybindings

  // scope 外部变更（如重置/其他端写入）且无未保存修改时回同步草稿
  React.useEffect(() => {
    if (dirtyRef.current) return
    const next = draftOf(snapshotValue)
    const key = JSON.stringify(next)
    if (key === lastKeyRef.current) return
    lastKeyRef.current = key
    setDraft(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotValue])

  // 录制态：窗口捕获下一次组合键（preventDefault 防浏览器默认动作）
  React.useEffect(() => {
    if (!recording) return
    const onKey = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setRecording(null); return }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setDraft((prev) => Object.assign({}, prev, { [recording]: null }))
        setRecording(null)
        setDirty(true)
        return
      }
      const chord = chordFromEvent(e)
      if (!chord) return
      setDraft((prev) => Object.assign({}, prev, { [recording]: chord }))
      setRecording(null)
      setDirty(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  const conflicts = conflictsOf(draft)
  const save = () => {
    if (!settings?.set) { setError('设置服务不可用'); return }
    setBusy(true)
    setError('')
    setMessage('')
    settings.set('keybindings', storeOf(draft)).then(() => {
      setDirty(false)
      lastKeyRef.current = JSON.stringify(draft)
      setMessage('已保存')
    }).catch((e) => setError(String(e))).finally(() => setBusy(false))
  }

  /**
   * 恢复全部默认（确认后直接保存，一步到位）。
   */
  const resetAll = () => {
    if (!settings?.set) { setError('设置服务不可用'); return }
    if (!window.confirm('恢复全部快捷键为默认值？')) return
    setBusy(true)
    setError('')
    setMessage('')
    settings.set('keybindings', { ...defaultKeybindings() }).then(() => {
      const next = draftOf({})
      setDraft(next)
      lastKeyRef.current = JSON.stringify(next)
      setDirty(false)
      setMessage('已恢复默认')
    }).catch((e) => setError(String(e))).finally(() => setBusy(false))
  }

  /** 行级恢复该项默认值（进草稿，随保存提交）。 */
  const resetRow = (id) => {
    setDraft((prev) => Object.assign({}, prev, { [id]: KEYBINDING_DEFAULTS[id] ?? null }))
    setDirty(true)
  }

  const rows = COMMANDS.map((command) => {
    const chord = draft[command.id] ?? null
    const conflict = chord !== null && conflicts.has(command.id)
    const invalid = chord !== null && parseChord(chord) === null
    const recordingRow = recording === command.id
    let display
    if (recordingRow) {
      display = React.createElement('span', { className: 'vsm-kb-rec' }, '按下组合键…（Esc 取消 / Backspace 清除）')
    } else {
      display = React.createElement('kbd', { className: 'vsm-kb-key' + (conflict ? ' warn' : '') + (invalid ? ' invalid' : '') },
        chord ?? '未绑定')
    }
    return React.createElement('div', { key: command.id, className: 'vsm-kb-row' + (recordingRow ? ' rec' : '') },
      React.createElement('div', { className: 'vsm-kb-label' },
        React.createElement('span', null, command.label),
        conflict && React.createElement('small', { className: 'vsm-kb-warn' }, '与另一命令冲突'),
        invalid && React.createElement('small', { className: 'vsm-kb-warn' }, '键位格式无效')),
      display,
      React.createElement('div', { className: 'vsm-kb-actions' },
        recordingRow
          ? React.createElement('button', { onClick: () => setRecording(null) }, '取消')
          : React.createElement(React.Fragment, null,
              React.createElement('button', { disabled: unavailable || notReady || busy || snapshot?.writable === false, onClick: () => { setRecording(command.id); setMessage('') } }, '编辑'),
              React.createElement('button', { disabled: busy, onClick: () => resetRow(command.id) }, '恢复')),
      ))
  })

  return React.createElement('section', { className: 'vsm-general-page' },
    React.createElement('h2', null, '快捷键'),
    React.createElement('p', null, '配置编辑器视图的快捷键（保存 / 快速打开 / 侧边栏 / 搜索）。修改即时写入配置，重新聚焦编辑器后生效。'),
    unavailable && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, '设置服务暂不可用，当前使用默认键位。'),
    error && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error),
    message && React.createElement('div', { className: 'vsm-kb-message' }, message),
    React.createElement('section', { className: 'vsm-panel' },
      React.createElement('h3', { className: 'vsm-panel-title' }, '编辑器键位'),
      React.createElement('div', { className: 'vsm-panel-body' }, React.createElement('div', { className: 'vsm-kb-list' }, rows)),
      React.createElement('div', { className: 'vsm-panel-body vsm-kb-actionsbar' },
        React.createElement('span', { className: 'vsm-kb-dirty' }, dirty ? '有未保存的修改' : ''),
        React.createElement('button', { className: 'vsm-primary vsm-small', disabled: unavailable || notReady || busy || snapshot?.writable === false || !dirty, onClick: save }, busy ? '保存中…' : '保存'),
        React.createElement('button', { className: 'vsm-small', disabled: unavailable || notReady || busy || snapshot?.writable === false, onClick: resetAll }, '恢复默认')),
    ),
  )
}
