/**
 * dsh-vscode-mode client — 浏览器半入口：slot 注册 + 装配。
 * 挂点：betterSidebar「文件编辑」Tab（侧边栏形态，对话+编辑同屏；未装 dsh-better-sidebar 时
 * 回退 conversation.view 中央页签）+ conversation.input.dock 差异条 + header 差异角标。
 * 与 Host 通信：同源 fetch('/edrv/rpc')（shared/rpc 契约）。
 *
 * ⚠️ 跨版本 slot 装配（2026-08-21）：新版 DSH 的 slots 系统要求 slot 必须由父 entry
 * 的 children table 先声明，直接 `ctx.slots.register({name:'conversation.view'})` 在
 * 声明未就绪时抛 `slot ... is not declared (a parent entry's children table must declare it)`。
 * 正确写法 = `ctx.slots.inject(name, () => ctx.slots.register(...))`：声明存在时同步
 * 执行，否则等待声明（官方 ui-conversation 自身即此模式）；旧版（rc.8 及更早）同样支持，
 * 故跨版本兼容。slot 名：conversation.view / conversation.session.header.utilities /
 * conversation.input.dock。
 * 作者 ddj 2026-08-20
 */
import React from 'react'
import './styles/editor.css'
import { EditorView } from './ui/EditorView.js'
import { DiffBadge } from './ui/DiffBadge.js'
import { ConversationDiffDock } from './ui/ConversationDiffDock.js'
import { McpSettings } from './ui/McpSettings.js'
import { rpc } from './rpc.js'
import { loadMonaco } from './monaco/loader.js'
import { createFileOpenerRegistry, scanSidebar, type FileOpenContext } from './fileOpeners.js'
import type { FileOpenerRegistry } from './fileOpeners.js'
import { installOpenPathRouter, vscodeOpener, autoValue } from './openPathRouter.js'
import { SettingsContext } from './settingsContext.js'
import { SIDEBAR_PLUGIN, pickSettingsBinder, registerSlotSafely } from './compat.js'
import { detectSidebarService, installSideEditor, setEnsureSideEditor, SIDEBAR_INSTALL_CMD } from './sidebarBridge.js'
import { SideEditorTab } from './ui/SideEditorTab.js'
import { createAddToConversation } from './addToConversation.js'
import { createSidebarPanelRegistry } from './sidebar/registry.js'
import { createFilePanel } from './sidebar/panels/index.js'
import { createSearchPanel } from './sidebar/panels/index.js'
import { createTreeMenuRegistry } from './sidebar/contextMenu.js'
import { createDefaultFileMenuItems } from './sidebar/menuItems.js'
import { createOutlinePanel } from './outline/index.js'
import { createOutlineSourceRegistry, registerBuiltinOutlineSources } from './outline/sources.js'
import { keybindingsApply } from './keybindings.js'
import type { CompatAdapter } from '../shared/compat.js'

// ⚠️ inject 只列必需服务：webUiSettings 是 @linxin666/dsh-client-ui-web-ui-settings 提供的
// 可选兼容桥（非官方服务），列入 inject 会让未装该桥的部署启动时 entry 永久 pending，
// web boot 直接失败（'1 entry did not activate'）。兼容层用 ctx.get 运行时探测 + 降级，不靠 inject。
export const inject = ['slots', 'timer', 'locale', 'connection', 'remote', 'workspaces', 'sessions', 'conversation', 'settingsScope']

