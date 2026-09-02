// @ts-nocheck
/**
 * dsh-vscode-mode client — EditorView：中央 VSCode 式文件编辑器（编排层）。
 * 迁移自原 src/client/index.ts 的 EditorView，语义不改；差异自绘已抽到 monaco/diffRender。
 * 职责：页签/QuickOpen/Monaco 编辑器/差异审查（DiffBox/Launcher/Badge 事件装配）/状态栏/自动保存。
 * 作者 ddj 2026-08-20
 */
import React from 'react'
import { dbg, rpc } from '../rpc.js'
import { emitRefresh } from '../events.js'
import { langOf, loadMonaco } from '../monaco/loader.js'
import { applyTheme, registerThemes, themeNameOf } from '../monaco/theme.js'
import { createDiffRenderer } from '../monaco/diffRender.js'
import { ST, callIdAttr, noopHunk, summarize } from '../state/records.js'
import { diffRegions } from '../state/regions.js'
import { QuickOpen } from './QuickOpen.js'
import { DiffLauncher } from './DiffLauncher.js'
import { SidebarView } from '../sidebar/SidebarView.js'
import { clearDiffDock, publishDiffDock } from '../diffDockStore.js'
import { displayDiffTotal, editorDockMode } from '../diffDock.js'
import { editorHeight } from '../editorLayout.js'
import { revealInExplorer as revealPathInExplorer } from '../fileReveal.js'
import { setSidePending, SIDEBAR_INSTALL_CMD } from '../sidebarBridge.js'
import { upsertViewState, viewStatesLoad, viewStatesSave } from '../state/viewStateCache.js'
import { bindingsOf, chordOf, matchEvent, useKeybindingsVersion } from '../keybindings.js'
import { createNavHistory } from '../navHistory.js'
import { CACHE_KEY } from '../paths.js'
import { bindLspEditor, runGoToDefinition, runFindReferences, hideReferencesOverlay } from '../monaco/lsp/providers.js'
import { bindLspUnderline } from '../monaco/lsp/underline.js'
import { onLspProgress, refreshStatus } from '../monaco/lsp/index.js'

/**
 * 中央编辑区：文件页签（脏点/关闭/打开路径）+ Ctrl+P 搜索 + Monaco 编辑器 +
 * 底部差异条（DiffBox/空态）+ 全局差异下拉（DiffLauncher）+ 状态栏。
 * @param props.sessionId 会话 id
 * @param props.schedule 延时调度（ctx.timeout）
 * @param props.layout 布局形态：'tab'（中央页签，默认）| 'side'（侧边栏面板）
 * @param props.sideHint 旧页签形态下显示侧边栏引导（安装命令）
 */
