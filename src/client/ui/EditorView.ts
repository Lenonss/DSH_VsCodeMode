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
import { createDiffRenderer } from '../monaco/diffRender.js'
import { ST, callIdAttr, noopHunk, summarize } from '../state/records.js'
import { diffRegions } from '../state/regions.js'
import { QuickOpen } from './QuickOpen.js'
import { DiffBox } from './DiffBox.js'
import { DiffBarEmpty } from './DiffBarEmpty.js'
import { DiffLauncher } from './DiffLauncher.js'

/**
 * 中央编辑区：文件页签（脏点/关闭/打开路径）+ Ctrl+P 搜索 + Monaco 编辑器 +
 * 底部差异条（DiffBox/空态）+ 全局差异下拉（DiffLauncher）+ 状态栏。
 * @param props.sessionId 会话 id
 * @param props.schedule 延时调度（ctx.timeout）
 */
export function EditorView(props) {
  const sessionId = props?.sessionId
  const schedule = props.schedule
  const [monaco, setMonaco] = React.useState(null)
  const [monacoErr, setMonacoErr] = React.useState(null)
  const [records, setRecords] = React.useState({})
  const [tabs, setTabs] = React.useState([])
  const [active, setActive] = React.useState(null)
  const [dirtyMap, setDirtyMap] = React.useState({})
  const [content, setContent] = React.useState(null)
  const [status, setStatus] = React.useState('')
  const [error, setError] = React.useState(null)
  const [openInput, setOpenInput] = React.useState(false)
  const [pathDraft, setPathDraft] = React.useState('')
  const [cursor, setCursor] = React.useState('')
  const [launcherOpen, setLauncherOpen] = React.useState(false)
  const [launcherTab, setLauncherTab] = React.useState('pending')
  const [hoverAct, setHoverAct] = React.useState(null) // { region, top } 编辑区 hover 差异块的 Keep/Undo 浮层
  const [diffIdx, setDiffIdx] = React.useState(0) // 当前文件内差异位置（x/x 显示）
  const [fileIdx, setFileIdx] = React.useState(0) // 全局差异文件位置（x/x 文件 显示）
  const editorRef = React.useRef(null)
  const monacoRef = React.useRef(null)
  const modelsRef = React.useRef(new Map())
  const saveTimerRef = React.useRef(null)
  const loadSeqRef = React.useRef(0)
  const programmaticRef = React.useRef(false)
  const bootRef = React.useRef(false)
  const pendingFocusRef = React.useRef(null) // { path, region } 内容加载后跳转
  const hoverRegionsRef = React.useRef([]) // 当前 pending 区域镜像（稳定回调读取）
  const lineRegionMapRef = React.useRef(new Map()) // 行 → 区域 映射（hover 命中）
  const hoverKeyRef = React.useRef(null) // 当前 hover 区域 key（区域不变不重渲染）
  const hoverTopRef = React.useRef(null) // 当前 hover 浮窗 top（滚动后位置变化才重定位）
  const hoverRightRef = React.useRef(null) // 浮窗右侧避让 Monaco 缩略栏
  const hideTimerRef = React.useRef(null) // 延迟隐藏计时器（防闪烁）
  const hoverEditorRef = React.useRef(false) // 鼠标是否仍在编辑器命中区
  const hoverPanelRef = React.useRef(false) // 鼠标是否已进入 Keep/Undo 浮层
  const batchBusyRef = React.useRef(false) // 批量 Keep All/Undo All 防重入
  const diffRendererRef = React.useRef(null)
  if (!diffRendererRef.current) diffRendererRef.current = createDiffRenderer((sid, t) => dbg(sid, t))

  const currentRecords = React.useMemo(() => {
    const list = []
    for (const rec of Object.values(records)) if (rec.path === active) list.push(rec)
    return list
  }, [records, active])

  const regions = React.useMemo(() => diffRegions(currentRecords, content).filter((r) => !r.superseded), [currentRecords, content])
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

  const closeTab = (path) => {
    flushSave()
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path)
      if (idx < 0) return prev
      const next = prev.filter((t) => t.path !== path)
      if (active === path) setActive(next[idx] ? next[idx].path : (next[idx - 1] ? next[idx - 1].path : null))
      return next
    })
  }

  const refreshRecords = () => {
    if (!sessionId) return
    rpc('edrv.list', { sessionId }).then((res) => {
      if (!res || !res.ok || !Array.isArray(res.records)) return
      const map = {}
      for (const r of res.records) map[r.callId] = r
      setRecords(map)
    }).catch((e) => setError('list异常:' + String(e)))
  }

  const loadContent = (path, sid) => {
    const seq = ++loadSeqRef.current
    rpc('edrv.read', { sessionId: sid, path }).then((res) => {
      if (seq !== loadSeqRef.current || path !== active) return
      if (res && res.ok) { setContent(res.content); setStatus('已加载') }
      else { setError(res?.error ? String(res.error) : '读取失败'); setStatus('读取失败') }
    }).catch((e) => { if (seq === loadSeqRef.current) { setError('read异常:' + String(e)); setStatus('读取失败') } })
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
    const onOpen = (e) => {
      const p = e?.detail?.path
      if (p) addTab(p, true)
    }
    const onShowLauncher = () => setLauncherOpen(true)
    window.addEventListener('edrv:open-editor', onOpen)
    window.addEventListener('edrv:show-launcher', onShowLauncher)
    return () => {
      window.removeEventListener('edrv:open-editor', onOpen)
      window.removeEventListener('edrv:show-launcher', onShowLauncher)
    }
  }, [sessionId])

  // localStorage v2 恢复页签
  React.useEffect(() => {
    if (bootRef.current || !sessionId) return
    bootRef.current = true
    try {
      const raw = localStorage.getItem('edrv.editor.v2.' + String(sessionId))
      if (raw) {
        const saved = JSON.parse(raw)
        if (Array.isArray(saved.tabs) && saved.tabs.length) {
          setTabs(saved.tabs.map((p) => ({ path: p })))
          if (typeof saved.active === 'string') setActive(saved.active)
        }
      }
    } catch (e) { /* 损坏忽略 */ }
  }, [sessionId])

  React.useEffect(() => {
    if (!sessionId) return
    try { localStorage.setItem('edrv.editor.v2.' + String(sessionId), JSON.stringify({ tabs: tabs.map((t) => t.path), active })) }
    catch (e) { /* 忽略 */ }
  }, [tabs, active, sessionId])

  React.useEffect(() => {
    if (!active) return
    setContent(null); setStatus('加载中…')
    loadContent(active, sessionId)
  }, [active, sessionId])

  React.useEffect(() => {
    if (monaco || monacoErr) return
    let alive = true
    loadMonaco().then((m) => { if (alive) setMonaco(m) }).catch((e) => { if (alive) { setMonacoErr(String(e?.message ?? e)); setStatus('Monaco 不可用') } })
    return () => { alive = false }
  }, [monaco, monacoErr])

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
        setDirtyMap((d) => Object.assign({}, d, { [active]: false }))
        refreshRecords()
        emitRefresh()
      } else { setStatus('保存失败'); setError(res?.error ? String(res.error) : '保存失败') }
    }).catch((e) => { setStatus('保存失败'); setError('保存异常:' + String(e)) })
  }

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
  }, [monaco, active, content])

  // 行内差异自绘（decorations / view zones / minus overlay）→ diffRenderer
  React.useEffect(() => {
    if (!monaco || !editorRef.current || !active || content === null) return
    diffRendererRef.current.render(monaco, editorRef.current, pendingRegions, sessionId)
  }, [monaco, active, content, pendingRegions])

  React.useEffect(() => () => {
    flushSave()
    diffRendererRef.current?.dispose?.()
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
    const ed = m.editor.create(node, {
      value: '',
      language: 'plaintext',
      theme: 'vs',
      fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: true, scale: 1 },
      glyphMargin: true,
      lineDecorationsWidth: 16,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 2,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: { top: 8 },
    })
    ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => { flushSave(); doSave(false) })
    ed.onDidChangeModelContent(() => {
      if (!ed.getModel() || programmaticRef.current) return
      onEdit()
    })
    ed.onDidChangeCursorPosition((e) => {
      setCursor('Ln ' + e.position.lineNumber + ', Col ' + e.position.column)
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
    editorRef.current = ed
  }, [])

  // 打开文件后的差异聚焦跳转（内容/差异就绪后执行一次）
  React.useEffect(() => {
    const pf = pendingFocusRef.current
    if (!pf || pf.path !== active || content === null) return
    const target = pf.region || pendingRegions[0]
    const ed = editorRef.current
    if (!target || !ed) return
    pendingFocusRef.current = null
    ed.revealLineInCenter(Math.max(1, target.start ?? 1))
    ed.setPosition({ lineNumber: Math.max(1, target.start ?? 1), column: 1 })
    ed.focus()
  }, [active, content, pendingRegions])

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

  const reloadFile = () => {
    if (!active) return
    loadContent(active, sessionId)
    refreshRecords()
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

  const acceptFile = () => { for (const r of pendingRegions) actHunk(r, false) }
  const undoFile = () => { for (const r of [...pendingRegions].reverse()) actHunk(r, true) }

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
   * 批量处理所有差异文件：采纳全部 / 不采纳全部。不采纳按 at 降序（新改先回滚）串行执行。
   * @author ddj 2026年08月20号
   * @param reject true=全部不采纳（回滚），false=全部采纳
   */
  const actAllPending = (reject) => {
    if (batchBusyRef.current || !allPending.length) return
    batchBusyRef.current = true
    const list = reject ? [...allPending].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.idx - a.idx)) : allPending
    let ok = 0, fail = 0
    const run = async () => {
      for (const r of list) {
        if (await actHunk(r, reject, true)) ok++
        else fail++
      }
      batchBusyRef.current = false
      reloadFile()
      emitRefresh()
      setStatus((reject ? '已不采纳 ' : '已采纳 ') + ok + ' 处差异' + (fail ? '，' + fail + ' 处失败' : ''))
      if (fail) setError(fail + ' 处差异处理失败（可能已被后续修改影响），可刷新后重试')
    }
    run()
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

  const openFile = (path, focusDiff) => {
    if (!path) return
    addTab(path, true)
    if (focusDiff) pendingFocusRef.current = { path, region: null }
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
      onClick: () => { if (t.path !== active) { flushSave(); setActive(t.path) } },
    },
      React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 } }, t.path.split(/[\\/]/).pop() || t.path),
      (dirtyMap[t.path] ? React.createElement('span', { className: 'edrv-tab-dot' }) : null),
      React.createElement('span', { className: 'edrv-tab-x', onClick: (e) => { e.stopPropagation(); closeTab(t.path) } }, '×'))),
    (openInput
      ? React.createElement('input', { className: 'edrv-path-input', autoFocus: true, placeholder: '输入工作区相对/绝对路径，回车打开', value: pathDraft, onChange: (e) => setPathDraft(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') openPath(); if (e.key === 'Escape') setOpenInput(false) } })
      : React.createElement('button', { className: 'edrv-tab-add', title: '打开文件（输入路径）', onClick: () => setOpenInput(true) }, '+')))

  const pathBar = React.createElement('div', { className: 'edrv-pathbar', title: active || '' },
    React.createElement('span', { className: 'edrv-pb-name' }, active ? String(active).split(/[\\/]/).pop() : '未打开文件'),
    React.createElement('span', { className: 'edrv-pb-full' }, active || '使用右上搜索框 (Ctrl+P) 打开文件'))

  const tabRow = React.createElement('div', { style: { display: 'flex', alignItems: 'center', background: 'var(--dsw-alias-bg-layer-1,transparent)', flexShrink: 0 } },
    tabsEl,
    React.createElement(QuickOpen, { sessionId, onOpen: (p) => openFile(p, false) }))

  const statusBar = React.createElement('div', { className: 'edrv-statusbar' },
    React.createElement('span', null, '编辑'),
    React.createElement('span', null, active ? langOf(active) : ''),
    React.createElement('span', null, cursor),
    (status ? React.createElement('span', null, status) : null),
    React.createElement('span', { style: { flex: 1 } }),
    (sum.totalFiles > 0
      ? React.createElement('button', { className: 'edrv-diffchip', title: '打开差异总览/归档', onClick: () => setLauncherOpen((o) => !o) }, '⚠ 差异 ' + sum.totalFiles + ' 文件')
      : null),
    React.createElement('button', { className: 'edrv-chip-btn', title: '刷新', onClick: reloadFile }, '⟳'))

  const otherFiles = sum.pendingFiles.filter((f) => f.path !== active)

  let body
  if (!monaco && !monacoErr) {
    body = React.createElement('div', { className: 'edrv-empty' }, '正在加载 Monaco 编辑器…')
  } else if (monacoErr) {
    body = React.createElement('div', { className: 'edrv-empty' },
      React.createElement('div', null, 'Monaco 编辑器加载失败：' + String(monacoErr)),
      React.createElement('div', { style: { fontSize: 11 } }, '请确认插件包 assets/vendor/monaco 完整（/edrv/vendor 路由可达）'))
  } else if (!active) {
    body = React.createElement('div', { className: 'edrv-empty' },
      React.createElement('div', null, '暂无打开的文件'),
      React.createElement('div', { style: { fontSize: 12 } }, '使用右上搜索框 (Ctrl+P) 打开工作区文件；agent 修改文件后顶部会出现差异角标'))
  } else if (content === null) {
    body = React.createElement('div', { className: 'edrv-empty' }, '加载中…')
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

  const overlay = launcherOpen
    ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 30 }, onClick: () => setLauncherOpen(false) }),
        React.createElement(DiffLauncher, { sessionId, sum, tab: launcherTab, onClose: () => setLauncherOpen(false), onOpenFile: (p) => { openFile(p, true); setLauncherOpen(false) } }))
    : (pendingRegions.length > 0
        ? React.createElement(DiffBox, {
            pendingRegions, staleRegions,
            onAct: actHunk,
            onAcceptFile: acceptFile,
            onUndoFile: undoFile,
            onAcceptAllFiles: acceptAllFiles,
            onUndoAllFiles: undoAllFiles,
            allPendingCount: allPending.length,
            onRollback: rollbackFile,
            onJump: jumpTo,
            otherFiles,
            onOpenOther: (p) => openFile(p, true),
            onOpenLauncher: (tab) => { setLauncherTab(tab || 'pending'); setLauncherOpen(true) },
            onRefresh: reloadFile,
            activePath: active,
            diffIdx, diffTotal: pendingRegions.length,
            fileIdx, fileTotal: sum.pendingFiles.length,
            onPrevDiff: () => gotoDiff(-1), onNextDiff: () => gotoDiff(1),
            onPrevFile: () => gotoFile(-1), onNextFile: () => gotoFile(1),
          })
        : (sum.pendingFiles.length > 0
            ? React.createElement(DiffBarEmpty, {
                sum, active, staleCount: staleRegions.length,
                onNextFile: () => { if (sum.pendingFiles.length) openFile(sum.pendingFiles[0].path, true) },
                onOpenLauncher: (tab) => { setLauncherTab(tab || 'pending'); setLauncherOpen(true) },
                onRefresh: reloadFile,
              })
            : null))

  return React.createElement('div', { 'data-edrv-view': '1', style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base,transparent)', overflow: 'hidden' } },
    pathBar,
    tabRow,
    React.createElement('div', { style: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
      body,
      hoverEl,
      overlay),
    statusBar)
}
