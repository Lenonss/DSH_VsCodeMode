/**
 * dsh-vscode-mode client — 浏览器半入口：slot 注册 + 装配。
 * 挂点：官方右侧 Sidebar「文件编辑」Tab（DSH 0.1.5+，对话+编辑同屏）> betterSidebar Tab
 * （归档，仅旧版 DSH 回退）> conversation.view 中央页签 + conversation.input.dock 差异条 + header 差异角标。
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
import { PerfSizeBadge } from './ui/PerfSizeBadge.js'
import { ConversationDiffDock } from './ui/ConversationDiffDock.js'
import { McpSettings } from './ui/McpSettings.js'
import { rpc } from './rpc.js'
import { loadMonaco } from './monaco/loader.js'
import { observeScheme, schemeOfSnapshot } from './monaco/theme.js'
import { createFileOpenerRegistry, scanSidebar, officialSidebarOpener, shouldClaimFiles, type FileOpenContext } from './fileOpeners.js'
import type { FileOpenerRegistry } from './fileOpeners.js'
import { installOpenPathRouter, vscodeOpener, autoValue } from './openPathRouter.js'
import { patchRemoteOpen, probeRemoteOpen } from './remoteOpenRouter.js'
import { setupExtOpen } from './externalOpen.js'
import { SettingsContext } from './settingsContext.js'
import { SIDEBAR_PLUGIN, pickSettingsBinder, registerSlotSafely } from './compat.js'
import { detectSidebarService, installSideEditor, setEnsureSideEditor, SIDEBAR_INSTALL_CMD } from './sidebarBridge.js'
import { detectOfficial, installOfficial, registerOfficialFileClaim, OFFICIAL_TAB_KIND, OFFICIAL_TAB_TITLE, isEditorTabActive, restoreEditorTab } from './officialSidebar.js'
import { SideEditorTab } from './ui/SideEditorTab.js'
import { OfficialSideTab } from './ui/OfficialSideTab.js'
import { createClaimRouter } from './ui/ClaimRouter.js'
import { createAddToConversation } from './addToConversation.js'
import { createSidebarPanelRegistry } from './sidebar/registry.js'
import { createFilePanel } from './sidebar/panels/index.js'
import { createSearchPanel } from './sidebar/panels/index.js'
import { createRulesPanel } from './sidebar/panels/index.js'
import { createTreeMenuRegistry } from './sidebar/contextMenu.js'
import { createDefaultFileMenuItems } from './sidebar/menuItems.js'
import { createOutlinePanel } from './outline/index.js'
import { createOutlineSourceRegistry, registerBuiltinOutlineSources } from './outline/sources.js'
import { createLspOutlineSource } from './outline/lspSource.js'
import { keybindingsApply } from './keybindings.js'
import { createCommandBridge } from './commandBridge.js'
import { REGISTRY_GLOBAL } from './commandGlobals.js'
import { sidebarMinApply } from './sidebarMin.js'
import { log } from './log.js'
import { setupLsp, setSession } from './monaco/lsp/index.js'
import type { CompatAdapter } from '../shared/compat.js'

// ⚠️ inject 只列必需服务：webUiSettings 是 @linxin666/dsh-client-ui-web-ui-settings 提供的
// 可选兼容桥（非官方服务），列入 inject 会让未装该桥的部署启动时 entry 永久 pending，
// web boot 直接失败（'1 entry did not activate'）。兼容层用 ctx.get 运行时探测 + 降级，不靠 inject。
export const inject = ['slots', 'timer', 'locale', 'connection', 'remote', 'workspaces', 'sessions', 'conversation', 'settingsScope']

/** 指令桥装配幂等标记（同一 document 重复 apply 只装配一次，避免重复键位监听）。 */
let commandsMounted = false

/**
 * 装配指令注册表（指令桥 + 命令栏）。
 * 指令桥不依赖已挂载编辑器（run 只派发窗口事件），故可在启动期装配；
 * 命令栏浮层的宿主由 CommandPalette 自己在编辑区树内认领。
 * @author ddj 2026年09月10号
 * @param ctx 客户端根上下文
 * @returns void
 */