export function EditorView(props) {
  const sessionId = props?.sessionId
  const schedule = props.schedule
  const addToConversation = props.addToConversation
  const layout = props?.layout === 'side' ? 'side' : 'tab'
  const sideHint = props?.sideHint
  const [monaco, setMonaco] = React.useState(null)
  const [monacoErr, setMonacoErr] = React.useState(null)
  const [records, setRecords] = React.useState({})
  const [tabs, setTabs] = React.useState([])
  const [active, setActive] = React.useState(null)
  const [dirtyMap, setDirtyMap] = React.useState({})
  const [content, setContent] = React.useState(null)
  const [contentPath, setContentPath] = React.useState(null)
  const [status, setStatus] = React.useState('')
  const [lspServers, setLspServers] = React.useState([])
  const [error, setError] = React.useState(null)
  const [loadError, setLoadError] = React.useState(null)
  const [loadStage, setLoadStage] = React.useState({ progress: 0, message: '准备加载编辑器…' })
  const [openInput, setOpenInput] = React.useState(false)
  const [pathDraft, setPathDraft] = React.useState('')
  const [cursor, setCursor] = React.useState('')
  const [launcherOpen, setLauncherOpen] = React.useState(false)
  const [launcherTab, setLauncherTab] = React.useState('pending')
  const [hoverAct, setHoverAct] = React.useState(null) // { region, top } 编辑区 hover 差异块的 Keep/Undo 浮层
  const [diffIdx, setDiffIdx] = React.useState(0) // 当前文件内差异位置（x/x 显示）
  const [fileIdx, setFileIdx] = React.useState(0) // 全局差异文件位置（x/x 文件 显示）
  const [tabMenu, setTabMenu] = React.useState(null) // Tab 右键菜单 { x,y,path }（编辑区右键走 Monaco 原生菜单，无此浮层）
  const [sidebarOn, setSidebarOn] = React.useState(layout !== 'side') // 侧边栏显隐（侧栏形态默认收起）
  const [sidebarW, setSidebarW] = React.useState(240) // 侧边栏宽度
  const [activePanel, setActivePanel] = React.useState('explorer') // 激活面板 id
  const [focusRequest, setFocusRequest] = React.useState(0) // 外部差异聚焦请求版本
  const kbVersion = useKeybindingsVersion() // 快捷键配置版本（tooltip 文案随键位刷新）
  const [hintDismissed, setHintDismissed] = React.useState(() => {
    try { return localStorage.getItem(CACHE_KEY.sideHint) === '1' } catch { return false }
  }) // 侧边栏引导条是否已关闭
  const editorRef = React.useRef(null)
  const viewRootRef = React.useRef(null)
  const monacoRef = React.useRef(null)
  const modelsRef = React.useRef(new Map())
  // 视图状态缓存（path → Monaco viewState；重启后恢复光标/滚动/折叠位置）
  const viewStatesRef = React.useRef({})
  const saveTimerRef = React.useRef(null)
  const loadSeqRef = React.useRef(0)
  const programmaticRef = React.useRef(false)
  const bootRef = React.useRef(false)
  const pendingFocusRef = React.useRef(null) // { path, region } 内容加载后跳转
  // 导航历史（后退/前进）：跨文件焦点位置；按会话隔离，会话切换重置
  const navRef = React.useRef(null)
  if (!navRef.current) navRef.current = createNavHistory()
  const navPendingRef = React.useRef(null) // { path,line,column,viewState } 待恢复条目（内容就绪后消费）
  const navCursorTimerRef = React.useRef(null) // 光标位置防抖记录计时器
  const navBackRef = React.useRef(null) // 后退动作最新闭包（窗口级键盘监听读取）
  const navForwardRef = React.useRef(null) // 前进动作最新闭包（窗口级键盘监听读取）
  const [navTick, setNavTick] = React.useState(0) // 历史可用性版本（按钮 disabled 重渲染）
  const hoverRegionsRef = React.useRef([]) // 当前 pending 区域镜像（稳定回调读取）
  const lineRegionMapRef = React.useRef(new Map()) // 行 → 区域 映射（hover 命中）
  const hoverKeyRef = React.useRef(null) // 当前 hover 区域 key（区域不变不重渲染）
  const hoverTopRef = React.useRef(null) // 当前 hover 浮窗 top（滚动后位置变化才重定位）
  const hoverRightRef = React.useRef(null) // 浮窗右侧避让 Monaco 缩略栏
  const hideTimerRef = React.useRef(null) // 延迟隐藏计时器（防闪烁）
  const hoverEditorRef = React.useRef(false) // 鼠标是否仍在编辑器命中区
  const hoverPanelRef = React.useRef(false) // 鼠标是否已进入 Keep/Undo 浮层
  const batchBusyRef = React.useRef(false) // 批量 Keep All/Undo All 防重入
  const menuHandlersRef = React.useRef(null) // 右键菜单动作的最新闭包（Monaco addAction 空依赖回调读取）
  const doSaveRef = React.useRef(null) // 保存动作的最新闭包（窗口级保存监听读取）
  const diffRendererRef = React.useRef(null)
  const layoutRef = React.useRef(layout) // ensureEditor 空依赖闭包读取的稳定布局
  layoutRef.current = layout
  if (!diffRendererRef.current) diffRendererRef.current = createDiffRenderer((sid, t) => dbg(sid, t))

  const currentRecords = React.useMemo(() => {
    const list = []
    for (const rec of Object.values(records)) if (rec.path === active && rec.archived !== true) list.push(rec)
    return list
  }, [records, active])

  const contentReady = content !== null && contentPath === active
  const regions = React.useMemo(() => diffRegions(currentRecords, contentReady ? content : null).filter((r) => !r.superseded), [currentRecords, content, contentPath, active])
  // useMemo 稳定引用：否则 hover 等重渲染会让 view zone effect 反复重建（- 号闪烁）
  const pendingRegions = React.useMemo(() => regions.filter((r) => r.status === ST.PENDING && !r.stale), [regions])
  const staleRegions = React.useMemo(() => regions.filter((r) => r.status === ST.PENDING && r.stale), [regions])
  hoverRegionsRef.current = pendingRegions
  // 行 → 差异区域 映射（hover O(1) 命中；每行归属其区域）
  const lineRegionMap = React.useMemo(() => {
    const map = new Map()
    for (const r of pendingRegions) {
      if (r.start === undefined || r.end === undefined) continue
      const last = Math.max(r.start, r.end - 1)
      for (let ln = r.start; ln <= last; ln++) if (!map.has(ln)) map.set(ln, r)
    }
    return map
  }, [pendingRegions])
  lineRegionMapRef.current = lineRegionMap
  const sum = React.useMemo(() => summarize(Object.values(records)), [records])

  const addTab = (path, select) => {
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev
      return prev.concat([{ path }])
    })
    if (select) setActive(path)
  }

  /**
   * 保存当前活动文件的视图状态（光标/滚动/折叠）到会话缓存。
   * @author ddj 2026年08月28号
   * @param path 要保存的文件路径（缺省 = 当前 active）
   */
  const saveViewState = (path) => {
    const ed = editorRef.current
    const target = path ?? active
    if (!ed || !target) return
    try {
      const state = ed.saveViewState()
      if (!state) return
      viewStatesRef.current = upsertViewState(viewStatesRef.current, target, state)
      viewStatesSave(sessionId, viewStatesRef.current)
    } catch (e) { /* 视图状态保存失败忽略 */ }
  }

  /**
   * 恢复指定文件的视图状态（内容就绪、setModel 后调用；恢复后即消费删除）。
   * @author ddj 2026年08月28号
   * @param path 文件路径
   */
  const restoreViewState = (path) => {
    const ed = editorRef.current
    if (!ed || !path) return
    const saved = viewStatesRef.current[path]
    if (!saved) return
    const next = Object.assign({}, viewStatesRef.current)
    delete next[path]
    viewStatesRef.current = next
    try { ed.restoreViewState(saved) } catch (e) { /* 恢复失败忽略（行号越界自动兜底） */ }
  }

  /**
   * 采集当前焦点条目：路径从编辑器 model 实时读取（避免空依赖闭包读到过期 active），
   * 位置/viewState 从编辑器读取；编辑器或模型未就绪 → null。
   * @author ddj 2026年09月04号
   * @returns 导航历史条目或 null
   */
  const captureNavEntry = () => {
    const ed = editorRef.current
    const model = ed?.getModel?.()
    const uriPath = model?.uri?.path
    if (!ed || !uriPath) return null
    let line = null
    let column = null
    try {
      const pos = ed.getPosition?.()
      if (pos) { line = pos.lineNumber; column = pos.column }
    } catch (e) { /* 位置读取失败降级为仅路径 */ }
    let viewState = null
    try { viewState = ed.saveViewState() } catch (e) { /* 快照失败忽略 */ }
    return { path: decodeURIComponent(String(uriPath).replace(/^\//, '')), line, column, viewState }
  }

  /**
   * 记录当前位置到导航历史（同位置去重由历史模块处理；可用性变化时刷新按钮）。
   * @author ddj 2026年09月04号
   */
  const recordNav = () => {
    const entry = captureNavEntry()
    if (!entry) return
    const wasBack = navRef.current.canBack()
    const wasForward = navRef.current.canForward()
    navRef.current.record(entry)
    if (navRef.current.canBack() !== wasBack || navRef.current.canForward() !== wasForward) {
      setNavTick((v) => v + 1)
    }
  }

  /**
   * 跳到历史条目：保存当前视图状态后打开目标文件，内容就绪后恢复焦点。
   * @author ddj 2026年09月04号
   * @param entry 目标历史条目
   */
  const navigateTo = (entry) => {
    if (!entry || !entry.path) return
    flushSave()
    saveViewState(active)
    navPendingRef.current = entry
    addTab(entry.path, true)
    setFocusRequest((value) => value + 1) // 目标已是活动文件时也触发恢复
  }

  /**
   * 立即落盘待记录的光标位置（后退/前进前调用：<500ms 内刚移动的光标也算入历史）。
   * @author ddj 2026年09月04号
   */
  const flushNavCursor = () => {
    if (!navCursorTimerRef.current) return
    clearTimeout(navCursorTimerRef.current)
    navCursorTimerRef.current = null
    recordNav()
  }

  /**
   * 后退：恢复上一处焦点（跨文件）。
   * @author ddj 2026年09月04号
   */
  const navBack = () => {
    flushNavCursor()
    const entry = navRef.current.back()
    if (!entry) return
    navigateTo(entry)
    setNavTick((v) => v + 1)
  }

  /**
   * 前进：恢复下一处焦点（跨文件）。
   * @author ddj 2026年09月04号
   */
  const navForward = () => {
    flushNavCursor()
    const entry = navRef.current.forward()
    if (!entry) return
    navigateTo(entry)
    setNavTick((v) => v + 1)
  }
  navBackRef.current = navBack
  navForwardRef.current = navForward

  const closeTab = (path) => {
    flushSave()
    if (path === active) { saveViewState(path); recordNav() }
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path)
      if (idx < 0) return prev
      const next = prev.filter((t) => t.path !== path)
      if (active === path) setActive(next[idx] ? next[idx].path : (next[idx - 1] ? next[idx - 1].path : null))
      return next
    })
  }

  /**
   * 轮询去重：前后记录内容一致时返回原引用，React 跳过重渲染，
   * 阻断 5s 轮询 → memo 链 → diff 重渲染/日志 的空转。
   * @author ddj 2026年08月26号
   * @param prev 当前 records
   * @param next 轮询新结果
   * @returns 内容一致返回 true
   */
  const sameRecords = (prev, next) => {
    const pk = Object.keys(prev)
    const nk = Object.keys(next)
    if (pk.length !== nk.length) return false
    for (const k of pk) {
      if (!(k in next)) return false
      if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) return false
    }
    return true
  }

  const refreshRecords = (skipStale) => {
    if (!sessionId) return
    rpc('edrv.list', { sessionId, ...(skipStale ? { skipStale: true } : {}) }).then((res) => {
      if (!res || !res.ok || !Array.isArray(res.records)) return
      const map = {}
      for (const r of res.records) {
        if (r.archived === true) continue
        map[r.callId] = r
      }
      setRecords((prev) => (sameRecords(prev, map) ? prev : map))
    }).catch((e) => setError('list异常:' + String(e)))
  }

  /**
   * 加载文件内容（对齐 VSCode model 复用：会话内已打开的 model 直接秒显，
   * 后台静默 RPC 校验防陈旧；首次打开走原读取流程）。
   * @author ddj 2026年08月28号
   * @param path 文件路径
   * @param sid 会话 id
   * @param force 强制走 RPC（reloadFile 用，跳过 model 复用）
   */
  const loadContent = (path, sid, force) => {
    const seq = ++loadSeqRef.current
    const cachedModel = force ? null : modelsRef.current.get(path)
    if (cachedModel) {
      // model 命中：直接显示其内容（切 tab 零等待），后台静默校验
      setContent(cachedModel.getValue())
      setContentPath(path)
      setLoadStage((prev) => ({ progress: Math.max(84, prev.progress), message: '文件已读取，准备创建编辑器…' }))
      setStatus('已加载')
      rpc('edrv.read', { sessionId: sid, path }).then((res) => {
        if (seq !== loadSeqRef.current || path !== active) return
        if (res && res.ok && res.content !== cachedModel.getValue()) {
          saveViewState(path) // 内容更新前保留当前视图位置
          setContent(res.content)
          setStatus('已加载')
        }
      }).catch(() => { /* 校验失败保留缓存内容 */ })
      return
    }
    setLoadError(null)
    setLoadStage({ progress: monaco ? 72 : 12, message: '读取文件内容…' })
    rpc('edrv.read', { sessionId: sid, path }).then((res) => {
      if (seq !== loadSeqRef.current || path !== active) return
      if (res && res.ok) {
        setContent(res.content)
        setContentPath(path)
        setLoadStage((prev) => ({ progress: Math.max(84, prev.progress), message: '文件已读取，准备创建编辑器…' }))
        setStatus('已加载')
      } else {
        const base = res?.error ? String(res.error) : '读取失败'
        // 带出 host 解析后的真实路径：跳转失败时一眼看出是路径解析错还是目标不存在
        const message = res?.resolvedPath ? base + '：' + String(res.resolvedPath) : base
        setLoadError(message)
        setError(message)
        setStatus('读取失败')
      }
    }).catch((e) => {
      if (seq !== loadSeqRef.current) return
      const message = 'read异常:' + String(e)
      setLoadError(message)
      setError(message)
      setStatus('读取失败')
    })
  }

  // 挂载轮询 + 事件订阅
  React.useEffect(() => {
    if (!sessionId) return
    refreshRecords()
    const t = setInterval(refreshRecords, 5000)
    const onRefresh = () => refreshRecords()
    window.addEventListener('edrv:refresh', onRefresh)
    return () => { clearInterval(t); window.removeEventListener('edrv:refresh', onRefresh) }
  }, [sessionId])

  React.useEffect(() => {
    const publishLsp = (servers) => setLspServers(Array.isArray(servers) ? servers : [])
    const unsubscribe = onLspProgress(publishLsp)
    void refreshStatus(true).then(publishLsp)
    const timer = setInterval(() => { void refreshStatus(true).then(publishLsp) }, 1500)
    return () => { unsubscribe(); clearInterval(timer) }
  }, [sessionId])

  React.useEffect(() => {
    const onOpen = (e) => {
      const p = e?.detail?.path
      if (!p) return
      if (e?.detail?.focusDiff === true) {
        recordNav()
        pendingFocusRef.current = { path: p, region: null }
        setFocusRequest((value) => value + 1)
        addTab(p, true)
        return
      }
      if (e?.detail?.line != null) {
        // LSP/搜索跳转：打开并定位到行列
        openFileAt(p, e?.detail?.line, e?.detail?.column)
        return
      }
      recordNav()
      addTab(p, true)
    }
    const onShowLauncher = (event) => {
      const tab = event?.detail?.tab
      if (tab === 'pending' || tab === 'archive') setLauncherTab(tab)
      setLauncherOpen(true)
    }
    window.addEventListener('edrv:open-editor', onOpen)
    window.addEventListener('edrv:show-launcher', onShowLauncher)
    const onStatus = (e) => { if (e?.detail?.text) setStatus(e.detail.text) }
    window.addEventListener('edrv:status', onStatus)
    return () => {
      window.removeEventListener('edrv:open-editor', onOpen)
      window.removeEventListener('edrv:show-launcher', onShowLauncher)
      window.removeEventListener('edrv:status', onStatus)
    }
  }, [sessionId])

  // 对话输入区的唯一差异 dock 读取此会话快照；编辑器卸载时只清理自己的发布者令牌。
  const dockSourceRef = React.useRef({})
  React.useEffect(() => () => {
    clearDiffDock(sessionId, dockSourceRef.current)
    if (layout === 'side') setSidePending(sessionId, 0)
  }, [sessionId])

  // DSH composer 保持原生布局；编辑区只读取几何边界并同步自己的高度。
  // 侧栏形态：面板容器自带高度，跳过 composer 几何同步（面板内无会话滚动区）。
  React.useLayoutEffect(() => {
    if (layout === 'side') return
    const root = viewRootRef.current
    const scroll = root?.closest?.('[data-conversation-scroll]')
    if (!root || !scroll) return
    let seat = null
    let frame = null
    let resizeObserver = null
    const update = () => {
      frame = null
      const rootRect = root.getBoundingClientRect()
      const scrollRect = scroll.getBoundingClientRect()
      const seatRect = seat?.getBoundingClientRect?.()
      const height = editorHeight(rootRect.top, scrollRect.bottom, seatRect?.top)
      root.style.setProperty('--edrv-editor-height', height + 'px')
    }
    const scheduleUpdate = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(update)
    }
    const attachSeat = () => {
      const next = scroll.querySelector?.('[data-composer-seat]')
      if (next === seat) {
        scheduleUpdate()
        return
      }
      resizeObserver?.disconnect()
      seat = next
      resizeObserver = null
      if (seat && typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(scheduleUpdate)
        resizeObserver.observe(seat)
      }
      scheduleUpdate()
    }
    attachSeat()
    const mutationObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(attachSeat)
      : null
    mutationObserver?.observe(scroll, { childList: true })
    const scrollObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleUpdate) : null
    scrollObserver?.observe(scroll)
    window.addEventListener('resize', scheduleUpdate)
    scheduleUpdate()
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      scrollObserver?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
      root.style.removeProperty('--edrv-editor-height')
    }
  }, [sessionId, layout])

  // localStorage v2 恢复页签
  React.useEffect(() => {
    if (bootRef.current || !sessionId) return
    bootRef.current = true
    viewStatesRef.current = viewStatesLoad(sessionId)
    try {
      const raw = localStorage.getItem(CACHE_KEY.editor + String(sessionId))
      if (raw) {
        const saved = JSON.parse(raw)
        if (Array.isArray(saved.tabs) && saved.tabs.length) {
          setTabs(saved.tabs.map((p) => ({ path: p })))
          if (typeof saved.active === 'string') setActive(saved.active)
        }
      }
    } catch (e) { /* 损坏忽略 */ }
  }, [sessionId])

  // 导航历史会话隔离：切换会话时重置（历史仅会话内存，不跨会话串扰）
  React.useEffect(() => {
    navRef.current = createNavHistory()
    navPendingRef.current = null
    if (navCursorTimerRef.current) { clearTimeout(navCursorTimerRef.current); navCursorTimerRef.current = null }
    setNavTick((v) => v + 1)
  }, [sessionId])

  React.useEffect(() => {
    if (!sessionId) return
    try { localStorage.setItem(CACHE_KEY.editor + String(sessionId), JSON.stringify({ tabs: tabs.map((t) => t.path), active })) }
    catch (e) { /* 忽略 */ }
  }, [tabs, active, sessionId])

  // 侧边栏状态：恢复（显隐/宽度/激活面板）；侧栏形态独立键（默认收起，不共享页签形态偏好）
  const sidebarKey = CACHE_KEY.sidebar + (layout === 'side' ? 'side.' : '') + String(sessionId)
  React.useEffect(() => {
    if (!sessionId) return
    try {
      const raw = localStorage.getItem(sidebarKey)
      if (raw) {
        const saved = JSON.parse(raw)
        if (typeof saved.on === 'boolean') setSidebarOn(saved.on)
        if (typeof saved.width === 'number') setSidebarW(Math.max(180, Math.min(560, saved.width)))
        if (typeof saved.panel === 'string') setActivePanel(saved.panel)
      }
    } catch (e) { /* 损坏忽略 */ }
  }, [sessionId, sidebarKey])

  // 侧边栏状态持久化
  React.useEffect(() => {
    if (!sessionId) return
    try { localStorage.setItem(sidebarKey, JSON.stringify({ on: sidebarOn, width: sidebarW, panel: activePanel })) }
    catch (e) { /* 忽略 */ }
  }, [sidebarOn, sidebarW, activePanel, sessionId, sidebarKey])

  // 切换侧边栏（capture 抢占，避免与 DSH 全局冲突；键位随快捷键配置）
  React.useEffect(() => {
    const onKey = (e) => {
      if (!matchEvent(e, bindingsOf('edrv.toggleSidebar'))) return
      e.preventDefault(); e.stopPropagation()
      setSidebarOn((v) => !v)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // 保存文件（窗口级）：编辑器有活动模型才拦截执行，无文件时放行（浏览器默认行为）
  React.useEffect(() => {
    const onKey = (e) => {
      if (!matchEvent(e, bindingsOf('edrv.save'))) return
      if (!editorRef.current?.getModel?.()) return
      e.preventDefault(); e.stopPropagation()
      flushSave()
      doSaveRef.current(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Ctrl+Shift+F 全局搜索：展开侧边栏 + 激活搜索页签，随后聚焦搜索输入框
  React.useEffect(() => {
    const onKey = (e) => {
      if (!matchEvent(e, bindingsOf('edrv.searchInFiles'))) return
      e.preventDefault(); e.stopPropagation()
      setSidebarOn(true)
      setActivePanel('search')
      setTimeout(() => window.dispatchEvent(new CustomEvent('edrv:search-focus')), 0)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // 后退/前进：导航历史（跨文件焦点位置；经 ref 读最新闭包，避免空依赖过期）
  React.useEffect(() => {
    const onKey = (e) => {
      if (!matchEvent(e, bindingsOf('edrv.navigateBack'))) return
      e.preventDefault(); e.stopPropagation()
      if (navBackRef.current) navBackRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  React.useEffect(() => {
    const onKey = (e) => {
      if (!matchEvent(e, bindingsOf('edrv.navigateForward'))) return
      e.preventDefault(); e.stopPropagation()
      if (navForwardRef.current) navForwardRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // 鼠标侧键后退/前进：Logitech 官方默认「后退/前进」= XButton 鼠标事件（button 3/4），不产生键盘事件。
  // pointerdown 触发导航（preventDefault 后兼容 mousedown 可能不再触发，避免双触发）；
  // mousedown 兜底仅取消浏览器历史导航默认动作（MDN：preventDefault mousedown/pointerdown 可抑制）。
  // @author ddj 2026年09月02号
  React.useEffect(() => {
    const onPointer = (e) => {
      if (e?.button !== 3 && e?.button !== 4) return
      e.preventDefault(); e.stopPropagation()
      const ref = e.button === 3 ? navBackRef : navForwardRef
      if (ref.current) ref.current()
    }
    const onMouse = (e) => {
      if (e?.button !== 3 && e?.button !== 4) return
      e.preventDefault(); e.stopPropagation()
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('mousedown', onMouse, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('mousedown', onMouse, true)
    }
  }, [])

  // 文件 → 待处理差异数 映射（侧边栏角标）
  const pendingByPath = React.useMemo(() => {
    const out = {}
    for (const f of sum.files) if (f.pending > 0) out[f.path] = f.pending
    return out
  }, [sum])

  React.useEffect(() => {
    if (!active) return
    setContent(null)
    setContentPath(null)
    setLoadError(null)
    setLoadStage({ progress: 10, message: '准备读取文件…' })
    setStatus('加载中…')
    loadContent(active, sessionId)
  }, [active, sessionId])

  // Tab 右键菜单打开时 Esc 关闭
  React.useEffect(() => {
    if (!tabMenu) return
    const onKey = (e) => { if (e.key === 'Escape') dismissMenus() }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [tabMenu])

  React.useEffect(() => {
    if (monaco || monacoErr) return
    let alive = true
    const onProgress = (stage) => {
      if (!alive) return
      const progress = stage.phase === 'ready' ? 70 : Math.round(10 + stage.progress * 0.6)
      setLoadStage((prev) => ({ progress: Math.max(prev.progress, progress), message: stage.message }))
    }
    loadMonaco(onProgress).then((m) => { if (alive) setMonaco(m) }).catch((e) => {
      if (alive) {
        setMonacoErr(String(e?.message ?? e))
        setStatus('Monaco 不可用')
      }
    })
    return () => { alive = false }
  }, [monaco, monacoErr])

  // 分色主题：Monaco 就绪后注册（幂等）+ 应用；DSH 明暗切换时跟随重刷。
  React.useEffect(() => {
    if (!monaco) return
    registerThemes(monaco)
    applyTheme(monaco)
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(monaco)
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    }
    query.addListener(onChange)
    return () => query.removeListener(onChange)
  }, [monaco])

  monacoRef.current = monaco

  const getModel = (path, text) => {
    const cache = modelsRef.current
    let model = cache.get(path)
    if (!model) {
      model = window.monaco.editor.createModel(text ?? '', langOf(path), window.monaco.Uri.parse('edrv:///' + encodeURI(path)))
      cache.set(path, model)
    } else if (text !== undefined && model.getValue() !== text) {
      programmaticRef.current = true
      model.setValue(text)
      programmaticRef.current = false
    }
    return model
  }

  const flushSave = () => {
    if (saveTimerRef.current) { saveTimerRef.current(); saveTimerRef.current = null }
  }

  const doSave = (silent) => {
    const ed = editorRef.current
    if (!active || !ed) return
    const text = ed.getValue()
    if (!silent) setStatus('保存中…')
    rpc('edrv.save', { sessionId, path: active, content: text }).then((res) => {
      if (res && res.ok) {
        setStatus('已保存 ' + new Date().toTimeString().slice(0, 8))
        setContent(text)
        setContentPath(active)
        setDirtyMap((d) => Object.assign({}, d, { [active]: false }))
        refreshRecords()
        emitRefresh()
      } else { setStatus('保存失败'); setError(res?.error ? String(res.error) : '保存失败') }
    }).catch((e) => { setStatus('保存失败'); setError('保存异常:' + String(e)) })
  }
  doSaveRef.current = doSave

  const onEdit = () => {
    const ed = editorRef.current
    if (!ed || !active) return
    setDirtyMap((d) => Object.assign({}, d, { [active]: true }))
    setStatus('编辑中…')
    if (saveTimerRef.current) saveTimerRef.current()
    saveTimerRef.current = schedule(() => doSave(true), 700)
  }

  // model 同步（当前内容）
  React.useEffect(() => {
    if (!monaco || !editorRef.current || !active || content === null) return
    const ed = editorRef.current
    const model = getModel(active, content)
    if (ed.getModel() !== model) ed.setModel(model)
    restoreViewState(active)
    setLoadStage((prev) => ({ progress: Math.max(96, prev.progress), message: '创建编辑器视图…' }))
  }, [monaco, active, content])

  // 行内差异自绘（decorations / view zones / minus overlay）→ diffRenderer
  React.useEffect(() => {
    if (!monaco || !editorRef.current || !active || content === null) return
    diffRendererRef.current.render(monaco, editorRef.current, pendingRegions, sessionId)
    setLoadStage({ progress: 100, message: '编辑器已就绪' })
  }, [monaco, active, content, pendingRegions])

  React.useEffect(() => () => {
    flushSave()
    saveViewState(active)
    diffRendererRef.current?.dispose?.()
    hideReferencesOverlay()
    if (editorRef.current) { editorRef.current.dispose(); editorRef.current = null }
    for (const m of modelsRef.current.values()) m.dispose()
    modelsRef.current.clear()
    const root = editorRef.current && editorRef.current.getDomNode ? editorRef.current.getDomNode() : null
    if (root) {
      const ov = root.querySelector('.edrv-minus-overlay')
      if (ov) ov.remove()
    }
  }, [])

  // 普通 Monaco 编辑器（可编辑、单列行号）+ 自绘行内差异（decoration 绿底+ / view zone 删除块）
  const ensureEditor = React.useCallback((node) => {
    if (!node) {
      if (editorRef.current) { editorRef.current.dispose(); editorRef.current = null }
      return
    }
    if (editorRef.current || !monacoRef.current) return
    const m = monacoRef.current
    const side = layoutRef.current === 'side'
    const ed = m.editor.create(node, {
      value: '',
      language: 'plaintext',
      theme: themeNameOf(),
      fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: !side, scale: 1 },
      glyphMargin: true,
      lineDecorationsWidth: 16,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 2,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: { top: side ? 6 : 8 },
    })
    // 保存改由窗口级快捷键监听执行（键位可配置；见上方 edrv.save 监听）
    ed.onDidChangeModelContent(() => {
      if (!ed.getModel() || programmaticRef.current) return
      onEdit()
    })
    ed.onDidChangeCursorPosition((e) => {
      setCursor('Ln ' + e.position.lineNumber + ', Col ' + e.position.column)
      // 导航历史：同文件内光标移动防抖记录（程序化恢复触发的位置与栈顶去重，无副作用）
      if (navCursorTimerRef.current) clearTimeout(navCursorTimerRef.current)
      navCursorTimerRef.current = setTimeout(() => {
        navCursorTimerRef.current = null
        recordNav()
      }, 500)
    })
    // 编辑区右键 → 注入 Monaco 原生 context menu（与 Go to Definition 等同菜单，避免分离浮层）。
    // 有选区时额外显示「选中内容」项：context key edrvSelection 由光标选区变化驱动。
    // 路径/选区在点击时从 model/editor 实时读取（不依赖闭包里的过期 active）。
    const menuHandlers = () => menuHandlersRef.current
    const pathOf = (edx) => {
      const model = edx?.getModel?.()
      const uriPath = model?.uri?.path
      return uriPath ? decodeURIComponent(String(uriPath).replace(/^\//, '')) : null
    }
    const selectionOf = (edx) => {
      const s = edx?.getSelection?.()
      if (!s) return null
      if (s.startLineNumber === s.endLineNumber && s.startColumn === s.endColumn) return null
      return { startLine: s.startLineNumber, endLine: s.endLineNumber }
    }
    const selKey = ed.createContextKey('edrvSelection', false)
    ed.onDidChangeCursorSelection((e) => {
      const s = e?.selection
      selKey.set(!!(s && (s.startLineNumber !== s.endLineNumber || s.startColumn !== s.endColumn)))
    })
    ed.addAction({
      id: 'edrv.addFileRef', label: '添加文件到对话', contextMenuGroupId: '1_edrv',
      precondition: 'editorTextFocus',
      run: (edx) => menuHandlers()?.addRefToChat(pathOf(edx)),
    })
    ed.addAction({
      id: 'edrv.addSelectionRef', label: '添加选中内容为引用', contextMenuGroupId: '1_edrv',
      precondition: 'edrvSelection',
      run: (edx) => {
        const s = selectionOf(edx)
        const p = pathOf(edx)
        if (s && p) menuHandlers()?.addRefToChat(p, { startLine: s.startLine, endLine: s.endLine })
      },
    })
    // 在 OS 文件浏览器中打开/定位当前活动文件（与文件管理栏右键菜单同源能力）。
    ed.addAction({
      id: 'edrv.revealInExplorer', label: '在文件浏览器中打开', contextMenuGroupId: '1_edrv',
      precondition: 'editorTextFocus',
      run: (edx) => menuHandlers()?.openInExplorer(pathOf(edx)),
    })
    // 语言智能（LSP）：转到定义 / 查找所有引用（右键 + F12/Shift+F12 键位）。
    ed.addAction({
      id: 'edrv.goToDefinition', label: '转到定义', contextMenuGroupId: '1_edrv',
      keybindings: m.KeyMod.CtrlCmd | m.KeyCode.F12,
      precondition: 'editorTextFocus',
      run: (edx) => { void runGoToDefinition(edx) },
    })
    ed.addAction({
      id: 'edrv.findReferences', label: '查找所有引用', contextMenuGroupId: '1_edrv',
      keybindings: m.KeyMod.Shift | m.KeyCode.F12,
      precondition: 'editorTextFocus',
      run: (edx) => { void runFindReferences(edx) },
    })
    ed.addCommand(m.KeyCode.F12, () => { void runGoToDefinition(ed) })
    bindLspEditor(ed)
    bindLspUnderline(ed, m)
    // hover 差异块 → 浮出 Keep/Undo（req：鼠标移到编辑区差异块时显示）
    // 防闪烁：① 区域不变不 setState（浮窗锚定差异块起始行，不跟随鼠标）；② 延迟隐藏；
    // ③ 浮窗自身 onMouseEnter 取消隐藏计时（鼠标在浮窗与编辑器间移动不闪）。
    const hideSoon = () => {
      if (hoverEditorRef.current || hoverPanelRef.current || hideTimerRef.current) return
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null
        if (hoverEditorRef.current || hoverPanelRef.current) return
        hoverKeyRef.current = null
        hoverTopRef.current = null
        setHoverAct(null)
      }, 180)
    }
    ed.onMouseMove((e) => {
      hoverEditorRef.current = true
      const line = e?.target?.position?.lineNumber
      const map = lineRegionMapRef.current
      if (!line || !map.size) { hoverEditorRef.current = false; hideSoon(); return }
      const hit = map.get(line)
      if (!hit) { hoverEditorRef.current = false; hideSoon(); return }
      const key = callIdAttr(hit.callId, hit.idx)
      const top = Math.max(0, ed.getTopForLineNumber(Math.max(1, hit.start)) - ed.getScrollTop())
      const layout = ed.getLayoutInfo()
      const minimapLeft = layout.minimap?.minimapLeft || 0
      const right = minimapLeft > 0 ? Math.max(12, layout.width - minimapLeft + 8) : Math.max(12, layout.verticalScrollbarWidth + 8)
      if (hoverKeyRef.current === key && hoverTopRef.current === top && hoverRightRef.current === right) return // 同区域同位置不重复更新
      hoverKeyRef.current = key
      hoverTopRef.current = top
      hoverRightRef.current = right
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
      setHoverAct({ region: hit, top, right })
    })
    editorRef.current = ed
  }, [])

  // 打开文件后的跳转（导航历史恢复/差异聚焦/搜索行列跳转，内容就绪后执行一次）
  React.useEffect(() => {
    const ed = editorRef.current
    if (!ed || content === null) return
    // 导航历史恢复优先：viewState 快照恢复滚动/折叠，行列补定位
    const nav = navPendingRef.current
    if (nav && nav.path === active) {
      navPendingRef.current = null
      if (nav.viewState) {
        try { ed.restoreViewState(nav.viewState) } catch (e) { /* 非法快照忽略（行号越界自动兜底） */ }
      }
      if (nav.line != null) {
        ed.revealLineInCenter(Math.max(1, nav.line))
        ed.setPosition({ lineNumber: Math.max(1, nav.line), column: Math.max(1, nav.column ?? 1) })
      }
      ed.focus()
      return
    }
    const pf = pendingFocusRef.current
    if (!pf || pf.path !== active) return
    if (pf.line != null) {
      // 搜索命中跳转：直接定位到行/列（不依赖差异区域）
      pendingFocusRef.current = null
      ed.revealLineInCenter(Math.max(1, pf.line))
      ed.setPosition({ lineNumber: Math.max(1, pf.line), column: Math.max(1, pf.column ?? 1) })
      ed.focus()
      return
    }
    const target = pf.region || pendingRegions[0]
    if (!target) return
    pendingFocusRef.current = null
    ed.revealLineInCenter(Math.max(1, target.start ?? 1))
    ed.setPosition({ lineNumber: Math.max(1, target.start ?? 1), column: 1 })
    ed.focus()
  }, [active, content, pendingRegions, focusRequest])

  const jumpTo = (region) => {
    if (editorRef.current) {
      editorRef.current.revealLineInCenter(Math.max(1, region?.start ?? 1))
      editorRef.current.setPosition({ lineNumber: Math.max(1, region?.start ?? 1), column: 1 })
      editorRef.current.focus()
    } else {
      pendingFocusRef.current = { path: active, region }
    }
  }

  // 索引校正：差异/文件被处理后 pending 列表变化，clamp 到有效范围
  React.useEffect(() => {
    if (diffIdx >= pendingRegions.length && pendingRegions.length > 0) setDiffIdx(pendingRegions.length - 1)
    else if (pendingRegions.length === 0) setDiffIdx(0)
  }, [pendingRegions.length])
  React.useEffect(() => {
    const i = sum.pendingFiles.findIndex((f) => f.path === active)
    if (i >= 0) { if (i !== fileIdx) setFileIdx(i) }
  }, [sum.pendingFiles, active])

  // 上下箭头：当前文件内差异切换（x/x）
  const gotoDiff = (delta) => {
    if (!pendingRegions.length) return
    const next = (diffIdx + delta + pendingRegions.length) % pendingRegions.length
    setDiffIdx(next)
    jumpTo(pendingRegions[next])
  }
  // 左右箭头：全局差异文件切换（x/x 文件），打开并跳转
  const gotoFile = (delta) => {
    if (!sum.pendingFiles.length) return
    const next = (fileIdx + delta + sum.pendingFiles.length) % sum.pendingFiles.length
    setFileIdx(next)
    openFile(sum.pendingFiles[next].path, true)
  }

  const openNextFile = () => {
    if (!sum.pendingFiles.length) return
    if (sum.pendingFiles.some((file) => file.path === active)) gotoFile(1)
    else openFile(sum.pendingFiles[0].path, true)
  }

  const reloadFile = (skipStale) => {
    if (!active) return
    loadContent(active, sessionId, true)
    refreshRecords(skipStale === true)
  }

  /**
   * 关闭当前差异浮窗并清理 hover 锚点。
   * @author ddj 2026年08月21号
   */
  const dismissHover = () => {
    hoverKeyRef.current = null
    hoverTopRef.current = null
    hoverRightRef.current = null
    hoverEditorRef.current = false
    hoverPanelRef.current = false
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
    setHoverAct(null)
  }

  /**
   * 对单个差异区域执行采纳/不采纳。
   * @author ddj 2026年08月20号
   * @param region 差异区域（callId/idx/create）
   * @param reject true=不采纳（回滚），false=采纳
   * @param silent 批量时抑制中间 reload/报错，由批量方统一收尾
   * @returns Promise<boolean> 是否成功
   */
  const actHunk = (region, reject, silent) => {
    const method = reject ? 'edrv.reject' : 'edrv.accept'
    return rpc(method, { sessionId, callId: region.callId, scope: region.create ? 'call' : 'hunk', hunkIndex: region.idx }).then((res) => {
      if (res && res.ok) {
        setRecords((prev) => Object.assign({}, prev, { [region.callId]: res.record }))
        if (!silent) { reloadFile(); emitRefresh() }
        return true
      }
      if (!silent) setError(res?.error ? String(res.error) : '操作失败')
      return false
    }).catch((e) => {
      if (!silent) setError('操作异常:' + String(e))
      return false
    })
  }

  /**
   * 批量采纳/不采纳：一次 RPC 处理多个差异（Keep 整文件 / Keep All / Undo All）。
   * 单次 setRecords 合并全部结果，避免逐条往返读写整个 sidecar。
   * @author ddj 2026年08月25号
   * @param items 决策项数组（callId/scope/hunkIndex/decision）
   * @returns Promise<{ok:number; fail:number}> 成功/失败计数
   */
  const actMany = (items) => {
    if (!items.length) return Promise.resolve({ ok: 0, fail: 0 })
    return rpc('edrv.decideBatch', { sessionId, items }).then((res) => {
      if (!res || !res.ok || !Array.isArray(res.results)) {
        setError(res?.error ? String(res.error) : '批量处理失败')
        return { ok: 0, fail: items.length }
      }
      let ok = 0
      let fail = 0
      const next = {}
      for (const item of res.results) {
        if (item && item.ok) {
          ok++
          if (item.record) next[item.callId] = item.record
        } else {
          fail++
        }
      }
      // 合并结果无变化（批量全部失败/重复点击）时不 setRecords：避免 records 换引用
      // → pendingRegions 换引用 → diff 全量重渲染（内容相同，纯空转）
      if (Object.keys(next).length) setRecords((prev) => Object.assign({}, prev, next))
      return { ok, fail }
    }).catch((e) => {
      setError('批量处理异常:' + String(e))
      return { ok: 0, fail: items.length }
    })
  }

  /**
   * 决策项构造（与单条 actHunk 的 scope 语义一致：create 记录走 call 作用域）。
   * @author ddj 2026年08月25号
   * @param r 差异区域/待处理项（callId/idx/create）
   * @param reject true=不采纳
   * @returns decideBatch items 元素
   */
  const itemOf = (r, reject) => ({ callId: r.callId, scope: r.create ? 'call' : 'hunk', hunkIndex: r.idx, decision: reject ? 'rejected' : 'accepted' })

  const acceptFile = () => {
    if (batchBusyRef.current || !pendingRegions.length) return
    batchBusyRef.current = true
    actMany(pendingRegions.map((r) => itemOf(r, false))).then(({ ok, fail }) => {
      batchBusyRef.current = false
      reloadFile(true)
      emitRefresh()
      setStatus('已采纳 ' + ok + ' 处差异' + (fail ? '，' + fail + ' 处失败' : ''))
      if (fail) setError(fail + ' 处差异处理失败（可能已被后续修改影响），可刷新后重试')
    }).catch(() => { batchBusyRef.current = false })
  }
  const undoFile = () => {
    if (batchBusyRef.current || !pendingRegions.length) return
    batchBusyRef.current = true
    actMany([...pendingRegions].reverse().map((r) => itemOf(r, true))).then(({ ok, fail }) => {
      batchBusyRef.current = false
      reloadFile(true)
      emitRefresh()
      setStatus('已不采纳 ' + ok + ' 处差异' + (fail ? '，' + fail + ' 处失败' : ''))
      if (fail) setError(fail + ' 处差异处理失败（可能已被后续修改影响），可刷新后重试')
    }).catch(() => { batchBusyRef.current = false })
  }

  // 所有差异文件的待处理 hunk 列表（二级菜单 Keep All / Undo All 用）
  const allPending = React.useMemo(() => {
    const out = []
    for (const rec of Object.values(records)) {
      if (rec.superseded === true) continue
      const perHunk = Array.isArray(rec.decisions?.perHunk) ? rec.decisions.perHunk : []
      const hunks = Array.isArray(rec.hunks) ? rec.hunks : []
      for (let i = 0; i < hunks.length; i++) {
        const st = perHunk.length ? perHunk[i] : rec.decisions.call
        if (st === 'pending' && !noopHunk(rec, hunks[i])) out.push({ callId: rec.callId, idx: i, create: rec.create === true, at: rec.at })
      }
    }
    return out
  }, [records])

  /**
   * 批量处理所有差异文件：采纳全部 / 不采纳全部。不采纳按 at 降序（新改先回滚）排序后一次 RPC。
   * @author ddj 2026年08月20号
   * @param reject true=全部不采纳（回滚），false=全部采纳
   */
  const actAllPending = (reject) => {
    if (batchBusyRef.current || !allPending.length) return
    batchBusyRef.current = true
    const list = reject ? [...allPending].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.idx - a.idx)) : allPending
    actMany(list.map((r) => itemOf(r, reject))).then(({ ok, fail }) => {
      batchBusyRef.current = false
      reloadFile(true)
      emitRefresh()
      setStatus((reject ? '已不采纳 ' : '已采纳 ') + ok + ' 处差异' + (fail ? '，' + fail + ' 处失败' : ''))
      if (fail) setError(fail + ' 处差异处理失败（可能已被后续修改影响），可刷新后重试')
    }).catch(() => { batchBusyRef.current = false })
  }
  const acceptAllFiles = () => actAllPending(false)
  const undoAllFiles = () => actAllPending(true)
  const rollbackFile = () => {
    if (!active) return
    if (!window.confirm('回滚当前文件到修改前状态？（相关差异将归档）')) return
    rpc('edrv.rollback', { sessionId, path: active }).then((res) => {
      if (res && res.ok) {
        setStatus('已回滚'); reloadFile()
        emitRefresh()
      } else setError(res?.error ? String(res.error) : '回滚失败')
    }).catch((e) => setError('回滚异常:' + String(e)))
  }

  /**
   * 关闭 Tab 右键菜单。
   * @author ddj 2026年08月25号
   */
  const dismissMenus = () => {
    setTabMenu(null)
  }

  /** 把「添加到对话」返回状态映射为状态栏文案。
   * @author ddj 2026年08月25号 */
  const statusOfAdd = (outcome, okText) => {
    if (outcome === 'ok') return okText
    if (outcome === 'busy') return okText + '（输入框忙，已降级纯文本）'
    return '无法添加到对话（无会话或输入框不可用）'
  }

  /** 添加文件/选中区引用到对话（异步，状态栏反馈）。 */
  const addRefToChat = (path, range) => {
    if (!path) { setStatus('无活动文件'); return }
    if (!addToConversation) { setStatus('添加到对话不可用'); return }
    addToConversation.appendReference(sessionId, path, range).then((o) => setStatus(statusOfAdd(o, '已添加文件引用')))
  }

  /**
   * 在 OS 文件浏览器中打开/定位路径（Monaco 右键菜单用，状态栏反馈）。
   * @author ddj 2026年08月27号
   * @param path 工作区相对路径（可能为 null）
   */
  const openInExplorer = (path) => {
    if (!path) { setStatus('无活动文件'); return }
    if (!sessionId) { setStatus('无活动会话'); return }
    setStatus('正在打开文件浏览器…')
    revealPathInExplorer(sessionId, path).then((outcome) => {
      setStatus(outcome.ok ? '已在文件浏览器中打开' : '打开失败')
      if (!outcome.ok && outcome.error) setError(outcome.error)
    })
  }

  // 供 Monaco 原生右键菜单 addAction 读取的最新动作闭包（空依赖回调不随渲染重建）
  menuHandlersRef.current = { addRefToChat, openInExplorer }

  const openFile = (path, focusDiff) => {
    if (!path) return
    recordNav()
    addTab(path, true)
    if (focusDiff) pendingFocusRef.current = { path, region: null }
  }

  /**
   * 打开文件并跳转到指定行列（搜索面板命中跳转）。
   * @author ddj 2026年08月26号
   * @param path 文件路径
   * @param line 目标行（缺省仅打开不跳转）
   * @param column 目标列（缺省 1）
   */
  const openFileAt = (path, line, column) => {
    if (!path) return
    recordNav()
    addTab(path, true)
    pendingFocusRef.current = { path, region: null, line: line ?? null, column: column ?? 1 }
    setFocusRequest((value) => value + 1)
  }

  const openPath = () => {
    const p = (pathDraft || '').trim()
    if (!p) return
    setStatus('打开中…')
    rpc('edrv.read', { sessionId, path: p }).then((res) => {
      if (res && res.ok) {
        openFile(p, false)
        setOpenInput(false); setPathDraft(''); setStatus('已打开'); setError(null)
      } else { setStatus('打开失败'); setError(res?.error ? String(res.error) : '打开失败') }
    }).catch((e) => { setStatus('打开失败'); setError('打开异常:' + String(e)) })
  }

  const tabsEl = React.createElement('div', { className: 'edrv-tabs', style: { flex: '1 1 auto', minWidth: 0 } },
    tabs.map((t) => React.createElement('div', {
      key: t.path,
      className: 'edrv-tab' + (t.path === active ? ' edrv-tab-active' : ''),
      title: t.path,
      onClick: () => { if (t.path !== active) { flushSave(); saveViewState(active); recordNav(); setActive(t.path) } },
      onContextMenu: (e) => {
        e.preventDefault()
        e.stopPropagation()
        setTabMenu({ x: e.clientX, y: e.clientY, path: t.path })
      },
    },
      React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 } }, t.path.split(/[\\/]/).pop() || t.path),
      (dirtyMap[t.path] ? React.createElement('span', { className: 'edrv-tab-dot' }) : null),
      React.createElement('span', { className: 'edrv-tab-x', onClick: (e) => { e.stopPropagation(); closeTab(t.path) } }, '×'))),
    (openInput
      ? React.createElement('input', { className: 'edrv-path-input', autoFocus: true, placeholder: '输入工作区相对/绝对路径，回车打开', value: pathDraft, onChange: (e) => setPathDraft(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') openPath(); if (e.key === 'Escape') setOpenInput(false) } })
      : React.createElement('button', { className: 'edrv-tab-add', title: '打开文件（输入路径）', onClick: () => setOpenInput(true) }, '+')))

  const pathBar = React.createElement('div', { className: 'edrv-pathbar', title: active || '' },
    React.createElement('span', { className: 'edrv-pb-name' }, active ? String(active).split(/[\\/]/).pop() : '未打开文件'),
    React.createElement('span', { className: 'edrv-pb-full' }, active || '使用右上搜索框 (' + (chordOf('edrv.quickOpen') ?? 'Ctrl+P') + ') 打开文件'),
    (active && langOf(active) ? React.createElement('span', { className: 'edrv-pb-meta' }, langOf(active)) : null),
    (cursor ? React.createElement('span', { className: 'edrv-pb-meta' }, cursor) : null),
    (status ? React.createElement('span', { className: 'edrv-pb-meta edrv-pb-status' }, status) : null))

  const lspLanguage = active ? langOf(active) : ''
  const lspServer = lspServers.find((item) => item.languageId === lspLanguage)
  const lspPhaseText = { idle: '未启动', starting: '启动中', ready: '已就绪', indexing: '解析中', unavailable: '不可用', stopped: '已停止' }
  const lspSourceText = { extension: '扩展', discover: '自动发现', manual: '手动配置', none: '未配置' }
  const lspLabel = lspServer
    ? 'LSP ' + lspLanguage + ' · ' + (lspPhaseText[lspServer.phase] ?? lspServer.phase) + ' · ' + (lspSourceText[lspServer.source] ?? lspServer.source)
    : 'LSP ' + lspLanguage + ' · 未启动'
  const lspProgress = typeof lspServer?.progress === 'number' ? Math.round(lspServer.progress) : null
  const lspFooter = (lspLanguage === 'lua' || lspLanguage === 'csharp')
    ? React.createElement('div', { className: 'edrv-statusbar', title: lspServer?.progressMessage || lspLabel },
        React.createElement('span', { className: 'edrv-lsp-status-dot ' + (lspServer?.phase === 'ready' ? 'ready' : lspServer?.phase === 'indexing' || lspServer?.phase === 'starting' ? 'busy' : 'idle') }),
        React.createElement('span', { className: 'edrv-sp-lsp' }, lspLabel),
        lspServer?.progressMessage ? React.createElement('span', { className: 'edrv-sp-progress-message' }, lspServer.progressMessage) : null,
        lspProgress !== null ? React.createElement('span', { className: 'edrv-sp-progress' }, lspProgress + '%') : null)
    : null

  // 导航历史按钮：目标条目名（tooltip 提示下一步会回到哪个文件）
  const navBackTarget = navRef.current.peekBack()
  const navForwardTarget = navRef.current.peekForward()
  const navNameOf = (entry) => (entry && entry.path ? String(entry.path).split(/[\\/]/).pop() : '')
  const tabRow = React.createElement('div', { style: { display: 'flex', alignItems: 'center', background: 'var(--dsw-alias-bg-layer-1,transparent)', flexShrink: 0 } },
    tabsEl,
    (sum.totalFiles > 0
      ? React.createElement('button', { className: 'edrv-diffchip', title: '打开差异总览/归档', onClick: () => setLauncherOpen((o) => !o) }, '⚠ 差异 ' + sum.totalFiles + ' 文件')
      : null),
    React.createElement('button', {
      className: 'edrv-chip-btn',
      title: '后退（' + (chordOf('edrv.navigateBack') ?? '未绑定') + '）' + (navBackTarget ? ' · ' + navNameOf(navBackTarget) : ''),
      disabled: !navRef.current.canBack(),
      'aria-label': '后退',
      onClick: navBack,
    }, '←'),
    React.createElement('button', {
      className: 'edrv-chip-btn',
      title: '前进（' + (chordOf('edrv.navigateForward') ?? '未绑定') + '）' + (navForwardTarget ? ' · ' + navNameOf(navForwardTarget) : ''),
      disabled: !navRef.current.canForward(),
      'aria-label': '前进',
      onClick: navForward,
    }, '→'),
    React.createElement('button', { className: 'edrv-chip-btn' + (sidebarOn ? ' edrv-chip-on' : ''), title: '切换侧边栏 (' + (chordOf('edrv.toggleSidebar') ?? 'Ctrl+B') + ')', onClick: () => setSidebarOn((v) => !v) }, '☰'),
    React.createElement('button', { className: 'edrv-chip-btn', title: '刷新', onClick: reloadFile }, '⟳'),
    React.createElement(QuickOpen, { sessionId, onOpen: (p) => openFile(p, false) }))

  const otherFiles = sum.pendingFiles.filter((f) => f.path !== active)

  /**
   * 渲染编辑器/文件加载进度面板。
   * @author ddj 2026年08月22号
   * @param message 当前加载阶段
   * @param progress 阶段进度
   * @param retry 可选重试回调
   * @returns 加载面板 React 元素
   */
  const loadingBody = (message, progress, retry) => React.createElement('div', { className: 'edrv-empty edrv-loading', 'aria-live': 'polite' },
    React.createElement('div', { className: 'edrv-loading-title' }, message),
    React.createElement('div', {
      className: 'edrv-progress',
      role: 'progressbar',
      'aria-label': '编辑器加载进度',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': progress,
    }, React.createElement('div', { className: 'edrv-progress-value', style: { width: Math.max(0, Math.min(100, progress)) + '%' } })),
    React.createElement('div', { className: 'edrv-loading-percent' }, Math.round(progress) + '%'),
    retry ? React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', onClick: retry }, '重试') : null)

  let body
  if (!monaco && !monacoErr) {
    body = loadingBody(loadStage.message, loadStage.progress)
  } else if (monacoErr) {
    body = React.createElement('div', { className: 'edrv-empty' },
      React.createElement('div', null, 'Monaco 编辑器加载失败：' + String(monacoErr)),
      React.createElement('div', { style: { fontSize: 11 } }, '请确认插件包 assets/vendor/monaco 完整（/edrv/vendor 路由可达）'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', onClick: () => { setMonacoErr(null); setLoadStage({ progress: 0, message: '准备重试 Monaco…' }) } }, '重试'))
  } else if (!active) {
    body = React.createElement('div', { className: 'edrv-empty' },
      React.createElement('div', null, '暂无打开的文件'),
      React.createElement('div', { style: { fontSize: 12 } }, '使用右上搜索框 (' + (chordOf('edrv.quickOpen') ?? 'Ctrl+P') + ') 打开工作区文件；agent 修改文件后顶部会出现差异角标'))
  } else if (content === null && loadError) {
    body = loadingBody('文件加载失败：' + loadError, 0, () => {
      setLoadError(null)
      setContent(null)
      setContentPath(null)
      setLoadStage({ progress: 10, message: '重新读取文件…' })
      loadContent(active, sessionId)
    })
  } else if (content === null) {
    body = loadingBody(loadStage.message || '读取文件内容…', loadStage.progress)
  } else {
    body = React.createElement('div', { className: 'edrv-monaco-host' },
      React.createElement('div', { ref: ensureEditor }))
  }

  const hoverEl = (hoverAct && !launcherOpen)
    ? React.createElement('div', {
        className: 'edrv-hoveract',
        style: { top: hoverAct.top, right: hoverAct.right ?? 12 },
        onMouseEnter: () => { hoverPanelRef.current = true; if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null } },
        onMouseMove: () => { hoverPanelRef.current = true; if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null } },
        onMouseLeave: () => {
          hoverPanelRef.current = false
          if (hoverEditorRef.current || hideTimerRef.current) return
          hideTimerRef.current = setTimeout(() => {
            hideTimerRef.current = null
            if (hoverEditorRef.current || hoverPanelRef.current) return
            hoverKeyRef.current = null
            hoverTopRef.current = null
            setHoverAct(null)
          }, 420)
        },
      },
        React.createElement('button', { className: 'edrv-pill edrv-pill-keep', onClick: () => { dismissHover(); actHunk(hoverAct.region, false) } }, '✓ Keep'),
        React.createElement('button', { className: 'edrv-pill edrv-pill-undo', onClick: () => { dismissHover(); actHunk(hoverAct.region, true) } }, '↩ Undo'))
    : null

  /** 组装差异 dock 快照（发布给 conversation.input.dock 的唯一 DiffBox 实例）。 */
  const buildDockSnapshot = () => ({
    mode: editorDockMode(active),
    pendingRegions,
    staleRegions,
    onAct: actHunk,
    onAcceptFile: acceptFile,
    onUndoFile: undoFile,
    onAcceptAllFiles: acceptAllFiles,
    onUndoAllFiles: undoAllFiles,
    allPendingCount: allPending.length,
    onRollback: rollbackFile,
    onJump: jumpTo,
    otherFiles,
    onOpenOther: (path) => openFile(path, true),
    onOpenLauncher: (tab) => { setLauncherTab(tab || 'pending'); setLauncherOpen(true) },
    onRefresh: reloadFile,
    activePath: active,
    diffIdx: contentReady ? diffIdx : 0,
    diffTotal: displayDiffTotal(contentReady, pendingRegions.length, sum.files.find((file) => file.path === active)?.pending ?? 0),
    fileIdx,
    fileTotal: sum.pendingFiles.length,
    onPrevDiff: () => gotoDiff(-1),
    onNextDiff: () => gotoDiff(1),
    onPrevFile: () => gotoFile(-1),
    onNextFile: () => gotoFile(1),
    onOpenNextFile: openNextFile,
  })

  React.useEffect(() => {
    if (!sessionId) return
    publishDiffDock(sessionId, buildDockSnapshot(), dockSourceRef.current)
    // 侧栏形态同步 Tab 角标计数（仅本形态写入；页签形态清零避免残留）
    if (layout === 'side') setSidePending(sessionId, sum.totalFiles)
    else setSidePending(sessionId, 0)
  })

  const overlay = launcherOpen
    ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 30 }, onClick: () => setLauncherOpen(false) }),
        React.createElement(DiffLauncher, { sessionId, sum, tab: launcherTab, onClose: () => setLauncherOpen(false), onOpenFile: (p) => { openFile(p, true); setLauncherOpen(false) } }))
    : null

  // Tab 右键菜单浮层：全屏遮罩（点击/右键关闭）+ 菜单（固定定位，clamp 防越界）。
  // 编辑区右键走 Monaco 原生 context menu（editor.addAction），不在此渲染浮层。
  /**
   * 计算右键菜单固定定位（clamp 防越出视口）。
   * @author ddj 2026年08月25号
   */
  const menuPos = (x, y) => ({
    left: Math.max(4, Math.min(x, (window.innerWidth || 800) - 224)),
    top: Math.max(4, Math.min(y, (window.innerHeight || 600) - 176)),
  })
  const menuBackdrop = tabMenu
    ? React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 70 },
        onClick: dismissMenus,
        onContextMenu: (e) => { e.preventDefault(); dismissMenus() },
      })
    : null
  const tabMenuEl = tabMenu
    ? React.createElement('div', { className: 'edrv-ctxmenu', style: menuPos(tabMenu.x, tabMenu.y) },
        React.createElement('button', { className: 'edrv-ctxmenu-item', onClick: () => { addRefToChat(tabMenu.path); dismissMenus() } }, '添加文件到对话'),
        React.createElement('div', { className: 'edrv-ctxmenu-sep' }),
        React.createElement('button', { className: 'edrv-ctxmenu-item edrv-ctxmenu-danger', onClick: () => { closeTab(tabMenu.path); dismissMenus() } }, '关闭标签页'))
    : null

  const sidebarPanels = props.sidebarPanels
  const sidebarCtx = {
    sessionId,
    openFile: (p) => openFile(p, false),
    openFileAt,
    activePath: active,
    pendingByPath,
    sum: { totalFiles: sum.totalFiles, files: sum.files },
    refreshRecords: () => refreshRecords(),
    editor: () => editorRef.current,
    outlineSources: props.outlineSources,
    fileMenuItems: props.fileMenuItems,
    notify: (message) => setStatus(message),
  }

  // 主编辑列（侧边栏右侧）：pathBar + tabRow + 编辑/差异区（底部整条留给 DSH 对话输入栏）
  const editorArea = React.createElement('div', { className: 'edrv-editor-area' },
    body,
    hoverEl,
    overlay)
  // 侧边栏引导条（仅旧页签形态且未装 betterSidebar 时显示；可复制安装命令、可关闭）
  const dismissHint = () => {
    setHintDismissed(true)
    try { localStorage.setItem(CACHE_KEY.sideHint, '1') } catch (e) { /* 忽略 */ }
  }
  const copyInstallCmd = () => {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(SIDEBAR_INSTALL_CMD).catch(() => {})
  }
  const sideHintEl = (layout === 'tab' && sideHint && !hintDismissed)
    ? React.createElement('div', { className: 'edrv-side-hint' },
        React.createElement('span', { className: 'edrv-side-hint-text' }, '安装 dsh-better-sidebar 后可启用侧边栏编辑（对话+编辑同屏）：'),
        React.createElement('code', { className: 'edrv-side-hint-cmd' }, SIDEBAR_INSTALL_CMD),
        React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '复制安装命令', onClick: copyInstallCmd }, '复制命令'),
        React.createElement('button', { className: 'edrv-side-hint-close', title: '关闭提示', 'aria-label': '关闭提示', onClick: dismissHint }, '×'))
    : null
  const mainCol = React.createElement('div', { className: 'edrv-main-col', style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    pathBar,
    tabRow,
    sideHintEl,
    editorArea,
    lspFooter)
  // 编辑器根节点按 composer 顶部边界动态限高，底部对话区域继续由 DSH 原生渲染。
  // 侧栏形态由面板容器给高（100%），不做 composer 几何同步。
  const editorRow = React.createElement('div', { className: 'edrv-editor-row' },
    (sidebarOn && sidebarPanels
      ? React.createElement(SidebarView, {
          registry: sidebarPanels,
          ctx: sidebarCtx,
          activePanel,
          onActive: setActivePanel,
          width: sidebarW,
          onWidth: setSidebarW,
          onHide: () => setSidebarOn(false),
        })
      : null),
    mainCol)

  const baseStyle = { minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base,transparent)', overflow: 'hidden' }
  const rootEl = layout === 'side'
    ? React.createElement('div', { ref: viewRootRef, 'data-edrv-view': '1', 'data-edrv-layout': 'side', className: 'edrv-view-side', style: Object.assign({}, baseStyle, { height: '100%' }) },
        editorRow,
        menuBackdrop,
        tabMenuEl)
    : React.createElement('div', { ref: viewRootRef, 'data-edrv-view': '1', style: Object.assign({}, baseStyle, { height: 'var(--edrv-editor-height, 100%)', maxHeight: 'var(--edrv-editor-height, 100%)' }) },
        editorRow,
        menuBackdrop,
        tabMenuEl)
  return rootEl
}
