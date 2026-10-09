// @ts-nocheck
/**
 * dsh-vscode-mode client — EditorView：中央 VSCode 式文件编辑器（编排层）。
 * 迁移自原 src/client/index.ts 的 EditorView，语义不改；差异自绘已抽到 monaco/diffRender。
 * 职责：页签/QuickOpen/Monaco 编辑器/差异审查（DiffBox/Launcher/Badge 事件装配）/状态栏/自动保存。
 * 状态作用域：页签/视图状态/侧边栏/展开树等 UI 状态按工作区作用域（cwd）隔离，
 * 同一工作区切换对话恢复同一份状态；无 cwd 会话回退按会话隔离（scopeStore）。
 * 作者 ddj 2026-08-20
 */
import React from 'react'
import { useOpenReceipt } from '../useOpenReceipt.js'
import { acceptsLoad, receiptErrorFor, receiptPath, receiptReadyFor, receiptTabPath } from '../receiptState.js'
import { bindPanelCommand } from '../panelCommands.js'
import { dbg, isDebug, rpc } from '../rpc.js'
import { emitFileChanged, emitRefresh } from '../events.js'
import { langOf, loadMonaco, snippetLanguageOf } from '../monaco/loader.js'
import { clampZoom, clearZoomMem, dataUrlOf, isImagePath, isSvgPath, recallZoom, rememberZoom, zoomKeyOf, zoomStepOf } from '../imagePreview.js'
import { isMarkdownPath } from '../markdownPreview.js'
import { setActiveEditorPath } from '../activePathStore.js'
import { MarkdownPanel } from '../md/mdPanel.js'
import { isPlanPath, planDocument } from '../planState.js'
import { MarkdownText, MarkdownDelegateProvider } from '@deepseek-ai/dsh-client-ui-primitives'
import { isComponentType } from '../md/componentType.js'
import { base64ToBytes, bytesToBase64, isPdfPath } from '../pdfPreview.js'
import { inNativePath, tryNativeOpen } from '../nativeOpenStore.js'
import { clearPendingNav, putPendingNav, readPendingNav } from '../pendingNav.js'
import { readBinaryPreview } from '../../shared/rpc.js'
import {
  clearBaseline,
  clearReadVersion,
  clearSync,
  markReadVersion,
  readSync,
  recordBaseline,
  type SyncFlag,
} from '../watchDecision.js'
import { useFileWatch } from './useFileWatch.js'
import { createPdfPanel } from '../pdf/pdfPanel.js'
import { SvnDiffPanel } from './SvnDiffPanel.js'
import { applyOfficial, registerThemes, themeNameOf } from '../monaco/theme.js'
import { createDiffRenderer } from '../monaco/diffRender.js'
import { ST, callIdAttr, noopHunk, summarize } from '../state/records.js'
import { diffRegions } from '../state/regions.js'
import { QuickOpen } from './QuickOpen.js'
import { attachHorizontalWheel } from './horizontalWheel.js'
import { CommandPalette } from './CommandPalette.js'
import { closeCommandPalette } from '../commandPaletteStore.js'
import { DiffLauncher } from './DiffLauncher.js'
import { SidebarView } from '../sidebar/SidebarView.js'
import { clearDiffDock, dockInLayout, publishDiffDock } from '../diffDockStore.js'
import { DiffBox } from './DiffBox.js'
import { displayDiffTotal, editorDockMode } from '../diffDock.js'
import { editorHeight } from '../editorLayout.js'
import { revealInExplorer as revealPathInExplorer } from '../fileReveal.js'
import { setSidePending, SIDEBAR_INSTALL_CMD } from '../sidebarBridge.js'
import { upsertViewState, viewStatesLoad, viewStatesSave } from '../state/viewStateCache.js'
import { mdPreviewLoad, mdPreviewSave } from '../state/mdPreviewCache.js'
import { onUiStateReady, reportUiStateEvent, uiStateSettled } from '../state/uiStatePersist.js'
import { migrateScopedKeys, workspaceScopeOf } from '../state/scopeStore.js'
import { modelsForScope, rememberModel } from '../state/modelCache.js'
import { navFlashRangeOf } from '../navHighlight.js'
import { chordOf, useKeybindingsVersion } from '../keybindings.js'
import { getSidebarMinWidth } from '../sidebarMin.js'
import { navHistoryFor } from '../navHistory.js'
import { navStateLoad, navStateSave } from '../state/navStateCache.js'
import { statusOfAdd } from '../addToConversation.js'
import { setSearchScope, setSearchSeed } from '../searchSeed.js'
import { CACHE_KEY } from '../paths.js'
import { runGoToDefinition, runFindReferences, hideReferencesOverlay } from '../monaco/lsp/providers.js'
import { isLuaTypeSlot } from '../monaco/lsp/keywords.js'
import { bindLspUnderline } from '../monaco/lsp/underline.js'
import { onLspProgress, refreshStatus, setSession as setLspSession } from '../monaco/lsp/index.js'
import { setupAiInline, trackAiEditor, aiInlineEnabled } from '../ai/inlineProvider.js'
import { SnippetsPicker } from './SnippetsPicker.js'
import { invalidateSnippets, setSnippetsSession, setupSnippets } from '../snippets/provider.js'
import { setupLaunchJson, prefetchSnippets } from '../dap/launchSnippetProvider.js'
import { findArrayPos, LAUNCH_JSON_RE } from '../dap/launchInsert.js'
import {
  absoluteOf, ancestorDirsOf, applyClose, baseNameOf, closeAll, closeOthers, closeRight, closeSaved,
  evictPlan, insertTab, isTreeRevealable, normalizeTabs, pickActive, relativeOf, remapPathOf, tabPathOf, togglePin,
} from '../tabActions.js'
import { getMaxOpenEditors } from '../editorLimit.js'
import { buildTabMenu } from '../tabMenu.js'
import { ensureSvnChanges, ensureSvnStatus, getSvnChanges, getSvnStatus, refreshSvnChanges, svnAdd, svnChangeMapOf, svnDiffBase, svnDiffLocalPair, svnEditorActions, svnRevert, svnTortoise } from '../svnStatus.js'
import { ensureSvnLog, getSvnLog, refreshSvnLog, svnDiffPair, svnDiffRev, svnDiffWorking, svnLogKeyOf, svnLogLoadedLimit, svnLogTruncated, svnWcRev, SVN_LOG_SHOW_ALL_LIMIT } from '../svnLog.js'
import { runSvnAction } from '../svnActions.js'
import { dshTrace } from '../svnStore.js'
import { SVN_ACTION_BY_ID, svnActionsFor } from '../../shared/svnActions.js'
import { isSvnDiffable } from '../../shared/svn.js'
import type { SvnAction } from '../../shared/svn.js'
import { createSaveTimer } from '../saveDebounce.js'
import { ContextMenu } from './ContextMenu.js'
import { promptName } from './PromptDialog.js'
import { openWithDialog } from '../openWithDialog.js'
import { copyText as copyClipText } from '../copyText.js'
import { SvnLogDialog } from './SvnLogDialog.js'
import { SvnUpdateDialog } from './SvnUpdateDialog.js'
import { sameUpdateOwner, updateDone } from './svnUpdateModel.js'
import { IconRefreshOutline16 } from './icons.js'
import { SvnPatchDialog } from './SvnPatchDialog.js'
import { SvnSumDialog } from './SvnSumDialog.js'
import { LogDialog } from './LogDialog.js'
import { dapStore } from '../dap/store.js'
import { bpDisabledLinesOf, bpLinesOf } from '../dap/breakpoints.js'
import { applyBpDecorations, setEditingLine, setHintLine, setPausedLine } from '../dap/decorate.js'
import { hintLineFor } from '../dap/hintLine.js'
import { createBpWidget } from '../dap/BpWidget.js'
import { buildBpMenu } from '../dap/bpMenu.js'
import { clampToolbarPosition, loadToolbarPosition, saveToolbarPosition } from '../dap/toolbarDrag.js'
import { editorModelPathOf } from '../dap/modelPath.js'
import { dapTrace } from '../dap/trace.js'

/**
 * 只在 Lua 注解类型槽开启注释自动建议；跨文件/离开类型槽立即恢复默认。
 * @author ddj 2026年09月24号
 * @param ed 当前 Monaco 编辑器
 * @param monaco Monaco API（读取 quickSuggestions 枚举）
 */
function syncTypeSuggest(ed, monaco) {
  const model = ed.getModel()
  const position = ed.getPosition()
  const typeSlot = model?.getLanguageId() === 'lua' && position
    && isLuaTypeSlot(model, position, model.getWordUntilPosition(position))
  const options = ed.getOption(monaco.editor.EditorOption.quickSuggestions)
  const comments = typeSlot ? 'on' : 'off'
  if (options.comments === comments) return
  ed.updateOptions({ quickSuggestions: { ...options, comments } })
}

/** 日志弹窗每次加载条数（「加载更多」按此步长递增；上限由 host 的 SVN_LOG_SHOW_ALL_CAP 约束）。 */
const SVN_LOG_PAGE = 100
/** Stable Markdown chrome for virtual plans; content stays in session-local memory. */
const PLAN_MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

/**
 * 日志弹窗状态 → 取数选项（P1-4/P1-5/P1-6：soc/mrg/range 与状态层键保持同源）。
 * @author ddj 2026年09月17号 / 2026年09月18号
 * @param svnLog 日志弹窗状态（null = 关闭）
 * @returns 状态层取数选项
 */
function svnLogOptsOf(svnLog) {
  if (!svnLog) return {}
  return { stopOnCopy: svnLog.soc === true, showMerged: svnLog.merged === true, range: svnLog.range ?? null }
}

/**
 * 工作区相对路径 → 所在目录相对路径（W2-2 目录对比的默认目标；无目录 = 工作副本根）。
 * @author ddj 2026年09月20号
 * @param relPath 工作区相对路径（可空）
 * @returns 目录相对路径（'' = 工作副本根）
 */
function dirOfRel(relPath) {
  const value = String(relPath ?? '').replace(/\\/g, '/')
  const cut = value.lastIndexOf('/')
  return cut > 0 ? value.slice(0, cut) : ''
}

/** 跳转目标高亮的保留时长（LSP/搜索跳转落地后给用户的位置提示，到期自动清除）。 */
const NAV_FLASH_MS = 1200

/** 二进制通道回退日志的一次性闸（整页仅报一次，避免每次读图/读 PDF 刷屏）。 */
let binFallbackLogged = false

/**
 * 二进制通道回退的一次性诊断日志：readBinaryPreview 本次尝试过新通道并失败时上报。
 * 有效期：随页面生命周期仅一条；dbg 本身受诊断开关控制（关=零输出零落盘）。
 * @author ddj 2026年09月22号
 * @param sid 会话 id
 * @param out readBinaryPreview 统一结果（带 probed 才说明本次尝试过新通道）
 */
const noteBinFallback = (sid, out) => {
  if (binFallbackLogged || !out?.probed) return
  binFallbackLogged = true
  dbg(sid, 'edrv.readBinary 不可用（host 未接线/旧版或网络失败），已回退 base64', 'debug')
}

/**
 * 从 Monaco 语言目录取可选语言 id 列表（代码片段新建时的语言下拉来源）。
 * 旧版 Monaco / 目录不可读时返回 undefined，由调用方回落 shared 的内置常量。
 * @author ddj 2026年09月10号
 * @param monaco window.monaco（可能未加载）
 * @returns 语言 id 数组或 undefined
 */
