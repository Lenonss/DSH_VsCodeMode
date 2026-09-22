// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏「调试」面板（对齐 CodeBuddy「运行和调试」视图）。
 * 顶部工具条：配置下拉 + 启动/继续 + 暂停 + 单步组 + 停止（禁用逻辑镜像编辑器浮动条）。
 * 四段折叠区（变量 / 监视 / 调用堆栈 / 断点，图2 顺序）+ 底部调试控制台（REPL）；
 * 每段头部可折叠（状态按 scope 持久化）且带悬浮动作按钮。
 * 断点多方式管理（对齐 CodeBuddy 断点区）：段头「新建断点」菜单（条件断点/记录点，
 * 落在活动编辑器光标行）、禁用/启用所有、删除所有；断点行右键菜单（编辑条件/命中次数/
 * 记录点/启停/删除）→ 行内展开编辑器（Enter 提交 / Escape 取消，字段语义同 BpWidget）；
 * 行内点展示适配器回执（未验证 = 空心点 + tooltip）。
 * 数据自取：paused 时经 dapStore 拉栈/作用域/变量/监视求值；断点读写 dapStore 断点表；
 * 输出流 = host poll 事件缓存（outputs）。host 不可达或未暂停时各段空态降级。
 * 断点行整行可点：除启停 checkbox 与删除 × 外，点击任一处即打开并定位到该断点行。
 * 作者 ddj 2026年09月29号 / 2026年09月21号
 */
import React from 'react'
import { DAP_LAUNCH_REL } from '../../../shared/dap.js'
import { dapStore } from '../../dap/store.js'
import { bpJumpTargetOf } from '../../dap/breakpoints.js'
import { flattenVariableRows } from '../../dap/variableTree.js'
import { buildBpRowMenu } from '../../dap/bpRowMenu.js'
import { editorModelPathOf } from '../../dap/modelPath.js'
import { redistribute, loadSectionHeights, saveSectionHeights, type SplitKey } from '../../dap/panelSplit.js'
import { BP_MODE, MODES as BP_WIDGET_MODES, fieldOfMode } from '../../dap/BpWidget.js'
import { ContextMenu } from '../../ui/ContextMenu.js'
import { rpc } from '../../rpc.js'
import type { SidebarCtx } from '../types.js'

/** 变量展开缓存上限（ref → 子级；防长会话累积）。 */
const VAR_CACHE_CAP = 200
/** REPL 历史行上限。 */
const REPL_CAP = 200
/** 监视持久化 key 前缀（CACHE_KEY 无调试段，自管命名空间）。 */
const WATCH_KEY = 'edrv.dap.watch.'
/** 段折叠持久化 key 前缀（存折叠段名数组；损坏安全，默认全展开）。 */
const FOLD_KEY = 'edrv.dap.fold.'

/** 调试配置文件（工作区相对路径；⚙ 按钮跳转/新建目标；与 VS Code 的 .vscode/launch.json 互不干扰）。 */
const LAUNCH_REL = DAP_LAUNCH_REL
/** 新建调试配置模板（JSONC；示例按本机已装的 EmmyLua 适配器写）。 */
const LAUNCH_TEMPLATE = `{
  // DSH 调试配置（插件专属 .dsh/launch.json，支持注释；改完整页刷新生效）
  // type 来自本机已装扩展的 contributes.debuggers（EmmyLua：emmylua_attach / emmylua_launch / emmylua_new）
  "version": "0.2.0",
  "configurations": [
    {
      "name": "附加 Unity (xLua)",
      "type": "emmylua_attach",
      "request": "attach",
      "processName": "Unity",
      "captureLog": true
    }
  ]
}`

/** 相位徽标文案。 */
const PHASE_LABEL = { idle: '未启动', starting: '启动中…', waiting: '等待目标…', running: '运行中', paused: '已暂停', terminated: '已结束' }

/** 读取监视表达式列表（损坏安全）。 */
function loadWatches(scope) {
  if (!scope) return []
  try {
    const raw = window.localStorage.getItem(WATCH_KEY + scope)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim()) : []
  } catch {
    return []
  }
}