function setupCommands(ctx: any): void {
  if (commandsMounted) return
  commandsMounted = true
  const bridge = createCommandBridge()
  ctx.provide(REGISTRY_GLOBAL, bridge.registry)
  // 无条件镜像到 window（DSH 不创建 window.dsh，旧条件式赋值是死代码 → 命令栏空表）
  const host = window as unknown as Record<string, unknown>
  host[REGISTRY_GLOBAL] = bridge.registry
  ctx.effect(() => () => {
    bridge.dispose()
    commandsMounted = false
    if (host[REGISTRY_GLOBAL] === bridge.registry) delete host[REGISTRY_GLOBAL]
  }, 'vscode-mode: command registry')
  log.info('指令系统已装配：' + bridge.registry.list().length + ' 条指令，Ctrl+Shift+P 打开命令栏')
}

/**
 * 装配客户端：注册中央编辑区视图与 header 差异角标。
 * @author ddj 2026年08月20号
 * @param ctx 客户端根上下文（slots + timer 服务）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  const schedule = (fn: () => void, ms: number) => ctx.timeout(fn, ms)

  // 指令系统（命令栏 + 指令注册表）先装配：命令栏在被任何 React slot 渲染前即可唤起
  setupCommands(ctx)

  const registry: FileOpenerRegistry = createFileOpenerRegistry()
  const workspaces = ctx.get('workspaces')
  const sessions = ctx.get('sessions')

  // 外部深链落地：Windows 右键菜单 / Unity 外部编辑器 → 浏览器 URL 参数 → 打开规则路由
  setupExtOpen(ctx)

  // Monaco 加载时机：不再 DSH 启动即预热，改为进入会话界面（sessions.list.current 出现）后再后台加载，
  // 用户点开「文件编辑」页签即用；空闲时仍由 EditorView 挂载兜底加载。
  // 模块级 promise 去重，重复触发只首次真正加载；requestIdleCallback 让出会话首屏带宽，缺省回退延时调度；
  // 预热失败静默吞掉（loader 失败会重置 promise，页签打开时仍走原有加载/重试路径）。
  const monacoList = sessions?.list
  if (typeof window !== 'undefined' && monacoList && typeof monacoList.subscribe === 'function') {
    const list = monacoList as { getSnapshot: () => { current?: unknown }; subscribe: (listener: () => void) => () => void }
    const schedulePreload = () => {
      const preload = () => loadMonaco(() => {}).then((m: unknown) => setupLsp(m)).catch(() => {})
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(preload, { timeout: 2000 })
      else schedule(preload, 300)
    }
    const onSessionEnter = () => {
      const current = list.getSnapshot()?.current
      if (!current) return
      setSession(current)
      schedulePreload()
    }
    ctx.effect(() => list.subscribe(onSessionEnter), 'vscode-mode: monaco session trigger')
    onSessionEnter()
  }
  // 会话切换 → LSP 文档归属更新 + 状态刷新
  if (monacoList && typeof monacoList.subscribe === 'function') {
    const list = monacoList as { getSnapshot: () => { current?: string }; subscribe: (listener: () => void) => () => void }
    ctx.effect(() => list.subscribe(() => {
      setSession(list.getSnapshot()?.current)
    }), 'vscode-mode: lsp session sync')
  }
  // 会话切换 → 编辑 Tab 跨会话自动恢复：上一会话编辑区激活时，新会话自动展开并激活
  //（官方停靠面按会话隔离，新会话默认收起；先试 openTabIn 直写新会话面，未 adopt 走有界重试）。
  // 注意：首次打开某会话时通知早于 current 字段落定，故通知只调度延迟任务，执行时再读最新快照
  if (monacoList && typeof monacoList.subscribe === 'function') {
    const list = monacoList as { getSnapshot: () => { current?: string }; subscribe: (listener: () => void) => () => void }
    ctx.effect(() => {
      let lastCurrent = list.getSnapshot?.()?.current
      const check = () => {
        const current = list.getSnapshot?.()?.current
        if (!current || current === lastCurrent) return
        lastCurrent = current
        if (!isEditorTabActive() || officialService === undefined) return
        try { officialService.service.openTabIn?.(current, OFFICIAL_TAB_KIND, {}) } catch { /* 未 adopt 等 seat 就绪走重试 */ }
        restoreEditorTab(officialService.service, schedule)
      }
      return list.subscribe(() => schedule(check, 0))
    }, 'vscode-mode: editor tab restore')
  }
  const originalOpenPath = workspaces?.openPath
  const binder = pickSettingsBinder(ctx)
  const settings = binder.scope
  let selected = autoValue('auto')
  /** 0.1.3+ 会话文件链接路由（remote.session.openWorkspacePath）是否已安装（compatSummary 展示用）。 */
  let remoteOpenInstalled = false
  /** 两条文件链接路由共用的路由日志（openPathRouter / remoteOpenRouter；统一走插件日志器）。 */
  const routeLogger = (message: string): void => log.warn(message)
  /** 两条路由共用的 FileOpenContext：当前会话 id 与工作区 cwd。 */
  const openContext = (): FileOpenContext => {
    const current = sessions?.list?.getSnapshot?.()
    const sessionId = current?.current
    const summary = sessionId ? current?.byId?.[sessionId] : undefined
    return { sessionId, cwd: summary?.cwd } as FileOpenContext
  }
  /** 可选探测 betterSidebar 服务（不进 inject：缺失会让插件停靠等待，杀死回退路径）。 */
  let sideService = detectSidebarService(ctx)
  /** 可选探测官方右侧 Sidebar（DSH 0.1.5-alpha.1+；探测命中 ≡ 版本判定，不进 inject 同上）。 */
  let officialService = detectOfficial(ctx)
  /** 官方 file 地址认领的当前注销器（null=未认领；由 syncFileClaim 依设置值切换）。 */
  let claimDisposer: (() => void) | null = null
  /** 「添加到对话」动作集：编辑区/Tab 右键菜单注入文件引用与代码块（conversation 服务缺失时各动作安全降级）。 */
  const addToConversation = createAddToConversation(ctx)

  /** 客户端侧兼容摘要（与 host 报告合并展示；惰性求值保证 HMR 后仍新鲜）。 */
  const compatSummary = (): CompatAdapter[] => [
    { name: '设置桥', active: settings !== undefined, note: settings !== undefined ? '使用 ' + binder.service + ' 桥' : '未绑定设置服务（fileOpenTool 持久化不可用）' },
    { name: '文件打开路由（workspaces.openPath）', active: Boolean(workspaces?.openPath), note: 'vscode 打开器优先，失败回退系统打开（0.1.2 及更早 DSH 的对话文件链接主路径）' },
    { name: '会话文件链接路由（remote.session.openWorkspacePath）', active: remoteOpenInstalled, note: '0.1.3+ 对话文件引用/产物打开优先走插件打开器，失败回退系统打开' },
    { name: '侧边栏打开器（' + SIDEBAR_PLUGIN + '）', active: registry.get(SIDEBAR_PLUGIN) !== undefined, note: registry.get(SIDEBAR_PLUGIN) !== undefined ? '已注册（优先级 80）' : '未检测到侧边栏打开能力' },
    { name: '侧边栏编辑区（官方 Sidebar）', active: officialService !== undefined, note: officialService !== undefined ? '编辑区=官方右侧 Sidebar Tab（对话+编辑同屏，DSH 0.1.5+）' : '官方侧边栏服务未探测到（DSH < 0.1.5-alpha.1 时属预期）' },
    { name: '侧边栏编辑区（' + SIDEBAR_PLUGIN + '，归档）', active: sideService !== undefined, note: sideService !== undefined ? '编辑区=侧边栏 Tab（旧版 DSH 回退形态）' : '未检测到；DSH ≥ 0.1.5 优先官方侧边栏，旧版可安装（' + SIDEBAR_INSTALL_CMD + '）' },
    { name: '文件链接官方认领（dsh-resource://file）', active: claimDisposer !== null, note: claimDisposer !== null ? '聊天文件链接转发进单一编辑器页签（文件分页归编辑器自带页签栏）' : '链接走官方查看器或旧版路由（未认领）' },
  ]

  ctx.provide('fileOpeners', registry)
  ctx.effect(() => registry.register(vscodeOpener()), 'vscode-mode: file opener')

  // 侧边栏面板注册表（对外 provide，供本插件/第三方注册面板；文件管理为面板 #1）
  const sidebarPanels = createSidebarPanelRegistry()
  ctx.provide('edrvSidebarPanels', sidebarPanels)
  ctx.effect(() => sidebarPanels.register(createFilePanel()), 'vscode-mode: sidebar panel')
  // 搜索面板：活动栏「搜索」页签（Ctrl+Shift+F 唤起，VSCode 搜索视图形态）
  ctx.effect(() => sidebarPanels.register(createSearchPanel()), 'vscode-mode: sidebar panel search')
  // 规则面板：活动栏「规则」页签（Codebuddy 规则管理形态：用户/项目规则 + 启用开关，host 注入生效）
  ctx.effect(() => sidebarPanels.register(createRulesPanel()), 'vscode-mode: sidebar panel rules')
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
  // LSP 大纲源（priority 60）：lua/csharp 有 host 服务器时优先生效，否则自动落入 fallback
  ctx.effect(() => outlineSources.register(createLspOutlineSource()), 'vscode-mode: outline lsp source')
  ctx.effect(() => sidebarPanels.register(createOutlinePanel()), 'vscode-mode: sidebar panel outline')
  ctx.effect(() => registry.register({
    id: 'system', label: '系统默认应用', priority: 0,
    open: (path: string) => originalOpenPath.call(workspaces, path),
  }), 'vscode-mode: system file opener')
  ctx.effect(() => {
    const sidebar = scanSidebar(ctx)
    return sidebar ? registry.register(sidebar) : undefined
  }, 'vscode-mode: sidebar file opener')
  // 官方侧边栏正文组件装配（页类型正文；兼作 file 认领转发失败时的兜底正文）
  const officialRenderTab = (props: Record<string, unknown>) => React.createElement(OfficialSideTab, Object.assign({}, props, { schedule, addToConversation, sidebarPanels, outlineSources, fileMenuItems, sessions }))
  /** 官方 file 地址认领同步：自动/VSCodeMode 档认领（转发进单一编辑器页签），其余交官方查看器。 */
  const syncFileClaim = (): void => {
    const official = officialService
    const want = official !== undefined && shouldClaimFiles(selected)
    if (want && claimDisposer === null && official) {
      // 认领正文只做转发：文件分页收归编辑器自带页签栏，官方侧栏不再按文件分裂编辑器实例
      const renderTab = createClaimRouter({ service: official.service, schedule, fallback: officialRenderTab })
      const disposer = registerOfficialFileClaim({ tabs: official.tabs, slots: ctx.slots, renderTab })
      if (disposer !== null) claimDisposer = ctx.effect(() => disposer, 'vscode-mode: official file claim')
      return
    }
    if (!want && claimDisposer !== null) {
      claimDisposer()
      claimDisposer = null
    }
  }
  ctx.effect(() => {
    if (!settings) return undefined
    const sync = (): void => {
      const snapshot = settings.getSnapshot()
      if (snapshot.status === 'loading') return
      selected = autoValue(snapshot.value?.fileOpenTool)
      syncFileClaim()
      window.dispatchEvent(new CustomEvent('edrv:file-open-tool-change', { detail: { value: selected } }))
    }
    sync()
    return settings.subscribe(sync)
  }, 'vscode-mode: file opener setting sync')
  // 快捷键配置同步：设置提交后立即刷新键位匹配（编辑器/QuickOpen 按事件时读取）
  // 同一订阅里顺带同步侧边栏最小宽度（sidebarMinWidth）→ 派发 edrv:sidebar-min-width 通知编辑器重夹
  ctx.effect(() => {
    if (!settings) return undefined
    const sync = (): void => {
      const snapshot = settings.getSnapshot()
      if (snapshot.status === 'loading') return
      keybindingsApply(snapshot.value?.keybindings)
      const minW = sidebarMinApply(snapshot.value?.sidebarMinWidth)
      window.dispatchEvent(new CustomEvent('edrv:sidebar-min-width', { detail: { value: minW } }))
    }
    sync()
    return settings.subscribe(sync)
  }, 'vscode-mode: keybindings setting sync')
  if (workspaces?.openPath) {
    ctx.effect(() => installOpenPathRouter({
      workspaces,
      registry,
      selected: () => selected,
      context: openContext,
      logger: routeLogger,
    }), 'vscode-mode: file link routing')
  }
  // 0.1.3+ 会话文件链接主路径：dsh-client-ui-chat 的 openFile 直接调
  // remote.session.openWorkspacePath（session/openWorkspacePath RPC），绕开
  // workspaces.openPath；该 namespace 由 api-remotes 在 loader.await 后挂载，
  // 晚于本插件 apply，且旧版 DSH 可能整段不存在——不加 inject（避免旧版停等
  // 永不激活），改为定时探测有界重试（与侧栏服务探测同款节奏）。
  let remoteRetries = 0
  const retryRemoteOpen = (): void => {
    if (remoteOpenInstalled || remoteRetries >= 15) {
      if (!remoteOpenInstalled) log.warn('未探测到 remote.session.openWorkspacePath，0.1.3+ 会话文件链接路由未安装')
      return
    }
    remoteRetries += 1
    schedule(() => {
      if (remoteOpenInstalled) return
      const service = probeRemoteOpen(ctx)
      if (!service) {
        retryRemoteOpen()
        return
      }
      const disposer = patchRemoteOpen(service, { registry, selected: () => selected, context: openContext, logger: routeLogger })
      if (!disposer) {
        log.warn('remote.session 存在但 openWorkspacePath 不可补丁，会话文件链接路由未安装')
        return
      }
      remoteOpenInstalled = true
      ctx.effect(() => disposer, 'vscode-mode: remote file link routing')
      log.info('已安装 0.1.3+ 会话文件链接路由（remote.session.openWorkspacePath）')
    }, 2000)
  }
  retryRemoteOpen()

  // 官方主题跟随（DSH 0.1.5+）：ctx.theme 快照事件优先，其次明暗标记观察（observeScheme），
  // 都不可用时 theme.ts 的 detectColorScheme 兜底；统一广播 edrv:theme-change 触发 Monaco 主题重刷。
  const themeService = ctx.get('theme') as { getTheme?: () => unknown } | undefined
  const emitTheme = (): void => {
    const snapshot = typeof themeService?.getTheme === 'function' ? themeService.getTheme() : undefined
    window.dispatchEvent(new CustomEvent('edrv:theme-change', { detail: { scheme: schemeOfSnapshot(snapshot) } }))
  }
  ctx.effect(() => {
    if (!themeService || typeof ctx.on !== 'function') return undefined
    const disposer = ctx.on('theme/change', emitTheme)
    return typeof disposer === 'function' ? disposer : undefined
  }, 'vscode-mode: official theme event')
  ctx.effect(() => observeScheme(emitTheme), 'vscode-mode: theme attribute watch')
  emitTheme()

  // 中央「文件编辑」页签（旧形态回退）：类 VSCode 编辑器；侧边栏形态（官方/better-sidebar）可用时
  // 编辑器住侧边栏 Tab，本页签不注册（避免双实例：Monaco×2 + diff dock 每会话单源抢占）。
  const registerLegacyTab = (): (() => void) | null => {
    return registerSlotSafely(ctx, {
      name: 'conversation.view',
      id: 'edrv-editor',
      order: 5,
      label: '文件编辑',
      inject: (sessionId: string) => ({ sessionId }),
    }, (props: unknown) => React.createElement(EditorView, Object.assign({}, props, { layout: 'tab', sideHint: SIDEBAR_INSTALL_CMD, schedule, addToConversation, sidebarPanels, outlineSources, fileMenuItems, sessions })))
  }

  // 侧边栏三形态互斥切换：官方（DSH 0.1.5+）> better-sidebar（归档，仅旧版回退）> 中央页签。
  // officialDisposer / sideDisposer / legacyDisposer 任一时刻只保留其一（避免双实例 Monaco 抢占）。
  // ⚠️ 两个可选服务都可能晚于本插件就绪（better-sidebar bundle 1MB+ 后加载；官方服务旧 DSH
  // 不存在），一次性探测会误报——故启动后按 2s 间隔重试（窗口 ~30s）：每 tick 先探官方再探
  // better-sidebar；better-sidebar 先命中而官方后到时自动切换（官方优先），窗口结束仍未命中
  // 则保持中央页签回退。
  let officialDisposer: (() => void) | null = null
  let sideDisposer: (() => void) | null = null
  let legacyDisposer: (() => void) | null = null
  const installOfficialForm = (): void => {
    const official = officialService
    if (officialDisposer !== null || !official) return
    if (sideDisposer !== null) { sideDisposer(); sideDisposer = null }
    if (legacyDisposer !== null) { legacyDisposer(); legacyDisposer = null }
    const outcome = installOfficial({
      tabs: official.tabs,
      service: official.service,
      slots: ctx.slots,
      renderTab: officialRenderTab,
      guide: {
        title: () => OFFICIAL_TAB_TITLE,
        description: () => 'Monaco 文件编辑器：对话与编辑同屏（差异审查/跳转/大纲）',
      },
    })
    if (outcome === null) {
      // 官方类型注册失败（API 变更等）：撤下官方标记，回退旧形态链
      officialService = undefined
      applySideForm()
      return
    }
    officialDisposer = ctx.effect(() => outcome, 'vscode-mode: official sidebar editor tab')
    // 官方打开器（下拉「官方侧边栏」选项，动态出现；openResource 能力缺失时跳过）+ 按当前设置同步 file 地址认领
    if (typeof official.service.openResource === 'function') {
      ctx.effect(() => registry.register(officialSidebarOpener(official.service)), 'vscode-mode: official sidebar opener')
    }
    syncFileClaim()
  }
  const applySideForm = (): void => {
    if (officialService) {
      installOfficialForm()
      return
    }
    if (sideService) {
      if (sideDisposer !== null) return
      if (officialDisposer !== null) { officialDisposer(); officialDisposer = null }
      if (legacyDisposer !== null) { legacyDisposer(); legacyDisposer = null }
      sideDisposer = ctx.effect(() => installSideEditor({
        service: sideService as NonNullable<typeof sideService>,
        renderTab: (props: Record<string, unknown>) => React.createElement(SideEditorTab, Object.assign({}, props, { schedule, addToConversation, sidebarPanels, outlineSources, fileMenuItems, sessions })),
        activeSession: () => {
          const snapshot = sessions?.list?.getSnapshot?.() as { current?: string; byId?: Record<string, { cwd?: string }> } | undefined
          const sessionId = snapshot?.current
          if (!sessionId) return undefined
          return { sessionId, cwd: snapshot?.byId?.[sessionId]?.cwd }
        },
        registerLegacyFallback: registerLegacyTab,
      }), 'vscode-mode: sidebar editor tab')
      return
    }
    if (legacyDisposer !== null) return
    if (officialDisposer !== null) { officialDisposer(); officialDisposer = null }
    if (sideDisposer !== null) { sideDisposer(); sideDisposer = null }
    setEnsureSideEditor(null)
    legacyDisposer = registerLegacyTab()
  }
  applySideForm()
  let sideRetries = 0
  const retrySideService = (): void => {
    if (officialService !== undefined || sideRetries >= 15) return
    sideRetries += 1
    schedule(() => {
      if (officialService !== undefined) return
      officialService = detectOfficial(ctx)
      if (officialService !== undefined) {
        log.info('检测到官方右侧 Sidebar（DSH 0.1.5+），切换官方侧边栏编辑形态')
        applySideForm()
        return
      }
      if (sideService === undefined) {
        sideService = detectSidebarService(ctx)
        if (sideService !== undefined) {
          log.info('检测到 ' + SIDEBAR_PLUGIN + '，切换侧边栏编辑形态（官方未探测到，后续仍优先官方）')
          applySideForm()
        }
      }
      retrySideService()
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

  // header 会话体积指示器：当前会话持久化体积，超阈值提示新开会话（性能优化）
  registerSlotSafely(ctx, { name: 'conversation.session.header.utilities', id: 'edrv-perf-size', order: 89, label: '会话体积' },
    (props: unknown) => React.createElement(PerfSizeBadge, Object.assign({}, props, { sessions })))

  // 设置页中的 VSCodeMode 专属页签，MCP 管理作为该页签的内部子 Tab。
  registerSlotSafely(ctx, {
    name: 'settings.section',
    id: 'vscode-mode',
    order: 30,
    label: 'VSCodeMode',
  }, () => React.createElement(SettingsContext.Provider, { value: settings }, React.createElement(McpSettings, { openerRegistry: registry, compatSummary })))
}