function snippetLanguageIds(monaco) {
  try {
    const languages = monaco?.languages?.getLanguages?.()
    if (!Array.isArray(languages) || !languages.length) return undefined
    return languages
      .map((item) => (item && typeof item.id === 'string' ? item.id : ''))
      .filter(Boolean)
  } catch (error) {
    return undefined
  }
}

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
  // 当前会话工作区 cwd（sessions 快照反应式读取；cwd 变化时作用域跟随刷新）
  const sessionsList = props?.sessions?.list
  const cwd = React.useSyncExternalStore(
    React.useCallback((onStoreChange) => (
      typeof sessionsList?.subscribe === 'function' ? sessionsList.subscribe(onStoreChange) : () => {}
    ), [sessionsList]),
    () => sessionsList?.getSnapshot?.()?.byId?.[sessionId]?.cwd ?? null,
    () => null,
  )
  // 状态作用域（scopeStore）：同工作区共享一份编辑区状态，无 cwd 回退会话隔离；
  // 迁移放渲染期（useMemo）——子面板恢复 effect 先于父 effect 执行，须先补齐工作区键
  const scope = React.useMemo(() => {
    const s = workspaceScopeOf(cwd, sessionId)
    migrateScopedKeys(s, sessionId)
    return s
  }, [cwd, sessionId])

  /**
   * 两个路径是否指向同一文件（归一化后比较）。
   *
   * 为什么需要：差异记录的 path 取自工具参数 `file_path`（多为**绝对路径**），而 `active`
   * 来自页签（多为**工作区相对路径**）；直接 `===` 会恒不相等，导致行内差异标记全部消失、
   * 「差异 N 文件」指示与实际文件对不上。统一经 relativeOf 归一再比即可消除形态差异。
   * @author ddj 2026年09月11号
   * @param a 路径（相对或绝对）
   * @param b 路径（相对或绝对）
   * @returns 是否同一文件
   */
  const sameFile = React.useCallback((a, b) => {
    if (!a || !b) return false
    return relativeOf(a, cwd).toLowerCase() === relativeOf(b, cwd).toLowerCase()
  }, [cwd])
  const [monaco, setMonaco] = React.useState(null)
  const [monacoErr, setMonacoErr] = React.useState(null)
  const [records, setRecords] = React.useState({})
  const [tabs, setTabs] = React.useState([])
  const [active, setDiskActive] = React.useState(null)
  const [planTabs, setPlanTabs] = React.useState([])
  const [planActive, setPlanActive] = React.useState(null)
  const planActiveRef = React.useRef(null)
  planActiveRef.current = planActive
  const planHostRef = React.useRef(null)
  React.useEffect(() => { setPlanTabs([]); setPlanActive(null) }, [sessionId, cwd])
  /** @private @author ddj 2026年10月08号 @param path Disk tab selection. Leave read-only plan mode before any disk navigation. */
  function setActive(path) { setPlanActive(null); setDiskActive(path) }
  const [dirtyMap, setDirtyMap] = React.useState({})
  const [content, setContent] = React.useState(null)
  const [contentPath, setContentPath] = React.useState(null)
  const [receiptLoad, setReceiptLoad] = React.useState(null) // { sessionId, path, sequence, status, error }
  const [imageSrc, setImageSrc] = React.useState(null) // 图片预览 data URL（图片 tab 专用，文本 tab 恒为 null）
  const [imgSize, setImgSize] = React.useState(null) // 图片自然尺寸 { w, h }（路径栏 meta）
  const [imgBroken, setImgBroken] = React.useState(false) // 图片解码失败（onError），显示占位与重试
  const [imgZoom, setImgZoom] = React.useState(null) // 图片缩放比例（null=适应宽度；会话+路径级记忆，见 imagePreview.zoomKeyOf）
  const imgElRef = React.useRef(null) // 预览 <img> 元素（适应宽度态下步进取实测缩放基准）
  const svgTextRef = React.useRef(new Set()) // 强制以文本打开的 SVG 路径集合（toggleSvgText 维护）
  const mdPreviewRef = React.useRef(new Set()) // 处于预览态的 Markdown 路径集合（toggleMdPreview 维护；不持久化）
  const [pdfBytes, setPdfBytes] = React.useState(null) // 当前 PDF tab 的原始字节（null=加载中/非 PDF）
  const pdfB64CacheRef = React.useRef(new Map()) // path → base64（tab 切回免重读；FIFO 上限防内存膨胀）
  const pdfCtlRef = React.useRef(new Map()) // path → PDF 面板控制器（mount 产出，关闭/卸载销毁）
  const pdfHostRef = React.useRef(null) // PDF 面板外壳 div（命令式控制器接管）
  const [status, setStatus] = React.useState('')
  const [lspServers, setLspServers] = React.useState([])
  // AI 补全状态（底部状态栏段）：{ state: idle|busy|ok|error, detail, enabled }
  const [aiStatus, setAiStatus] = React.useState({ state: 'idle', detail: null, enabled: false })
  const aiStatusTimer = React.useRef(null)
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
  const [svnStatus, setSvnStatus] = React.useState(null) // SVN 能力状态（SvnStatusPayload；null=未加载，SVN 入口隐藏）
  const [svnChanges, setSvnChanges] = React.useState(null) // SVN 变更清单（null=未加载；徽标/菜单判定）
  const [svnDiff, setSvnDiff] = React.useState(null) // 差异视图 { path, base, working, reason, message, leftLabel, rightLabel, scheme, logTarget?, binary?, encodingHint? }（null=关闭；logTarget 存在 = 来自日志弹窗，差异条可返回日志）
  const [patchDialog, setPatchDialog] = React.useState(null) // W2-1 补丁对话框 { path, text, truncated, binary }（null = 关闭）
  const [sumDialog, setSumDialog] = React.useState(null) // W2-2 目录对比对话框 { path }（null = 关闭）
  const [svnLog, setSvnLog] = React.useState(null) // 日志弹窗 { target, limit, soc?, range? }（null=关闭；P1-4/P1-6 增选项维度）
  const [svnLogData, setSvnLogData] = React.useState(null) // 日志条目（null=未加载）
  const [svnLogBusy, setSvnLogBusy] = React.useState(false) // 日志在途
  const [svnLogError, setSvnLogError] = React.useState('') // 日志错误文案
  const [svnLogWcRev, setSvnLogWcRev] = React.useState(null) // P1-9：文件目标的工作副本版号（null = 不加粗）
  const [dlogOpen, setDlogOpen] = React.useState(false) // 诊断日志弹窗（自取数据，null 语义无需状态层）
  const [svnUpdateDialog, setSvnUpdateDialog] = React.useState(null) // {path,sessionId,scope,resumeJobId?}；窗口内自取增量
  const [svnUpdateReturn, setSvnUpdateReturn] = React.useState(null) // 从日志/差异返回时恢复同一 job
  const [recentUpdate, setRecentUpdate] = React.useState(null) // {jobId,path,sessionId,scope}；只读恢复入口
  const [updateOpenWith, setUpdateOpenWith] = React.useState(false) // 二级弹窗 Esc 不联动关闭父窗口
  const svnUpdateDoneRef = React.useRef(new Set()) // job 终态刷新一次，往返日志/差异不重复刷新
  // @author ddj 2026年09月24号：切换作用域只关闭窗口，不取消旧工作副本中已启动的任务
  React.useEffect(() => {
    setSvnUpdateDialog(null)
    setSvnUpdateReturn(null)
    setRecentUpdate(null)
    setUpdateOpenWith(false)
  }, [sessionId, scope])
  // @author ddj 2026年09月24号：只读恢复原工作区的活动更新，不调用 updateStart
  React.useEffect(() => {
    if (!sessionId || svnStatus?.managed !== true) return undefined
    let alive = true
    void rpc('svn.updateActive', { sessionId }).then((outcome) => {
      if (!alive || !outcome.ok || !outcome.job) return
      const recovered = { path: outcome.job.target, sessionId, scope, resumeJobId: outcome.job.jobId }
      if (updateDone(outcome.job.phase)) setRecentUpdate(recovered)
      else setSvnUpdateDialog((current) => current ?? recovered)
    }).catch(() => {})
    return () => { alive = false }
  }, [sessionId, scope, svnStatus?.managed])
  const [sidebarOn, setSidebarOn] = React.useState(layout !== 'side') // 侧边栏显隐（侧栏形态默认收起）
  const [sidebarW, setSidebarW] = React.useState(() => getSidebarMinWidth()) // 侧边栏宽度（初值 = 最小宽度，默认 300）
  const [activePanel, setActivePanel] = React.useState('explorer') // 激活面板 id
  const [focusRequest, setFocusRequest] = React.useState(0) // 外部差异聚焦请求版本
  const kbVersion = useKeybindingsVersion() // 快捷键配置版本（tooltip 文案随键位刷新）
  const [hintDismissed, setHintDismissed] = React.useState(() => {
    try { return localStorage.getItem(CACHE_KEY.sideHint) === '1' } catch { return false }
  }) // 侧边栏引导条是否已关闭
  const editorRef = React.useRef(null)
  const viewRootRef = React.useRef(null)
  const monacoRef = React.useRef(null)
  const modelsRef = React.useRef(null)
  // model 跨挂载缓存（按工作区作用域）：重挂载秒显内容，消除切换对话闪烁
  if (!modelsRef.current) modelsRef.current = modelsForScope(scope)
  // 视图状态缓存（path → Monaco viewState；重启后恢复光标/滚动/折叠位置）
  const viewStatesRef = React.useRef({})
  // 防抖保存槽（arm/flush/cancel；见 saveDebounce.ts 的缺陷说明，勿退回单一取消句柄）
  const saveTimerRef = React.useRef(createSaveTimer())
  const savingRef = React.useRef(new Set()) // 在途保存的路径（关闭前落盘去重，防同内容双发）
  const loadSeqRef = React.useRef(0)
  const programmaticRef = React.useRef(false)
  const restoredScopeRef = React.useRef(null) // 已恢复状态的作用域（cwd 晚到 sid→ws 时允许重恢复）
  // 界面状态镜像迟到回填的触发器（重启换 origin：首帧 localStorage 为空，回填后需重跑恢复）
  const [hydrateTick, setHydrateTick] = React.useState(0)
  const pendingFocusRef = React.useRef(null) // { path, region, line, column } 内容加载后跳转
  const navFlashRef = React.useRef([]) // 跳转目标高亮装饰 id（独立于 diff/下划线，随跳转替换）
  const navFlashTimerRef = React.useRef(null) // 跳转目标高亮自动清除计时器
  // 导航历史（后退/前进）：跨文件焦点位置；按会话隔离，会话切换重置
  const navRef = React.useRef(null)
  if (!navRef.current) navRef.current = navHistoryFor(scope)
  const navPendingRef = React.useRef(null) // { path,line,column,viewState } 待恢复条目（内容就绪后消费）
  const navCursorTimerRef = React.useRef(null) // 光标位置防抖记录计时器
  const navBackRef = React.useRef(null) // 后退动作最新闭包（窗口级键盘监听读取）
  const navForwardRef = React.useRef(null) // 前进动作最新闭包（窗口级键盘监听读取）
  const cycleTabRef = React.useRef(null) // 页签循环动作最新闭包（Ctrl+Alt+←/→、Ctrl+PgUp/PgDn）
  const toggleMdPreviewRef = React.useRef(null) // Markdown 预览切换动作最新闭包（窗口键位监听读取，防陈旧闭包）
  const rowNavColRef = React.useRef(null) // 整行上下移动的期望列（连续移动保持列位）
  const rowNavMoveRef = React.useRef(false) // 本次光标变化是否由整行移动触发（否则清空期望列）
  const activeRef = React.useRef(null) // 当前活动文件的最新值（空依赖闭包/指令回调读取）
  activeRef.current = active
  // 活动文件路径镜像到模块级 store：命令目录可用性判定读取（如 Markdown 预览切换仅 .md 吞键）
  setActiveEditorPath(active)
  React.useEffect(() => () => setActiveEditorPath(null), [])
  const tabsRef = React.useRef([]) // 当前页签表的最新值（菜单动作按 id 分派时读，防陈旧闭包）
  tabsRef.current = tabs
  const tabPathsRef = React.useRef([]) // 页签路径镜像（外部改动轮询读取）
  tabPathsRef.current = tabs.map((t) => t.path)
  const dirtyRef = React.useRef({}) // 脏标记最新值（菜单禁用判定与关闭时落盘读）
  dirtyRef.current = dirtyMap
  const tabsHostRef = React.useRef(null) // 页签栏容器（切换后把当前页签滚入可见区）
  // 页签上限与 LRU 使用序（超限淘汰最久未用者；见下方 tabTouchEffect / tabEvictEffect）
  const [tabLimit, setTabLimit] = React.useState(() => getMaxOpenEditors())
  const tabUseRef = React.useRef({ seq: 0, used: {} })
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
  const svnMenuDisposersRef = React.useRef([]) // Monaco 右键 SVN 组当前 disposables（同步时先注销旧组）
  // 调试（DAP）：store 订阅 tick 驱动重渲 + gutter/F9 切换闭包（ensureEditor 空依赖读取）
  const [dapTick, setDapTick] = React.useState(0)
  React.useEffect(() => dapStore.subscribe(() => setDapTick((t) => t + 1)), [])
  const dapSnap = dapStore.getSnapshot()
  const [dapBarPos, setDapBarPos] = React.useState(() => loadToolbarPosition(scope))
  const [dapBarDragging, setDapBarDragging] = React.useState(false)
  const dapBarRef = React.useRef(null)
  const dapDragRef = React.useRef(null)
  React.useEffect(() => {
    setDapBarPos(loadToolbarPosition(scope))
  }, [scope])
  React.useEffect(() => {
    const onMove = (event) => {
      const drag = dapDragRef.current
      const bar = dapBarRef.current
      const area = bar?.parentElement
      if (!drag || !bar || !area) return
      const areaRect = area.getBoundingClientRect()
      const barRect = bar.getBoundingClientRect()
      const next = clampToolbarPosition({
        left: event.clientX - areaRect.left - drag.offsetX,
        top: event.clientY - areaRect.top - drag.offsetY,
      }, {
        width: areaRect.width,
        height: areaRect.height,
        barWidth: barRect.width,
        barHeight: barRect.height,
      })
      setDapBarPos(next)
    }
    const onUp = () => {
      if (!dapDragRef.current) return
      dapDragRef.current = null
      setDapBarDragging(false)
      const latest = dapBarPosRef.current
      if (latest) saveToolbarPosition(scope, latest)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
  }, [scope])
  const dapBarPosRef = React.useRef(dapBarPos)
  dapBarPosRef.current = dapBarPos
  const startDapBarDrag = (event) => {
    if (event.button !== 0 || !dapBarRef.current) return
    const rect = dapBarRef.current.getBoundingClientRect()
    event.preventDefault()
    event.stopPropagation()
    dapDragRef.current = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
    setDapBarDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  // 进程选择器选中项（多候选附加时；候选集变化回落首个）
  const [dapPickPid, setDapPickPid] = React.useState(0)
  React.useEffect(() => { setDapPickPid(dapSnap.candidates?.[0]?.pid ?? 0) }, [dapSnap.candidates])
  // 断点右键菜单（glyph 区右键）与行内断点编辑浮层（Monaco content widget）
  const [dapBpMenu, setDapBpMenu] = React.useState(null)
  const bpWidgetRef = React.useRef(null) // { close, path, line } | null
  const dapScopeRef = React.useRef(scope)
  const dapCwdRef = React.useRef(cwd)
  dapScopeRef.current = scope
  dapCwdRef.current = cwd
  const dapToggleRef = React.useRef(null)
  dapToggleRef.current = (path, line) => {
    if (!cwd || !path || !line) return
    // 严格对齐 CodeBuddy：任意文件都可切换断点（不再限定 .lua 调试目标）
    dapStore.toggleAt(scope, cwd, path, line)
  }
  // 工作区变化同步调试 store（配置清单/启动基准）；有 cwd 时预拉 launch.json 配置
  React.useEffect(() => {
    dapStore.setWorkspace(cwd || '')
    if (cwd) void dapStore.ensureConfigs()
  }, [cwd])
  const svnStatusRef = React.useRef(null) // svnStatus 渲染值镜像（ensureEditor 空依赖闭包读取最新状态）
  const [snippetPicker, setSnippetPicker] = React.useState(null) // 'configure' | 'insert' | null（代码片段浮层）
  const doSaveRef = React.useRef(null) // 保存动作的最新闭包（窗口级保存监听读取）
  const onEditRef = React.useRef(null) // 编辑置脏的最新闭包（Monaco 内容变化监听经 ref 调用，防首帧 active=null 陈旧闭包）
  const saveViewStateRef = React.useRef(null) // 视图状态保存的最新闭包（卸载清理读取，避免过期 active）
  // 磁盘版本基线（path → 最后一次从磁盘读到的版本令牌）：外部改动检测与保存护栏共用
  const revRef = React.useRef({})
  // 外部改动回调的最新闭包（轮询 hook 经 ref 调用，避免把轮询写进 React 依赖数组）
  const diskChangeRef = React.useRef(null)
  // 当前展示的外部同步提示（冲突/文件被删除；随 active 切换派生显示）
  const [diskFlag, setDiskFlag] = React.useState(null)
  const diffRendererRef = React.useRef(null)
  const layoutRef = React.useRef(layout) // ensureEditor 空依赖闭包读取的稳定布局
  layoutRef.current = layout
  if (!diffRendererRef.current) diffRendererRef.current = createDiffRenderer((sid, t) => dbg(sid, t))

  const currentRecords = React.useMemo(() => {
    const list = []
    for (const rec of Object.values(records)) {
      if (rec.archived === true) continue
      if (sameFile(rec.path, active)) list.push(rec)
    }
    return list
  }, [records, active, cwd])

  const contentReady = content !== null && contentPath === active
  // 当前 tab 是否处于图片预览模式（与 loadContent 的分派条件同源；SVG 文本模式时为 false）
  const isImageActive = !!active && isImagePath(active) && !svgTextRef.current.has(active)
  // 当前 tab 是否为 PDF 面板（与 loadContent 分派条件同源）
  const isPdfActive = !!active && isPdfPath(active)
  // 当前 tab 是否为可预览的 Markdown，以及是否正处于预览态（预览态替换 Monaco host，只读）
  const isMdActive = !!active && isMarkdownPath(active)
  const mdPreviewing = isMdActive && mdPreviewRef.current.has(active)
  const regions = React.useMemo(() => {
    // #region debug log
    const trace = isDebug() && contentReady && currentRecords.length > 0
    const start = trace ? performance.now() : 0
    // #endregion
    const next = diffRegions(currentRecords, contentReady ? content : null).filter((r) => !r.superseded)
    // #region debug log
    if (trace) {
      try { dbg(sessionId, `[DEBUG diffRegions] records=${currentRecords.length} bytes=${content.length} regions=${next.length} ms=${(performance.now() - start).toFixed(1)}`) } catch (e) { /* 诊断不可影响渲染 */ }
    }
    // #endregion
    return next
  }, [currentRecords, content, contentPath, active])
  // useMemo 稳定引用：否则 hover 等重渲染会让 view zone effect 反复重建（- 号闪烁）
  const pendingRegions = React.useMemo(() => regions.filter((r) => r.status === ST.PENDING && !r.stale), [regions])
  const staleRegions = React.useMemo(() => regions.filter((r) => r.status === ST.PENDING && r.stale), [regions])
  // 单文件 Keep/Undo 的作用域：可定位差异 + 无法定位的冲突差异（后者否则永久留在待处理列表）
  const decideRegions = React.useMemo(() => [...pendingRegions, ...staleRegions], [pendingRegions, staleRegions])
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

  /** @private @author ddj 2026年10月08号 @param path Disk path. @param select Select tab. @param preview Optional explicit Markdown mode. */
  function addTab(path, select, preview) {
    setTabs((prev) => insertTab(prev, path))
    if (select) {
      if (typeof preview === 'boolean' || isPlanPath(path, cwd, sessionId)) setMdPreview(path, typeof preview === 'boolean' ? preview : true)
      setActive(path)
    }
  }

  /**
   * 页签规范路径（G9）：统一收敛为工作区相对路径后再进页签。
   *
   * 差异记录路径取自工具结果 `target.displayPath`（官方恒绝对），而资源管理器树给相对路径；
   * 不归一会导致地址栏形态不一致、同文件出现两个页签（insertTab 按原串去重）、
   * 且绝对路径被 isTreeRevealable 判为不可定位（「在资源管理器视图中显示」失效）。
   * 工作区外文件由 relativeOf 回退原绝对路径，语义不变。
   * @author ddj 2026年09月18号
   * @param path 原始路径（绝对或相对）
   * @returns 页签规范路径
   */
  const tabPath = (path) => tabPathOf(path, cwd)
  /**
   * 打开文件入口的统一收敛（G9）：所有「进页签」路径都经此归一，避免逐点打补丁。
   * @author ddj 2026年09月18号
   * @param path 原始路径
   * @param select 是否设为活动页签
   * @returns 归一后的路径（空值返回 null）
   */
  const addTabNorm = (path, select, preview) => {
    if (!path) return null
    const normalized = tabPath(path)
    if (!normalized) return null
    addTab(normalized, select, preview)
    return normalized
  }

  /**
   * 保存当前活动文件的视图状态（光标/滚动/折叠）到工作区作用域缓存。
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
      viewStatesSave(scope, viewStatesRef.current)
    } catch (e) { /* 视图状态保存失败忽略 */ }
  }
  saveViewStateRef.current = saveViewState

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
    addTabNorm(entry.path, true)
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

  /**
   * 关闭页签的收尾（不动作状态）：活动页签先存视图状态与导航历史；
   * PDF 页签销毁面板控制器并清 base64 缓存（未保存注释随之丢弃，脏点已提示）。
   * @author ddj 2026年09月11号
   * @param path 待关闭页签路径
   */
  const releaseTab = (path) => {
    if (path === activeRef.current) { saveViewState(path); recordNav() }
    const pdfCtl = pdfCtlRef.current.get(path)
    if (pdfCtl) { pdfCtl.destroy(); pdfCtlRef.current.delete(path) }
    pdfB64CacheRef.current.delete(path)
    // 关闭即失去跟踪：清磁盘版本基线/已读台账/同步标记（重开时按最新内容重建）
    clearBaseline(scope, path)
    clearReadVersion(scope, path)
    clearSync(scope, path)
    delete revRef.current[path]
  }

  /**
   * 提交关闭结果：一次性更新页签与活动页签（补位规则见 tabActions.applyClose）。
   * @author ddj 2026年09月11号
   * @param result tabActions 产出的关闭结果
   */
  const commitClose = (result) => {
    setTabs((prev) => (prev === result.tabs ? prev : result.tabs))
    if (result.active !== activeRef.current) setActive(result.active)
  }

  /**
   * 立即关闭页签（页签 × 按钮与「关闭」菜单项共用；批量关闭走 closeTabs）。
   * @author ddj 2026年08月25号 / 2026年09月11号
   * @param path 待关闭页签路径
   */
  const closeTab = (path) => {
    // 先静默落盘再关闭：flushSave 立即提交待执行的防抖保存（不是取消），
    // persistDirty 再对仍标脏者（保存失败/在途）用 model 当前文本补一次
    flushSave()
    persistDirty([path])
    releaseTab(path)
    commitClose(applyClose(tabsRef.current, new Set([path]), activeRef.current))
  }

  /**
   * 批量关闭：先落盘全部待关闭的脏页签，再逐个收尾并一次性提交。
   * @author ddj 2026年09月11号
   * @param result 关闭结果（来自 tabActions 的 closeOthers/closeRight/closeSaved/closeAll）
   * @param label 状态栏文案前缀（如「已关闭其他」）
   */
  const closeTabs = (result, label) => {
    flushSave()
    const closing = tabsRef.current.filter((t) => !result.tabs.some((r) => r.path === t.path))
    if (!closing.length) { setStatus('无可关闭的页签'); return }
    persistDirty(closing.map((t) => t.path))
    for (const tab of closing) releaseTab(tab.path)
    commitClose(result)
    setStatus(label + '（' + closing.length + ' 个）')
  }

  /**
   * 删除落盘后的页签收尾：关闭目标及其子树页签。
   * 不走 closeTab 的「先落盘」：文件已删除，落盘会把删除的文件写回磁盘。
   * @author ddj 2026年09月22号
   * @param path 已删除的工作区相对路径
   */
  const dropDeletedTabs = (path) => {
    const doomed = tabsRef.current.filter((t) => t.path === path || t.path.startsWith(path + '/'))
    if (!doomed.length) return
    for (const tab of doomed) releaseTab(tab.path)
    commitClose(applyClose(tabsRef.current, new Set(doomed.map((t) => t.path)), activeRef.current))
  }

  /**
   * 重命名落盘后的页签改写：目标及其子树页签路径整体改写（含脏标与活动页签）。
   * @author ddj 2026年09月22号
   * @param from 原路径
   * @param to 新路径
   */
  const remapRenamedTabs = (from, to) => {
    setTabs((prev) => prev.map((tab) => ({ ...tab, path: remapPathOf(tab.path, from, to) })))
    setDirtyMap((prev) => {
      const next = {}
      for (const key of Object.keys(prev)) next[remapPathOf(key, from, to)] = prev[key]
      return next
    })
    setActive((prev) => (prev ? remapPathOf(prev, from, to) : prev))
  }

  // 文件树右键的重命名/删除 → 页签同步（动作在 sidebar/menuItems.ts，经窗口事件桥接；
  // 经 ref 读最新闭包，避免空依赖 effect 捕获陈旧状态）
  const tabFsSyncRef = React.useRef({ rename: () => {}, drop: () => {} })
  tabFsSyncRef.current = { rename: remapRenamedTabs, drop: dropDeletedTabs }
  React.useEffect(() => {
    const onRenamed = (event) => {
      const from = event?.detail?.from
      const to = event?.detail?.to
      if (typeof from !== 'string' || !from || typeof to !== 'string' || !to || from === to) return
      tabFsSyncRef.current.rename(from, to)
    }
    const onDeleted = (event) => {
      const path = event?.detail?.path
      if (typeof path !== 'string' || !path) return
      tabFsSyncRef.current.drop(path)
    }
    window.addEventListener('edrv:path-renamed', onRenamed)
    window.addEventListener('edrv:path-deleted', onDeleted)
    return () => {
      window.removeEventListener('edrv:path-renamed', onRenamed)
      window.removeEventListener('edrv:path-deleted', onDeleted)
    }
  }, [])

  /**
   * 在已打开页签间循环切换（文件分页归编辑器自带页签栏）。
   * @author ddj 2026年09月10号
   * @param step 步进（+1 下一个 / -1 上一个）
   */
  const cycleTab = (step) => {
    if (tabs.length < 2) return
    const idx = tabs.findIndex((t) => t.path === active)
    const next = tabs[(idx + step + tabs.length) % tabs.length]
    if (!next || next.path === active) return
    flushSave()
    saveViewState(active)
    recordNav()
    setActive(next.path)
  }
  cycleTabRef.current = cycleTab

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
    // #region debug log
    const trace = isDebug()
    const start = trace ? performance.now() : 0
    // #endregion
    rpc('edrv.list', { sessionId, ...(skipStale ? { skipStale: true } : {}) }).then((res) => {
      // #region debug log
      const received = trace ? performance.now() : 0
      // #endregion
      if (!res || !res.ok || !Array.isArray(res.records)) return
      const map = {}
      for (const r of res.records) {
        if (r.archived === true) continue
        map[r.callId] = r
      }
      setRecords((prev) => {
        // #region debug log
        const compareStart = trace ? performance.now() : 0
        // #endregion
        const equal = sameRecords(prev, map)
        // #region debug log
        if (trace) {
          try {
            const compareMs = performance.now() - compareStart
            if (compareMs > 20 || received - start > 100) dbg(sessionId, `[DEBUG diffList] count=${res.records.length} skipStale=${skipStale === true} rpcMs=${(received - start).toFixed(1)} compareMs=${compareMs.toFixed(1)} changed=${!equal}`)
          } catch (e) { /* 诊断不可影响轮询 */ }
        }
        // #endregion
        return equal ? prev : map
      })
    }).catch((e) => setError('list异常:' + String(e)))
  }

  /**
   * Reject callbacks for a replaced file or loader generation.
   * @private @author ddj 2026年09月28号
   * @param path Normalized tab path.
   * @param sequence Loader generation.
   * @returns Whether this load still owns the active view.
   */
  function loadCurrent(path, sequence) {
    return sequence === loadSeqRef.current && path === activeRef.current
  }

  /**
   * Commit receipt metadata in the same React batch as loaded content.
   * @private @author ddj 2026年09月28号
   * @param path Loaded tab path.
   * @param sid Session owning the operation.
   * @param sequence Loader generation.
   * @param failure Optional target-specific read/render error.
   */
  function stampLoad(path, sid, sequence, failure) {
    if (!loadCurrent(path, sequence)) return
    setReceiptLoad({ path, cwd, sessionId: sid, sequence, status: failure ? 'error' : 'ready', error: failure })
  }

  /**
   * Report a read failure without attributing another operation's error to the file.
   * @private @author ddj 2026年09月28号
   * @param path Failed tab path.
   * @param sid Session owning the load.
   * @param sequence Loader generation.
   * @param message Read failure description.
   */
  function failLoad(path, sid, sequence, message) {
    if (!loadCurrent(path, sequence)) return
    stampLoad(path, sid, sequence, message)
    setLoadError(message)
    setError(message)
    setStatus('读取失败')
  }

  /**
   * Attribute a preview decoder failure only to its still-current byte generation.
   * @private @author ddj 2026年09月28号
   * @param path Rendered file path.
   * @param sid Rendering session.
   * @param sequence Byte-load generation captured by the renderer.
   * @param message Decoder failure.
   */
  function renderLoadFail(path, sid, sequence, message) {
    if (!loadCurrent(path, sequence)) return
    /** @author ddj 2026年09月28号 @param current Committed load state. @returns Correlated failure or unchanged state. */
    const reject = (current) => acceptsLoad(current, sid, path, sequence, loadSeqRef.current)
      ? { ...current, status: 'error', error: String(message) } : current
    setReceiptLoad(reject)
  }

  /**
   * Revalidate clean cached text without replacing edits made during the request.
   * @private @author ddj 2026年09月28号
   * @param model Cached text model.
   * @param path Normalized target path.
   * @param sid Session owning the read.
   * @param sequence Loader generation.
   * @param mark Existing disk-version bookkeeping callback.
   */
  function checkCached(model, path, sid, sequence, mark) {
    if (dirtyRef.current[path]) return
    const before = model.getValue()
    /** @author ddj 2026年09月28号 @param res Disk content for a still-clean cached model. */
    const accept = (res) => {
      if (!loadCurrent(path, sequence) || dirtyRef.current[path] || model.getValue() !== before) return
      if (!res?.ok) return
      mark(res.version)
      if (res.content === before) return
      saveViewState(path)
      setContent(res.content)
      setStatus('已加载')
    }
    rpc('edrv.read', { sessionId: sid, path }).then(accept).catch(() => {})
  }

  /**
   * 加载文件内容（对齐 VSCode model 复用：会话内已打开的 model 直接秒显，
   * 后台静默 RPC 校验防陈旧；首次打开走原读取流程）。
   * 每条成功分支都记下磁盘版本基线：外部改动轮询据此判断缓冲是否已陈旧，
   * 保存时作为版本守卫令牌随 edrv.save 回传（读后被外部改过则拒绝写入）。
   * @author ddj 2026年08月28号 / 2026年09月15号
   * @param path 文件路径
   * @param sid 会话 id
   * @param force 强制走 RPC（reloadFile 用，跳过 model 复用）
   * @param version 已知磁盘版本（缺省走 RPC 返回值）
   */
  const loadContent = (path, sid, force, version) => {
    const seq = ++loadSeqRef.current
    setReceiptLoad({ path, cwd, sessionId: sid, sequence: seq, status: 'loading' })
    setLoadError(null)
    /**
     * 记下磁盘版本基线；markRead=true 表示本次真的从磁盘读了内容
     * （已读版本台账随之失效，下一轮轮询按新版本重新比对）。
     */
    const mark = (ver, markRead) => {
      if (typeof ver !== 'string' || !ver) return
      revRef.current[path] = ver
      recordBaseline(scope, path, ver)
      clearSync(scope, path)
      if (markRead === true) clearReadVersion(scope, path)
    }
    // 图片文件走专用通道：base64 → data URL 预览，不建 Monaco model、不进文本/差异流程
    if (isImagePath(path) && !svgTextRef.current.has(path)) {
      loadImage(path, sid, seq, version)
      return
    }
    // PDF 文件走专用通道：base64 → PDF 面板（浏览 + 注释编辑），不建 Monaco model
    if (isPdfPath(path)) {
      loadPdf(path, sid, seq, force === true, version)
      return
    }
    const cachedModel = force ? null : modelsRef.current.get(path)
    if (cachedModel) {
      // model 命中：直接显示其内容（切 tab 零等待），后台静默校验
      setContent(cachedModel.getValue())
      setContentPath(path)
      setLoadStage((prev) => ({ progress: Math.max(84, prev.progress), message: '文件已读取，准备创建编辑器…' }))
      setStatus('已加载')
      stampLoad(path, sid, seq)
      checkCached(cachedModel, path, sid, seq, mark)
      return
    }
    setLoadStage({ progress: monaco ? 72 : 12, message: '读取文件内容…' })
    // #region debug log
    const readStart = isDebug() ? performance.now() : 0
    // #endregion
    rpc('edrv.read', { sessionId: sid, path }).then((res) => {
      // #region debug log
      if (readStart) {
        try { dbg(sid, `[DEBUG diffRead] force=${force === true} ok=${res?.ok === true} bytes=${typeof res?.content === 'string' ? res.content.length : 0} rpcMs=${(performance.now() - readStart).toFixed(1)}`) } catch (e) { /* 诊断不可影响文件读取 */ }
      }
      // #endregion
      if (!loadCurrent(path, seq)) return
      if (res && res.ok) {
        mark(res.version, true)
        setContent(res.content)
        setContentPath(path)
        stampLoad(path, sid, seq)
        setLoadStage((prev) => ({ progress: Math.max(84, prev.progress), message: '文件已读取，准备创建编辑器…' }))
        setStatus('已加载')
      } else {
        const base = res?.error ? String(res.error) : '读取失败'
        dapTrace('read-failed', { path, error: base, resolvedPath: res?.resolvedPath, cwd })
        // 带出 host 解析后的真实路径：跳转失败时一眼看出是路径解析错还是目标不存在
        const message = res?.resolvedPath ? base + '：' + relativeOf(String(res.resolvedPath), cwd) : base
        failLoad(path, sid, seq, message)
      }
    }).catch((e) => {
      if (!loadCurrent(path, seq)) return
      const message = 'read异常:' + String(e)
      failLoad(path, sid, seq, message)
    })
  }

  /**
   * 加载图片文件为 data URL（编辑区只读预览）；失败走 loadError 面板（重试经 loadContent 分派回此）。
   * @author ddj 2026年09月08号 / 2026年09月15号
   * @param path 图片文件路径
   * @param sid 会话 id
   * @param seq 加载序号（过期响应丢弃）
   * @param version 已知磁盘版本（图片同走外部改动轮询，读到新版本即重取）
   */
  const loadImage = (path, sid, seq, version) => {
    setImageSrc(null)
    setImgSize(null)
    setImgBroken(false)
    setLoadStage({ progress: monaco ? 72 : 12, message: '读取图片…' })
    readBinaryPreview(rpc, { sessionId: sid, path }).then((out) => {
      if (!loadCurrent(path, seq)) return
      if (out.ok && out.via === 'binary') {
        // 新通道：原始字节本地组 data URL（线上省 base64，本地编码为 img src 所需不可省）
        recordBaseline(scope, path, out.version || version)
        clearReadVersion(scope, path) // 刚读过内容：已读版本台账失效，下一轮按新版本比对
        setImageSrc(dataUrlOf(bytesToBase64(out.bytes), out.mime))
        stampLoad(path, sid, seq)
        setLoadStage({ progress: 100, message: '图片已就绪' })
        setStatus('已加载')
        return
      }
      noteBinFallback(sid, out)
      if (out.ok && out.via === 'base64') {
        if (!out.mime) {
          failLoad(path, sid, seq, 'host 版本过旧：图片响应缺少 mime')
          return
        }
        const imgVersion = out.version ?? version
        recordBaseline(scope, path, imgVersion)
        clearReadVersion(scope, path) // 刚读过内容：已读版本台账失效，下一轮按新版本比对
        setImageSrc(dataUrlOf(out.content, out.mime))
        stampLoad(path, sid, seq)
        setLoadStage({ progress: 100, message: '图片已就绪' })
        setStatus('已加载')
        return
      }
      const base = out.error ? String(out.error) : '读取失败'
      // 带出 host 解析后的真实路径：跳转失败时一眼看出是路径解析错还是目标不存在
      const message = out.resolvedPath ? base + '：' + String(out.resolvedPath) : base
      failLoad(path, sid, seq, message)
    }).catch((e) => {
      if (!loadCurrent(path, seq)) return
      const message = 'read异常:' + String(e)
      failLoad(path, sid, seq, message)
    })
  }

  /**
   * 加载 PDF 文件为原始字节（编辑区 PDF 面板）；命中 base64 缓存秒切，force 绕过缓存重读。
   * 面板控制器由 pdf host mount effect 产出（per-path，关闭/卸载销毁）。
   * @author ddj 2026年09月22号
   * @param path PDF 文件路径
   * @param sid 会话 id
   * @param seq 加载序号（过期响应丢弃）
   * @param force true=绕过缓存强制 RPC 重读（刷新按钮）
   * @param version 已知磁盘版本（外部改动轮询触发时带入）
   */
  const loadPdf = (path, sid, seq, force, version) => {
    setPdfBytes(null)
    setLoadStage({ progress: monaco ? 72 : 12, message: '读取 PDF…' })
    const cache = pdfB64CacheRef.current
    const hit = !force ? cache.get(path) : undefined
    if (typeof hit === 'string' && hit) {
      // 刷新插入序（Map 按插入序 FIFO 驱逐）后秒切
      cache.delete(path)
      cache.set(path, hit)
      setPdfBytes(base64ToBytes(hit))
      stampLoad(path, sid, seq)
      setLoadStage({ progress: 100, message: 'PDF 已就绪' })
      setStatus('已加载')
      return
    }
    readBinaryPreview(rpc, { sessionId: sid, path }).then((out) => {
      if (!loadCurrent(path, seq)) return
      if (out.ok && out.via === 'binary') {
        const pdfVersion = out.version || version
        recordBaseline(scope, path, pdfVersion)
        clearReadVersion(scope, path) // 刚读过内容：已读版本台账失效，下一轮按新版本比对
        // 缓存仍存 base64（pdfB64CacheRef 形状不变，命中路径零改动）；字节直通面板省一次解码
        cache.set(path, bytesToBase64(out.bytes))
        while (cache.size > 6) cache.delete(cache.keys().next().value)
        setPdfBytes(out.bytes)
        stampLoad(path, sid, seq)
        setLoadStage({ progress: 100, message: 'PDF 已就绪' })
        setStatus('已加载')
        return
      }
      noteBinFallback(sid, out)
      if (out.ok && out.via === 'base64') {
        const pdfVersion = out.version ?? version
        recordBaseline(scope, path, pdfVersion)
        clearReadVersion(scope, path) // 刚读过内容：已读版本台账失效，下一轮按新版本比对
        cache.set(path, out.content)
        while (cache.size > 6) cache.delete(cache.keys().next().value)
        setPdfBytes(base64ToBytes(out.content))
        stampLoad(path, sid, seq)
        setLoadStage({ progress: 100, message: 'PDF 已就绪' })
        setStatus('已加载')
        return
      }
      const base = out.error ? String(out.error) : '读取失败'
      const message = out.resolvedPath ? base + '：' + String(out.resolvedPath) : base
      failLoad(path, sid, seq, message)
    }).catch((e) => {
      if (!loadCurrent(path, seq)) return
      const message = 'read异常:' + String(e)
      failLoad(path, sid, seq, message)
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

  /**
   * 展示外部同步提示（按路径+类型去重：同一文件重复回调不重置已关闭的提示）。
   * @author ddj 2026年09月15号
   * @param flag 同步标记
   */
  const markDiskFlag = (flag) => {
    setDiskFlag((prev) => (prev && prev.path === flag.path && prev.kind === flag.kind ? prev : flag))
  }

  /**
   * 外部改动落地：干净缓冲直接刷入（含差异标记重算），脏缓冲只提示不覆盖。
   * 经 ref 暴露给轮询 hook（hook 只负责观测，IO/UI 全在这里）。
   * @author ddj 2026年09月15号
   * @param change 轮询判定出的外部变更
   */
  const onDiskChange = (change) => {
    if (!change || !change.path) return
    // 文件树同步：目录缓存按该路径失效并强制重列（外部新增/删除/改名都能看到）
    emitFileChanged(change.path)
    if (change.kind === 'modified') {
      // 干净缓冲：强制从磁盘重读（跳过 model 复用），差异标记随之重算
      loadContent(change.path, sessionId, true)
      clearSync(scope, change.path)
      setDiskFlag((prev) => (prev && prev.path === change.path ? null : prev))
      setStatus('已同步外部修改 ' + new Date().toTimeString().slice(0, 8))
      emitRefresh()
      return
    }
    const kind = change.kind === 'deleted' ? 'deleted' : 'conflict'
    markDiskFlag(readSync(scope, change.path) ?? { path: change.path, kind, at: Date.now() })
    setStatus(kind === 'deleted' ? '文件已被外部删除' : '外部已修改（未保存的编辑保留）')
  }
  diskChangeRef.current = onDiskChange

  /**
   * 版本变化时读磁盘并与缓冲比对：内容相同 → 只推进基线（不做无意义重载）；
   * 内容不同 → 由判定表决定自动刷入还是冲突提示。
   * @author ddj 2026年09月15号
   * @param path 文件路径
   * @returns 比对结果；模型不可用/读失败 → null（按「需要重载」处理）
   */
  const readDiskCompare = (path) => {
    const model = modelsRef.current?.get(path)
    if (!model || typeof model.getValue !== 'function') return Promise.resolve(null)
    return rpc('edrv.read', { sessionId, path }).then((res) => {
      if (!res || !res.ok) return null
      return { equal: res.content === model.getValue() }
    }).catch(() => null)
  }

  // 外部改动轮询：观测交给 hook，动作落 onDiskChange（干净自动刷入 / 脏缓冲提示）
  useFileWatch({
    sessionId,
    scope,
    tabsRef: tabPathsRef,
    dirtyRef,
    onReadDisk: readDiskCompare,
    onDiskChange: (change) => diskChangeRef.current?.(change),
  })

  React.useEffect(() => {
    const publishLsp = (servers) => setLspServers(Array.isArray(servers) ? servers : [])
    const unsubscribe = onLspProgress(publishLsp)
    void refreshStatus(true).then(publishLsp)
    const timer = setInterval(() => { void refreshStatus(true).then(publishLsp) }, 1500)
    return () => { unsubscribe(); clearInterval(timer) }
  }, [sessionId])

  // LSP 会话：EditorView 持有权威 sessionId，直接写入 lspClient 并广播。
  // 直接调用不依赖事件时序（订阅可能晚于首次派发），广播供其它消费方复用。
  // @author ddj 2026年09月11号
  React.useEffect(() => {
    if (!sessionId) return
    setLspSession(sessionId)
    window.dispatchEvent(new CustomEvent('edrv:lsp-session', { detail: { sessionId } }))
  }, [sessionId])

  // AI 补全状态事件：busy/ok/error/idle 即时上栏；ok 3s、error 10s 后回落就绪
  React.useEffect(() => {
    const apply = (state, detail) => {
      if (aiStatusTimer.current) { clearTimeout(aiStatusTimer.current); aiStatusTimer.current = null }
      setAiStatus((prev) => ({ state, detail: detail ?? null, enabled: state === 'config' ? detail?.enabled === true : prev.enabled }))
      if (state === 'ok') aiStatusTimer.current = setTimeout(() => setAiStatus((p) => (p.state === 'ok' ? { ...p, state: 'idle' } : p)), 3000)
      else if (state === 'error') aiStatusTimer.current = setTimeout(() => setAiStatus((p) => (p.state === 'error' ? { ...p, state: 'idle' } : p)), 10000)
    }
    const onAiStatus = (e) => { if (e?.detail?.state) apply(e.detail.state, e.detail.detail) }
    const onAiConfig = (e) => apply('config', { enabled: e?.detail?.enabled === true })
    window.addEventListener('edrv:ai-status', onAiStatus)
    window.addEventListener('edrv:ai-config', onAiConfig)
    apply('config', { enabled: aiInlineEnabled() })
    return () => {
      window.removeEventListener('edrv:ai-status', onAiStatus)
      window.removeEventListener('edrv:ai-config', onAiConfig)
      if (aiStatusTimer.current) clearTimeout(aiStatusTimer.current)
    }
  }, [])

  // 代码片段：会话切换让补全按当前工作区叠加项目片段；配置文件保存后失效缓存即时生效
  React.useEffect(() => {
    setSnippetsSession(sessionId)
  }, [sessionId])
  React.useEffect(() => {
    const onChanged = () => invalidateSnippets()
    window.addEventListener('edrv:snippets-changed', onChanged)
    return () => window.removeEventListener('edrv:snippets-changed', onChanged)
  }, [])

  const fileOpenRef = React.useRef(null)
  /** @private @author ddj 2026年10月08号 @param e Routed file request. Always uses the current workspace and save/preview callbacks. */
  fileOpenRef.current = (e) => {
    const p = e?.detail?.path
    if (!p) return
    // G9：入口统一归一为工作区相对路径（差异栏/对话链接/LSP 跳转等都经此事件）
    const normalized = tabPath(p)
    if (!normalized) return
    if (e?.detail?.focusDiff === true) {
      recordNav()
      pendingFocusRef.current = { path: normalized, region: null }
      setFocusRequest((value) => value + 1)
      addTab(normalized, true, false)
      return
    }
    if (e?.detail?.line != null) {
      // LSP/搜索跳转：打开并定位到行列（endLine/endColumn 为目标区间，供落地高亮）
      openFileAt(normalized, e?.detail?.line, e?.detail?.column, e?.detail?.endLine, e?.detail?.endColumn)
      return
    }
    recordNav()
    addTab(normalized, true, e?.detail?.preview)
  }
  React.useEffect(() => {
    /** @private @author ddj 2026年10月08号 @param event File navigation event. Dispatch to the latest render closure. */
    const onOpen = (event) => fileOpenRef.current?.(event)
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

  // localStorage 恢复页签（v3：页签带 pinned；按工作区作用域；cwd 晚到 sid→ws 切换时重恢复一次）
  React.useEffect(() => {
    if (!sessionId || restoredScopeRef.current === scope) return
    restoredScopeRef.current = scope
    // model 缓存跟随作用域（切工作区释放旧作用域模型；同工作区跨挂载复用）
    modelsRef.current = modelsForScope(scope)
    viewStatesRef.current = viewStatesLoad(scope)
    // Markdown 预览态同样按作用域恢复（重启/换端口后由界面状态镜像回填，见 lateHydrateRef 分支）
    mdPreviewRef.current = mdPreviewLoad(String(scope))
    try {
      // v3 优先；缺失时回读 v2（旧版纯路径数组）——normalizeTabs 兼容两种形状
      const raw = localStorage.getItem(CACHE_KEY.editor + String(scope))
        ?? localStorage.getItem(CACHE_KEY.editorLegacy + String(scope))
      if (raw) {
        const saved = JSON.parse(raw)
        // G9：迁移历史持久化里的绝对路径页签（旧版差异入口写入），并顺带按新形态去重
        const restored = normalizeTabs(saved?.tabs, cwd)
        if (restored.length) {
          // 活动路径同形态归一，否则恢复后匹配不到任何页签（pickActive 回退首个）
          const wanted = typeof saved?.active === 'string' ? tabPathOf(saved.active, cwd) : saved?.active
          const activePath = pickActive(restored, wanted)
          // 上限已下调过（或历史存档超限）：恢复即收敛。此时页签均未编辑、无脏数据，
          // 故只做纯计算裁剪，不走 closeTabs（避免无谓的落盘探测与状态栏提示）。
          // evictPlan 已保护活动页签，无需额外 keep。
          const limit = getMaxOpenEditors()
          const plan = evictPlan(restored, limit, { active: activePath, used: {} })
          const dropped = new Set(plan)
          const kept = plan.length ? restored.filter((tab) => !dropped.has(tab.path)) : restored
          setTabs(kept)
          setActive(kept.some((tab) => tab.path === activePath) ? activePath : (kept[0]?.path ?? null))
          reportUiStateEvent(
            '页签恢复（scope=' + String(scope) + '）：存档 ' + restored.length + ' 个、保留 ' + kept.length
            + ' 个、活动 ' + String(activePath),
          )
        } else {
          reportUiStateEvent('页签恢复（scope=' + String(scope) + '）：存档非空但归一化后为 0 个')
        }
      } else {
        reportUiStateEvent('页签恢复（scope=' + String(scope) + '）：localStorage 无存档')
      }
    } catch (e) {
      reportUiStateEvent('页签恢复失败（scope=' + String(scope) + '）: ' + String(e), 'warn')
    }
  }, [sessionId, scope, hydrateTick])

  // 镜像迟到回填：重启换 origin 时首帧读不到存档，host 回填完成后重跑一次恢复。
  // 仅在本页签尚未恢复出任何内容时重跑（用户已打开/关闭过页签则不打扰）。
  React.useEffect(() => onUiStateReady(() => {
    if (tabsRef.current.length) return
    restoredScopeRef.current = null
    setHydrateTick((v) => v + 1)
  }), [])

  // 导航历史按工作区作用域隔离：同工作区切换对话保留历史，跨工作区换实例
  React.useEffect(() => {
    const history = navHistoryFor(scope)
    // 空实例（首次创建/换作用域）才用存档恢复，避免覆盖本次会话已积累的历史；
    // 换 origin 时存档由镜像迟到回填，hydrateTick 变化后再跑一次本效应
    const current = history.snapshot()
    if (!current.past.length && !current.future.length) {
      const saved = navStateLoad(String(scope))
      if (saved) history.restore(saved)
      reportUiStateEvent(
        '导航历史恢复（scope=' + String(scope) + '）：'
        + (saved ? 'past=' + saved.past.length + ' future=' + saved.future.length : 'localStorage 无存档'),
      )
    }
    navRef.current = history
    navPendingRef.current = null
    if (navCursorTimerRef.current) { clearTimeout(navCursorTimerRef.current); navCursorTimerRef.current = null }
    setNavTick((v) => v + 1)
  }, [scope, hydrateTick])

  // 导航双栈落 localStorage（同原文去重写；镜像层负责跨重启）：刷新/重启后前进后退与当前位置仍在
  React.useEffect(() => {
    if (!sessionId || !uiStateSettled()) return
    navStateSave(String(scope), navRef.current?.snapshot?.() ?? null)
  }, [navTick, cursor, active, sessionId, scope, hydrateTick])

  React.useEffect(() => {
    if (!sessionId || !uiStateSettled()) return
    try {
      // v3 写入：页签带 pinned（只写有值字段，减小体积）；固定态随工作区作用域持久化
      const payload = { tabs: tabs.map((t) => (t.pinned ? { path: t.path, pinned: true } : { path: t.path })), active }
      localStorage.setItem(CACHE_KEY.editor + String(scope), JSON.stringify(payload))
    }
    catch (e) { /* 忽略 */ }
  }, [tabs, active, sessionId, scope, hydrateTick])

  /**
   * 标记页签为「最近使用」（LRU 序号单调递增；编辑动作也算使用，见 onEdit）。
   * @author ddj 2026年09月18号
   * @param path 页签路径
   */
  const touchTab = (path) => {
    if (!path) return
    const state = tabUseRef.current
    state.seq += 1
    state.used[path] = state.seq
  }

  // 页签上限设置变更（edrv:max-open-editors）→ 更新上限态并触发下方淘汰 effect 复算
  React.useEffect(() => {
    const onLimit = () => setTabLimit(getMaxOpenEditors())
    window.addEventListener('edrv:max-open-editors', onLimit)
    return () => window.removeEventListener('edrv:max-open-editors', onLimit)
  }, [])

  // LRU 使用序维护：活动页签变化即标记；顺带把 used 表裁剪到当前页签集合，
  // 否则长会话中已关闭页签的条目会永久堆积（内存无界增长）。
  // ⚠️ 本 effect 必须声明在淘汰 effect 之前：先标记再淘汰，才能保证「刚打开/刚切到的
  // 页签」不会在同一次 commit 里被当作最久未用者淘汰。
  React.useEffect(() => {
    if (active) touchTab(active)
    const alive = new Set(tabs.map((t) => t.path))
    const used = tabUseRef.current.used
    for (const path of Object.keys(used)) if (!alive.has(path)) delete used[path]
  }, [tabs, active])

  // 页签超限淘汰：关闭最久未使用的页签（固定页签与活动页签受保护；见 tabActions.evictPlan）。
  // 复用 closeTabs：它已实现 flushSave + persistDirty（脏页签先静默落盘）+ releaseTab + commitClose，
  // 故「超限淘汰脏页签」不会丢用户编辑。淘汰后 tabs 变化 → 本 effect 复算 evictPlan 返回空 → 自然收敛。
  React.useEffect(() => {
    const plan = evictPlan(tabsRef.current, tabLimit, { active: activeRef.current, used: tabUseRef.current.used })
    if (!plan.length) return
    closeTabs(applyClose(tabsRef.current, new Set(plan), activeRef.current), '已关闭最久未使用的页签')
  }, [tabs, tabLimit, active])

  // 侧边栏状态：恢复（显隐/宽度/激活面板）；侧栏形态独立键（默认收起，不共享页签形态偏好）
  // 宽度下限来自通用设置 sidebarMinWidth（默认 300），恢复值按其重夹
  const sidebarKey = CACHE_KEY.sidebar + (layout === 'side' ? 'side.' : '') + String(scope)
  React.useEffect(() => {
    if (!sessionId) return
    try {
      const raw = localStorage.getItem(sidebarKey)
      if (raw) {
        const saved = JSON.parse(raw)
        if (typeof saved.on === 'boolean') setSidebarOn(saved.on)
        if (typeof saved.width === 'number') setSidebarW(Math.max(getSidebarMinWidth(), Math.min(560, saved.width)))
        if (typeof saved.panel === 'string') setActivePanel(saved.panel)
        reportUiStateEvent(
          '侧栏恢复（键 ' + sidebarKey + '）：on=' + String(saved.on) + ' width=' + String(saved.width)
          + ' panel=' + String(saved.panel),
        )
      } else {
        reportUiStateEvent('侧栏恢复（键 ' + sidebarKey + '）：localStorage 无存档')
      }
    } catch (e) {
      reportUiStateEvent('侧栏恢复失败（键 ' + sidebarKey + '）: ' + String(e), 'warn')
    }
  }, [sessionId, sidebarKey, hydrateTick])

  // 侧边栏最小宽度设置变更（edrv:sidebar-min-width）→ 更新 minW 并重夹当前宽度
  const [sidebarMinW, setSidebarMinW] = React.useState(() => getSidebarMinWidth())
  React.useEffect(() => {
    const onMinChange = () => {
      setSidebarMinW(getSidebarMinWidth())
      setSidebarW((w) => Math.max(getSidebarMinWidth(), w))
    }
    window.addEventListener('edrv:sidebar-min-width', onMinChange)
    return () => window.removeEventListener('edrv:sidebar-min-width', onMinChange)
  }, [])

  // 侧边栏状态持久化
  React.useEffect(() => {
    if (!sessionId || !uiStateSettled()) return
    try { localStorage.setItem(sidebarKey, JSON.stringify({ on: sidebarOn, width: sidebarW, panel: activePanel })) }
    catch (e) { /* 忽略 */ }
  }, [sidebarOn, sidebarW, activePanel, sessionId, sidebarKey, hydrateTick])
  // 编辑器键位（侧栏/保存/搜索/Markdown 预览/导航/页签循环）已归官方 shortcuts 机制派发：
  // 官方 resolve → 指令注册表 run → `edrv.command.*` 事件 → 下方「指令系统接线」表执行。
  // 历史 capture 监听移除（与官方派发并存会双执行）；Markdown 预览的「非 .md 不吞键」
  // 语义由命令 available()（activePathStore + isMarkdownPath）承载，可用性为假时官方派发放行。

  /**
   * 打开搜索面板（Ctrl+Shift+F 与命令栏「在工作区中搜索」的唯一动作）。
   *
   * 若编辑器有选区，把选区文本作为一次性种子交给搜索面板自动填入（需求 1）；
   * 无选区/无编辑器时种子为空，行为与改动前一致（仅展开并聚焦）。
   * 种子经 searchSeed 模块交棒而非事件 detail：侧栏原本收起时搜索面板尚未挂载，
   * 事件 detail 会丢；面板挂载后自行取走槽内种子。
   * @author ddj 2026年09月18号
   */
  const openSearchPanel = () => {
    const ed = editorRef.current
    const model = ed?.getModel?.()
    const sel = ed?.getSelection?.()
    let selected = ''
    if (model && sel && (sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn)) {
      // 选中区间文本（多行时 seedQueryOf 只取首行）
      selected = model.getValueInRange?.(sel) ?? ''
    }
    setSearchSeed(selected)
    setSidebarOn(true)
    setActivePanel('search')
    setTimeout(() => window.dispatchEvent(new CustomEvent('edrv:search-focus')), 0)
  }

  React.useEffect(() => bindPanelCommand('searchInFiles', { sessionId, cwd: cwd ?? undefined }, openSearchPanel), [sessionId, cwd])

  // Ctrl+Shift+F / Ctrl+Shift+V / Alt+←→ / Ctrl+Alt+←→ 的 capture 监听已随官方派发改造移除（见上）。

  // 整行上下移动的实现见下方「指令系统接线」effect（moveRow 单点定义，命令栏与键位共用）。

  // SVN 能力状态：scope 变化拉取 + `edrv:svn-status` 事件驱动刷新（菜单/页签/命令面板显隐数据源）
  React.useEffect(() => {
    ensureSvnStatus(sessionId, scope)
    const onSvnStatus = (event) => {
      if (!event?.detail?.scope || event.detail.scope === scope) setSvnStatus(getSvnStatus(scope))
    }
    window.addEventListener('edrv:svn-status', onSvnStatus)
    // 缓存命中时 ensure 直接 return、不广播事件，须同步读回当前 scope 的载荷：
    // 否则从非 SVN 工作区切回 SVN 工作区后，状态残留上一个工作区的 managed:false，
    // 右键菜单/页签菜单的 SVN 组会整组消失（与下方变更清单 effect 的同步语句同理）。
    setSvnStatus(getSvnStatus(scope))
    return () => window.removeEventListener('edrv:svn-status', onSvnStatus)
  }, [sessionId, scope])

  // SVN 变更清单：状态就绪且受管理时才拉取（非 SVN 工作区零请求）+ `edrv:svn-changes` 驱动刷新
  // 依赖里放 managed/svnCli：状态后到时会自动补拉（首次渲染时状态尚为 null）
  React.useEffect(() => {
    const ready = Boolean(svnStatus?.managed && svnStatus?.svnCli)
    if (ready) ensureSvnChanges(sessionId, scope)
    const onSvnChanges = (event) => {
      if (!event?.detail?.scope || event.detail.scope === scope) setSvnChanges(getSvnChanges(scope))
    }
    window.addEventListener('edrv:svn-changes', onSvnChanges)
    // 状态刚到达（同轮已拉到清单）时也同步一次当前值，避免事件早于监听错过
    setSvnChanges(getSvnChanges(scope))
    return () => window.removeEventListener('edrv:svn-changes', onSvnChanges)
  }, [sessionId, scope, svnStatus?.managed, svnStatus?.svnCli])

  // SVN 日志：弹窗打开期间订阅 `edrv:svn-log`（键经 svnLogKeyOf 统一拼装，含 P1-4/P1-5/P1-6 选项维度）
  React.useEffect(() => {
    if (!svnLog) return undefined
    const target = svnLog.target || ''
    const opts = svnLogOptsOf(svnLog)
    const key = svnLogKeyOf(scope, target, opts)
    const sync = (event) => {
      dshTrace('svnLog.syncEvent', { got: event?.detail?.key ?? null, expected: key })
      if (event?.detail?.key && event.detail.key !== key) return
      setSvnLogData(getSvnLog(scope, target, 0, opts))
      setSvnLogBusy(false)
    }
    window.addEventListener('edrv:svn-log', sync)
    // 打开时先同步一次（状态层可能已缓存）
    setSvnLogData(getSvnLog(scope, target, 0, opts))
    return () => window.removeEventListener('edrv:svn-log', sync)
  }, [svnLog, scope])

  // P1-9：文件目标拉取工作副本版号（目录/根不拉，官方对目录需 crawl 工作副本，本插件不做）
  React.useEffect(() => {
    if (!svnLog || !svnLog.target) { setSvnLogWcRev(null); return undefined }
    let live = true
    void svnWcRev(sessionId, svnLog.target).then((rev) => { if (live) setSvnLogWcRev(rev) })
    return () => { live = false }
  }, [svnLog?.target, sessionId])

  /**
   * 指令系统接线：命令栏/键位/第三方派发的 `edrv.command.*` 事件落到编辑器动作。
   * 全部动作经最新闭包执行（与窗口级键位监听同源）；事件名逐条字面书写，
   * 便于与指令目录（ui/commandCatalog）静态对照（tests/commands.test.ts 有断言）。
   * @author ddj 2026年09月10号
   */
  React.useEffect(() => {
    /** 整行上下移动：Monaco 内置 cursorUp/Down 会丢列位，故按期望列自行定位（连续移动保持同列）。 */
    const moveRow = (step) => {
      const ed = editorRef.current
      const model = ed?.getModel?.()
      const pos = ed?.getPosition?.()
      if (!ed || !model || !pos) return
      const col = rowNavColRef.current ?? pos.column
      const line = Math.max(1, Math.min(model.getLineCount(), pos.lineNumber + step))
      if (line === pos.lineNumber) return
      const maxCol = model.getLineMaxColumn(line)
      rowNavColRef.current = col
      rowNavMoveRef.current = true
      ed.setPosition({ lineNumber: line, column: Math.max(1, Math.min(col, maxCol)) })
      ed.revealLineInCenterIfOutsideViewport?.(line)
    }
    const handlers = [
      ['edrv.command.save', () => { if (editorRef.current?.getModel?.()) { flushSave(); doSaveRef.current?.(false) } }],
      // 快速打开由 QuickOpen 自己接该事件（它持有搜索框 ref），此处不重复实现
      ['edrv.command.toggleSidebar', () => setSidebarOn((v) => !v)],
      ['edrv.command.toggleMarkdownPreview', () => {
        const path = activeRef.current
        if (!isMarkdownPath(path)) { setStatus('当前文件不是 Markdown'); return }
        toggleMdPreviewRef.current?.(path)
      }],
      ['edrv.command.navigateBack', () => navBackRef.current?.()],
      ['edrv.command.navigateForward', () => navForwardRef.current?.()],
      ['edrv.command.nextTab', () => cycleTabRef.current?.(1)],
      ['edrv.command.prevTab', () => cycleTabRef.current?.(-1)],
      ['edrv.command.closeTab', () => closeActiveTab()],
      ['edrv.command.nextEditorRow', () => moveRow(1)],
      ['edrv.command.prevEditorRow', () => moveRow(-1)],
      ['edrv.command.goToDefinition', () => { const ed = editorRef.current; if (ed) void runGoToDefinition(ed) }],
      ['edrv.command.findReferences', () => { const ed = editorRef.current; if (ed) void runFindReferences(ed) }],
      ['edrv.command.triggerAi', () => editorRef.current?.trigger?.('edrv-ai', 'editor.action.inlineSuggest.trigger', null)],
      ['edrv.command.openInExplorer', () => {
        const path = activeRef.current
        if (!path) { setStatus('无活动文件'); return }
        menuHandlersRef.current?.openInExplorer?.(path)
      }],
      // 代码片段：配置（选择器）与插入（当前语言条目）；选区引用（Ctrl+U）。
      // 打开前先关命令栏：命令栏是「执行一条命令」的一次性入口，执行完即关，
      // 否则会残留一个已打开（可能被浮窗遮住）的命令栏，使后续 Ctrl+Shift+P 看似失效。
      ['edrv.command.configureSnippets', () => { closeCommandPalette(); setSnippetPicker('configure') }],
      ['edrv.command.insertSnippet', () => { closeCommandPalette(); setSnippetPicker('insert') }],
      ['edrv.command.addSelectionRef', () => {
        const ed = editorRef.current
        const sel = ed?.getSelection?.()
        const path = activeRef.current
        if (!path) { setStatus('无活动文件'); return }
        if (!sel || (sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn)) {
          setStatus('请先选中内容再添加引用')
          return
        }
        const range = { startLine: sel.startLineNumber, endLine: sel.endLineNumber }
        if (!addToConversation) { setStatus('添加到对话不可用'); return }
        addToConversation.appendReference(sessionId, path, range).then((o) => setStatus(statusOfAdd(o, '已添加选中内容为引用')))
      }],
      // SVN：命令面板动作（活动文件；无活动文件时 update/commit 用工作区根，其余提示）
      ['edrv.command.svnUpdate', () => runSvnUpdate(activeRef.current ?? '')],
      ['edrv.command.svnRefreshChanges', () => runSvnReload()],
      ['edrv.command.svnDiffBase', () => runSvnDiffBase(activeRef.current)],
      ['edrv.command.svnAdd', () => runSvnAdd(activeRef.current)],
      ['edrv.command.svnRevertCli', () => runSvnRevertCli(activeRef.current)],
      ['edrv.command.svnLog', () => openSvnLog(activeRef.current || undefined)],
      ['edrv.command.svnCreatePatch', () => runSvnAction(SVN_ACTION_BY_ID['create-patch'], {
        sessionId,
        scope,
        path: activeRef.current ?? '',
        notify: (message) => setStatus(message),
        openPatchDialog: (payload) => setPatchDialog(payload),
      })],
      ['edrv.command.svnDiffSum', () => runSvnAction(SVN_ACTION_BY_ID['diff-summarize'], {
        sessionId,
        scope,
        path: dirOfRel(activeRef.current ?? ''),
        notify: (message) => setStatus(message),
        openSumDialog: (target) => setSumDialog({ path: target }),
      })],
      ['edrv.command.svnCleanup', () => runSvnAction(SVN_ACTION_BY_ID.cleanup, {
        sessionId,
        scope,
        notify: (message) => setStatus(message),
        refreshChanges: () => refreshSvnChanges(sessionId, scope),
      })],
      ['edrv.command.svnTortoiseCommit', () => runSvnTortoise('commit', activeRef.current ?? '')],
      ['edrv.command.svnTortoiseLog', () => runSvnTortoise('log', activeRef.current)],
      ['edrv.command.svnTortoiseDiff', () => runSvnTortoise('diff', activeRef.current)],
      ['edrv.command.svnTortoiseBlame', () => runSvnTortoise('blame', activeRef.current)],
      ['edrv.command.svnTortoiseRevert', () => runSvnTortoise('revert', activeRef.current)],
      // 转到行：转发 Monaco 原生 action（widget 本体/占位/跳转全原生，插件只补键位与命令栏入口）
      ['edrv.command.goToLine', () => {
        const ed = editorRef.current
        if (ed?.getModel?.()) ed.trigger('edrv-goto', 'editor.action.gotoLine', null)
      }],
      // 诊断日志弹窗（同片段选择器：执行一条命令即关命令栏，避免残浮层遮挡）
      ['edrv.command.showLogs', () => { closeCommandPalette(); setDlogOpen(true) }],
    ]
    const byName = new Map(handlers)
    const onCommand = (event) => {
      const action = byName.get(event.type)
      if (!action) return
      try { action() } catch (error) { dbg(sessionId, '指令 ' + event.type + ' 失败：' + String(error)) }
    }
    for (const [eventName] of handlers) window.addEventListener(eventName, onCommand)
    return () => {
      for (const [eventName] of handlers) window.removeEventListener(eventName, onCommand)
    }
  }, [sessionId])

  // 活动页签滚动可见（页签栏溢出时键盘切换/打开文件后把当前页签带回视野）：
  // 只调整页签栏自身 scrollLeft，不触发页面滚动。
  React.useEffect(() => {
    const host = tabsHostRef.current
    if (!host) return
    const el = host.querySelector?.('.edrv-tab-active')
    if (!el) return
    const left = el.offsetLeft
    const right = left + el.offsetWidth
    if (left < host.scrollLeft) host.scrollLeft = left
    else if (right > host.scrollLeft + host.clientWidth) host.scrollLeft = right - host.clientWidth
  }, [active, tabs.length])

  // 页签栏滚轮横向滚动（需求 3）：页签栏溢出时，鼠标滚轮（含触控板纵向手势）横滚页签栏，
  // 不溢出时不接管（保持页面垂直滚动）；Shift+滚轮交由浏览器原生横滚。详见 horizontalWheel.ts。
  React.useEffect(() => attachHorizontalWheel(tabsHostRef.current), [])

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
    setImageSrc(null)
    setImgSize(null)
    setImgBroken(false)
    setPdfBytes(null)
    setLoadError(null)
    setLoadStage({ progress: 10, message: '准备读取文件…' })
    setStatus('加载中…')
    loadContent(active, sessionId)
  }, [active, sessionId])

  // 页签右键菜单的 Esc 关闭由 ContextMenu 组件自己处理（capture 监听），此处不再重复挂监听

  React.useEffect(() => {
    if (monaco || monacoErr) return
    let alive = true
    const onProgress = (stage) => {
      if (!alive) return
      const progress = stage.phase === 'ready' ? 70 : Math.round(10 + stage.progress * 0.6)
      setLoadStage((prev) => ({ progress: Math.max(prev.progress, progress), message: stage.message }))
    }
    loadMonaco(onProgress).then((m) => {
      if (!alive) return
      setMonaco(m)
      // AI 内联补全 provider 注册 + 开关初始化（幂等）
      setupAiInline(m)
      // 代码片段补全 provider 注册（幂等；条目按会话工作区懒加载）
      setupSnippets(m)
      // launch.json「添加配置」补全 provider 注册（幂等；仅 launch.json configurations 数组内出条目）
      setupLaunchJson(m)
    }).catch((e) => {
      if (alive) {
        setMonacoErr(String(e?.message ?? e))
        setStatus('Monaco 不可用')
      }
    })
    return () => { alive = false }
  }, [monaco, monacoErr])

  // 主题：Monaco 就绪后注册现役双套（幂等）+ 应用跟随官方的令牌主题；
  // 官方主题事件（edrv:theme-change，经 ctx.theme/属性观察广播）与系统明暗切换时跟随重刷。
  React.useEffect(() => {
    if (!monaco) return
    registerThemes(monaco)
    /** @private @author ddj 2026年10月09号 同步 Monaco 主题与行内删除代码着色。 */
    const apply = () => {
      const themeId = applyOfficial(monaco)
      diffRendererRef.current.refresh(themeId)
    }
    apply()
    window.addEventListener('edrv:theme-change', apply)
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    if (query) {
      if (typeof query.addEventListener === 'function') query.addEventListener('change', apply)
      else query.addListener(apply)
    }
    return () => {
      window.removeEventListener('edrv:theme-change', apply)
      if (!query) return
      if (typeof query.removeEventListener === 'function') query.removeEventListener('change', apply)
      else query.removeListener(apply)
    }
  }, [monaco])

  monacoRef.current = monaco

  /** 从编辑器实例 model URI 解析活动文件路径（工作区相对；无模型返回 null）。 */
  const modelPathOf = (edx) => editorModelPathOf(edx)

  /**
   * 同步 Monaco 右键菜单 SVN 组：先注销旧组，再按最新 svn 状态注册（空状态 = 全部移除）。
   * ensureEditor（编辑器创建）与 svn 状态变化两条通道都会调用，幂等。
   * @author ddj 2026年09月16号
   * @param ed Monaco 编辑器实例（未创建传 null）
   */
  const syncSvnMenuActs = (ed) => {
    const stale = svnMenuDisposersRef.current
    svnMenuDisposersRef.current = []
    for (const dispose of stale) {
      try { dispose?.() } catch { /* dispose 异常忽略，不阻塞重注册 */ }
    }
    if (!ed || typeof ed.addAction !== 'function') return
    const changeMap = svnChangeMapOf(scope)
    const activeEntry = activeRef.current ? changeMap[activeRef.current] : undefined
    for (const item of svnEditorActions(svnStatusRef.current, {
      versioned: activeEntry ? activeEntry.versioned : true,
      status: activeEntry?.status,
      diffable: activeRef.current ? isSvnDiffable(activeRef.current, activeEntry?.status) : true,
    })) {
      const handle = ed.addAction({
        id: item.id,
        label: item.label,
        contextMenuGroupId: '2_edrv',
        precondition: 'editorTextFocus',
        run: (edx) => {
          const relPath = modelPathOf(edx)
          if (item.kind === 'tortoise') { menuHandlersRef.current?.svnTortoise?.(item.tortoiseAction, relPath); return }
          // 自研动作经动作目录统一执行（与树/页签/命令栏同一执行器）
          const def = SVN_ACTION_BY_ID[item.actionId]
          if (!def) return
          runSvnAction(def, {
            sessionId,
            scope,
            path: def.id === 'update' ? (relPath ?? '') : relPath,
            openSvnUpdate: (p) => runSvnUpdate(p),
            notify: (message) => setStatus(message),
            openSvnDiff: (p) => runSvnDiffBase(p),
            openSvnLocalPair: runSvnDiffLocalPair,
            openSvnLog: (p) => openSvnLog(p ?? relPath),
            refreshChanges: () => refreshSvnChanges(sessionId, scope),
          })
        },
      })
      svnMenuDisposersRef.current.push(handle?.dispose ? () => handle.dispose() : null)
    }
  }

  // Monaco 右键 SVN 组随 svn 状态与变更清单增减；编辑器尚未创建时 no-op（创建时由 ensureEditor 补注册）
  React.useEffect(() => {
    syncSvnMenuActs(editorRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco, svnStatus, svnChanges])

  const getModel = (path, text) => {
    const cache = modelsRef.current
    let model = cache.get(path)
    if (!model) {
      // 注册表守卫：同 URI 已存在的 model 直接复用（HMR 换 bundle 后防重复创建抛错）
      // edrv URI 装「工作区相对路径」（对齐 toEdrvUri 约定）：绝对路径剥前导 /，
      // 否则 'edrv:///' + '/home/x' 拼出 edrv:////home/x（空 authority + // 开头）→
      // Monaco Uri.parse 抛 UriError → 官方侧栏/差异入口打开绝对路径文件白屏（issue #5/#6）
      const uri = window.monaco.Uri.parse('edrv:///' + encodeURI(String(path ?? '').replace(/^\/+/, '')))
      model = window.monaco.editor.getModel(uri) || window.monaco.editor.createModel(text ?? '', langOf(path), uri)
      rememberModel(cache, path, model)
    } else if (text !== undefined && model.getValue() !== text) {
      programmaticRef.current = true
      model.setValue(text)
      programmaticRef.current = false
    }
    return model
  }

  /**
   * 提交待执行的防抖保存（**真正执行保存**，不是取消）。
   * 语义与缺陷背景见 saveDebounce.ts：`schedule` 的返回值是只 clearTimeout 的 disposer，
   * 旧实现把它当「立即保存」调用 → 防抖窗口内切页签/关闭文件会静默丢改动。
   * 外部改动待处理（冲突/文件被删）时跳过：切页签/卸载不得用陈旧缓冲覆盖磁盘，
   * 缓冲内容仍在 model 里，用户处理完冲突后再保存。
   * @author ddj 2026年09月11号 / 2026年09月15号
   * @param path 目标路径（缺省 = 当前活动文件）
   * @returns 是否执行了保存
   */
  const flushSave = (path) => {
    const target = path ?? active
    if (target && readSync(scope, target)) return false
    saveTimerRef.current?.flush()
    return true
  }

  /**
   * Apply a save completion only to the unchanged model that supplied its text.
   * @private @author ddj 2026年09月28号
   * @param path Saved tab path.
   * @param text Text actually sent to disk.
   * @param model Model captured before the save request.
   */
  function acceptSaved(path, text, model) {
    if (!model || modelsRef.current.get(path) !== model || model.isDisposed?.() || model.getValue() !== text) return
    setDirtyMap((current) => ({ ...current, [path]: false }))
    if (activeRef.current !== path) return
    setContent(text)
    setContentPath(path)
    setStatus('已保存 ' + new Date().toTimeString().slice(0, 8))
    setDiskFlag((prev) => (prev && prev.path === path ? null : prev))
  }

  const doSave = (silent) => {
    if (!active) return
    // 外部改动待处理：自动保存（silent）直接放弃，避免陈旧缓冲覆盖磁盘；
    // 手工保存（Ctrl+S / 命令栏）继续走版本守卫，由 host 判定并给冲突提示。
    if (silent && readSync(scope, active)) { setStatus('外部已修改（未保存的编辑保留）'); return }
    // PDF tab：保存委托给面板控制器（saveDocument → base64 → edrv.saveBinary）
    if (isPdfPath(active)) {
      const ctl = pdfCtlRef.current.get(active)
      if (!ctl) { if (!silent) setStatus('PDF 未就绪'); return }
      if (!ctl.isDirty()) { if (!silent) setStatus('PDF 无未保存修改'); return }
      void ctl.savePdf()
      return
    }
    const ed = editorRef.current
    if (!ed) return
    if (isImageActive) { setStatus('图片只读预览'); return }
    const text = ed.getValue()
    const savedModel = ed.getModel?.()
    const path = active
    if (!silent) setStatus('保存中…')
    // 在途登记：关闭路径的 persistDirty 据此跳过重复提交（内容在同一 tick 内取，必然相同）
    savingRef.current.add(path)
    // 版本守卫令牌：上次读取/写入时的磁盘版本；与磁盘当前版本不符时 host 拒绝写入
    const rev = revRef.current[path]
    rpc('edrv.save', { sessionId, path, content: text, rev: typeof rev === 'string' && rev ? rev : undefined }).then((res) => {
      if (res && res.ok) {
        if (res.rev) revRef.current[path] = res.rev
        recordBaseline(scope, path, res.rev)
        markReadVersion(scope, path, res.rev, true) // 缓冲即磁盘内容：同版本无需再读盘
        clearSync(scope, path)
        acceptSaved(path, text, savedModel)
        refreshRecords()
        emitRefresh()
        // 片段配置文件保存后失效补全缓存（下次补全即读到新片段）
        if (/\.code-snippets$/i.test(path)) window.dispatchEvent(new CustomEvent('edrv:snippets-changed'))
        return
      }
      if (res && res.conflict) {
        // 磁盘已被外部改过：保留缓冲内容与脏标记，交给用户显式选择
        markDiskFlag({ path, kind: 'conflict', at: Date.now() })
        setStatus('保存被拒：文件已被外部修改')
        return
      }
      setStatus('保存失败')
      setError(res?.error ? String(res.error) : '保存失败')
    }).catch((e) => { setStatus('保存失败'); setError('保存异常:' + String(e)) })
      .finally(() => { savingRef.current.delete(path) })
  }
  doSaveRef.current = doSave

  /**
   * 关闭前落盘：把「待关闭且仍标脏」的页签静默保存。
   *
   * 调用方须先 `flushSave()`：它已把活动页签的待执行保存真正提交（见 saveDebounce 的缺陷说明）。
   * 这里再处理**仍标脏**的页签 —— 包括活动页签（其保存可能在途或失败），
   * 用 model 里的当前文本补一次，保证关闭前内容一定写到磁盘。
   * 保存失败只保留脏标记（不丢用户编辑），并在状态栏给出提示。
   * 外部改动待处理的页签跳过（版本守卫下必被拒绝；缓冲仍在 model 里，不丢内容）。
   * @author ddj 2026年09月11号 / 2026年09月15号
   * @param paths 即将关闭的页签路径
   */
  const persistDirty = (paths) => {
    for (const path of paths) {
      if (!dirtyRef.current[path]) continue
      // 外部改动未处理：不落盘（避免覆盖），脏内容仍保留在 model 中
      if (readSync(scope, path)) { setStatus('未落盘（外部已修改）：' + baseNameOf(path)); continue }
      // 已有在途保存（flushSave 刚提交的防抖保存）：同一 tick 内容必然一致，跳过重复提交
      if (savingRef.current.has(path)) continue
      const pdfCtl = pdfCtlRef.current.get(path)
      if (pdfCtl) { if (pdfCtl.isDirty()) void pdfCtl.savePdf(); continue }
      const model = modelsRef.current.get(path)
      if (!model) { setStatus('未保存的修改无法落盘：' + baseNameOf(path)); continue }
      const content = model.getValue()
      savingRef.current.add(path)
      const rev = revRef.current[path]
      rpc('edrv.save', { sessionId, path, content, rev: typeof rev === 'string' && rev ? rev : undefined })
        .then((res) => {
          if (res && res.ok) {
            if (res.rev) revRef.current[path] = res.rev
            recordBaseline(scope, path, res.rev)
            markReadVersion(scope, path, res.rev, true) // 缓冲即磁盘内容：同版本无需再读盘
            setDirtyMap((d) => Object.assign({}, d, { [path]: false }))
          }
        })
        .catch((e) => dbg(sessionId, '关闭前落盘失败：' + path + ' · ' + String(e)))
        .finally(() => { savingRef.current.delete(path) })
    }
  }

  const onEdit = () => {
    const ed = editorRef.current
    if (!ed || !active) return
    setDirtyMap((d) => Object.assign({}, d, { [active]: true }))
    // 编辑即「使用」：需求 2 的淘汰口径是「最近没有改动」，故有改动时刷新 LRU 序号，
    // 使长时间只在某文件里编辑的页签不会被其它文件的打开动作挤出。
    touchTab(active)
    setStatus('编辑中…')
    // 外部改动尚未处理（冲突/文件被删）：抑制自动保存，避免用陈旧缓冲反复覆盖磁盘；
    // 手工 Ctrl+S 不受抑制（doSave 会走版本守卫并给冲突提示）。
    if (readSync(scope, active)) { setStatus('外部已修改（未保存的编辑保留）'); return }
    // 重新计时（arm 内部先取消上一轮）；到点自动保存，切页签/关闭前由 flushSave 立即提交
    saveTimerRef.current?.arm(schedule, 700, () => doSave(true))
  }
  // @author ddj 2026年09月09号 空依赖监听只持有首帧 onEdit（active 恒 null→提前返回，星号与自动保存从未生效）：每次渲染同步最新闭包
  onEditRef.current = onEdit

  // model 同步（当前内容）
  // ⚠️ 必须以 contentReady（contentPath === active）为门，不能用 `content !== null`：
  // 切页签的那一帧 content 仍是**上一个文件**的内容，据此建 model 会先塞入陈旧文本，
  // 待真实内容到达再由 getModel→setValue 覆盖，光标随之被重置（见下方跳转 effect 注释）。
  // ⚠️ 依赖必须含 mdPreviewing：Markdown 预览态不渲染 Monaco host（见 body 分派的 mdPreviewing 分支），
  // 切回源码时 ensureEditor 会**新建**编辑器实例，而 active/content 都没变；缺此依赖则本 effect
  // 不重跑 → 空 model、行内差异标记消失。同款原因见下方差异自绘 effect。
  React.useEffect(() => {
    if (!monaco || !editorRef.current || !active || !contentReady) return
    const ed = editorRef.current
    const model = getModel(active, content)
    if (ed.getModel() !== model) ed.setModel(model)
    syncTypeSuggest(ed, monaco)
    restoreViewState(active)
    setLoadStage((prev) => ({ progress: Math.max(96, prev.progress), message: '创建编辑器视图…' }))
  }, [monaco, active, content, contentReady, mdPreviewing, svnDiff])

  // PDF 面板外壳 ref 回调（div 仅在 PDF 分支渲染，refs 先于 effect 就绪）
  const ensurePdfHost = (node) => { pdfHostRef.current = node }

  // PDF 面板装配：控制器挂进外壳 div，切换 tab/卸载即销毁（重开重挂，base64 缓存兜底秒切）
  React.useEffect(() => {
    const host = pdfHostRef.current
    if (!isPdfActive || !pdfBytes || !host) return
    const path = active
    const sequence = receiptLoad?.sequence
    if (!acceptsLoad(receiptLoad, sessionId, path, sequence, loadSeqRef.current)) return
    let mounting = true
    /** @author ddj 2026年09月28号 @param message PDF error; only startup failures affect an open receipt. */
    const pdfError = (message) => {
      setError(message)
      if (mounting && message) renderLoadFail(path, sessionId, sequence, message)
    }
    /** @author ddj 2026年09月28号 End startup error attribution before later save operations. */
    const mounted = () => { mounting = false }
    const ctl = createPdfPanel({
      sessionId,
      path,
      setStatus,
      setError: pdfError,
      onDirtyChange: (d) => setDirtyMap((prev) => Object.assign({}, prev, { [path]: d })),
      onReload: () => loadContent(path, sessionId, true),
    })
    pdfCtlRef.current.set(path, ctl)
    void ctl.mount(host, pdfBytes).then(mounted, pdfError)
    return () => {
      mounting = false
      ctl.destroy()
      if (pdfCtlRef.current.get(path) === ctl) pdfCtlRef.current.delete(path)
    }
  }, [isPdfActive, pdfBytes, active, receiptLoad?.sequence])

  // 行内差异自绘（decorations / view zones / minus overlay）→ diffRenderer
  // ⚠️ 依赖含 mdPreviewing：切回源码时编辑器实例被重建（见上方 model 同步 effect 的说明），
  // 不重跑则新实例上没有任何差异装饰，表现为「差异标记全部消失」。
  React.useEffect(() => {
    if (!monaco || !editorRef.current || !active || content === null) return
    diffRendererRef.current.render(monaco, editorRef.current, pendingRegions, sessionId)
    setLoadStage({ progress: 100, message: '编辑器已就绪' })
  }, [monaco, active, content, pendingRegions, mdPreviewing, svnDiff])

  React.useEffect(() => () => {
    flushSave()
    // 卸载即切作用域/重挂载：先把待记录光标落进历史，再存当前文件视图状态
    //（经 ref 取最新闭包，修正旧实现捕获挂载时 active 的问题）
    flushNavCursor()
    // 关页面/切作用域前把双栈落到 localStorage（镜像层 flush 负责写穿 host）
    navStateSave(String(scope), navRef.current?.snapshot?.() ?? null)
    saveViewStateRef.current?.()
    diffRendererRef.current?.dispose?.()
    hideReferencesOverlay()
    // 跳转目标高亮的计时器随卸载清理（装饰随编辑器 dispose 一并消失）
    if (navFlashTimerRef.current) { clearTimeout(navFlashTimerRef.current); navFlashTimerRef.current = null }
    navFlashRef.current = []
    if (editorRef.current) { editorRef.current.dispose(); editorRef.current = null }
    // model 不在此销毁：跨挂载缓存按作用域存活（modelCache 切作用域时统一释放）
    for (const ctl of pdfCtlRef.current.values()) ctl.destroy()
    pdfCtlRef.current.clear()
    clearZoomMem() // 图片缩放记忆随 EditorView 卸载清空（会话级生命周期，不持久化）
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
      // AI 内联补全（ghost text）：开关经 edrv.ai.configGet 拉取；provider 见 client/ai/inlineProvider
      inlineSuggest: { enabled: true },
    })
    // 保存改由窗口级快捷键监听执行（键位可配置；见上方 edrv.save 监听）
    ed.onDidChangeModelContent(() => {
      if (!ed.getModel() || programmaticRef.current) return
      syncTypeSuggest(ed, m)
      onEditRef.current?.()
    })
    ed.onDidChangeCursorPosition((e) => {
      syncTypeSuggest(ed, m)
      setCursor('Ln ' + e.position.lineNumber + ', Col ' + e.position.column)
      // 整行移动（↓↑）刚定位时保留期望列；其余光标移动（点击/打字/方向键）清空期望列
      if (rowNavMoveRef.current) rowNavMoveRef.current = false
      else rowNavColRef.current = null
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
    const pathOf = modelPathOf
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
    // 整行上下移动 + 命令栏：只登记 Monaco 右键菜单入口（不绑键位）。
    // 键位由指令桥统一 capture 派发 `edrv.command.*`，此处再绑一次会双执行。
    ed.addAction({
      id: 'edrv.prevEditorRow', label: '上一编辑行', contextMenuGroupId: '1_edrv',
      run: () => window.dispatchEvent(new CustomEvent('edrv.command.prevEditorRow')),
    })
    ed.addAction({
      id: 'edrv.nextEditorRow', label: '下一编辑行', contextMenuGroupId: '1_edrv',
      run: () => window.dispatchEvent(new CustomEvent('edrv.command.nextEditorRow')),
    })
    ed.addAction({
      id: 'edrv.showCommands', label: '显示所有命令', contextMenuGroupId: '1_edrv',
      run: () => window.dispatchEvent(new CustomEvent('edrv.command.showCommands')),
    })
    // SVN 组按创建时的最新状态注册（此后由 [monaco, svnStatus] effect 随状态增减）
    syncSvnMenuActs(ed)
    bindLspUnderline(ed, m)
    // AI 补全：编辑器实例登记（差异静默判定用）+ Alt+\ 手动触发 ghost text
    trackAiEditor(ed)
    ed.addCommand(m.KeyMod.Alt | m.KeyCode.Backslash, () => {
      ed.trigger('edrv-ai', 'editor.action.inlineSuggest.trigger', null)
    })
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
    // 调试断点：行首 glyph 圆点区**左键**点击切换（右键走下方 contextmenu 菜单，
    // 必须区分按键——否则右键会既 toggle 断点又弹菜单）。
    // ⚠️ 枚举在 monaco.editor 子命名空间（monaco.editor.MouseTargetType，值为 2）；
    //    取顶层 m.MouseTargetType 是 undefined，会让点击永远静默返回（实测踩坑）。
    ed.onMouseDown((e) => {
      const target = e?.target
      if (!e?.event?.leftButton) return
      const GUTTER = m.editor?.MouseTargetType?.GUTTER_GLYPH_MARGIN ?? 2
      if (!target || target.type !== GUTTER) return
      const line = target.position?.lineNumber
      const path = pathOf(ed)
      if (line && path) dapToggleRef.current?.(path, line)
    })
    // 断点 hover 预览（对齐 VS Code `ensureBreakpointHintDecoration`）：
    // 鼠标移到 glyph 区（type=2）或行号区（type=3）的可下断点行 → 半透明红点 + pointer 光标；
    // 移开/离开编辑器 → 清除。已有断点的行不显示预览（避免与实心红点重叠）。
    ed.onMouseMove((e) => {
      const target = e?.target
      const path = pathOf(ed)
      const list = path ? (dapStore.bpMapOf(dapScopeRef.current)[path] ?? []) : []
      const line = hintLineFor(target?.type, target?.position?.lineNumber, list.map((it) => it.line))
      setHintLine(ed, line || null)
    })
    ed.onMouseLeave(() => setHintLine(ed, null))
    // 断点右键菜单：glyph 区右键**始终**由本插件接管（严格对齐 CodeBuddy：任意文件都出菜单，
    // 不再限定 .lua）。命中行改用 Monaco 官方 getTargetAtClientPoint——
    // 手算 floor((relY+scrollTop)/lineHeight)+1 **未扣编辑器 padding-top**（实测 6px），
    // 点在某行框下半部会被算成下一行 → 对空行显示"添加"菜单（实测踩坑）。
    const glyphHitLine = (ev) => {
      const edi = editorRef.current
      if (!edi?.getTargetAtClientPoint) return null
      const rect = edi.getDomNode?.()?.getBoundingClientRect?.()
      if (!rect) return null
      const layout = edi.getLayoutInfo?.()
      if (!layout) return null
      const relX = ev.clientX - rect.left
      if (relX < layout.glyphMarginLeft || relX > layout.glyphMarginLeft + layout.glyphMarginWidth) return null
      const GUTTER = m.editor?.MouseTargetType?.GUTTER_GLYPH_MARGIN ?? 2
      const target = edi.getTargetAtClientPoint(ev.clientX, ev.clientY)
      if (!target || target.type !== GUTTER) return null
      return target.position?.lineNumber ?? null
    }
    const onBpCtxCapture = (ev) => {
      const line = glyphHitLine(ev)
      if (!line) return
      const path = pathOf(editorRef.current)
      if (!path) return
      const entry = (dapStore.bpMapOf(dapScopeRef.current)[path] ?? []).find((it) => it.line === line)
      ev.preventDefault()
      ev.stopPropagation()
      setDapBpMenu({
        x: ev.clientX,
        y: ev.clientY,
        path,
        line,
        hasBp: !!entry,
        enabled: entry ? entry.enabled !== false : true,
        isLogpoint: !!(entry && entry.logMessage),
      })
    }
    node.addEventListener('contextmenu', onBpCtxCapture, true)
    editorRef.current = ed
  }, [])

  // 调试断点装饰：断点表/活动文件变化时全量替换行首圆点（独立 collection，与差异/下划线互不干扰）；
  // 适配器真实回执 verified:false 的行渲染空心红圈（对齐 VS Code 未验证语义）
  React.useEffect(() => {
    const ed = editorRef.current
    if (!ed || !active) return
    const map = dapStore.bpMapOf(scope)
    const unverified = bpLinesOf(map, active).filter((line) => dapStore.ackOf(active, line)?.verified === false)
    applyBpDecorations(ed, bpLinesOf(map, active), bpDisabledLinesOf(map, active), unverified)
  }, [scope, active, contentPath, dapSnap.bpVersion, dapSnap.bpAckVersion, monaco])

  // 行内断点编辑浮层：切换文件 / 编辑器重建时关闭（浮层锚定旧 model 的行号，留着会错位）
  React.useEffect(() => {
    closeBpWidget()
  }, [active, contentPath])

  // 编辑浮层的目标断点被删除（如 agent 清理埋点/用户在面板删除）→ 浮层自动关闭
  React.useEffect(() => {
    const held = bpWidgetRef.current
    if (!held) return
    const entry = (dapStore.bpMapOf(scope)[held.path] ?? []).some((it) => it.line === held.line)
    if (!entry) closeBpWidget()
  }, [scope, dapSnap.bpVersion])

  // 编辑器卸载时移除浮层（content widget 不随 React 树回收）
  React.useEffect(() => () => closeBpWidget(), [])

  // 调试停帧行：paused 且首帧属于当前文件时高亮该行；继续/停止/切走自动清除
  React.useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    const top = dapSnap.topFrame
    const hit = top && top.file && sameFile(top.file, active)
    setPausedLine(ed, hit ? top.line : null)
  }, [dapSnap.phase, dapSnap.topFrame, active, contentPath, sameFile])

  /**
   * 跳转落地后给目标区域挂临时高亮（默认 1.2s 后自动清除）。
   *
   * 为什么自绘：原生 `_openReference` 跳转后会挂 `symbolHighlight` 装饰并在 350ms 后清除，
   * 但本插件用 registerEditorOpener 接管了打开动作（自行派发 edrv:open-editor），
   * 原生那段续作不会执行 → 跳转后没有任何目标提示。这里补上同等语义的高亮。
   * 装饰 id 独立保存，与差异渲染（diffRender）和 Ctrl+hover 下划线（underline）互不干扰；
   * 连续跳转先替换旧装饰，避免叠加残留。
   * @author ddj 2026年09月17号
   * @param ed Monaco 编辑器
   * @param target 目标位置 { line, column, endLine?, endColumn? }（均 1-based）
   */
  const flashNavTarget = (ed, target) => {
    const model = ed?.getModel?.()
    if (!model || !target) return
    const range = navFlashRangeOf(model, target)
    if (!range) return
    if (navFlashTimerRef.current) { clearTimeout(navFlashTimerRef.current); navFlashTimerRef.current = null }
    navFlashRef.current = ed.deltaDecorations(navFlashRef.current, [{
      range,
      options: { className: 'edrv-nav-target', isWholeLine: false },
    }])
    navFlashTimerRef.current = setTimeout(() => {
      navFlashTimerRef.current = null
      const current = editorRef.current
      navFlashRef.current = current ? current.deltaDecorations(navFlashRef.current, []) : []
    }, NAV_FLASH_MS)
  }

  // 打开文件后的跳转（导航历史恢复/差异聚焦/搜索与 LSP 行列跳转，目标内容就绪后执行一次）
  //
  // ⚠️ 依赖必须含 monaco：contentReady 在**文本到达**时即为真，可能早于 Monaco 就绪；
  // 那一帧 editorRef.current 仍是 null → 本 effect 提前返回并保留 pendingFocus，随后
  // Monaco 载入、ensureEditor 建好编辑器，若 effect 不因 monaco 变化重跑，pendingFocus
  // 就永久滞留 —— 观感是「首次跳转只打开文件不定位，手动再触发一次才落到目标行」
  // （实测复现：Monaco 未就绪时派发 line=500，首次停在 1:1，二次触发才到 500）。
  // ⚠️ 依赖也必须含 mdPreviewing：预览态切换会替换 Monaco host 并**重建**编辑器实例，
  // 而 active/content 都没变；缺此依赖同样不重跑（同下方 model 同步 effect）。
  //
  // ⚠️ 门控必须用 contentReady（contentPath === active），不能用 `content === null`：
  // 跨文件跳转时切页签的那一帧 content 仍是**上一个文件**的内容（非 null），据此判定
  // 「已就绪」会提前定位；随后真实内容到达触发 model 重设/内容写入，Monaco 会重置光标，
  // 落点丢失且 pendingFocus 已消费，最终停在 {1,1}。实测（v0.4.6，Ctrl+点击枚举成员）：
  // opener 正确派发 line=349，落地后编辑器实际停在 1:1 且无高亮；同文件跳转不换内容故不复现。
  //
  // ⚠️ 第三次事故（2026-09-23 实测取证）：并行改码触发插件 client HMR 热重载
  // （保留 console 装配日志重复 6-7 轮为证）→ 本组件被重挂载 → 挂载级 pendingFocusRef
  // 随旧实例销毁 → 「首开只打开文件不落行、热重载平息后第二次才正常」。
  // 修复：openFileAt 同步写 window.__edrvPendingNav__ 槽（跨热重载存活），本 effect 取
  // ref || 槽、成功落点后一并清；并加模型身份守卫（模型不是目标文件时不清、等重跑）。
  React.useEffect(() => {
    const ed = editorRef.current
    if (!ed || !contentReady) return
    // 导航历史恢复优先：viewState 快照恢复滚动/折叠，行列补定位
    const nav = navPendingRef.current
    if (nav && sameFile(nav.path, active)) {
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
    // 快路径 = 挂载级 ref；交接路径 = window 槽（热重载重挂载后 ref 已丢、槽仍在）
    const refPf = pendingFocusRef.current
    const slotNav = refPf ? null : readPendingNav()
    const pf = refPf || (slotNav
      ? { path: slotNav.path, region: null, line: slotNav.line ?? null, column: slotNav.column ?? 1, endLine: slotNav.endLine ?? null, endColumn: slotNav.endColumn ?? null }
      : null)
    if (!pf || !sameFile(pf.path, active)) return
    // 单一清除点：ref 与 window 槽一并处理，防残留二次跳
    const dropPending = () => {
      pendingFocusRef.current = null
      if (pf.line != null) clearPendingNav()
    }
    // 模型身份守卫：编辑器模型必须已是目标文件才落点；不匹配则保留 pending（不清），
    // 依赖变化后的下一次运行再落（model 同步 effect 声明在本 effect 之前、同帧先执行）。
    if (pf.line != null) {
      if (!sameFile(modelPathOf(ed), pf.path)) return
      // 搜索命中 / LSP 跳转：直接定位到行/列（不依赖差异区域）并高亮目标区域
      dropPending()
      const line = Math.max(1, pf.line)
      const column = Math.max(1, pf.column ?? 1)
      ed.revealLineInCenter(line)
      ed.setPosition({ lineNumber: line, column })
      flashNavTarget(ed, { line, column, endLine: pf.endLine, endColumn: pf.endColumn })
      ed.focus()
      return
    }
    const target = pf.region || pendingRegions[0]
    if (!target) return
    if (!sameFile(modelPathOf(ed), pf.path)) return
    dropPending()
    ed.revealLineInCenter(Math.max(1, target.start ?? 1))
    ed.setPosition({ lineNumber: Math.max(1, target.start ?? 1), column: 1 })
    ed.focus()
  }, [active, content, contentReady, pendingRegions, focusRequest, monaco, mdPreviewing, svnDiff])

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
    const i = sum.pendingFiles.findIndex((f) => sameFile(f.path, active))
    if (i >= 0) { if (i !== fileIdx) setFileIdx(i) }
  }, [sum.pendingFiles, active, sameFile])

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
    if (sum.pendingFiles.some((file) => sameFile(file.path, active))) gotoFile(1)
    else openFile(sum.pendingFiles[0].path, true)
  }

  /**
   * 重新从磁盘加载当前文件（工具栏 ⟳ / 冲突提示「重新加载」/ 差异决策后刷新）。
   * 一律强制重读（跳过 model 复用）：这才是「用户要看到磁盘真实内容」的语义。
   * @author ddj 2026年09月15号
   * @param skipStale 差异记录刷新是否跳过 stale 清理
   */
  const reloadFile = (skipStale) => {
    if (!active) return
    const path = active
    loadContent(path, sessionId, true)
    clearSync(scope, path)
    setDiskFlag((prev) => (prev && prev.path === path ? null : prev))
    refreshRecords(skipStale === true)
  }

  /**
   * 冲突处理：用编辑器内容覆盖磁盘（在缓冲内容为权威时用户显式选择）。
   * 覆盖不带版本令牌（host 无条件写入），成功后以返回的新版本重记基线。
   * @author ddj 2026年09月15号
   */
  const overwriteDisk = () => {
    const path = diskFlag?.path
    const model = path ? modelsRef.current.get(path) : null
    if (!path || !model) { setStatus('无法覆盖：文件未打开'); return }
    rpc('edrv.save', { sessionId, path, content: model.getValue() }).then((res) => {
      if (res && res.ok) {
        if (res.rev) revRef.current[path] = res.rev
        recordBaseline(scope, path, res.rev)
        markReadVersion(scope, path, res.rev, true) // 缓冲即磁盘内容：同版本无需再读盘
        clearSync(scope, path)
        setDirtyMap((d) => Object.assign({}, d, { [path]: false }))
        setDiskFlag((prev) => (prev && prev.path === path ? null : prev))
        setStatus('已覆盖磁盘')
        emitRefresh()
        return
      }
      setStatus('覆盖失败')
      setError(res?.error ? String(res.error) : '覆盖失败')
    }).catch((e) => setError('覆盖异常:' + String(e)))
  }

  /**
   * 冲突处理：保留本地编辑（关掉提示），磁盘内容不取用。
   * 基线推进到磁盘当前版本，避免同一外部改动被反复提示；缓冲仍标脏，
   * 之后的手工保存会被版本守卫拒绝并再次给出选择。
   * @author ddj 2026年09月15号
   */
  const keepLocal = () => {
    const path = diskFlag?.path
    if (!path) return
    rpc('edrv.versions', { sessionId, paths: [path] }).then((res) => {
      const item = res && res.ok && Array.isArray(res.items) ? res.items[0] : null
      if (item && item.version) {
        recordBaseline(scope, path, item.version)
        // 该版本已判定为「与缓冲不同」：记入已读台账，避免下一轮轮询再读一次并重复弹提示
        markReadVersion(scope, path, item.version, false)
        revRef.current[path] = item.version
      }
      clearSync(scope, path)
      setDiskFlag((prev) => (prev && prev.path === path ? null : prev))
      setStatus('已保留本地编辑（磁盘内容未取用）')
    }).catch(() => {
      clearSync(scope, path)
      setDiskFlag(null)
    })
  }

  /**
   * SVG 在图片预览与文本编辑间切换（按路径记忆；重载分派随集合状态自动路由）。
   * @author ddj 2026年09月08号
   * @param path SVG 文件路径
   */
  const toggleSvgText = (path) => {
    const next = new Set(svgTextRef.current)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    svgTextRef.current = next
    setContent(null)
    setContentPath(null)
    setImageSrc(null)
    setImgSize(null)
    setImgBroken(false)
    setLoadError(null)
    setStatus(next.has(path) ? '已切换为文本模式' : '已切换为图片预览')
    loadContent(path, sessionId, true)
  }

  /**
   * Markdown 在源码编辑与预览之间切换（按路径记忆，不持久化）。
   *
   * ⚠️ 进入预览前必须 flushSave()：预览态会替换 Monaco host，切回时编辑器实例是新建的；
   * 若此刻还有未到期的 700ms 防抖保存，定时器到点时 editorRef.current 已被清空
   * （见 EditorView 卸载清理），doSave 会静默 return —— 用户改动永不落盘。
   * 同时保存视图状态，保证切回源码后光标/滚动位置不丢。
   * @author ddj 2026年09月18号
   * @param path Markdown 文件路径
   */
  /** @private @author ddj 2026年10月08号 @param path Markdown disk path. @param preview Desired mode; explicit line opens always select source. */
  function setMdPreview(path, preview) {
    if (!isMarkdownPath(path) || mdPreviewRef.current.has(path) === preview) return
    toggleMdPreview(path)
  }
  /** @private @author ddj 2026年10月08号 @param path Markdown file. Toggle preview after flushing the active file's save and view state. */
  const toggleMdPreview = (path) => {
    if (!path) return
    const next = new Set(mdPreviewRef.current)
    const entering = !next.has(path)
    if (entering) {
      flushSave()
      saveViewState(active)
      next.add(path)
    } else {
      next.delete(path)
    }
    mdPreviewRef.current = next
    // 预览态按作用域落 localStorage（镜像层写穿 host）：刷新/重启后仍以预览打开
    mdPreviewSave(String(scope), next)
    setStatus(entering ? '已切换为 Markdown 预览' : '已切换为源码编辑')
  }
  toggleMdPreviewRef.current = toggleMdPreview

  /** 当前图片的会话+路径级缩放记忆键（页签切换回来保留同一缩放）。 */
  const imgZoomKey = zoomKeyOf(sessionId, active)

  // 页签/会话切换时恢复该图片的记忆缩放（无记忆 = 初始适应宽度，等价 PDF page-width）
  React.useEffect(() => { setImgZoom(recallZoom(imgZoomKey)) }, [imgZoomKey])

  /**
   * 应用图片缩放并写入页签记忆（null = 适应宽度；数值经 clampZoom 收敛 25%–400%）。
   * @author ddj 2026年09月22号
   * @param next 目标缩放（null = 适应宽度）
   */
  const applyImgZoom = (next) => {
    const value = next === null ? null : clampZoom(next)
    setImgZoom(value)
    rememberZoom(imgZoomKey, value)
  }

  /**
   * 图片缩放步进（10%/档，clamp 25%–400%）；适应宽度态先按渲染尺寸实测当前缩放作基准。
   * @author ddj 2026年09月22号
   * @param dir 方向：1 放大 / -1 缩小
   */
  const stepImgZoom = (dir) => {
    const el = imgElRef.current
    const measured = el && el.naturalWidth ? el.clientWidth / el.naturalWidth : 1
    applyImgZoom(zoomStepOf(imgZoom ?? measured, dir))
  }

  /**
   * Preserve image UI behavior while attributing decoder failure to its rendered load.
   * @private @author ddj 2026年09月28号
   */
  function imageFailed() {
    if (!receiptLoad || !loadCurrent(receiptLoad.path, receiptLoad.sequence)) return
    setImgBroken(true)
    renderLoadFail(receiptLoad.path, receiptLoad.sessionId, receiptLoad.sequence, '图片解码失败')
  }

  /**
   * 图片预览面板：工具条（尺寸 meta / 缩放 −＋适应宽度 / SVG 文本切换 / 刷新）+ 棋盘底图片。
   * 初始适应宽度（等价 PDF page-width，0.1.7 官方统一缩放）；按钮样式与 PDF 工具条同款。
   * @author ddj 2026年09月08号 / 2026年09月22号
   */
  const imagePanel = () => React.createElement('div', { className: 'edrv-imgview' },
    React.createElement('div', { className: 'edrv-imgview-bar' },
      React.createElement('span', { className: 'edrv-imgview-meta' },
        imgBroken ? '图片无法显示' : (imgSize ? imgSize.w + '×' + imgSize.h : '…')),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('span', { className: 'edrv-pdf-page' },
        imgZoom === null ? '适应' : Math.round(imgZoom * 100) + '%'),
      React.createElement('button', {
        className: 'edrv-pill edrv-pill-ghost edrv-pdf-zoom', title: '缩小（10%/档）',
        onClick: () => stepImgZoom(-1),
      }, '−'),
      React.createElement('button', {
        className: 'edrv-pill edrv-pill-ghost edrv-pdf-zoom', title: '放大（10%/档）',
        onClick: () => stepImgZoom(1),
      }, '＋'),
      React.createElement('button', {
        className: 'edrv-pill edrv-pill-ghost', title: '恢复适应宽度',
        disabled: imgZoom === null, onClick: () => applyImgZoom(null),
      }, '适应宽度'),
      (isSvgPath(active) ? React.createElement('button', {
        className: 'edrv-pill edrv-pill-ghost', title: '以文本方式查看/编辑（SVG 为文本格式）',
        onClick: () => toggleSvgText(active),
      }, '以文本打开') : null),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '重新加载图片', onClick: () => reloadFile() }, '⟳ 刷新')),
    React.createElement('div', { className: 'edrv-imgview-stage' },
      (imgBroken
        ? React.createElement('div', { className: 'edrv-imgview-broken' },
            React.createElement('div', null, '图片解码失败，文件可能已损坏'),
            React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', onClick: () => reloadFile() }, '重试'))
        : React.createElement('img', {
            className: 'edrv-imgview-img',
            ref: imgElRef,
            key: active + ':' + (receiptLoad?.sequence ?? 0),
            src: imageSrc,
            alt: active || '',
            style: (imgZoom !== null && imgSize)
              ? { width: Math.round(imgSize.w * imgZoom) + 'px', maxWidth: 'none', maxHeight: 'none' }
              : undefined,
            onLoad: (e) => { setImgBroken(false); setImgSize({ w: e.target.naturalWidth, h: e.target.naturalHeight }) },
            onError: imageFailed,
          }))))

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
    // #region debug log
    const trace = isDebug()
    const start = trace ? performance.now() : 0
    const traceId = trace ? `${Date.now()}-${Math.floor(Math.random() * 1000)}` : ''
    if (trace) {
      try { dbg(sessionId, `[DEBUG diffAction] stage=start trace=${traceId} method=${method} scope=${region.create ? 'call' : 'hunk'}`) } catch (e) { /* 诊断不可影响决策 */ }
    }
    // #endregion
    return rpc(method, { sessionId, callId: region.callId, scope: region.create ? 'call' : 'hunk', hunkIndex: region.idx }).then((res) => {
      // #region debug log
      if (trace) {
        try { dbg(sessionId, `[DEBUG diffAction] stage=reply trace=${traceId} method=${method} ok=${res?.ok === true} rpcMs=${(performance.now() - start).toFixed(1)}`) } catch (e) { /* 诊断不可影响决策 */ }
      }
      // #endregion
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
   * @returns Promise<{ok:number; fail:number; stale:number}> 成功/失败/已不存在计数
   */
  const actMany = (items) => {
    if (!items.length) return Promise.resolve({ ok: 0, fail: 0, stale: 0 })
    // #region debug log
    const trace = isDebug()
    const start = trace ? performance.now() : 0
    const rejected = trace ? items.filter((item) => item.decision === 'rejected').length : 0
    const traceId = trace ? `${Date.now()}-${Math.floor(Math.random() * 1000)}` : ''
    if (trace) {
      try { dbg(sessionId, `[DEBUG diffAction] stage=start trace=${traceId} method=decideBatch items=${items.length} rejected=${rejected}`) } catch (e) { /* 诊断不可影响决策 */ }
    }
    // #endregion
    return rpc('edrv.decideBatch', { sessionId, items }).then((res) => {
      // #region debug log
      if (trace) {
        try { dbg(sessionId, `[DEBUG diffAction] stage=reply trace=${traceId} method=decideBatch items=${items.length} rpcMs=${(performance.now() - start).toFixed(1)} ok=${res?.ok === true}`) } catch (e) { /* 诊断不可影响决策 */ }
      }
      // #endregion
      if (!res || !res.ok || !Array.isArray(res.results)) {
        setError(res?.error ? String(res.error) : '批量处理失败')
        return { ok: 0, fail: items.length, stale: 0 }
      }
      let ok = 0
      let fail = 0
      let stale = 0
      const next = {}
      for (const item of res.results) {
        if (item && item.ok) {
          ok++
          if (item.stale === true) stale++
          if (item.record) next[item.callId] = item.record
        } else {
          fail++
        }
      }
      // 合并结果无变化（批量全部失败/重复点击）时不 setRecords：避免 records 换引用
      // → pendingRegions 换引用 → diff 全量重渲染（内容相同，纯空转）
      if (Object.keys(next).length) setRecords((prev) => Object.assign({}, prev, next))
      return { ok, fail, stale }
    }).catch((e) => {
      setError('批量处理异常:' + String(e))
      return { ok: 0, fail: items.length, stale: 0 }
    })
  }

  /**
   * 批量决策状态文案（含"差异已不存在于文件"提示）。
   * @author ddj 2026年09月15号
   * @param prefix 动作前缀（已采纳/已不采纳）
   * @param result 批量决策计数
   * @returns 状态栏文案
   */
  const decideStatus = (prefix, result) => {
    const text = prefix + result.ok + ' 处差异' + (result.fail ? '，' + result.fail + ' 处失败' : '')
    return result.stale ? text + '（其中 ' + result.stale + ' 处已不存在于文件，未改动）' : text
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
    if (batchBusyRef.current || !decideRegions.length) return
    batchBusyRef.current = true
    actMany(decideRegions.map((r) => itemOf(r, false))).then((result) => {
      batchBusyRef.current = false
      reloadFile(true)
      emitRefresh()
      setStatus(decideStatus('已采纳 ', result))
      if (result.fail) setError(result.fail + ' 处差异处理失败（可能已被后续修改影响），可刷新后重试')
    }).catch(() => { batchBusyRef.current = false })
  }
  const undoFile = () => {
    if (batchBusyRef.current || !decideRegions.length) return
    batchBusyRef.current = true
    actMany([...decideRegions].reverse().map((r) => itemOf(r, true))).then((result) => {
      batchBusyRef.current = false
      reloadFile(true)
      emitRefresh()
      setStatus(decideStatus('已不采纳 ', result))
      if (result.fail) setError(result.fail + ' 处差异处理失败（可能已被后续修改影响），可刷新后重试')
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
    actMany(list.map((r) => itemOf(r, reject))).then((result) => {
      batchBusyRef.current = false
      reloadFile(true)
      emitRefresh()
      setStatus(decideStatus(reject ? '已不采纳 ' : '已采纳 ', result))
      if (result.fail) setError(result.fail + ' 处差异处理失败（可能已被后续修改影响），可刷新后重试')
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

  /** 添加文件/选中区引用到对话（异步，状态栏反馈；状态文案走共享 statusOfAdd）。 */
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
  /**
   * 四入口共用的更新窗口：仅显式点击触发，不在背景静默更新。
   * @author ddj 2026年09月24号
   * @param relPath 工作区相对目标；空串代表根
   */
  const runSvnUpdate = (relPath) => {
    closeCommandPalette()
    setSvnUpdateReturn(null)
    setRecentUpdate(null)
    setSvnUpdateDialog({ path: relPath ?? '', sessionId, scope })
  }
  /** 强制重查 SVN 变更清单（命令栏「SVN 刷新变更」）。 */
  const runSvnReload = () => {
    refreshSvnChanges(sessionId, scope)
    setStatus('已刷新 SVN 变更')
  }

  /**
   * 打开基线差异视图（BASE 左 / 工作区右，只读）。
   * 编辑区右上差异视图以活动文件为语义：无活动文件直接提示，不猜目标。
   * @author ddj 2026年09月16号
   * @param relPath 目标工作区相对路径
   */
  const runSvnDiffBase = (relPath) => {
    if (!relPath) { setStatus('无活动文件'); return }
    setStatus('读取基线…')
    void svnDiffBase(sessionId, relPath).then((outcome) => {
      if (!outcome.ok) { setStatus(outcome.message); return }
      setSvnDiff({
        path: relPath,
        base: outcome.base,
        working: outcome.working,
        reason: outcome.reason,
        message: outcome.base === null ? '' : outcome.message,
        leftLabel: 'BASE',
        rightLabel: '工作区',
        scheme: 'edrv-svn-base',
        binary: outcome.binary === true,
        encodingHint: outcome.encodingHint === true,
      })
      setStatus(outcome.message)
    })
  }

  /**
   * 打开某版本的差异视图（REV-1 ↔ REV 只读并排）。
   * 左侧缺失（该版本尚无此文件 = 新增）属正常语义，不改文案为错误。
   * @author ddj 2026年09月16号
   * @param relPath 目标工作区相对路径
   * @param revision 目标版本
   * @param logTarget 来自日志弹窗时的日志目标（不传 = 非日志入口）
   */
  const runSvnDiffRev = (relPath, revision, logTarget) => {
    if (!relPath) { setStatus('无目标文件'); return }
    setStatus('读取 r' + revision + ' 差异…')
    void svnDiffRev(sessionId, relPath, revision).then((outcome) => {
      if (!outcome.ok) { setStatus('读取版本差异失败：' + (outcome.error ?? '未知错误')); return }
      const isAdd = outcome.left === null
      setSvnDiff({
        path: relPath,
        base: outcome.left,
        working: outcome.right,
        reason: outcome.reason,
        message: isAdd ? '该版本新增此文件（无上一版可比）' : '',
        leftLabel: 'r' + Math.max(1, revision - 1),
        rightLabel: 'r' + revision,
        scheme: 'edrv-svn-rev' + revision,
        binary: outcome.binary === true,
        encodingHint: outcome.encodingHint === true,
        logTarget,
      })
      setStatus('已打开 r' + revision + ' 差异')
    })
  }

  /**
   * 打开两个版本的差异视图（P1-2 比较两个修订；左右标签按传入顺序，不自动排序）。
   * 左右任一侧缺失（新增/删除）属正常语义，渲染为空而非报错。
   * @author ddj 2026年09月17号
   * @param relPath 目标工作区相对路径
   * @param revA 左侧版本（选中顺序在前）
   * @param revB 右侧版本（选中顺序在后）
   * @param logTarget 来自日志弹窗时的日志目标（不传 = 非日志入口）
   */
  const runSvnDiffPair = (relPath, revA, revB, logTarget) => {
    if (!relPath) { setStatus('仅文件目标支持比较两个修订'); return }
    setStatus('读取 r' + revA + ' ↔ r' + revB + ' 差异…')
    void svnDiffPair(sessionId, relPath, revA, revB).then((outcome) => {
      if (!outcome.ok) { setStatus('读取版本差异失败：' + (outcome.error ?? '未知错误')); return }
      const notes = []
      if (outcome.left === null) notes.push('r' + revA + ' 无此文件')
      if (outcome.right === null) notes.push('r' + revB + ' 无此文件')
      setSvnDiff({
        path: relPath,
        base: outcome.left,
        working: outcome.right,
        reason: outcome.reason,
        message: notes.join('；'),
        leftLabel: 'r' + revA,
        rightLabel: 'r' + revB,
        scheme: 'edrv-svn-pair-' + revA + '-' + revB,
        binary: outcome.binary === true,
        encodingHint: outcome.encodingHint === true,
        logTarget,
      })
      setStatus('已打开 r' + revA + ' ↔ r' + revB + ' 差异')
    })
  }

  /**
   * 打开「某版本 ↔ 工作副本」差异视图（P1-1 Compare with working copy，只读并排）。
   * 左侧缺失（该版本尚无此文件）属正常语义，渲染为空而非报错。
   * @author ddj 2026年09月17号
   * @param relPath 目标工作区相对路径
   * @param revision 左侧版本
   * @param logTarget 来自日志弹窗时的日志目标（不传 = 非日志入口）
   * @param onOpened 差异视图成功打开后触发（更新结果返回用）
   */
  const runSvnDiffWorking = (relPath, revision, logTarget, onOpened) => {
    if (!relPath) { setStatus('仅文件目标支持与工作副本比较'); return }
    setStatus('读取 r' + revision + ' ↔ 工作副本 差异…')
    void svnDiffWorking(sessionId, relPath, revision).then((outcome) => {
      if (!outcome.ok) { setStatus('读取工作副本差异失败：' + (outcome.error ?? '未知错误')); return }
      setSvnDiff({
        path: relPath,
        base: outcome.left,
        working: outcome.right,
        reason: outcome.reason,
        message: outcome.left === null ? '该版本尚无此文件（右侧为工作副本内容）' : '',
        leftLabel: 'r' + revision,
        rightLabel: '工作区',
        scheme: 'edrv-svn-work-' + revision,
        binary: outcome.binary === true,
        encodingHint: outcome.encodingHint === true,
        logTarget,
      })
      setStatus('已打开 r' + revision + ' ↔ 工作副本 差异')
      onOpened?.()
    })
  }

  /**
   * 打开双侧本地文件差异（W2-4 冲突副本 `.rN` ↔ `.mine`，只读并排；resolve 由用户自行执行）。
   * @author ddj 2026年09月20号
   * @param left 左侧工作区相对路径
   * @param right 右侧工作区相对路径
   * @param leftLabel 左侧标签（如 `.r293524`）
   * @param rightLabel 右侧标签（如 `.mine`）
   * @param title 标题（冲突文件路径）
   */
  const runSvnDiffLocalPair = (left, right, leftLabel, rightLabel, title) => {
    setStatus('读取冲突副本差异…')
    void svnDiffLocalPair(sessionId, left, right).then((outcome) => {
      if (!outcome.ok) { setStatus(outcome.message); return }
      setSvnDiff({
        path: title,
        base: outcome.leftText ?? null,
        working: outcome.rightText ?? '',
        message: '解决后执行 svn resolve --accept working（本插件不自动执行）',
        leftLabel,
        rightLabel,
        scheme: 'edrv-svn-local',
        binary: outcome.binary === true,
        encodingHint: outcome.encodingHint === true,
      })
      setStatus('已打开冲突副本对比')
    })
  }

  /**
   * 打开日志弹窗（P3）：加载该目标的提交历史。
   * @author ddj 2026年09月16号
   * @param relPath 目标相对路径（缺省 = 工作区根）
   */
  const openSvnLog = (relPath) => {
    const target = relPath || ''
    dshTrace('svnLog.open', { target, scope, hasSession: Boolean(sessionId) })
    setSvnLog({ target, limit: SVN_LOG_PAGE })
    setSvnLogData(getSvnLog(scope, target, SVN_LOG_PAGE))
    setSvnLogError('')
    setSvnLogBusy(true)
    ensureSvnLog(sessionId, scope, target, SVN_LOG_PAGE)
  }

  /**
   * 从日志弹窗打开的差异视图返回日志：按打开时记录的日志目标重开弹窗。
   * 日志数据走 scope 缓存（openSvnLog → ensureSvnLog 命中即不重查）；选中项不复原。
   * @author ddj 2026年09月18号
   */
  const backToSvnLog = () => {
    const target = svnDiff?.logTarget ?? ''
    setSvnDiff(null)
    openSvnLog(target)
  }

  /** 加入版本控制（活动文件；未纳入版本控制的文件才有意义，host 侧会再校验）。 */
  const runSvnAdd = (relPath) => {
    if (!relPath) { setStatus('无活动文件'); return }
    void svnAdd(sessionId, [relPath]).then((o) => {
      setStatus(o.message)
      refreshSvnChanges(sessionId, scope)
    })
  }

  /** 还原（活动文件，CLI）：confirm 守卫，避免误触丢弃本地改动。 */
  const runSvnRevertCli = (relPath) => {
    if (!relPath) { setStatus('无活动文件'); return }
    if (!window.confirm('确认还原「' + relPath + '」的本地改动？新增（A）文件在磁盘上会保留，仅取消登记。')) return
    void svnRevert(sessionId, [relPath]).then((o) => {
      setStatus(o.message)
      refreshSvnChanges(sessionId, scope)
      // 当前打开的文件被还原：重载磁盘内容，避免编辑器仍显示已丢弃的改动
      if (o.ok && activeRef.current === relPath) reloadFile()
    })
  }

  /** TortoiseSVN 动作（Windows）：需要文件/目录目标（编辑区右键无活动文件时提示）。 */
  const runSvnTortoise = (action: SvnAction, relPath) => {
    if (!relPath) { setStatus('无活动文件'); return }
    void svnTortoise(sessionId, action, relPath).then((o) => setStatus(o.message))
  }

  // 渲染期镜像（赋值在被引用 const 定义之后，防 TDZ）：Monaco addAction 空依赖回调读取最新动作与 svn 状态
  svnStatusRef.current = svnStatus
  menuHandlersRef.current = {
    addRefToChat,
    openInExplorer,
    svnUpdate: runSvnUpdate,
    svnDiffBase: runSvnDiffBase,
    svnAdd: runSvnAdd,
    svnRevertCli: runSvnRevertCli,
    svnTortoise: runSvnTortoise,
  }

  /**
   * 复制文本到剪贴板（状态栏反馈；浏览器拒绝时提示，不抛异常）。
   * 剪贴板写入与降级文案收敛到 client/copyText.ts（文件树菜单同源共用）。
   * @author ddj 2026年09月11号 / 2026年09月22号
   * @param text 待复制文本
   * @param okText 成功文案
   */
  const copyText = (text, okText) => {
    const value = String(text ?? '')
    if (!value) { setStatus('无可复制内容'); return }
    void copyClipText(value, okText + '：' + value, setStatus)
  }

  /**
   * 在资源管理器视图中显示：展开侧栏文件树到目标文件并高亮。
   * 工作区外文件（片段/全局规则）无树节点，判定为不可定位并给出提示。
   * @author ddj 2026年09月11号
   * @param path 工作区相对路径
   */
  const revealTabInView = (path) => {
    if (!isTreeRevealable(path)) { setStatus('该文件不在工作区内，无法在资源管理器中定位'); return }
    setSidebarOn(true)
    setActivePanel('explorer')
    // 面板可能刚展开（FileExplorer 尚未挂载），故用窗口事件而非直接调用
    window.dispatchEvent(new CustomEvent('edrv:reveal-path', { detail: { path } }))
    setStatus('已在资源管理器中定位：' + baseNameOf(path))
  }

  /**
   * 切换页签固定态（固定页签整体前移；固定后隐藏 ×，仅可经菜单取消固定）。
   * @author ddj 2026年09月11号
   * @param path 目标页签路径
   */
  const toggleTabPin = (path) => {
    const target = tabsRef.current.find((t) => t.path === path)
    if (!target) return
    setTabs((prev) => togglePin(prev, path))
    setStatus(target.pinned ? '已取消固定：' + baseNameOf(path) : '已固定：' + baseNameOf(path))
  }

  /** 关闭当前活动页签（Ctrl+F4 与菜单动作共用；无页签时提示）。 */
  const closeActiveTab = () => {
    if (planActiveRef.current) { closePlan(planActiveRef.current); return }
    if (!activeRef.current) { setStatus('无打开的文件'); return }
    closeTab(activeRef.current)
  }

  /**
   * 页签菜单的 SVN 动作分派（由 shared 动作目录生成，与树菜单/命令栏共用执行器与显隐规则）。
   * @author ddj 2026年09月16号
   * @param path 右键目标页签路径
   * @returns id → 动作
   */
  const svnTabActions = (path) => {
    const out = {}
    for (const action of svnActionsFor('tab')) {
      out['svn-' + action.id] = () => runSvnAction(action, {
        sessionId,
        scope,
        path,
        openSvnUpdate: (p) => runSvnUpdate(p),
        notify: (message) => setStatus(message),
        openSvnDiff: (p) => runSvnDiffBase(p),
        openSvnLocalPair: runSvnDiffLocalPair,
        openSvnLog: (p) => openSvnLog(p ?? path),
        refreshChanges: () => refreshSvnChanges(sessionId, scope),
      })
    }
    return out
  }

  /**
   * 页签右键菜单动作表（按菜单条目 id 分派；全部读 ref 取最新状态，防陈旧闭包）。
   * @author ddj 2026年09月11号
   * @param path 右键目标页签路径
   * @returns id → 动作
   */
  const tabMenuActions = (path) => ({
    'add-to-conversation': () => addRefToChat(path),
    close: () => closeTab(path),
    'close-others': () => closeTabs(closeOthers(tabsRef.current, path, activeRef.current), '已关闭其他页签'),
    'close-right': () => closeTabs(closeRight(tabsRef.current, path, activeRef.current), '已关闭右侧页签'),
    'close-saved': () => closeTabs(closeSaved(tabsRef.current, dirtyRef.current, activeRef.current), '已关闭已保存页签'),
    'close-all': () => closeTabs(closeAll(tabsRef.current, activeRef.current), '已关闭全部页签'),
    'copy-path': () => copyText(absoluteOf(path, cwd), '已复制路径'),
    'copy-relative-path': () => copyText(relativeOf(path, cwd), '已复制相对路径'),
    'reveal-in-os': () => openInExplorer(path),
    'reveal-in-view': () => revealTabInView(path),
    'toggle-pinned': () => toggleTabPin(path),
    ...svnTabActions(path),
  })

  /**
   * 构建页签右键菜单条目（数据来自 tabMenu 纯函数；此处只注入键位与可用性快照）。
   * @author ddj 2026年09月11号
   * @returns ContextMenu 的 entries
   */
  const tabMenuEntries = () => {
    if (!tabMenu) return []
    const actions = tabMenuActions(tabMenu.path)
    const changeMap = svnChangeMapOf(scope)
    return buildTabMenu({
      path: tabMenu.path,
      tabs: tabsRef.current,
      active: activeRef.current,
      dirty: dirtyRef.current,
      cwd,
      hasSession: Boolean(sessionId),
      canAddToConversation: Boolean(addToConversation),
      svnReady: Boolean(svnStatus?.managed && svnStatus?.svnCli),
      tortoiseReady: Boolean(svnStatus?.managed && svnStatus?.tortoise),
      // 自研替换时间线：自研就绪的能力对应 Tortoise 项不出现
      svnFeatures: svnStatus?.svnFeatures,
      // 目标文件的 SVN 状态：CLI 三项（比较/加入/还原）按它显隐
      svnStatusOfTarget: changeMap[tabMenu.path]?.status,
      closeChord: chordOf('edrv.closeTab'),
    }).map((entry) => Object.assign({}, entry, { onClick: actions[entry.id] }))
  }

  /**
   * 在光标处按片段语法展开插入（Monaco 原生 snippet 控制器解析 ${1:占位} 与 $TM_* 变量）。
   * @author ddj 2026年09月10号
   * @param entry 片段条目
   */
  const insertSnippetAtCursor = (entry) => {
    const ed = editorRef.current
    if (!ed || !entry) { setStatus('无活动编辑器'); return }
    try {
      ed.focus()
      const controller = ed.getContribution?.('snippetController2')
      if (controller?.insert) controller.insert(String(entry.body ?? ''))
      else ed.executeEdits('edrv-snippet', [{ range: ed.getSelection(), text: String(entry.body ?? '') }])
      setStatus('已插入代码片段：' + (entry.prefix || entry.key))
    } catch (error) {
      setStatus('插入代码片段失败')
      setError('插入代码片段失败：' + String(error))
    }
  }

  const openFile = (path, focusDiff) => {
    if (!path) return
    // 原生打开范围（nativeOpenExts 设置）：命中且非差异跳转 → 走官方渲染器
    //（focusDiff=true 跳过：差异审查对象必为本插件编辑的文本文件，审查优先）；
    // handler 缺失/失败（旧版无 openResource / seat 未挂）→ 回退现状页签打开，不阻断
    if (!focusDiff && inNativePath(path) && tryNativeOpen(path)) return
    // 打开文件即离开基线差异审阅态（差异视图是「当前文件」的临时视图）
    setSvnDiff(null)
    recordNav()
    // G9：统一归一为页签规范形态（差异栏/启动器/树/命令栏等入口一致）
    const normalized = addTabNorm(path, true)
    if (focusDiff && normalized) pendingFocusRef.current = { path: normalized, region: null }
  }

  /**
   * 打开文件并跳转到指定行列（搜索面板命中 / LSP 定义与引用跳转）。
   * 落地后会把目标区域短暂高亮（见 flashNavTarget），便于在长文件中一眼看到落点。
   * @author ddj 2026年08月26号 / 2026年09月17号
   * @param path 文件路径
   * @param line 目标行（缺省仅打开不跳转）
   * @param column 目标列（缺省 1）
   * @param endLine 目标区间结束行（LSP 定义选区，可空 = 按单词/整行推定）
   * @param endColumn 目标区间结束列（可空）
   */
  const openFileAt = (path, line, column, endLine, endColumn) => {
    if (!path) return
    const tracePath = tabPathOf(path, cwd)
    dapTrace('open-file-at', { input: path, normalized: tracePath, line, cwd })
    recordNav()
    // G9：同 openFile，先归一再进页签，保证待跳转路径与 active 同形态
    const normalized = addTabNorm(path, true, false)
    if (!normalized) return
    stageFileAt(normalized, line, column, endLine, endColumn)
  }

  /**
   * Stage a normalized navigation target using the existing reload-safe handoff.
   * @private @author ddj 2026年09月28号
   * @param normalized Exact tab path.
   * @param line Optional line.
   * @param column Optional column.
   * @param endLine Optional range end line.
   * @param endColumn Optional range end column.
   */
  function stageFileAt(normalized, line, column, endLine, endColumn) {
    pendingFocusRef.current = { path: normalized, region: null, line: line ?? null, column: column ?? 1, endLine: endLine ?? null, endColumn: endColumn ?? null }
    putPendingNav({ path: normalized, line: line ?? null, column: column ?? 1, endLine: endLine ?? null, endColumn: endColumn ?? null })
    setFocusRequest((value) => value + 1)
  }

  /** @private @author ddj 2026年10月08号 @param plan Complete virtual document. Keeps virtual addresses out of all disk/save/LSP/SVN flows. */
  function openPlanDoc(plan) {
    const document = planDocument(plan?.address, plan)
    if (!document) return
    flushSave()
    saveViewState(active)
    setSvnDiff(null)
    setDiskActive(null)
    setPlanTabs((prev) => [...prev.filter((item) => item.address !== document.address), document].slice(-32))
    setPlanActive(document.address)
    setError(null)
    setStatus('计划预览 · 只读')
  }
  /** @private @author ddj 2026年10月08号 @param address Virtual tab. @param event Optional close click. Removes only in-memory plan content. */
  function closePlan(address, event) {
    event?.stopPropagation()
    setPlanTabs((prev) => prev.filter((item) => item.address !== address))
    if (planActiveRef.current === address) setActive(tabsRef.current[0]?.path ?? null)
  }
  /** @private @author ddj 2026年10月08号 @param request Claimed disk or virtual open. Flushes saves without replacing dirty models. */
  function openReceiptFile(request) {
    if (request.plan) { openPlanDoc(request.plan); return }
    if (!request.path) return
    let path = receiptTabPath(request.path, cwd)
    const existing = tabsRef.current.find((tab) => receiptPath(tab.path, cwd) === receiptPath(path, cwd))
    if (existing) path = existing.path
    flushSave()
    saveViewState(active)
    recordNav()
    setSvnDiff(null)
    const positioned = request.line != null || request.column != null
    if (positioned && mdPreviewRef.current.has(path)) toggleMdPreview(path)
    setError(null)
    if (monacoErr) setMonacoErr(null)
    addTab(path, true, positioned ? false : request.preview)
    if (positioned) stageFileAt(path, request.line ?? 1, request.column ?? 1)
    const moved = receiptLoad && receiptPath(receiptLoad.path, receiptLoad.cwd) !== receiptPath(path, cwd)
    if (path !== active || !(loadError || receiptLoad?.status === 'error' || moved)) return
    if (pdfCtlRef.current.get(path)?.isDirty?.()) return
    pdfB64CacheRef.current.delete(path)
    loadContent(path, sessionId, false)
  }

  /**
   * Build facts from the current render; model identity is the exact cached instance.
   * @private @author ddj 2026年09月28号
   * @param request Claimed target and optional position.
   * @returns State consumed by the tested receipt predicates.
   */
  function receiptView(request) {
    const ed = editorRef.current
    const model = ed?.getModel?.()
    const modelMatches = Boolean(model && modelsRef.current.get(active) === model)
    let positionMatches = false
    if (modelMatches && (request.line != null || request.column != null)) {
      const expected = model.validatePosition({ lineNumber: request.line ?? 1, column: request.column ?? 1 })
      const actual = ed.getPosition()
      positionMatches = actual?.lineNumber === expected.lineNumber && actual?.column === expected.column
    }
    const image = imgElRef.current
    return {
      sessionId, cwd, active, sequence: loadSeqRef.current, load: receiptLoad,
      mounted: Boolean(viewRootRef.current), blocked: Boolean(svnDiff),
      kind: isImageActive ? 'image' : isPdfActive ? 'pdf' : mdPreviewing ? 'markdown' : 'text',
      contentPath, contentReady, modelMatches, positionMatches,
      imageLoaded: Boolean(imageSrc && !imgBroken && image?.getAttribute('src') === imageSrc && image.complete && image.naturalWidth > 0),
      pdfLoaded: Boolean(pdfBytes && pdfHostRef.current?.querySelector('.page[data-loaded="true"]')),
      engineError: monacoErr ? String(monacoErr) : null,
    }
  }

  /** @private @author ddj 2026年09月28号 @param request Claimed target. @returns Correlated actual readiness. */
  function receiptReady(request) {
    if (request.plan) return request.sessionId === sessionId && planActive === request.plan.address
      && planTabs.some((item) => item.address === request.plan.address && item.markdown === request.plan.markdown)
      && planHostRef.current?.getAttribute('data-plan-address') === request.plan.address && !svnDiff
    return receiptReadyFor(request, receiptView(request))
  }
  /** @private @author ddj 2026年09月28号 @param request Claimed target. @returns Only its current load/render error. */
  function receiptError(request) {
    if (request.plan) return planDocument(request.plan.address, request.plan) ? null : '计划内容或资源地址无效'
    return receiptErrorFor(request, receiptView(request))
  }
  useOpenReceipt({ sessionId, open: openReceiptFile, ready: receiptReady, error: receiptError })

  // 停帧跳转/调试命令监听（openFileAt 每渲染重建，经 ref 让空依赖监听读最新闭包）
  const dapOpenRef = React.useRef(null)
  dapOpenRef.current = openFileAt
  React.useEffect(() => {
    const onStopped = (e) => {
      const detail = e?.detail
      dapTrace('debug-stopped', detail)
      if (!detail?.file) {
        // 适配器只给了 chunkname 且工作区未定位到源文件：明确告知，不留静默无反应
        setStatus('已暂停：未定位到源文件')
        return
      }
      dapOpenRef.current?.(detail.file, detail.line, 1)
    }
    const onToggle = () => {
      const ed = editorRef.current
      const path = modelPathOf(ed)
      const line = ed?.getPosition?.()?.lineNumber
      if (path && line) dapToggleRef.current?.(path, line)
      else setStatus('无活动文件，无法切换断点')
    }
    const onToggleEvt = () => onToggle()
    const onStart = () => dapStore.startOrContinue()
    const onStop = () => { void dapStore.stop() }
    const onStepOver = () => { void dapStore.action('next') }
    const onStepIn = () => { void dapStore.action('stepIn') }
    const onStepOut = () => { void dapStore.action('stepOut') }
    window.addEventListener('edrv:debug-stopped', onStopped)
    window.addEventListener('edrv.command.debugToggleBreakpoint', onToggleEvt)
    window.addEventListener('edrv.command.debugStartContinue', onStart)
    window.addEventListener('edrv.command.debugStepOver', onStepOver)
    window.addEventListener('edrv.command.debugStepInto', onStepIn)
    window.addEventListener('edrv.command.debugStepOut', onStepOut)
    window.addEventListener('edrv.command.debugStop', onStop)
    return () => {
      window.removeEventListener('edrv:debug-stopped', onStopped)
      window.removeEventListener('edrv.command.debugToggleBreakpoint', onToggleEvt)
      window.removeEventListener('edrv.command.debugStartContinue', onStart)
      window.removeEventListener('edrv.command.debugStepOver', onStepOver)
      window.removeEventListener('edrv.command.debugStepInto', onStepIn)
      window.removeEventListener('edrv.command.debugStepOut', onStepOut)
      window.removeEventListener('edrv.command.debugStop', onStop)
    }
  }, [])

  const openPath = () => {
    const p = (pathDraft || '').trim()
    if (!p) return
    // 图片/PDF 文件跳过文本读探测（二进制会被 host 拒绝），直接进 tab 由专用预览接管
    if (isImagePath(p) || isPdfPath(p)) {
      openFile(p, false)
      setOpenInput(false); setPathDraft(''); setStatus('已打开'); setError(null)
      return
    }
    setStatus('打开中…')
    rpc('edrv.read', { sessionId, path: p }).then((res) => {
      if (res && res.ok) {
        openFile(p, false)
        setOpenInput(false); setPathDraft(''); setStatus('已打开'); setError(null)
      } else { setStatus('打开失败'); setError(res?.error ? String(res.error) : '打开失败') }
    }).catch((e) => { setStatus('打开失败'); setError('打开异常:' + String(e)) })
  }

  const tabsEl = React.createElement('div', { className: 'edrv-tabs', ref: tabsHostRef, style: { flex: '1 1 auto', minWidth: 0 } },
    tabs.map((t) => React.createElement('div', {
      key: t.path,
      className: 'edrv-tab' + (t.path === active ? ' edrv-tab-active' : '') + (t.pinned ? ' edrv-tab-pinned' : ''),
      title: t.pinned ? t.path + '（已固定）' : t.path,
      onClick: () => { if (t.path !== active) { flushSave(); saveViewState(active); recordNav(); setActive(t.path) } },
      onContextMenu: (e) => {
        e.preventDefault()
        e.stopPropagation()
        setTabMenu({ x: e.clientX, y: e.clientY, path: t.path })
      },
    },
      // 固定页签在文件名前显示 📌 标记，且不渲染 × （与参考图一致：固定页签不显示关闭按钮）
      // @author ddj 2026年09月11号
      (t.pinned ? React.createElement('span', { className: 'edrv-tab-pin', title: '已固定', 'aria-label': '已固定' }, '📌') : null),
      React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 } }, t.path.split(/[\\/]/).pop() || t.path),
      // 未保存修改页签显示 * 星号（保存成功消失、失败持续）；替换原圆点脏标记
      // @author ddj 2026年09月09号
      (dirtyMap[t.path] ? React.createElement('span', { className: 'edrv-tab-star', title: '未保存修改' }, '*') : null),
      (t.pinned ? null : React.createElement('span', { className: 'edrv-tab-x', title: '关闭', onClick: (e) => { e.stopPropagation(); closeTab(t.path) } }, '×')))),
    planTabs.map((plan) => React.createElement('div', {
      key: plan.address, className: 'edrv-tab' + (plan.address === planActive ? ' edrv-tab-active' : ''),
      title: plan.title + '（计划预览 · 只读）', onClick: () => openPlanDoc(plan),
    }, React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 } }, plan.title),
    React.createElement('span', { className: 'edrv-tab-x', title: '关闭', onClick: (event) => closePlan(plan.address, event) }, '×'))),
    (openInput
      ? React.createElement('input', { className: 'edrv-path-input', autoFocus: true, placeholder: '输入工作区相对/绝对路径，回车打开', value: pathDraft, onChange: (e) => setPathDraft(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') openPath(); if (e.key === 'Escape') setOpenInput(false) } })
      : React.createElement('button', { className: 'edrv-tab-add', title: '打开文件（输入路径）', onClick: () => setOpenInput(true) }, '+')))

  const activePlan = planTabs.find((plan) => plan.address === planActive)
  const pathBar = activePlan ? React.createElement('div', { className: 'edrv-pathbar', title: activePlan.address },
    React.createElement('span', { className: 'edrv-pb-name' }, activePlan.title),
    React.createElement('span', { className: 'edrv-pb-meta' }, '计划预览 · 只读 · 审批请使用对话中的官方控件'))
    : React.createElement('div', { className: 'edrv-pathbar', title: active || '' },
    React.createElement('span', { className: 'edrv-pb-name' }, active ? String(active).split(/[\\/]/).pop() : '未打开文件'),
    React.createElement('span', { className: 'edrv-pb-full' }, active || '使用右上搜索框 (' + (chordOf('edrv.quickOpen') ?? 'Ctrl+P') + ') 打开文件'),
    (recentUpdate && !svnUpdateDialog && sameUpdateOwner(recentUpdate, sessionId, scope)
      ? React.createElement('button', {
          className: 'edrv-pb-update', type: 'button', title: '查看最近 SVN 更新结果（不重新更新）',
          onClick: () => setSvnUpdateDialog(recentUpdate),
        }, React.createElement(IconRefreshOutline16, { size: 14 }), '最近更新')
      : null),
    // Markdown 预览/源码切换（需求 4）：仅 .md 文件出现；命令栏与 Ctrl+Shift+V 为同一动作
    (isMdActive ? React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost edrv-pb-mdbtn',
      title: (mdPreviewing ? '切回源码编辑' : '预览 Markdown') + '（' + (chordOf('edrv.toggleMarkdownPreview') ?? '未绑定') + '）',
      onClick: () => toggleMdPreview(active),
    }, mdPreviewing ? '源码' : '预览') : null),
    (mdPreviewing ? React.createElement('span', { className: 'edrv-pb-meta' }, '预览') : null),
    (active && !isImageActive && langOf(active) ? React.createElement('span', { className: 'edrv-pb-meta' }, langOf(active)) : null),
    (isImageActive && imgSize ? React.createElement('span', { className: 'edrv-pb-meta' }, imgSize.w + '×' + imgSize.h) : null),
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
  // 状态段行内样式：单行状态栏内的一段；LSP 段弹性占满空闲宽度，把后续段推到行尾
  const lspSegStyle = { display: 'inline-flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: '1 1 auto' }
  const lspSeg = (lspLanguage === 'lua' || lspLanguage === 'csharp')
    ? React.createElement('span', { className: 'edrv-status-seg', style: lspSegStyle, title: lspServer?.progressMessage || lspLabel },
        React.createElement('span', { className: 'edrv-lsp-status-dot ' + (lspServer?.phase === 'ready' ? 'ready' : lspServer?.phase === 'indexing' || lspServer?.phase === 'starting' ? 'busy' : 'idle') }),
        React.createElement('span', { className: 'edrv-sp-lsp' }, lspLabel),
        lspServer?.progressMessage ? React.createElement('span', { className: 'edrv-sp-progress-message' }, lspServer.progressMessage) : null,
        lspProgress !== null ? React.createElement('span', { className: 'edrv-sp-progress' }, lspProgress + '%') : null)
    : null

  // AI 补全状态段（全语言可用，不随 LSP 语言过滤）：就绪/请求中/完成·耗时/失败原因
  const aiEnabled = aiStatus.enabled
  const aiState = aiStatus.state
  const aiDotCls = aiState === 'busy' ? 'busy' : aiState === 'ok' ? 'ready' : aiState === 'error' ? 'idle' : 'ready'
  const aiMsText = aiStatus.detail && aiStatus.detail.ms != null ? (aiStatus.detail.ms / 1000).toFixed(1) + 's' : ''
  const aiNote = aiStatus.detail && aiStatus.detail.note ? String(aiStatus.detail.note) : ''
  const aiLabel = !aiEnabled ? 'AI 补全 · 关'
    : aiState === 'busy' ? 'AI 补全请求中…'
    : aiState === 'ok' ? 'AI 补全完成' + (aiMsText ? ' · ' + aiMsText : '')
    : aiState === 'error' ? 'AI 补全失败 · ' + aiNote.slice(0, 48)
    : 'AI 补全就绪'
  const aiSegStyle = { display: 'inline-flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: '0 0 auto' }
  const aiSeg = (active && aiEnabled !== null)
    ? React.createElement('span', { className: 'edrv-status-seg', style: aiSegStyle, title: aiState === 'error' && aiNote ? aiNote : 'AI 自动补全（设置页「AI 补全」可配置）' },
        React.createElement('span', { className: 'edrv-lsp-status-dot ' + (!aiEnabled ? 'idle' : aiDotCls) }),
        React.createElement('span', { className: 'edrv-sp-lsp' }, aiLabel))
    : null

  // 外部改动段：仅当前文件有未处理的外部变更时出现（点「重新加载」即消解）
  const diskSeg = (active && diskFlag && sameFile(diskFlag.path, active))
    ? React.createElement('span', {
        className: 'edrv-status-seg',
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: '0 0 auto', cursor: 'pointer' },
        title: '磁盘内容已被外部修改：重新加载 = 取磁盘版本；保留本地 = 继续编辑（保存时会被版本守卫拒绝）',
        onClick: () => reloadFile(),
      }, React.createElement('span', { className: 'edrv-sp-lsp' }, diskFlag.kind === 'deleted' ? '⚠ 外部已删除' : '⚠ 外部已修改'))
    : null

  // 底部状态栏：单行多段——LSP 段居左（弹性吸收空闲宽度），外部改动段与 AI 段固定右对齐
  const statusBar = (lspSeg || aiSeg || diskSeg)
    ? React.createElement('div', { className: 'edrv-statusbar' }, lspSeg, diskSeg, aiSeg)
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
    React.createElement('button', { className: 'edrv-chip-btn' + (sidebarOn ? ' edrv-chip-on' : ''), title: '切换面板区 (' + (chordOf('edrv.toggleSidebar') ?? 'Ctrl+B') + ')，图标列常显', onClick: () => setSidebarOn((v) => !v) }, '☰'),
    React.createElement('button', { className: 'edrv-chip-btn', title: '刷新', onClick: reloadFile }, '⟳'),
    React.createElement(QuickOpen, { sessionId, onOpen: (p) => openFile(p, false) }))

  /**
   * 外部同步提示条（冲突 / 文件被删）：仅在提示对象就是当前活动文件时显示。
   * 不复用 error 面板：内容照常可编辑，提示条只是把「磁盘已变、怎么处理」摆在眼前。
   * @author ddj 2026年09月15号
   * @returns 提示条元素或 null
   */
  const diskBanner = () => {
    const flag: SyncFlag | null = diskFlag && sameFile(diskFlag.path, active) ? diskFlag : null
    if (!flag) return null
    const deleted = flag.kind === 'deleted'
    const text = deleted
      ? '该文件已被外部删除（缓冲内容保留，保存会失败）'
      : '磁盘内容已被外部修改（当前有未保存编辑，未覆盖）'
    return React.createElement('div', {
      className: 'edrv-diskbar',
      style: {
        display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0,
        padding: '4px 8px', fontSize: '12px',
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,193,7,.12))',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(255,193,7,.35))',
      },
    },
      React.createElement('span', { title: flag.path }, '⚠ ' + text),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', {
        className: 'edrv-pill edrv-pill-keep', title: '放弃缓冲内容，重新加载磁盘版本',
        onClick: () => reloadFile(),
      }, '重新加载'),
      (deleted ? null : React.createElement('button', {
        className: 'edrv-pill edrv-pill-undo', title: '用编辑器内容覆盖磁盘（放弃磁盘上的外部修改）',
        onClick: overwriteDisk,
      }, '覆盖磁盘')),
      (deleted ? null : React.createElement('button', {
        className: 'edrv-pill edrv-pill-ghost', title: '保留编辑器内容，不取用磁盘版本',
        onClick: keepLocal,
      }, '保留本地')))
  }

  // G9：记录路径为绝对、active 为页签规范形态（相对），必须经 sameFile 归一比较，
  // 否则当前活动文件会被误列入「其他差异文件」。
  const otherFiles = sum.pendingFiles.filter((f) => !sameFile(f.path, active))

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
  if (activePlan) {
    const labels = PLAN_MD_LABELS
    const text = activePlan.markdown
    const render = isComponentType(MarkdownText)
      ? React.createElement(MarkdownDelegateProvider, {
          openFile: (path, options) => options?.line != null ? openFileAt(path, options.line) : openFile(path, false),
        }, React.createElement(MarkdownText, { text, streaming: false, labels, variant: 'body' }))
      : React.createElement('pre', { className: 'edrv-mdview-pre' }, text)
    body = React.createElement('div', { className: 'edrv-mdview', ref: planHostRef, 'data-plan-address': activePlan.address },
      React.createElement('div', { className: 'edrv-mdview-stage' }, React.createElement('div', { className: 'edrv-mdview-doc' }, render)))
  } else if (svnDiff) {
    // 差异视图优先占位（覆盖编辑器主体）：只读审阅态，关闭后回到原编辑器
    body = React.createElement(SvnDiffPanel, {
      key: 'edrv-svndiff:' + svnDiff.scheme + ':' + svnDiff.path,
      monaco,
      path: svnDiff.path,
      base: svnDiff.base,
      working: svnDiff.working,
      reason: svnDiff.reason,
      message: svnDiff.message,
      leftLabel: svnDiff.leftLabel,
      rightLabel: svnDiff.rightLabel,
      onBack: svnDiff.logTarget !== undefined ? backToSvnLog : undefined,
      onClose: () => {
        setSvnDiff(null)
        if (svnUpdateReturn?.from === 'diff') {
          setSvnUpdateDialog(svnUpdateReturn.dialog)
          setSvnUpdateReturn(null)
        }
      },
    })
  } else if (!monaco && !monacoErr) {
    body = loadingBody(loadStage.message, loadStage.progress)
  } else if (monacoErr) {
    body = React.createElement('div', { className: 'edrv-empty' },
      React.createElement('div', null, 'Monaco 编辑器加载失败：' + String(monacoErr)),
      React.createElement('div', { style: { fontSize: 11 } }, '请确认插件包 assets/vendor/monaco 完整（/edrv/vendor 路由可达）'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', onClick: () => { setMonacoErr(null); setLoadStage({ progress: 0, message: '准备重试 Monaco…' }) } }, '重试'))
  } else if (!active) {
    body = React.createElement('div', { className: 'edrv-empty' },
      React.createElement('div', null, '暂无打开的文件'),
      React.createElement('div', { style: { fontSize: 12 } }, '使用右上搜索框 (' + (chordOf('edrv.quickOpen') ?? 'Ctrl+P') + ') 打开工作区文件；' + (chordOf('edrv.showCommands') ?? 'Ctrl+Shift+P') + ' 打开命令栏；agent 修改文件后顶部会出现差异角标'))
  } else if (content === null && loadError) {
    body = loadingBody('文件加载失败：' + loadError, 0, () => {
      setLoadError(null)
      setContent(null)
      setContentPath(null)
      setLoadStage({ progress: 10, message: '重新读取文件…' })
      loadContent(active, sessionId)
    })
  } else if (isImageActive && imageSrc) {
    body = imagePanel()
  } else if (isImageActive) {
    body = loadingBody(loadStage.message || '读取图片…', loadStage.progress)
  } else if (isPdfActive && pdfBytes) {
    body = React.createElement('div', { className: 'edrv-pdf-host', ref: ensurePdfHost, key: active + ':' + (receiptLoad?.sequence ?? 0) })
  } else if (isPdfActive) {
    body = loadingBody(loadStage.message || '读取 PDF…', loadStage.progress)
  } else if (mdPreviewing && contentReady) {
    // Markdown 预览（需求 4）：复用已加载的文本内容渲染，不额外请求；编辑仍在源码态完成
    body = React.createElement(MarkdownPanel, {
      key: 'edrv-md-' + active,
      text: content,
      onToggleSource: () => toggleMdPreview(active),
      onReload: () => reloadFile(),
      onOpenFile: (path, line) => openFileAt(path, line ?? 1),
    })
  } else if (mdPreviewing) {
    body = loadingBody(loadStage.message || '读取 Markdown…', loadStage.progress)
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

  /**
   * 组装当前编辑器的差异上下文，供侧栏本地与会话 dock 共用。
   * @author ddj 2026年09月29号
   * @returns 含布局及操作回调的差异快照
   */
  const buildDockSnapshot = () => ({
    mode: editorDockMode(active),
    layout,
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
    diffTotal: displayDiffTotal(contentReady, pendingRegions.length, sum.files.find((file) => sameFile(file.path, active))?.pending ?? 0),
    fileIdx,
    fileTotal: sum.pendingFiles.length,
    onPrevDiff: () => gotoDiff(-1),
    onNextDiff: () => gotoDiff(1),
    onPrevFile: () => gotoFile(-1),
    onNextFile: () => gotoFile(1),
    onOpenNextFile: openNextFile,
  })

  const dockSnapshot = buildDockSnapshot()
  React.useEffect(() => {
    if (!sessionId) return
    publishDiffDock(sessionId, dockSnapshot, dockSourceRef.current)
    // 侧栏形态同步 Tab 角标计数（仅本形态写入；页签形态清零避免残留）
    if (layout === 'side') setSidePending(sessionId, sum.totalFiles)
    else setSidePending(sessionId, 0)
  })

  const overlay = launcherOpen
    ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 30 }, onClick: () => setLauncherOpen(false) }),
        React.createElement(DiffLauncher, { sessionId, sum, tab: launcherTab, onClose: () => setLauncherOpen(false), onOpenFile: (p) => { openFile(p, true); setLauncherOpen(false) } }))
    : null

  // 页签右键菜单：改用通用 ContextMenu 浮层（portal + data-edrv-view + 实测尺寸 clamp +
  // Esc/外部点击关闭），与侧栏文件树同一套原语。编辑区右键仍走 Monaco 原生菜单。
  // @author ddj 2026年09月11号
  const tabMenuEl = tabMenu
    ? React.createElement(ContextMenu, {
        key: 'edrv-tab-menu',
        x: tabMenu.x,
        y: tabMenu.y,
        entries: tabMenuEntries(),
        onClose: dismissMenus,
      })
    : null

  // 代码片段浮层（命令栏「代码片段：配置代码片段」/「插入代码片段」）：portal 到 body，随会话注入 cwd/语言
  const snippetPickerEl = snippetPicker
    ? React.createElement(SnippetsPicker, {
        mode: snippetPicker,
        sessionId,
        cwd: cwd ?? null,
        // 片段文件本身的语言要按 `<语言>.code-snippets` 命名约定推导（不能用 langOf：
        // 那会把 .code-snippets 当成 json 源文件，默认名会错成 json.code-snippets）
        language: active ? snippetLanguageOf(active) : '',
        languages: snippetLanguageIds(monacoRef.current),
        // 显式给 line=1：走 openFileAt 的直接定位分支（并清掉 pendingFocus，不残留跳转意图）
        onOpenFile: (absPath) => { openFileAt(absPath, 1); setStatus('已打开代码片段文件') },
        onInsert: insertSnippetAtCursor,
        onClose: () => setSnippetPicker(null),
      })
    : null

  const sidebarPanels = props.sidebarPanels
  // SVN 变更查表（文件树徽标 O(1) 查表用）：O(n) 建表只随数据/作用域变化重算，
  // 不再随编辑区每轮渲染重建（条目多时每帧新建几千键的 Record 徒增 GC 压力）。
  // @author ddj 2026年09月23号
  const svnChangeMapMemo = React.useMemo(() => svnChangeMapOf(scope), [scope, svnChanges])
  const sidebarCtx = {
    sessionId,
    // 当前会话工作区（反应式 cwd；规则面板项目 Tab 自动匹配）
    cwd: cwd ?? null,
    // 状态作用域键（工作区优先，无 cwd 回退会话；面板持久化统一走它）
    scope,
    openFile: (p) => openFile(p, false),
    openFileAt,
    activePath: active,
    pendingByPath,
    sum: { totalFiles: sum.totalFiles, files: sum.files },
    refreshRecords: () => refreshRecords(),
    editor: () => editorRef.current,
    outlineSources: props.outlineSources,
    fileMenuItems: props.fileMenuItems,
    addToConversation,
    svn: svnStatus,
    // SVN 变更：面板列表 + 文件树徽标查表（客户端合成，不改 listDir 契约）
    svnChanges,
    svnChangeMap: svnChangeMapMemo,
    openSvnDiff: (p) => runSvnDiffBase(p),
    openSvnUpdate: (p) => runSvnUpdate(p),
    openSvnLocalPair: runSvnDiffLocalPair,
    refreshSvnChanges: () => refreshSvnChanges(sessionId, scope),
    openSvnLog: (p) => openSvnLog(p),
    confirm: (message) => (typeof window === 'undefined' ? false : window.confirm(message)),
    notify: (message) => setStatus(message),
    // 名称输入弹窗（资源管理器右键的新建文件/新建文件夹/重命名）
    prompt: promptName,
    // 「打开方式…」（资源管理器右键、文件目标）：打开器选择弹窗（注册表由 index 装配传入）
    openWith: (p) => {
      const openers = props.fileOpeners
      if (!openers) return
      openWithDialog(openers, { sessionId, cwd: cwd ?? undefined }, p, (opener) => {
        if (opener) setStatus('已用「' + opener.label + '」打开：' + baseNameOf(p))
      })
    },
    // 「在文件夹中查找…」（资源管理器右键、目录目标）：目录过滤种子 + 跳搜索面板
    searchInFolder: (dir) => {
      setSearchScope(dir)
      openSearchPanel()
    },
  }

  // 调试工具条（VS Code 浮动条紧凑版，图2 形态）：配置下拉 + 启动/继续 + 单步组 + 停止 + 相位。
  // 配置来自工作区 .dsh/launch.json（插件专属，与 VS Code 互不干扰）；无配置时下拉提示且按钮禁用。
  const dapPhaseTextOf = () => ({
    idle: '', starting: '启动中…', waiting: '等待目标…', running: '运行中', paused: '已暂停', terminated: '已结束',
  }[dapSnap.phase] || '')
  const dapActive = dapSnap.phase !== 'idle' && dapSnap.phase !== 'terminated'
  const dapPaused = dapSnap.phase === 'paused'
  const dapBtn = (label, title, disabled, onClick) => React.createElement('button', {
    key: title, className: 'edrv-dapbar-btn', title, disabled: disabled === true, onClick,
  }, label)
  const dapBarVisible = dapActive || Boolean(dapSnap.candidates)
  const dapBarStyle = dapBarPos
    ? { left: dapBarPos.left, top: dapBarPos.top, right: 'auto' }
    : undefined
  const dapBar = dapBarVisible ? React.createElement('div', {
    ref: dapBarRef,
    className: 'edrv-dapbar' + (dapBarVisible ? ' on' : '') + (dapBarDragging ? ' dragging' : ''),
    style: dapBarStyle,
  },
    React.createElement('span', {
      className: 'edrv-dapbar-grip',
      role: 'button',
      tabIndex: 0,
      title: '拖动调试工具条',
      'aria-label': '拖动调试工具条',
      onPointerDown: startDapBarDrag,
    }, '⠿'),
    (dapSnap.candidates
      ? [
          React.createElement('select', {
            key: 'pick', className: 'edrv-dapbar-cfg', title: '选择附加目标进程（processName 命中多个候选）',
            value: String(dapPickPid || dapSnap.candidates[0]?.pid || ''),
            onChange: (e) => setDapPickPid(Number(e.target.value)),
          },
            dapSnap.candidates.map((it) => React.createElement('option', { key: it.pid, value: String(it.pid) },
              it.pid + ' : ' + it.name + (it.title ? ' — ' + it.title.slice(0, 44) : '')))),
          dapBtn('✓', '附加到选中进程', false, () => dapStore.confirmPick(dapPickPid || dapSnap.candidates![0]?.pid || 0)),
          dapBtn('✕', '取消', false, () => dapStore.cancelPick()),
        ]
      : React.createElement('select', {
          className: 'edrv-dapbar-cfg',
          title: '调试配置（读取工作区 .dsh/launch.json；适配器由扩展清单 contributes.debuggers 提供）',
          value: dapSnap.selectedConfig ?? '',
          onChange: (e) => dapStore.selectConfig(e.target.value),
        },
          dapSnap.configs.length
            ? dapSnap.configs.map((c) => {
                // 旧 host 无 adapters 数据时视为全部可用（保持兼容）；有数据则按可用性置灰并给原因
                const adapter = dapSnap.adapters.find((a) => a.type === c.type)
                const ready = dapSnap.adapters.length === 0 || adapter?.available === true
                const suffix = ready ? '' : '（' + (adapter?.reason || '未发现该类型适配器') + '）'
                return React.createElement('option', { key: c.name, value: c.name, disabled: !ready }, c.name + suffix)
              })
            : React.createElement('option', { value: '' }, '无可用调试配置'))),
    dapBtn(dapPaused ? '▶' : '▶', '启动 / 继续（F5）', !dapPaused && (!dapSnap.configs.some((c) => dapSnap.adapters.length === 0 || dapSnap.adapters.find((a) => a.type === c.type)?.available === true) || dapActive), () => dapStore.startOrContinue()),
    dapBtn('⏸', '暂停', !dapActive, () => { void dapStore.action('pause') }),
    dapBtn('⤵', '单步跳过（F10）', !dapPaused, () => { void dapStore.action('next') }),
    dapBtn('↓', '单步步入（F11）', !dapPaused, () => { void dapStore.action('stepIn') }),
    dapBtn('↑', '单步步出（Shift+F11）', !dapPaused, () => { void dapStore.action('stepOut') }),
    dapBtn('⏹', '停止（Shift+F5）', !dapActive, () => { void dapStore.stop() }),
    (dapPhaseTextOf()
      ? React.createElement('span', { className: 'edrv-dapbar-phase' + (dapPaused ? ' paused' : '') },
          dapPhaseTextOf() + (dapSnap.pid ? ' · pid ' + dapSnap.pid : ''))
      : null),
    (dapSnap.error
      ? React.createElement('span', { className: 'edrv-dapbar-err', title: dapSnap.error }, '⚠ ' + dapSnap.error.slice(0, 40))
      : null)) : null

  /**
   * 「添加配置」按钮点击：定位 configurations 数组插入点（数组开头行首），
   * 显式拉起 Monaco 补全下拉选择调试配置片段插入。
   * @author ddj 2026年09月22号
   */
  const addLaunchConfig = async () => {
    const ed = editorRef.current
    if (!ed) { setStatus('无活动编辑器'); return }
    const path = modelPathOf(ed)
    if (!path || !LAUNCH_JSON_RE.test(String(path).replace(/\\/g, '/'))) {
      setStatus('请先打开 .dsh/launch.json')
      return
    }
    const model = ed.getModel && ed.getModel()
    const pos = model ? findArrayPos(model.getValue()) : null
    if (!pos) { setStatus('未找到 configurations 数组'); return }
    // 预拉片段并预检可用条数：全不可用时不弹空 suggest（否则按钮点了无反馈）
    const snippets = await prefetchSnippets().catch(() => [])
    if (!snippets.some((snip) => snip.available !== false)) {
      setStatus('无可用适配器的配置模板（适配器入口缺失或未发现该类型适配器）')
      return
    }
    ed.focus()
    ed.setPosition({ lineNumber: pos.line, column: pos.column })
    if (typeof ed.revealPositionInCenterIfOutsideViewport === 'function') {
      ed.revealPositionInCenterIfOutsideViewport({ lineNumber: pos.line, column: pos.column })
    }
    ed.trigger('edrv-addcfg', 'editor.action.triggerSuggest', null)
    setStatus('选择要插入的调试配置')
  }

  // 「添加配置」按钮（VSCode 同款形态，编辑区右下角）：仅插件专属 launch.json 打开且非差异审阅态显示
  const addCfgBtn = (active && !svnDiff && LAUNCH_JSON_RE.test(String(active).replace(/\\/g, '/')))
    ? React.createElement('button', {
        className: 'edrv-addcfg',
        title: '添加调试配置（插入到 configurations 数组开头）',
        onClick: addLaunchConfig,
      }, '添加配置…')
    : null

  // 侧栏差异栏悬浮在编辑区底部；中央页签仍使用对话 dock。
  const sideDock = dockInLayout(dockSnapshot, 'side')
    ? React.createElement('div', {
        className: 'edrv-side-diff-dock edrv-diff-dock-shell',
        'data-edrv-diff-dock-shell': '1',
      }, React.createElement(DiffBox, { ...dockSnapshot, dock: true }))
    : null
  // 主编辑列（侧边栏右侧）：pathBar + tabRow + 编辑/差异区。
  const editorArea = React.createElement('div', { className: 'edrv-editor-area' },
    dapBar,
    addCfgBtn,
    body,
    hoverEl,
    sideDock,
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
        React.createElement('span', { className: 'edrv-side-hint-text' }, 'DSH 0.1.5+ 自带官方右侧侧边栏（升级即用）；旧版可安装 dsh-better-sidebar 启用侧边栏编辑（对话+编辑同屏）：'),
        React.createElement('code', { className: 'edrv-side-hint-cmd' }, SIDEBAR_INSTALL_CMD),
        React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '复制安装命令', onClick: copyInstallCmd }, '复制命令'),
        React.createElement('button', { className: 'edrv-side-hint-close', title: '关闭提示', 'aria-label': '关闭提示', onClick: dismissHint }, '×'))
    : null
  const mainCol = React.createElement('div', { className: 'edrv-main-col', style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    pathBar,
    tabRow,
    sideHintEl,
    diskBanner(),
    editorArea,
    statusBar)
  // 编辑器根节点按 composer 顶部边界动态限高，底部对话区域继续由 DSH 原生渲染。
  // 侧栏形态由面板容器给高（100%），不做 composer 几何同步。
  const editorRow = React.createElement('div', { className: 'edrv-editor-row' },
    (sidebarPanels
      ? React.createElement(SidebarView, {
          registry: sidebarPanels,
          ctx: sidebarCtx,
          activePanel,
          onActive: setActivePanel,
          visible: sidebarOn,
          onShow: () => setSidebarOn(true),
          width: sidebarW,
          onWidth: setSidebarW,
          onHide: () => setSidebarOn(false),
          minWidth: sidebarMinW,
        })
      : null),
    mainCol)

  const baseStyle = { minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base,transparent)', overflow: 'hidden' }
  // 命令栏浮层（Ctrl+Shift+P / F1）：portal 到 body，但需挂在插件自己的 React 树里；
  // 三种布局形态都渲染 EditorView，故这里挂载即可，多宿主由 store 单实例认领兜底。
  const paletteEl = React.createElement(CommandPalette, { key: 'edrv-palette', sessionId })
  // SVN 日志弹窗（P3）：portal 到 body，与命令栏/片段选择器同一挂载方式
  const svnLogEl = svnLog
    ? React.createElement(SvnLogDialog, {
        key: 'edrv-svnlog',
        target: svnLog.target,
        entries: svnLogData,
        wcRev: svnLogWcRev,
        truncated: svnLogTruncated(scope, svnLog.target || '', svnLog.limit || SVN_LOG_PAGE, svnLogOptsOf(svnLog)),
        error: svnLogError,
        busy: svnLogBusy,
        stopOnCopy: svnLog.soc === true,
        includeMerged: svnLog.merged === true,
        rangeActive: Array.isArray(svnLog.range),
        onShowRange: (start, end) => {
          const next = { ...svnLog, range: [start, end], limit: SVN_LOG_PAGE }
          setSvnLog(next)
          setSvnLogBusy(true)
          // 换键取数（range 维度隔离缓存）
          ensureSvnLog(sessionId, scope, next.target || '', SVN_LOG_PAGE, false, svnLogOptsOf(next))
        },
        onRangeReset: () => {
          const next = { ...svnLog, range: null, limit: SVN_LOG_PAGE }
          setSvnLog(next)
          setSvnLogBusy(true)
          ensureSvnLog(sessionId, scope, next.target || '', SVN_LOG_PAGE, false, svnLogOptsOf(next))
        },
        onStopCopy: (on) => {
          const next = { ...svnLog, soc: on }
          setSvnLog(next)
          setSvnLogBusy(true)
          // 换键取数（soc 维度隔离缓存）；已加载过默认窗口时无需 force
          ensureSvnLog(sessionId, scope, next.target || '', next.limit || SVN_LOG_PAGE, false, svnLogOptsOf(next))
        },
        onShowMerged: (on) => {
          const next = { ...svnLog, merged: on }
          setSvnLog(next)
          setSvnLogBusy(true)
          // 换键取数（mrg 维度隔离缓存，P1-5）；与 soc 同口径
          ensureSvnLog(sessionId, scope, next.target || '', next.limit || SVN_LOG_PAGE, false, svnLogOptsOf(next))
        },
        onRefresh: () => {
          setSvnLogError('')
          setSvnLogBusy(true)
          refreshSvnLog(sessionId, scope, svnLog.target || '', svnLog.limit || SVN_LOG_PAGE, svnLogOptsOf(svnLog))
        },
        onLoadMore: () => {
          // P1-8：按已加载上限递增（防旧 limit 倒退），force 绕过缓存命中后原地替换同键数据
          const opts = svnLogOptsOf(svnLog)
          const loaded = svnLogLoadedLimit(scope, svnLog.target || '', opts) || SVN_LOG_PAGE
          setSvnLogBusy(true)
          setSvnLog({ ...svnLog, limit: loaded + SVN_LOG_PAGE })
          ensureSvnLog(sessionId, scope, svnLog.target || '', loaded + SVN_LOG_PAGE, true, opts)
        },
        onShowAll: () => {
          setSvnLogBusy(true)
          setSvnLog({ ...svnLog, limit: SVN_LOG_SHOW_ALL_LIMIT })
          ensureSvnLog(sessionId, scope, svnLog.target || '', SVN_LOG_SHOW_ALL_LIMIT, true, svnLogOptsOf(svnLog))
        },
        onOpenDiff: (relPath, revision) => { setSvnLog(null); runSvnDiffRev(relPath, revision, svnLog.target || '') },
        onComparePair: (revA, revB) => { setSvnLog(null); runSvnDiffPair(svnLog.target || '', revA, revB, svnLog.target || '') },
        onCompareWorking: (revision) => { setSvnLog(null); runSvnDiffWorking(svnLog.target || '', revision, svnLog.target || '') },
        onOpenFile: (relPath) => { setSvnLog(null); openFile(relPath, false) },
        onClose: () => {
          setSvnLog(null)
          setSvnLogError('')
          if (svnUpdateReturn?.from === 'log') {
            setSvnUpdateDialog(svnUpdateReturn.dialog)
            setSvnUpdateReturn(null)
          }
        },
      })
    : null
  /**
   * 更新终态只刷新一次目录树与变更缓存，切到日志再返回不重复执行。
   * @author ddj 2026年09月24号
   * @param result 已结束的更新任务
   */
  const onSvnUpdateDone = (result) => {
    if (svnUpdateDoneRef.current.has(result.jobId)) return
    svnUpdateDoneRef.current.add(result.jobId)
    const message = result.phase === 'completed' ? 'SVN 更新完成'
      : result.phase === 'cancelled' ? 'SVN 更新已取消（可能部分完成）' : 'SVN 更新失败：' + result.error
    setStatus(message)
    setRecentUpdate({ path: result.target, sessionId, scope, resumeJobId: result.jobId })
    refreshSvnChanges(sessionId, scope)
    emitRefresh()
  }
  const svnUpdateEl = sameUpdateOwner(svnUpdateDialog, sessionId, scope)
    ? React.createElement(SvnUpdateDialog, {
        key: 'edrv-svn-update:' + svnUpdateDialog.path + ':' + (svnUpdateDialog.resumeJobId || ''),
        sessionId, cwd, path: svnUpdateDialog.path, resumeJobId: svnUpdateDialog.resumeJobId,
        childOverlay: updateOpenWith,
        onDone: onSvnUpdateDone, onNote: (message) => setStatus(message),
        onClose: () => setSvnUpdateDialog(null),
        onShowLog: (target, jobId) => {
          setSvnUpdateReturn({ from: 'log', dialog: { ...svnUpdateDialog, resumeJobId: jobId } })
          setSvnUpdateDialog(null)
          openSvnLog(target)
        },
        onCompare: (path, revision, jobId) => runSvnDiffWorking(path, revision, undefined, () => {
          setSvnUpdateReturn({ from: 'diff', dialog: { ...svnUpdateDialog, resumeJobId: jobId } })
          setSvnUpdateDialog(null)
        }),
        onOpenFile: (path) => openFile(path, false),
        onOpenWith: (path) => {
          if (!props.fileOpeners) { setStatus('打开方式不可用'); return }
          setUpdateOpenWith(true)
          openWithDialog(props.fileOpeners, { sessionId, cwd: cwd ?? undefined }, path, (opener) => {
            setUpdateOpenWith(false)
            if (opener) setStatus('已用「' + opener.label + '」打开：' + baseNameOf(path))
          })
        },
        onOpenParent: (path) => {
          void revealPathInExplorer(sessionId, path).then((outcome) => {
            setStatus(outcome.ok ? '已打开父目录' : '打开父目录失败：' + (outcome.error ?? '未知错误'))
          })
        },
      })
    : null
  // W2-1 补丁对话框 / W2-2 目录对比对话框：portal 到 body，与日志弹窗同一挂载方式
  const patchDialogEl = patchDialog
    ? React.createElement(SvnPatchDialog, {
        key: 'edrv-svn-patch',
        path: patchDialog.path,
        text: patchDialog.text,
        truncated: patchDialog.truncated === true,
        binary: patchDialog.binary === true,
        onNote: (message) => setStatus(message),
        onClose: () => setPatchDialog(null),
      })
    : null
  const sumDialogEl = sumDialog
    ? React.createElement(SvnSumDialog, {
        key: 'edrv-svn-sum',
        sessionId,
        path: sumDialog.path,
        onNote: (message) => setStatus(message),
        onClose: () => setSumDialog(null),
      })
    : null
  // 诊断日志弹窗：portal 到 body，与命令栏/SVN 日志弹窗同一挂载方式
  const dlogEl = dlogOpen
    ? React.createElement(LogDialog, { key: 'edrv-dlog', sessionId, onClose: () => setDlogOpen(false) })
    : null
  // 断点右键菜单（逐条对齐 CodeBuddy：4 项添加类 / 删除·编辑·启停 / 记录点名词 / 暂停追加运行到行）
  const runBpMenuAction = (action) => {
    const scope = dapScopeRef.current
    const cwd = dapCwdRef.current
    const menu = dapBpMenu
    if (!menu) return
    const { path, line } = menu
    if (action === 'add') { dapStore.toggleAt(scope, cwd, path, line); return }
    if (action === 'delete') { if (menu.hasBp) dapStore.toggleAt(scope, cwd, path, line); return }
    if (action === 'disable' || action === 'enable') { dapStore.setBpEnabled(scope, cwd, path, line, action === 'enable'); return }
    if (action === 'edit') { openBpEditor(path, line); return }
    if (action === 'run-to-line') { dapStore.runTo(cwd, path, line); return }
    if (action === 'add-triggered') { setStatus('当前 Lua 调试器不支持触发的断点'); return }
    // 添加条件断点 / 添加记录点：先建点，再开浮层并选中对应模式（0 表达式 / 2 日志消息）
    dapStore.toggleAt(scope, cwd, path, line)
    openBpEditor(path, line, action === 'add-logpoint' ? 2 : 0)
  }
  const openBpEditor = (path, line, mode) => {
    const entry = (dapStore.bpMapOf(dapScopeRef.current)[path] ?? []).find((it) => it.line === line)
    if (!entry) return
    const ed = editorRef.current
    if (!ed?.changeViewZones) return
    // 行内浮层（View Zone，整编辑区宽 + 推开内容，对齐 VS Code breakpointWidget）：同一时刻只挂一个
    closeBpWidget()
    bpWidgetRef.current = { ...createBpWidget(ed, {
      line,
      entry,
      mode,
      onSave: (fields) => {
        dapStore.applyBpFields(dapScopeRef.current, dapCwdRef.current, path, line, fields)
        setStatus('断点已更新')
        closeBpWidget()
      },
      onClose: () => closeBpWidget(),
    }), path, line }
  }
  const closeBpWidget = () => {
    const held = bpWidgetRef.current
    if (!held) return
    bpWidgetRef.current = null
    try { held.close() } catch { /* 编辑器可能已销毁 */ }
  }
  const dapBpMenuEl = dapBpMenu
    ? React.createElement(ContextMenu, {
        x: dapBpMenu.x,
        y: dapBpMenu.y,
        onClose: () => setDapBpMenu(null),
        entries: buildBpMenu({
          hasBreakpoint: dapBpMenu.hasBp,
          enabled: dapBpMenu.enabled,
          isLogpoint: dapBpMenu.isLogpoint,
          paused: dapSnap.phase === 'paused',
          canRunTo: true,
          canTriggered: false,
        }).map((item) => ({
          id: 'dap-bp-' + item.id,
          label: item.label,
          hint: item.hint,
          separator: item.separator,
          onClick: () => runBpMenuAction(item.id),
        })),
      })
    : null
  const dapBpEditEl = null
  const rootEl = layout === 'side'
    ? React.createElement('div', { ref: viewRootRef, 'data-edrv-view': '1', 'data-edrv-layout': 'side', className: 'edrv-view-side', style: Object.assign({}, baseStyle, { height: '100%' }) },
        editorRow,
        tabMenuEl,
        paletteEl,
        svnLogEl,
        svnUpdateEl,
        patchDialogEl,
        sumDialogEl,
        dlogEl,
        snippetPickerEl,
        dapBpMenuEl,
        dapBpEditEl)
    : React.createElement('div', { ref: viewRootRef, 'data-edrv-view': '1', style: Object.assign({}, baseStyle, { height: 'var(--edrv-editor-height, 100%)', maxHeight: 'var(--edrv-editor-height, 100%)' }) },
        editorRow,
        tabMenuEl,
        paletteEl,
        svnLogEl,
        svnUpdateEl,
        patchDialogEl,
        sumDialogEl,
        dlogEl,
        snippetPickerEl,
        dapBpMenuEl,
        dapBpEditEl)
  return rootEl
}
