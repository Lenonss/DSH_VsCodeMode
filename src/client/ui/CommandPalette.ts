/**
 * dsh-vscode-mode client — 命令栏浮层（Ctrl+Shift+P / F1）。
 * 订阅 commandPaletteStore 的开关状态；候选来自注入的指令注册表（window.dsh.edrvCommands），
 * 过滤/排序复用 commandSearch 纯函数；↑↓ 选择、Enter 执行、Esc 或点击遮罩关闭。
 * 浮层经 createPortal 渲染到 body，故不受编辑区三种形态（官方侧栏/better-sidebar/中央页签）影响；
 * 宿主单实例由 store 的 claimPaletteHost 保证（另一个宿主自动返回 null）。
 * 作者 ddj 2026年09月10号
 */
import React from 'react'
import { createPortal } from 'react-dom'
import { REGISTRY_GLOBAL } from '../commandGlobals.js'
import { filterCommands } from '../commandSearch.js'
import { createCommandRegistry } from '../commandRegistry.js'
import type { CommandRegistry } from '../commandRegistry.js'
import { chordOf } from '../keybindings.js'
import {
  claimPaletteHost, closeCommandPalette, isPaletteOpen, paletteHostRev, paletteOpenSeq, registryRef,
  releasePaletteHost, runPaletteCommand, subscribePalette,
} from '../commandPaletteStore.js'
import type { CommandDef } from './commandCatalog.js'

/** 空注册表（宿主未注入时的安全降级：命令栏可开但无候选）。 */
let fallbackRegistry: CommandRegistry | null = null

/**
 * 读取指令注册表：① 装配期存入的模块引用（首选，不依赖全局）
 * ② window[REGISTRY_GLOBAL] 镜像（第三方/调试场景）③ 空表降级（仅装配异常时）。
 * @author ddj 2026年09月10号
 * @returns 指令注册表
 */
function useRegistry(): CommandRegistry {
  const injected = registryRef()
  if (injected) return injected
  const mirrored = typeof window === 'undefined'
    ? undefined
    : (window as unknown as Record<string, CommandRegistry | undefined>)[REGISTRY_GLOBAL]
  if (mirrored) return mirrored
  if (!fallbackRegistry) fallbackRegistry = createCommandRegistry()
  return fallbackRegistry
}

/** 命令栏每一行的展示信息。 */
interface PaletteRow {
  command: CommandDef
  chord: string | null
}

/**
 * 组装候选行（先按可用性过滤，再按查询排序）。
 * @author ddj 2026年09月10号
 * @param registry 指令注册表
 * @param query 用户输入
 * @returns 候选行
 */
function rowsOf(registry: CommandRegistry, query: string): PaletteRow[] {
  return filterCommands(registry.available(), query)
    .map((command) => ({ command, chord: chordOf(command.id) }))
}

/**
 * 命令栏浮层（未展开/非宿主时渲染 null）。
 * @author ddj 2026年09月10号
 * @returns 浮层 React 元素或 null
 */
