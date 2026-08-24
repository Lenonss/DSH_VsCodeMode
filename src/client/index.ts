/**
 * dsh-vscode-mode client — 浏览器半入口：slot 注册 + 装配。
 * 挂点：conversation.view「文件编辑」页签（中央 Monaco 编辑器）+ header 差异角标。
 * 与 Host 通信：同源 fetch('/edrv/rpc')（shared/rpc 契约）。
 *
 * ⚠️ 跨版本 slot 装配（2026-08-21）：新版 DSH 的 slots 系统要求 slot 必须由父 entry
 * 的 children table 先声明，直接 `ctx.slots.register({name:'conversation.view'})` 在
 * 声明未就绪时抛 `slot ... is not declared (a parent entry's children table must declare it)`。
 * 正确写法 = `ctx.slots.inject(name, () => ctx.slots.register(...))`：声明存在时同步
 * 执行，否则等待声明（官方 ui-conversation 自身即此模式）；旧版（rc.8 及更早）同样支持，
 * 故跨版本兼容。slot 名未变：conversation.view / conversation.session.header.utilities。
 * 作者 ddj 2026-08-20
 */
import React from 'react'
import './styles/editor.css'
import { EditorView } from './ui/EditorView.js'
import { DiffBadge } from './ui/DiffBadge.js'
import { McpSettings } from './ui/McpSettings.js'
import { rpc } from './rpc.js'
import { loadMonaco } from './monaco/loader.js'
import { createFileOpenerRegistry, scanSidebar, type FileOpenContext } from './fileOpeners.js'
import type { FileOpenerRegistry } from './fileOpeners.js'
import { installOpenPathRouter, vscodeOpener, autoValue } from './openPathRouter.js'
import { SettingsContext } from './settingsContext.js'
import { SIDEBAR_PLUGIN, pickSettingsBinder, registerSlotSafely } from './compat.js'
import { createAddToConversation } from './addToConversation.js'
import type { CompatAdapter } from '../shared/compat.js'

export const inject = ['slots', 'timer', 'locale', 'connection', 'remote', 'workspaces', 'sessions', 'conversation', 'settingsScope', 'webUiSettings']

/**
 * 装配客户端：注册中央编辑区视图与 header 差异角标。
 * @author ddj 2026年08月20号
 * @param ctx 客户端根上下文（slots + timer 服务）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  const schedule = (fn: () => void, ms: number) => ctx.timeout(fn, ms)

  // Monaco 预热：DSH 启动后后台加载编辑器核心（模块级 promise 去重），用户点开「文件编辑」页签即用，
  // 不再等页签挂载后才首次拉取 /edrv/vendor/*。requestIdleCallback 让出首屏带宽，缺省回退延时调度；
  // 预热失败静默吞掉（loader 失败会重置 promise，页签打开时仍走原有加载/重试路径）。
  if (typeof window !== 'undefined') {
    const preloadMonaco = () => loadMonaco(() => {}).catch(() => {})
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(preloadMonaco, { timeout: 2000 })
    else schedule(preloadMonaco, 300)
  }

  const registry: FileOpenerRegistry = createFileOpenerRegistry()
  const workspaces = ctx.get('workspaces')
  const sessions = ctx.get('sessions')
  const originalOpenPath = workspaces?.openPath
  const binder = pickSettingsBinder(ctx)
  const settings = binder.scope
  let selected = autoValue('auto')
  /** 「添加到对话」动作集：编辑区/Tab 右键菜单注入文件引用与代码块（conversation 服务缺失时各动作安全降级）。 */
  const addToConversation = createAddToConversation(ctx)

  /** 客户端侧兼容摘要（与 host 报告合并展示；惰性求值保证 HMR 后仍新鲜）。 */
  const compatSummary = (): CompatAdapter[] => [
    { name: '设置桥', active: settings !== undefined, note: settings !== undefined ? '使用 ' + binder.service + ' 桥' : '未绑定设置服务（fileOpenTool 持久化不可用）' },
    { name: '文件打开路由（workspaces.openPath）', active: Boolean(workspaces?.openPath), note: 'vscode 打开器优先，失败回退系统打开' },
    { name: '侧边栏打开器（' + SIDEBAR_PLUGIN + '）', active: registry.get(SIDEBAR_PLUGIN) !== undefined, note: registry.get(SIDEBAR_PLUGIN) !== undefined ? '已注册（优先级 80）' : '未检测到侧边栏打开能力' },
  ]

  ctx.provide('fileOpeners', registry)
  ctx.effect(() => registry.register(vscodeOpener()), 'vscode-mode: file opener')
  ctx.effect(() => registry.register({
    id: 'system', label: '系统默认应用', priority: 0,
    open: (path: string) => originalOpenPath.call(workspaces, path),
  }), 'vscode-mode: system file opener')
  ctx.effect(() => {
    const sidebar = scanSidebar(ctx)
    return sidebar ? registry.register(sidebar) : undefined
  }, 'vscode-mode: sidebar file opener')
  ctx.effect(() => {
    if (!settings) return undefined
    const sync = (): void => {
      const snapshot = settings.getSnapshot()
      if (snapshot.status === 'loading') return
      selected = autoValue(snapshot.value?.fileOpenTool)
      window.dispatchEvent(new CustomEvent('edrv:file-open-tool-change', { detail: { value: selected } }))
    }
    sync()
    return settings.subscribe(sync)
  }, 'vscode-mode: file opener setting sync')
  if (workspaces?.openPath) {
    ctx.effect(() => installOpenPathRouter({
      workspaces,
      registry,
      selected: () => selected,
      context: () => {
        const current = sessions?.list?.getSnapshot?.()
        const sessionId = current?.current
        const summary = sessionId ? current?.byId?.[sessionId] : undefined
        return { sessionId, cwd: summary?.cwd } as FileOpenContext
      },
      logger: (message: string) => console.warn('[dsh-vscode-mode] ' + message),
    }), 'vscode-mode: file link routing')
  }

  // 中央「文件编辑」页签：类 VSCode 编辑器（顶部=文件页签+搜索框，差异 UI=文件底部圆角悬浮框）
  registerSlotSafely(ctx, {
    name: 'conversation.view',
    id: 'edrv-editor',
    order: 5,
    label: '文件编辑',
    inject: (sessionId: string) => ({ sessionId }),
  }, (props: unknown) => React.createElement(EditorView, Object.assign({}, props, { schedule, addToConversation })))

  // header 差异角标：仅当前工作区存在差异时渲染
  registerSlotSafely(ctx, { name: 'conversation.session.header.utilities', id: 'edrv-diff-badge', order: 90, label: '差异' },
    (props: unknown) => React.createElement(DiffBadge, Object.assign({}, props)))

  // 设置页中的 VSCodeMode 专属页签，MCP 管理作为该页签的内部子 Tab。
  registerSlotSafely(ctx, {
    name: 'settings.section',
    id: 'vscode-mode',
    order: 30,
    label: 'VSCodeMode',
  }, () => React.createElement(SettingsContext.Provider, { value: settings }, React.createElement(McpSettings, { openerRegistry: registry, compatSummary })))
}