/** 写监视表达式列表。 */
function saveWatches(scope, list) {
  try { window.localStorage.setItem(WATCH_KEY + scope, JSON.stringify(list)) } catch { /* 忽略 */ }
}

/** 读折叠段名列表（损坏安全；非字符串项丢弃）。 */
function loadFolds(scope) {
  if (!scope) return []
  try {
    const raw = window.localStorage.getItem(FOLD_KEY + scope)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item) : []
  } catch {
    return []
  }
}

/** 写折叠段名列表（写失败静默）。 */
function saveFolds(scope, list) {
  try { window.localStorage.setItem(FOLD_KEY + scope, JSON.stringify(list)) } catch { /* 忽略 */ }
}

/**
 * 「调试」面板组件。
 * @param ctx 侧栏上下文（openFileAt 跳转 / scope 持久化 / cwd / editor 光标）
 */
export function DebugPanel({ ctx }) {
  const scope = ctx?.scope || ''
  const [, setTick] = React.useState(0)
  React.useEffect(() => dapStore.subscribe(() => setTick((t) => t + 1)), [])
  const snap = dapStore.getSnapshot()
  const paused = snap.phase === 'paused'
  const dapActive = snap.phase !== 'idle' && snap.phase !== 'terminated'

  // 数据状态（paused 变化/停帧变化时重拉）
  const [stacks, setStacks] = React.useState([])
  const [scopes, setScopes] = React.useState([])
  const [varCache, setVarCache] = React.useState(() => new Map())
  const [expanded, setExpanded] = React.useState(() => new Set())
  const [watches, setWatches] = React.useState(() => loadWatches(scope))
  const [watchHits, setWatchHits] = React.useState({})
  const [watchDraft, setWatchDraft] = React.useState('')
  const [replLog, setReplLog] = React.useState([])
  const [replDraft, setReplDraft] = React.useState('')
  // 段折叠（folded 段名集合；localStorage 按 scope 持久）
  const [folds, setFolds] = React.useState(() => new Set(loadFolds(scope)))
  // 分栏高度（四段 splitview；拖动 sash 相邻重分配，按 scope 持久）
  const [heights, setHeights] = React.useState(() => loadSectionHeights(scope))
  const [splitDragging, setSplitDragging] = React.useState(false)
  // 菜单态：断点行右键 / 段头「新建断点」下拉
  const [bpMenu, setBpMenu] = React.useState(null)
  const [newBpMenu, setNewBpMenu] = React.useState(null)
  // 断点行内编辑态：{ path, line, mode, drafts }（drafts 三字段同 BpWidget 记忆口径）
  const [bpEdit, setBpEdit] = React.useState(null)
  // 进程候选选择（candidates 非空时镜像浮动条的选择模式）
  const [pickPid, setPickPid] = React.useState(0)
  const watchInputRef = React.useRef(null)
  const stackTopKey = paused && snap.topFrame ? snap.topFrame.file + ':' + snap.topFrame.line : ''

  // 工作区同步 + 配置预拉（幂等；与 EditorView 的 cwd 副作用互不冲突）
  React.useEffect(() => {
    if (!ctx?.cwd) return
    dapStore.setWorkspace(ctx.cwd)
    void dapStore.ensureConfigs()
  }, [ctx?.cwd])

  // paused：拉调用栈 + 作用域 + 首帧变量 + 监视求值；非 paused 清空（reloadTick 手动刷新）
  const [reloadTick, setReloadTick] = React.useState(0)
  React.useEffect(() => {    if (!paused) {
      setStacks([]); setScopes([]); setVarCache(new Map()); setExpanded(new Set()); setWatchHits({})
      return
    }
    let alive = true
    const load = async () => {
      const frames = await dapStore.stackTrace()
      if (!alive) return
      setStacks(frames)
      const list = await dapStore.scopes(snap.selectedFrameId)
      if (!alive) return
      setScopes(list)
      const first = list[0]
      if (first?.ref) {
        const vars = await dapStore.variables(first.ref)
        if (!alive) return
        setVarCache((prev) => new Map(prev).set(first.ref, vars))
        setExpanded((prev) => new Set(prev).add(first.ref))
      }
      const hits = {}
      for (const expr of watches) {
        const r = await dapStore.evaluate(expr, snap.selectedFrameId)
        hits[expr] = r
      }
      if (alive) setWatchHits(hits)
    }
    void load()
    return () => { alive = false }
  }, [paused, stackTopKey, snap.selectedFrameId, watches, reloadTick])

  // 展开变量节点（懒拉子级）
  const expandVar = async (ref) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(ref)) next.delete(ref)
      else next.add(ref)
      return next
    })
    if (!varCache.has(ref)) {
      const vars = await dapStore.variables(ref)
      setVarCache((prev) => {
        const next = new Map(prev)
        next.set(ref, vars)
        if (next.size > VAR_CACHE_CAP) next.delete(next.keys().next().value)
        return next
      })
    }
  }

  const addWatch = () => {
    const expr = watchDraft.trim()
    if (!expr || watches.includes(expr)) { setWatchDraft(''); return }
    const next = [...watches, expr]
    setWatches(next)
    saveWatches(scope, next)
    setWatchDraft('')
    if (paused) void dapStore.evaluate(expr, snap.selectedFrameId).then((r) => setWatchHits((prev) => ({ ...prev, [expr]: r })))
  }

  const removeWatch = (expr) => {
    const next = watches.filter((item) => item !== expr)
    setWatches(next)
    saveWatches(scope, next)
  }

  /** 移除全部监视（段头动作；持久化与命中缓存同步清）。 */
  const clearWatches = () => {
    setWatches([])
    saveWatches(scope, [])
    setWatchHits({})
  }

  /** 聚焦监视新增输入（段折叠时先展开，二次点击聚焦）。 */
  const focusWatchInput = () => {
    if (folds.has('watch')) { toggleFold('watch'); return }
    watchInputRef.current?.focus?.()
  }

  const runRepl = async () => {
    const expr = replDraft.trim()
    if (!expr) return
    setReplDraft('')
    const r = await dapStore.evaluate(expr, snap.selectedFrameId)
    setReplLog((prev) => {
      const next = [...prev, { expr, result: r.result, type: r.type }]
      return next.length > REPL_CAP ? next.slice(next.length - REPL_CAP) : next
    })
  }

  /** 切换段折叠（持久化到 localStorage）。 */
  const toggleFold = (key) => {
    setFolds((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveFolds(scope, [...next])
      return next
    })
  }

  // 分栏拖动：进行中的清理句柄（pointerup 与组件卸载双路径移除 window 监听）
  const splitCleanupRef = React.useRef(null)
  React.useEffect(() => () => {
    const cleanup = splitCleanupRef.current
    if (cleanup) cleanup()
  }, [])

  /** 段间 sash 拖动：以起点高度为基准按 dy 相邻重分配；pointerup 持久化（镜像 dapbar 拖动模式）。 */
  const startSplitDrag = (above: SplitKey, below: SplitKey) => (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeights = { ...heights }
    const onMove = (ev) => {
      setHeights(redistribute(startHeights, above, below, ev.clientY - startY))
    }
    const detach = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      splitCleanupRef.current = null
      setSplitDragging(false)
    }
    const onUp = () => {
      detach()
      setHeights((prev) => { saveSectionHeights(scope, prev); return prev })
    }
    splitCleanupRef.current = detach
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    setSplitDragging(true)
  }

  // 断点启停/删除/跳转（checkbox + 红点 + 文件名 + 目录 + 行号徽标；整行可点跳转）
  const cwd = ctx?.cwd || dapStore.workspace()
  const bpMap = dapStore.bpMapOf(scope)
  const bpRows = Object.entries(bpMap).flatMap(([path, list]) => list.map((entry) => ({ path, entry })))
    .sort((a, b) => a.path.localeCompare(b.path) || a.entry.line - b.entry.line)
  const allBpEnabled = bpRows.length > 0 && bpRows.every((row) => row.entry.enabled)

  const toggleBpEnabled = (row) => dapStore.setBpEnabled(scope, cwd, row.path, row.entry.line, !row.entry.enabled)
  const removeBp = (row) => dapStore.toggleAt(scope, cwd, row.path, row.entry.line)
  /** 删除所有断点（confirm 守卫；逐文件同步空载荷清空 Monaco 装饰与 host 断点）。 */
  const removeAllBps = () => {
    if (ctx?.confirm && !ctx.confirm('删除所有断点？')) return
    dapStore.removeAllBps(scope, cwd)
    setBpEdit(null)
  }
  // 跳转目标经纯函数守卫（路径缺失/行号非法的行不发起导航）；openFileAt 内含 recordNav，
  // 故整行只挂这一个 handler，文件名按钮不再自带 onClick（防双触发双记导航历史）。
  const jumpBp = (row) => {
    const target = bpJumpTargetOf(row)
    if (target) ctx?.openFileAt?.(target.path, target.line, target.column)
  }

  // 断点行内编辑器（字段语义同 BpWidget：三字段独立草稿，提交全量落 store，空串清字段）
  const autoBpModeOf = (entry) => (
    entry?.logMessage ? BP_MODE.LOG_MESSAGE : entry?.hitCondition ? BP_MODE.HIT_COUNT : BP_MODE.EXPRESSION
  )
  const openBpRowEditor = (path, line, entry, mode) => {
    setBpEdit({
      path, line,
      mode: typeof mode === 'number' ? mode : autoBpModeOf(entry),
      drafts: {
        condition: entry?.condition || '',
        hitCondition: entry?.hitCondition || '',
        logMessage: entry?.logMessage || '',
      },
    })
  }
  const commitBpEdit = () => {
    if (!bpEdit) return
    dapStore.applyBpFields(scope, cwd, bpEdit.path, bpEdit.line, { ...bpEdit.drafts })
    setBpEdit(null)
    ctx?.notify?.('断点已更新')
  }

  /** 断点行右键菜单动作分发（菜单数据由 buildBpRowMenu 产出）。 */
  const runBpRowAction = (action, row) => {
    if (action === 'remove') { removeBp(row); return }
    if (action === 'enable' || action === 'disable') {
      dapStore.setBpEnabled(scope, cwd, row.path, row.entry.line, action === 'enable')
      return
    }
    const mode = action === 'edit-condition' ? BP_MODE.EXPRESSION
      : action === 'edit-hit-count' ? BP_MODE.HIT_COUNT
      : action === 'edit-logpoint' ? BP_MODE.LOG_MESSAGE
      : undefined
    openBpRowEditor(row.path, row.entry.line, row.entry, mode)
  }

  /** 段头「新建断点」：条件断点/记录点落在活动编辑器光标行（已有断点则直接编辑不翻转）。 */
  const addBpAtCursor = (mode) => {
    const ed = ctx?.editor?.()
    const path = editorModelPathOf(ed)
    const line = ed?.getPosition?.()?.lineNumber
    if (!path || !line || !Number.isFinite(line)) { ctx?.notify?.('无活动文件，无法添加断点'); return }
    const existing = (dapStore.bpMapOf(scope)[path] ?? []).find((it) => it.line === line)
    if (!existing) dapStore.toggleAt(scope, cwd, path, line)
    const entry = (dapStore.bpMapOf(scope)[path] ?? []).find((it) => it.line === line)
    if (entry) openBpRowEditor(path, line, entry, mode)
  }

  /** ⚙ 打开/新建调试配置：存在即跳转；缺失经确认后写模板（edrv.save 无 rev 仅用于新建，绝不覆盖已有文件）。 */
  const openLaunchConfig = async () => {
    if (!ctx?.cwd) { ctx?.notify?.('无工作区，无法定位 ' + LAUNCH_REL); return }
    try {
      const probe = await rpc('edrv.read', { sessionId: ctx?.sessionId, path: LAUNCH_REL }).catch(() => null)
      if (probe?.ok) { ctx?.openFile?.(LAUNCH_REL); return }
    } catch { /* 探活失败按缺失处理 */ }
    if (ctx?.confirm && !ctx.confirm('未找到 ' + LAUNCH_REL + '，是否创建调试配置模板？')) return
    try {
      const saved = await rpc('edrv.save', { sessionId: ctx?.sessionId, path: LAUNCH_REL, content: LAUNCH_TEMPLATE })
      if (!saved?.ok) { ctx?.notify?.(saved?.error || '创建 ' + LAUNCH_REL + ' 失败'); return }
      void dapStore.ensureConfigs(true)
      ctx?.openFile?.(LAUNCH_REL)
      ctx?.notify?.('已创建 ' + LAUNCH_REL)
    } catch (error) {
      ctx?.notify?.('创建 ' + LAUNCH_REL + ' 失败：' + String(error))
    }
  }

  /** 段头动作按钮（hover 显隐，样式见 .edrv-dapseg-act）。 */
  const segAct = (key, label, title, onClick) => React.createElement('button', {
    key, className: 'edrv-dapseg-act', title,
    onClick: (e) => { e.stopPropagation(); onClick(e) },
  }, label)

  /** 折叠段壳：chevron + 标题 + 悬浮动作区 + 可折叠主体（高度由分栏 state 内联接管）。 */
  const section = (title, key, variant, actions, children) => {
    const folded = folds.has(key)
    return React.createElement('div', { className: 'edrv-dapseg edrv-dapseg-' + variant, key },
      React.createElement('div', { className: 'edrv-dapseg-head', onClick: () => toggleFold(key) },
        React.createElement('span', { className: 'edrv-dapseg-chevron', title: folded ? '展开' : '折叠' }, folded ? '▸' : '▾'),
        React.createElement('span', { className: 'edrv-dapseg-title' }, title),
        React.createElement('span', { style: { flex: 1 } }),
        ...(folded ? [] : (actions || []))),
      ...(folded ? [] : [React.createElement('div', {
        className: 'edrv-dapseg-body', style: { height: (heights[key] ?? 200) + 'px' },
      }, ...children)]))
  }

  /** 段间分隔条（两侧段都展开时才渲染；拖动调整相邻两段高度占比）。 */
  const sash = (above: SplitKey, below: SplitKey) => (folds.has(above) || folds.has(below) ? null : React.createElement('div', {
    key: 'sash-' + above + '-' + below,
    className: 'edrv-dapseg-sash' + (splitDragging ? ' dragging' : ''),
    title: '拖动调整上下两段高度占比',
    onPointerDown: startSplitDrag(above, below),
  }))

  const renderVarRow = (row) => {
    const v = row.variable
    const depth = row.depth + 1
    return React.createElement('div', { key: row.key, className: 'edrv-dapvar', style: { paddingLeft: 8 + depth * 12 } },
      v.ref > 0
        ? React.createElement('button', {
            className: 'edrv-dapvar-tw', title: expanded.has(v.ref) ? '折叠' : '展开',
            onClick: () => { void expandVar(v.ref) },
          }, expanded.has(v.ref) ? '▾' : '▸')
        : React.createElement('span', { className: 'edrv-dapvar-tw' }, ''),
      React.createElement('span', { className: 'edrv-dapvar-name', title: v.name }, v.name),
      React.createElement('span', { className: 'edrv-dapvar-val', title: v.value }, v.value),
      (v.type ? React.createElement('span', { className: 'edrv-dapvar-type' }, v.type) : null))
  }

  const stackRows = stacks.length
    ? stacks.map((f) => React.createElement('div', {
        key: f.id,
        className: 'edrv-dapframe' + (f.id === snap.selectedFrameId ? ' selected' : ''),
        title: f.rawFile,
        onClick: () => {
          dapStore.selectFrame(f.id)
          const target = f.file || f.rawFile
          if (target) ctx?.openFileAt?.(target, f.line, 1)
        },
      },
        React.createElement('span', { className: 'edrv-dapframe-name' }, f.name || '(anonymous)'),
        React.createElement('span', { className: 'edrv-dapframe-loc' }, (f.file || f.rawFile) + ':' + f.line)))
    : [React.createElement('div', { key: 'empty', className: 'edrv-dapempty' }, paused ? '（无调用栈）' : '暂停时显示调用堆栈')]

  const scopeRows = scopes.flatMap((s) => [
    React.createElement('div', { key: 'scope' + s.name, className: 'edrv-dapscope' }, s.name),
    ...flattenVariableRows(varCache.get(s.ref) ?? [], expanded, varCache, { maxRows: 800 }).map(renderVarRow),
  ])
  const varRows = scopes.length ? scopeRows : [React.createElement('div', { key: 'e', className: 'edrv-dapempty' }, '暂停时显示变量')]

  const watchRows = watches.flatMap((expr) => {
    const hit = watchHits[expr]
    const rows = [React.createElement('div', { key: expr, className: 'edrv-dapwatch' },
      React.createElement('button', { className: 'edrv-dapwatch-x', title: '移除监视', onClick: () => removeWatch(expr) }, '×'),
      (hit?.ref > 0
        ? React.createElement('button', {
            className: 'edrv-dapvar-tw', title: expanded.has(hit.ref) ? '折叠 table' : '展开 table',
            onClick: () => { void expandVar(hit.ref) },
          }, expanded.has(hit.ref) ? '▾' : '▸')
        : React.createElement('span', { className: 'edrv-dapvar-tw' }, '')),
      React.createElement('span', { className: 'edrv-dapvar-name', title: expr }, expr),
      React.createElement('span', { className: 'edrv-dapvar-val', title: hit?.result || '' }, hit ? '= ' + hit.result : '= 不可用'),
      (hit?.type ? React.createElement('span', { className: 'edrv-dapvar-type' }, hit.type) : null))]
    if (hit?.ref > 0 && expanded.has(hit.ref)) {
      rows.push(...flattenVariableRows(varCache.get(hit.ref) ?? [], expanded, varCache, { maxRows: 500 }).map(renderVarRow))
    }
    return rows
  })
  const watchSection = section('监视', 'watch', 'watch', [
    segAct('watch-add', '＋', '新增监视表达式', focusWatchInput),
    segAct('watch-clear', '🗑', '移除全部监视', clearWatches),
  ], [
    ...watchRows,
    React.createElement('div', { key: 'add', className: 'edrv-dapwatch-add' },
      React.createElement('input', {
        ref: watchInputRef,
        className: 'edrv-daprepl-in', placeholder: '新增监视表达式，回车确认',
        value: watchDraft, onChange: (e) => setWatchDraft(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') addWatch() },
      })),
  ])

  // 断点行 + 行内编辑行（编辑中的行紧随其后展开，对齐 VS Code 断点视图的行内编辑形态）
  const bpSectionChildren = bpRows.length
    ? bpRows.flatMap((row) => {
        const base = row.path.split('/').pop() || row.path
        const dir = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : ''
        const ack = dapStore.ackOf(row.path, row.entry.line)
        const unverified = Boolean(ack && !ack.verified)
        const editing = bpEdit && bpEdit.path === row.path && bpEdit.line === row.entry.line
        const rows = [React.createElement('div', {
          key: row.path + ':' + row.entry.line, className: 'edrv-dapbp',
          title: '跳转到 ' + row.path + ':' + row.entry.line
            + (unverified && ack.message ? '（' + ack.message + '）' : ''),
          onClick: () => jumpBp(row),
          onContextMenu: (e) => { e.preventDefault(); setBpMenu({ x: e.clientX, y: e.clientY, row }) },
        },
          React.createElement('input', {
            type: 'checkbox', checked: row.entry.enabled, title: row.entry.enabled ? '禁用断点' : '启用断点',
            onChange: () => toggleBpEnabled(row),
            // 启停不连带跳转（整行可点后必须阻断冒泡）
            onClick: (e) => e.stopPropagation(),
          }),
          React.createElement('span', {
            className: 'edrv-dapbp-dot'
              + (row.entry.enabled ? '' : ' off')
              + (unverified ? ' unverified' : ''),
            title: unverified && ack.message ? ack.message : undefined,
          }),
          React.createElement('button', { className: 'edrv-dapbp-file', title: row.path }, base),
          React.createElement('span', { className: 'edrv-dapbp-dir', title: dir }, dir),
          React.createElement('span', { className: 'edrv-dapbp-line' }, row.entry.line),
          React.createElement('button', {
            className: 'edrv-dapbp-x', title: '删除断点',
            // 删除不连带跳转
            onClick: (e) => { e.stopPropagation(); removeBp(row) },
          }, '×'))]
        if (editing) {
          const fieldKey = fieldOfMode(bpEdit.mode)
          const modeItem = BP_WIDGET_MODES.find((m) => m.mode === bpEdit.mode) ?? BP_WIDGET_MODES[0]
          rows.push(React.createElement('div', { key: row.path + ':' + row.entry.line + ':edit', className: 'edrv-dapbp-edit' },
            React.createElement('select', {
              className: 'edrv-bpwidget-mode', title: '断点类型', value: String(bpEdit.mode),
              onChange: (e) => setBpEdit({ ...bpEdit, mode: Number(e.target.value) }),
            },
              BP_WIDGET_MODES.filter((m) => m.mode !== BP_MODE.WAIT).map((m) => React.createElement('option', { key: m.mode, value: String(m.mode) }, m.label))),
            React.createElement('input', {
              className: 'edrv-bpwidget-input', autoFocus: true, spellCheck: false,
              placeholder: modeItem?.placeholder ?? '',
              hidden: fieldKey === null,
              value: fieldKey ? (bpEdit.drafts[fieldKey] || '') : '',
              onChange: (e) => setBpEdit({ ...bpEdit, drafts: { ...bpEdit.drafts, [fieldKey]: e.target.value } }),
              onKeyDown: (e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitBpEdit(); return }
                if (e.key === 'Escape') { e.preventDefault(); setBpEdit(null) }
              },
            })))
        }
        return rows
      })
    : [React.createElement('div', { key: 'e', className: 'edrv-dapempty' }, '在编辑器行首点击或 F9 添加断点')]

  const bpSection = section('断点', 'breakpoints', 'breakpoints', [
    segAct('bp-new', '新建断点 ▾', '添加条件断点 / 记录点（落在当前编辑器光标行）', (e) => setNewBpMenu({ x: e.clientX, y: e.clientY })),
    (bpRows.length ? segAct('bp-toggle', allBpEnabled ? '⊘' : '◉', allBpEnabled ? '禁用所有断点' : '启用所有断点', () => dapStore.setAllBpEnabled(scope, cwd, !allBpEnabled)) : null),
    (bpRows.length ? segAct('bp-clear', '🗑', '删除所有断点', removeAllBps) : null),
  ], bpSectionChildren)

  const outputRows = dapStore.outputs().slice(-60).map((ev, idx) => React.createElement('div', { key: ev.seq + ':' + idx, className: 'edrv-daprepl-line out' }, ev.text?.trimEnd() || ''))

  // 顶部工具条：配置下拉（option 可用性置灰逻辑镜像编辑器浮动条）+ 控制按钮组
  const configReady = snap.configs.some((c) => snap.adapters.length === 0 || snap.adapters.find((a) => a.type === c.type)?.available === true)
  const toolbarBtn = (key, label, title, disabled, onClick) => React.createElement('button', {
    key, className: 'edrv-dappanel-run', title, disabled: disabled === true, onClick,
  }, label)

  // 断点行右键菜单（面板内行级操作：编辑字段 / 启停 / 删除；同 EditorView dapBpMenuEl 装配模式）
  const bpMenuEl = bpMenu
    ? React.createElement(ContextMenu, {
        x: bpMenu.x, y: bpMenu.y, onClose: () => setBpMenu(null),
        entries: buildBpRowMenu({ enabled: bpMenu.row.entry.enabled }).map((item) => ({
          id: item.id, label: item.label, separator: item.separator,
          onClick: () => runBpRowAction(item.id, bpMenu.row),
        })),
      })
    : null
  // 段头「新建断点」下拉（条件断点 / 记录点）
  const newBpMenuEl = newBpMenu
    ? React.createElement(ContextMenu, {
        x: newBpMenu.x, y: newBpMenu.y, onClose: () => setNewBpMenu(null),
        entries: [
          { id: 'add-conditional', label: '添加条件断点...', onClick: () => addBpAtCursor(BP_MODE.EXPRESSION) },
          { id: 'add-logpoint', label: '添加记录点...', onClick: () => addBpAtCursor(BP_MODE.LOG_MESSAGE) },
        ],
      })
    : null

  return React.createElement('div', { className: 'edrv-dappanel' },
    React.createElement('div', { className: 'edrv-dappanel-head' },
      ...(snap.candidates
        ? [
            React.createElement('select', {
              key: 'pick', className: 'edrv-dappanel-cfg-select', title: '选择附加目标进程（processName 命中多个候选）',
              value: String(pickPid || snap.candidates[0]?.pid || ''),
              onChange: (e) => setPickPid(Number(e.target.value)),
            },
              snap.candidates.map((it) => React.createElement('option', { key: it.pid, value: String(it.pid) },
                it.pid + ' : ' + it.name + (it.title ? ' — ' + it.title.slice(0, 44) : '')))),
            toolbarBtn('pick-ok', '✓', '附加到选中进程', false, () => dapStore.confirmPick(pickPid || snap.candidates![0]?.pid || 0)),
            toolbarBtn('pick-cancel', '✕', '取消', false, () => dapStore.cancelPick()),
          ]
        : [React.createElement('select', {
            key: 'cfg', className: 'edrv-dappanel-cfg-select',
            title: '调试配置（读取工作区 .dsh/launch.json；适配器由扩展清单 contributes.debuggers 提供）',
            value: snap.selectedConfig ?? '',
            onChange: (e) => dapStore.selectConfig(e.target.value),
          },
            snap.configs.length
              ? snap.configs.map((c) => {
                  const adapter = snap.adapters.find((a) => a.type === c.type)
                  const ready = snap.adapters.length === 0 || adapter?.available === true
                  const suffix = ready ? '' : '（' + (adapter?.reason || '未发现该类型适配器') + '）'
                  return React.createElement('option', { key: c.name, value: c.name, disabled: !ready }, c.name + suffix)
                })
              : React.createElement('option', { value: '' }, '无可用调试配置'))]),
      toolbarBtn('run', '▶', paused ? '继续（F5）' : '启动调试（F5）', !paused && (!configReady || dapActive), () => dapStore.startOrContinue()),
      toolbarBtn('cfg-gear', '⚙', '打开/新建调试配置（' + LAUNCH_REL + '）', !ctx?.cwd, () => { void openLaunchConfig() }),
      toolbarBtn('pause', '⏸', '暂停', !dapActive, () => { void dapStore.action('pause') }),
      toolbarBtn('next', '⤵', '单步跳过（F10）', !paused, () => { void dapStore.action('next') }),
      toolbarBtn('stepin', '↓', '单步步入（F11）', !paused, () => { void dapStore.action('stepIn') }),
      toolbarBtn('stepout', '↑', '单步步出（Shift+F11）', !paused, () => { void dapStore.action('stepOut') }),
      toolbarBtn('stop', '⏹', '停止（Shift+F5）', !dapActive, () => { void dapStore.stop() }),
      React.createElement('span', { className: 'edrv-dappanel-phase' + (paused ? ' paused' : '') }, PHASE_LABEL[snap.phase] || snap.phase),
      (snap.pid ? React.createElement('span', { className: 'edrv-dappanel-pid' }, 'pid ' + snap.pid) : null),
      React.createElement('span', { style: { flex: 1 } }),
      (snap.error ? React.createElement('span', { className: 'edrv-dappanel-err', title: snap.error }, '⚠') : null)),
    section('变量', 'variables', 'variables', [
      segAct('var-reload', '⟳', '刷新变量', () => setReloadTick((t) => t + 1)),
    ], varRows),
    sash('variables', 'watch'),
    watchSection,
    sash('watch', 'stack'),
    section('调用堆栈', 'stack', 'stack', [], stackRows),
    sash('stack', 'breakpoints'),
    bpSection,
    React.createElement('div', { className: 'edrv-daprepl' },
      React.createElement('div', { className: 'edrv-dapseg-head' }, '调试控制台'),
      React.createElement('div', { className: 'edrv-daprepl-log' },
        ...replLog.map((row, idx) => React.createElement('div', { key: idx, className: 'edrv-daprepl-line' },
          React.createElement('span', { className: 'edrv-dapvar-name' }, row.expr),
          React.createElement('span', { className: 'edrv-dapvar-val' }, '= ' + row.result))),
        ...outputRows),
      React.createElement('input', {
        className: 'edrv-daprepl-in', placeholder: paused ? '输入表达式求值，回车执行（如 self.itemId）' : '暂停时才可求值',
        disabled: !paused, value: replDraft,
        onChange: (e) => setReplDraft(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') void runRepl() },
      })),
    bpMenuEl,
    newBpMenuEl)
}