export function CommandPalette(): React.ReactElement | null {
  const open = React.useSyncExternalStore(subscribePalette, isPaletteOpen)
  // 唤起序号：已打开时每次快捷键再触发都会递增 → 重新聚焦输入框（否则看似"没反应"）
  const openSeq = React.useSyncExternalStore(subscribePalette, paletteOpenSeq)
  // 宿主令牌版本：宿主释放时递增，驱动本实例重试认领（避免宿主更替后无人渲染浮层）
  const hostRev = React.useSyncExternalStore(subscribePalette, paletteHostRev)
  const registry = useRegistry()
  const [token, setToken] = React.useState<object | null>(null)
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState(0)
  const [notice, setNotice] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const tokenRef = React.useRef<object | null>(null)
  const host = token !== null

  /**
   * 认领宿主：放在 effect（不在 render 期做副作用 —— StrictMode 双调用会让首次认领
   * 被判定失败而永久无人渲染）。hostRev 变化（有实例释放了宿主）时重试认领。
   *
   * ⚠️ 此处**不**做 cleanup 释放：releasePaletteHost 会通知订阅者（hostRev 变化），
   * 若在依赖 hostRev 的 effect 里释放，会「释放→通知→重跑→再释放」自激循环。
   * 释放统一交给下面的「仅卸载时」effect。
   */
  React.useEffect(() => {
    if (tokenRef.current) return
    const claimed = claimPaletteHost()
    if (!claimed) return
    tokenRef.current = claimed
    setToken(claimed)
  }, [hostRev])

  /** 仅卸载时释放宿主；释放后 store 通知其余实例接管（自愈）。 */
  React.useEffect(() => () => {
    releasePaletteHost(tokenRef.current)
    tokenRef.current = null
  }, [])
  // 新开（open false→true）时重置查询/选择/提示
  React.useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(0)
    setNotice('')
  }, [open])
  // 每次唤起（含已打开时的重复唤起 openSeq 变化）重新聚焦输入框 ——
  // 否则命令栏被其它浮层短暂遮挡后，快捷键再按会「看似没反应」。
  React.useEffect(() => {
    if (!open) return undefined
    const timer = setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.select?.()
    }, 0)
    return () => clearTimeout(timer)
  }, [open, openSeq])

  const rows = React.useMemo(
    () => (open && host ? rowsOf(registry, query) : []),
    [open, host, registry, query],
  )
  const active = rows.length ? Math.min(selected, rows.length - 1) : 0

  React.useEffect(() => {
    if (!open) return
    const node = document.querySelector('.edrv-palette-row.edrv-palette-sel')
    const scroll = (node as HTMLElement | null)?.scrollIntoView
    if (typeof scroll === 'function') scroll.call(node, { block: 'nearest' })
  }, [open, active, rows.length])

  /** 执行候选行（执行器内部会做可用性校验与异常上报）。 */
  const execute = (row: PaletteRow | undefined): void => {
    if (!row) return
    closeCommandPalette()
    if (!runPaletteCommand(row.command.id)) setNotice('命令未执行：' + row.command.label)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      closeCommandPalette()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!rows.length) return
      const step = event.key === 'ArrowDown' ? 1 : rows.length - 1
      setSelected((value) => (Math.min(value, rows.length - 1) + step) % rows.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      execute(rows[active])
    }
  }

  if (!open || !host || typeof document === 'undefined') return null
  const list = rows.length
    ? rows.map((row, index) => React.createElement('div', {
        key: row.command.id,
        className: 'edrv-palette-row' + (index === active ? ' edrv-palette-sel' : ''),
        onMouseEnter: () => setSelected(index),
        onClick: () => execute(row),
      },
        React.createElement('span', { className: 'edrv-palette-label' }, row.command.label),
        React.createElement('span', { className: 'edrv-palette-cat' }, row.command.category),
        row.chord ? React.createElement('kbd', { className: 'edrv-palette-key' }, row.chord) : null))
    : React.createElement('div', { className: 'edrv-palette-empty' }, '无匹配命令')

  const panel = React.createElement('div', { className: 'edrv-palette', 'data-edrv-palette': '1', onKeyDown },
    React.createElement('input', {
      ref: inputRef,
      className: 'edrv-palette-input',
      value: query,
      placeholder: '输入命令名称…（↑↓ 选择 · Enter 执行 · Esc 关闭）',
      spellCheck: false,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
        setQuery(event.target.value)
        setSelected(0)
        setNotice('')
      },
    }),
    React.createElement('div', { className: 'edrv-palette-list' }, list),
    notice ? React.createElement('div', { className: 'edrv-palette-notice' }, notice) : null)

  const overlay = React.createElement('div', { 'data-edrv-view': '1' },
    React.createElement('div', { className: 'edrv-palette-mask', onClick: () => closeCommandPalette() }),
    panel)
  return createPortal(overlay, document.body)
}