/**
 * 装配客户端：注册中央编辑区视图与 header 差异角标。
 * @author ddj 2026年08月20号
 * @param ctx 客户端根上下文（slots + timer 服务）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  const schedule = (fn: () => void, ms: number) => ctx.timeout(fn, ms)

  const registry: FileOpenerRegistry = createFileOpenerRegistry()
  const workspaces = ctx.get('workspaces')
  const sessions = ctx.get('sessions')

  // Monaco 加载时机：不再 DSH 启动即预热，改为进入会话界面（sessions.list.current 出现）后再后台加载，
  // 用户点开「文件编辑」页签即用；空闲时仍由 EditorView 挂载兜底加载。
  // 模块级 promise 去重，重复触发只首次真正加载；requestIdleCallback 让出会话首屏带宽，缺省回退延时调度；
  // 预热失败静默吞掉（loader 失败会重置 promise，页签打开时仍走原有加载/重试路径）。
  const monacoList = sessions?.list
  if (typeof window !== 'undefined' && monacoList && typeof monacoList.subscribe === 'function') {
    const list = monacoList as { getSnapshot: () => { current?: unknown }; subscribe: (listener: () => void) => () => void }
    const schedulePreload = () => {
      const preload = () => loadMonaco(() => {}).catch(() => {})
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(preload, { timeout: 2000 })
      else schedule(preload, 300)
    }
    const onSessionEnter = () => {
      if (!list.getSnapshot()?.current) return
      schedulePreload()
    }
    ctx.effect(() => list.subscribe(onSessionEnter), 'vscode-mode: monaco session trigger')
    onSessionEnter()
  }
  const originalOpenPath = workspaces?.openPath
  const binder = pickSettingsBinder(ctx)
  const settings = binder.scope
  let selected = autoValue('auto')
  /** 可选探测 betterSidebar 服务（不进 inject：缺失会让插件停靠等待，杀死回退路径）。 */
  let sideService = detectSidebarService(ctx)
  /** 「添加到对话」动作集：编辑区/Tab 右键菜单注入文件引用与代码块（conversation 服务缺失时各动作安全降级）。 */
  const addToConversation = createAddToConversation(ctx)

  /** 客户端侧兼容摘要（与 host 报告合并展示；惰性求值保证 HMR 后仍新鲜）。 */
  const compatSummary = (): CompatAdapter[] => [
    { name: '设置桥', active: settings !== undefined, note: settings !== undefined ? '使用 ' + binder.service + ' 桥' : '未绑定设置服务（fileOpenTool 持久化不可用）' },
    { name: '文件打开路由（workspaces.openPath）', active: Boolean(workspaces?.openPath), note: 'vscode 打开器优先，失败回退系统打开' },
    { name: '侧边栏打开器（' + SIDEBAR_PLUGIN + '）', active: registry.get(SIDEBAR_PLUGIN) !== undefined, note: registry.get(SIDEBAR_PLUGIN) !== undefined ? '已注册（优先级 80）' : '未检测到侧边栏打开能力' },
    { name: '侧边栏编辑区（' + SIDEBAR_PLUGIN + '）', active: sideService !== undefined, note: sideService !== undefined ? '编辑区=侧边栏 Tab（对话+编辑同屏）' : '未检测到；安装 dsh-better-sidebar 后刷新启用侧边栏形态（' + SIDEBAR_INSTALL_CMD + '）' },
  ]

  ctx.provide('fileOpeners', registry)
  ctx.effect(() => registry.register(vscodeOpener()), 'vscode-mode: file opener')

  // 侧边栏面板注册表（对外 provide，供本插件/第三方注册面板；文件管理为面板 #1）
  const sidebarPanels = createSidebarPanelRegistry()
  ctx.provide('edrvSidebarPanels', sidebarPanels)
  ctx.effect(() => sidebarPanels.register(createFilePanel()), 'vscode-mode: sidebar panel')
  // 搜索面板：活动栏「搜索」页签（Ctrl+Shift+F 唤起，VSCode 搜索视图形态）
  ctx.effect(() => sidebarPanels.register(createSearchPanel()), 'vscode-mode: sidebar panel search')
  // 文件右键菜单项注册表（对外 provide，供本插件/第三方注册；内置「在文件浏览器中打开」）
  const fileMenuItems = createTreeMenuRegistry()
  ctx.provide('edrvFileContextMenuItems', fileMenuItems)
  for (const item of createDefaultFileMenuItems()) {
    ctx.effect(() => fileMenuItems.register(item), 'vscode-mode: file context menu item ' + item.id)
  }
  // 大纲源注册表（公开预留口）：第三方语言插件（LSP/VSIX 等）注册更高优先级源即可覆盖兜底
  const outlineSources = createOutlineSourceRegistry()
  ctx.provide('edrvOutlineSources', outlineSources)
  ctx.effect(() => registerBuiltinOutlineSources(outlineSources), 'vscode-mode: outline sources')
  ctx.effect(() => sidebarPanels.register(createOutlinePanel()), 'vscode-mode: sidebar panel outline')
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
  // 快捷键配置同步：设置提交后立即刷新键位匹配（编辑器/QuickOpen 按事件时读取）
  ctx.effect(() => {
    if (!settings) return undefined
    const sync = (): void => {
      const snapshot = settings.getSnapshot()
      if (snapshot.status === 'loading') return
      keybindingsApply(snapshot.value?.keybindings)
    }
    sync()
    return settings.subscribe(sync)
  }, 'vscode-mode: keybindings setting sync')
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

  // 中央「文件编辑」页签（旧形态回退）：类 VSCode 编辑器；侧边栏形态可用时编辑器住 betterSidebar Tab，
  // 本页签不注册（避免双实例：Monaco×2 + diff dock 每会话单源抢占）。
  const registerLegacyTab = (): (() => void) | null => {
    return registerSlotSafely(ctx, {
      name: 'conversation.view',
      id: 'edrv-editor',
      order: 5,
      label: '文件编辑',
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: unknown) => React.createElement(EditorView, Object.assign({}, props, { layout: 'tab', sideHint: SIDEBAR_INSTALL_CMD, schedule, addToConversation, sidebarPanels, outlineSources, fileMenuItems })))
  }

  // 侧边栏/中央页签两形态互斥切换：sideDisposer（侧边栏 Tab）与 legacyDisposer（中央页签）只保留其一。
  // ⚠️ betterSidebar 服务由 dsh-better-sidebar 的 client bundle（1MB+）在页面加载时提供，本插件
  // bundle 较小往往先执行完启动检测——一次性探测会误报「未检测到」并永久停在中央页签形态（实测
  // 竞态：better-sidebar 已装，但「文件编辑」Tab 未注册）。故启动后按 2s 间隔重试（窗口 ~30s），
  // 命中即自动切换侧边栏形态；始终未命中则保持中央页签回退。
  let sideDisposer: (() => void) | null = null
  let legacyDisposer: (() => void) | null = null
  const applySideForm = (): void => {
    if (sideService) {
      if (sideDisposer !== null) return
      if (legacyDisposer !== null) { legacyDisposer(); legacyDisposer = null }
      sideDisposer = ctx.effect(() => installSideEditor({
        service: sideService as NonNullable<typeof sideService>,
        renderTab: (props: Record<string, unknown>) => React.createElement(SideEditorTab, Object.assign({}, props, { schedule, addToConversation, sidebarPanels, outlineSources, fileMenuItems })),
        activeSession: () => {
          const snapshot = sessions?.list?.getSnapshot?.() as { current?: string; byId?: Record<string, { cwd?: string }> } | undefined
          const sessionId = snapshot?.current
          if (!sessionId) return undefined
          return { sessionId, cwd: snapshot?.byId?.[sessionId]?.cwd }
        },
        registerLegacyFallback: registerLegacyTab,
      }), 'vscode-mode: sidebar editor tab')
    } else {
      if (legacyDisposer !== null) return
      if (sideDisposer !== null) { sideDisposer(); sideDisposer = null }
      setEnsureSideEditor(null)
      legacyDisposer = registerLegacyTab()
    }
  }
  applySideForm()
  let sideRetries = 0
  const retrySideService = (): void => {
    if (sideService !== undefined || sideRetries >= 15) return
    sideRetries += 1
    schedule(() => {
      if (sideService !== undefined) return
      sideService = detectSidebarService(ctx)
      if (sideService !== undefined) {
        console.info('[dsh-vscode-mode] 检测到 ' + SIDEBAR_PLUGIN + '，切换侧边栏编辑形态')
        applySideForm()
      } else {
        retrySideService()
      }
    }, 2000)
  }
  retrySideService()

  // 对话输入框上方差异 dock：普通对话显示单文案按钮，文件编辑页由 EditorView 隐藏
  registerSlotSafely(ctx, {
    name: 'conversation.input.dock',
    id: 'edrv-diff-dock',
    order: 30,
    label: '差异',
    inject: (sessionId: string) => ({ sessionId }),
  }, (props: unknown) => React.createElement(ConversationDiffDock, Object.assign({}, props)))

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