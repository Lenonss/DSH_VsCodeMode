/**
 * dsh-vscode-mode client — live SVN update dialog with bounded virtual rows.
 * @author ddj 2026年09月24号
 */
import React from 'react'
import type { SvnUpdateRow, SvnUpdateState } from '../../shared/svn.js'
import { copyText } from '../copyText.js'
import { rpc } from '../rpc.js'
import { absoluteOf } from '../tabActions.js'
import { ContextMenu } from './ContextMenu.js'
import type { ContextMenuEntry } from './ContextMenu.js'
import { ModalShell } from './ModalShell.js'
import { updateActs, updateCloseMode, updateDone, updateLocked, updateParent, updateRange, updateReady, updateType } from './svnUpdateModel.js'

interface UpdateProps {
  sessionId?: string
  cwd?: string | null
  path: string
  resumeJobId?: string
  childOverlay?: boolean
  onClose: () => void
  onDone: (state: SvnUpdateState) => void
  onNote: (message: string) => void
  onShowLog: (path: string, jobId: string) => void
  onCompare: (path: string, revision: number, jobId: string) => void
  onOpenFile: (path: string) => void
  onOpenWith: (path: string) => void
  onOpenParent: (path: string) => void
}
interface UpdateMenu { x: number; y: number; row: SvnUpdateRow; kind: string }

/**
 * 仅恢复明确匹配的原任务；失败时不重新触发一次 SVN 更新。
 * @author ddj 2026年09月24号
 * @param props 会话与更新目标
 * @returns 已启动或已恢复的任务
 */
async function connectUpdate(props: UpdateProps): Promise<SvnUpdateState> {
  const result = props.resumeJobId
    ? await rpc('svn.updateActive', { sessionId: props.sessionId })
    : await rpc('svn.updateStart', { sessionId: props.sessionId, path: props.path })
  if (!result.ok) throw new Error(result.error)
  const job = 'job' in result ? result.job : result
  if (!job || (props.resumeJobId && job.jobId !== props.resumeJobId)) throw new Error('上次 SVN 更新结果已过期')
  return job
}

/**
 * 按后端有效序号剔除过期行；无新行时保留数组身份，避免多余渲染。
 * @author ddj 2026年09月24号
 * @param previous 当前可视记录
 * @param result 本次增量响应
 * @returns 新记录集
 */
function mergeUpdateRows(previous: SvnUpdateRow[], result: { offset: number; rows: SvnUpdateRow[] }): SvnUpdateRow[] {
  if (!result.rows.length && (previous[0]?.seq ?? result.offset) >= result.offset) return previous
  return previous.filter((row) => row.seq >= result.offset).concat(result.rows).slice(-20_000)
}

/**
 * 轮询状态：保留已收到的行，后端页大小与 UI 可见行数独立。
 * @author ddj 2026年09月24号
 * @param props 窗口目标与回调
 * @returns 状态、行、连接错误
 */
function useUpdateJob(props: UpdateProps) {
  const [state, setState] = React.useState<SvnUpdateState | null>(null)
  const [rows, setRows] = React.useState<SvnUpdateRow[]>([])
  const [error, setError] = React.useState('')
  const [pendingRows, setPendingRows] = React.useState(false)
  const doneRef = React.useRef('')
  const onDoneRef = React.useRef(props.onDone)
  onDoneRef.current = props.onDone

  /**
   * 仅在目标变化时连接任务，销毁时停止客户端轮询但不隐式取消更新。
   * @author ddj 2026年09月24号
   * @returns 轮询释放回调
   */
  const watchJob = () => {
    let alive = true
    let busy = false
    let jobId = ''
    let since = 0
    /**
     * 每轮至多请求一页，等待下一轮继续追赶后台任务。
     * @author ddj 2026年09月24号
     */
    const poll = async () => {
      if (!alive || busy || !jobId) return
      busy = true
      try {
        const result = await rpc('svn.updatePoll', { sessionId: props.sessionId, jobId, since })
        if (!alive) return
        if (!result.ok) { setError(result.error); return }
        setError('')
        since = result.nextSeq
        const backlog = result.nextSeq < result.totalSeq
        setPendingRows(backlog)
        setState(result)
        setRows((previous) => mergeUpdateRows(previous, result))
        if (updateDone(result.phase) && !backlog) window.clearInterval(timer)
        if (updateDone(result.phase) && !backlog && doneRef.current !== jobId) {
          doneRef.current = jobId
          onDoneRef.current(result)
        }
        if (backlog && result.rows.length) window.setTimeout(() => { void poll() }, 0)
      } catch (cause) { if (alive) setError('连接更新任务失败：' + String(cause)) }
      finally { busy = false }
    }
    /**
     * 恢复原任务或首次启动；UI 错误可见但绝不自动重试 SVN update。
     * @author ddj 2026年09月24号
     */
    const connect = async () => {
      try {
        const job = await connectUpdate(props)
        if (!alive) return
        jobId = job.jobId
        setState(job)
        setPendingRows(updateDone(job.phase))
        void poll()
      } catch (cause) { if (alive) setError('连接更新任务失败：' + String(cause)) }
    }
    setRows([])
    setState(null)
    setError('')
    setPendingRows(false)
    doneRef.current = ''
    void connect()
    const timer = window.setInterval(() => { void poll() }, 350)
    return () => { alive = false; window.clearInterval(timer) }
  }
  React.useEffect(watchJob, [props.sessionId, props.path, props.resumeJobId])

  return { state, rows, error, pendingRows, setState }
}

/**
 * 中文计数只报告已观察到的条目，截断输出时 UI 会单独告警。
 * @author ddj 2026年09月24号
 * @param state 任务快照
 * @returns 可读的状态行
 */
function countText(state: SvnUpdateState | null): string {
  if (!state) return '等待 SVN 任务…'
  const c = state.counts
  return '合并 ' + c.G + '  ·  新增 ' + c.A + '  ·  删除 ' + c.D
    + '  ·  更新 ' + c.U + '  ·  冲突 ' + c.C + (c.R || c.E ? '  ·  其他 ' + (c.R + c.E) : '')
}

/**
 * 右键命令：可用性先经会话内路径守卫，再依据真实文件判型。
 * @author ddj 2026年09月24号
 * @param props 窗口回调
 * @param state 任务状态
 * @param menu 右键目标及文件判型
 * @param rows 当前结果列表
 * @param selected 已选序号
 * @returns 可点击动作列表
 */
function menuEntries(props: UpdateProps, state: SvnUpdateState, menu: UpdateMenu, rows: SvnUpdateRow[], selected: number[]): ContextMenuEntry[] {
  const { row, kind } = menu
  const actions = updateActs(row, state.phase, kind, state.revision)
  const rel = row.relPath ?? ''
  const picked = new Set(selected)
  const names = rows.filter((item) => picked.has(item.seq)).map((item) => item.relPath
    ? absoluteOf(item.relPath, props.cwd) : item.path)
  return [
    { id: 'compare', label: '与工作副本比较', disabled: !actions.compare, onClick: () => props.onCompare(rel, state.revision!, state.jobId) },
    { id: 'log', label: '查看日志', disabled: !actions.log, onClick: () => props.onShowLog(rel, state.jobId) },
    { id: 'open', label: '打开', disabled: !actions.open, separator: true, onClick: () => props.onOpenFile(rel) },
    { id: 'open-with', label: '打开方式…', disabled: !actions.openWith, onClick: () => props.onOpenWith(rel) },
    { id: 'parent', label: '打开父目录', disabled: !actions.parent, onClick: () => props.onOpenParent(updateParent(rel)) },
    { id: 'copy', label: selected.length > 1 ? '复制选中路径' : '复制路径', disabled: !actions.copy, separator: true,
      onClick: () => { void copyText(names.join('\n'), '已复制路径', props.onNote) } },
  ]
}

/**
 * 将一条增量行映射为高密度的三列；单元格显示工作副本内相对路径，完整绝对路径留在 title 中。
 * @author ddj 2026年09月24号
 * @param row 更新行
 * @param cwd 工作区目录
 * @param picked 是否选中
 * @param onPick 选择回调
 * @param onMenu 右键回调
 * @returns 行元素
 */
function rowElement(row: SvnUpdateRow, cwd: string | null | undefined, picked: boolean,
  onPick: (event: React.MouseEvent<HTMLDivElement>) => void,
  onMenu: (event: React.MouseEvent<HTMLDivElement>) => void): React.ReactElement {
  // 显示用相对路径（窄窗省略尾部时先保住文件名），悬浮与复制仍用完整绝对路径。
  const full = row.relPath ? absoluteOf(row.relPath, cwd) : (row.path || row.label)
  const path = row.relPath || row.path || row.label
  const tone = row.action === 'C' ? 'conflict' : row.action === 'D' ? 'deleted'
    : row.action === 'A' ? 'added' : row.action === 'G' ? 'merged' : 'updated'
  return React.createElement('div', {
    role: 'row', 'aria-selected': picked, className: 'edrv-update-row' + (picked ? ' is-selected' : ''),
    onClick: onPick, onContextMenu: onMenu, title: row.raw,
  },
    React.createElement('span', { role: 'cell', className: 'edrv-update-action tone-' + tone }, row.action ? row.label : '信息'),
    React.createElement('span', { role: 'cell', className: 'edrv-update-path', title: full }, path),
    React.createElement('span', { role: 'cell', className: 'edrv-update-type' }, row.action ? updateType(row.path) : ''))
}

/**
 * 观察列表尺寸并只跟随用户尚未滚离底部的更新结果。
 * @author ddj 2026年09月24号
 * @param count 当前记录数
 * @returns 虚拟列表视口、行高和滚动回调
 */
function useUpdateView(count: number) {
  const [scrollTop, setScrollTop] = React.useState(0)
  const [height, setHeight] = React.useState(350)
  const [compact, setCompact] = React.useState(() => window.innerWidth < 620)
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const followRef = React.useRef(true)
  const rowHeight = compact ? 44 : 28
  React.useEffect(() => {
    const list = listRef.current
    if (!list) return
    const observer = new ResizeObserver(() => setHeight(list.clientHeight))
    observer.observe(list)
    setHeight(list.clientHeight)
    const resize = () => setCompact(window.innerWidth < 620)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [])
  React.useLayoutEffect(() => {
    const list = listRef.current
    if (list && followRef.current) { list.scrollTop = list.scrollHeight; setScrollTop(list.scrollTop) }
  }, [count, rowHeight])
  /**
   * 用户离开底部后暂停自动滚动，保持当前文件可读。
   * @author ddj 2026年09月24号
   * @param event 列表滚动事件
   */
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const list = event.currentTarget
    followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    setScrollTop(list.scrollTop)
  }
  return { listRef, rowHeight, range: updateRange(count, scrollTop, height, rowHeight), onScroll }
}

/**
 * 行选择、右键文件判型与菜单状态只在可见行交互时运行。
 * @author ddj 2026年09月24号
 * @param props 窗口回调
 * @param rows 增量结果
 * @param state 任务状态
 * @returns 选择集和交互回调
 */
function useUpdateMenu(props: UpdateProps, rows: SvnUpdateRow[], state: SvnUpdateState | null) {
  const [selected, setSelected] = React.useState<number[]>([])
  const [menu, setMenu] = React.useState<UpdateMenu | null>(null)
  const anchorRef = React.useRef(0)
  const picked = React.useMemo(() => new Set(selected), [selected])
  /**
   * 支持普通、Ctrl 和 Shift 范围选择。
   * @author ddj 2026年09月24号
   * @param event 行点击事件
   * @param row 目标行
   */
  const pick = (event: React.MouseEvent<HTMLDivElement>, row: SvnUpdateRow) => {
    const index = rows.findIndex((item) => item.seq === row.seq)
    if (event.shiftKey) {
      const from = Math.min(index, anchorRef.current)
      const to = Math.max(index, anchorRef.current)
      setSelected(rows.slice(from, to + 1).map((item) => item.seq))
    } else if (event.ctrlKey || event.metaKey) {
      setSelected((previous) => previous.includes(row.seq)
        ? previous.filter((seq) => seq !== row.seq) : previous.concat(row.seq))
      anchorRef.current = index
    } else { setSelected([row.seq]); anchorRef.current = index }
  }
  /**
   * 先开放父目录/复制，再按真实磁盘类型启用文件级操作。
   * @author ddj 2026年09月24号
   * @param event 右键位置
   * @param row 目标行
   */
  const openMenu = (event: React.MouseEvent<HTMLDivElement>, row: SvnUpdateRow) => {
    event.preventDefault()
    event.stopPropagation()
    if (!state) return
    if (!picked.has(row.seq)) setSelected([row.seq])
    setMenu({ x: event.clientX, y: event.clientY, row, kind: 'loading' })
    if (!row.relPath || !updateDone(state.phase) || row.action === 'D') return
    void rpc('edrv.externalStat', { path: absoluteOf(row.relPath, props.cwd) }).then((outcome) => {
      setMenu((current) => current?.row.seq === row.seq
        ? { ...current, kind: outcome.ok ? outcome.kind : 'missing' } : current)
    }).catch(() => {})
  }
  return { selected, picked, menu, setMenu, pick, openMenu }
}

/**
 * 窗口标题和执行阶段（无活动任务时仍可展示目标）。
 * @author ddj 2026年09月24号
 * @param props 用户目标与关闭动作
 * @param state 任务状态
 * @param phase 当前阶段文案
 * @param closable 能否显式关闭
 * @param dismiss 确认后的关闭动作
 * @returns 标题元素
 */
function updateHead(props: UpdateProps, state: SvnUpdateState | null, phase: string, closable: boolean, dismiss: () => void): React.ReactElement {
  return React.createElement('header', { className: 'edrv-update-head' },
    React.createElement('div', { className: 'edrv-update-heading' },
      React.createElement('h3', null, 'SVN 更新'),
      React.createElement('span', { className: 'edrv-update-target', title: state?.target ?? props.path }, state?.target || '工作区根')),
    React.createElement('span', { className: 'edrv-update-phase', role: 'status' }, phase),
    React.createElement('button', {
      type: 'button', className: 'edrv-update-close', disabled: !closable,
      title: closable ? '关闭更新窗口' : '更新运行中；请先取消', 'aria-label': '关闭更新窗口', onClick: dismiss,
    }, '✕'))
}

/**
 * 固定列头与虚拟行区域；只渲染当前视口附近的条目。
 * @author ddj 2026年09月24号
 * @param props 工作区路径
 * @param rows 已收到的更新行
 * @param view 虚拟滚动视口
 * @param selection 行选择/菜单
 * @param finished 是否终态
 * @returns 表格元素
 */
function updateTable(props: UpdateProps, rows: SvnUpdateRow[], view: ReturnType<typeof useUpdateView>,
  selection: ReturnType<typeof useUpdateMenu>, finished: boolean): React.ReactElement {
  const visible = rows.slice(view.range.start, view.range.end)
  return React.createElement('div', { className: 'edrv-update-table', role: 'table', 'aria-label': 'SVN 更新文件明细', 'aria-rowcount': rows.length },
    React.createElement('div', { role: 'row', className: 'edrv-update-cols' },
      React.createElement('span', { role: 'columnheader' }, '操作'),
      React.createElement('span', { role: 'columnheader' }, '路径'),
      React.createElement('span', { role: 'columnheader', title: '仅对已知扩展名推断，非 SVN 属性' }, '类型（推断）')),
    React.createElement('div', { className: 'edrv-update-list', ref: view.listRef, role: 'rowgroup', onScroll: view.onScroll },
      React.createElement('div', { className: 'edrv-update-space', style: { height: rows.length * view.rowHeight } },
        visible.map((row, index) => React.createElement('div', {
          key: row.seq, className: 'edrv-update-pos',
          style: { top: (view.range.start + index) * view.rowHeight, height: view.rowHeight },
          'aria-rowindex': view.range.start + index + 1,
        }, rowElement(row, props.cwd, selection.picked.has(row.seq),
          (event) => selection.pick(event, row), (event) => selection.openMenu(event, row))))),
      !rows.length ? React.createElement('div', { className: 'edrv-update-empty' },
        finished ? '没有逐文件变更' : '等待 SVN 输出…') : null))
}

/**
 * 真实修订号、耗时和错误回显；输出不完整时醒目标记；
 * 被中断的操作留下 SVN 锁时明确引导先清理，避免用户反复重试。
 * @author ddj 2026年09月24号
 * @param state 任务快照
 * @param error 连接错误
 * @param cleaned 本次窗口内是否已执行过清理
 * @returns 状态元素
 */
function updateStatus(state: SvnUpdateState | null, error: string, cleaned: boolean): React.ReactElement {
  const duration = state ? (state.elapsedMs / 1000).toFixed(1) + ' 秒' : ''
  const locked = updateLocked(state)
  return React.createElement('div', { className: 'edrv-update-telemetry', role: 'status' },
    error || state?.error ? React.createElement('span', { className: 'edrv-update-error' }, error || state?.error) : null,
    locked ? React.createElement('span', { className: 'edrv-update-locked' },
      cleaned ? '已执行清理，可重新点击「SVN 更新」' : '工作副本被上次中断的操作锁定：请先执行清理再重试') : null,
    React.createElement('span', null, (state?.revision ? 'r' + state.revision + '  ·  ' : '') + '已耗时 ' + duration),
    state?.truncated ? React.createElement('span', { className: 'edrv-update-warning' }, '输出已截断，列表与计数可能不完整') : null)
}

/**
 * 运行时仅可取消，结束后才可查看日志或关闭；
 * 失败于工作副本锁定时额外提供一次清理入口（不自动重试更新）。
 * @author ddj 2026年09月24号
 * @param props 窗口动作
 * @param state 任务快照
 * @param closable 能否关闭
 * @param finished 是否终态
 * @param cancel 终止请求
 * @param dismiss 明确关闭或暂时退出窗口
 * @param confirmClose 是否要提示后台可能继续运行
 * @param cleaned 本次窗口内是否已执行过清理
 * @param cleanup 请求清理工作副本
 * @returns 操作区
 */
function updateFoot(props: UpdateProps, state: SvnUpdateState | null, closable: boolean,
  finished: boolean, cancel: () => void, dismiss: () => void, confirmClose: boolean,
  cleaned: boolean, cleanup: () => void): React.ReactElement {
  const locked = updateLocked(state)
  return React.createElement('footer', { className: 'edrv-update-foot' },
    React.createElement('span', { className: 'edrv-update-counts' }, countText(state)),
    locked ? React.createElement('button', {
      type: 'button', className: 'edrv-svn-act edrv-update-cleanup', disabled: !finished || cleaned,
      title: locked && !cleaned ? '执行 svn cleanup，清除中断残留的锁（不撤销已完成的更新）' : '已执行过清理',
      onClick: cleanup,
    }, cleaned ? '已清理' : '执行清理') : null,
    React.createElement('button', { type: 'button', className: 'edrv-svn-act', disabled: !finished || !state,
      onClick: () => state && props.onShowLog(state.target, state.jobId) }, '查看日志'),
    React.createElement('button', { type: 'button', className: 'edrv-svn-act edrv-update-primary', disabled: !closable, onClick: dismiss }, confirmClose ? '暂时关闭' : '确定'),
    React.createElement('button', { type: 'button', className: 'edrv-svn-act',
      disabled: !state || updateDone(state.phase) || state.phase === 'cancelling', onClick: cancel }, '取消更新'))
}

/**
 * 原生 SVN 更新窗口；任务只在用户打开后启动，运行中不静默关闭。
 * @author ddj 2026年09月24号
 * @param props 目标与 EditorView 的复用动作
 * @returns 更新窗口
 */
export function SvnUpdateDialog(props: UpdateProps): React.ReactElement {
  const { state, rows, error, pendingRows, setState } = useUpdateJob(props)
  const [cleaned, setCleaned] = React.useState(false)
  const view = useUpdateView(rows.length)
  const selection = useUpdateMenu(props, rows, state)
  const processFinished = updateDone(state?.phase)
  const finished = updateReady(state?.phase, pendingRows)
  const closeMode = updateCloseMode(finished, error, Boolean(state), Boolean(selection.menu || props.childOverlay))
  const closable = closeMode.explicit
  /**
   * 确认后请求终止任务；已变更文件不会自动回滚。
   * @author ddj 2026年09月24号
   */
  const cancel = () => {
    if (!state || processFinished || state.phase === 'cancelling') return
    if (!window.confirm('停止 SVN 更新？已更新的文件不会回滚，工作副本可能仅完成一部分。')) return
    void rpc('svn.updateCancel', { sessionId: props.sessionId, jobId: state.jobId }).then((outcome) => {
      if (outcome.ok) setState(outcome)
      else props.onNote(outcome.error)
    }).catch((cause) => props.onNote('取消更新失败：' + String(cause)))
  }
  /**
   * 清理只修复工作副本锁，绝不自动重跑更新；结果经提示条回报。
   * @author ddj 2026年09月28号
   */
  const cleanup = () => {
    if (!updateLocked(state) || cleaned) return
    if (!window.confirm('对工作副本执行 svn cleanup？这会清除上次中断残留的锁，不会撤销已完成的更新。')) return
    void rpc('svn.cleanup', { sessionId: props.sessionId }).then((outcome) => {
      if (outcome.ok) { setCleaned(true); props.onNote('清理完成，可重新执行 SVN 更新') }
      else props.onNote(outcome.error)
    }).catch((cause) => props.onNote('清理失败：' + String(cause)))
  }
  /**
   * 连接中断时只暂时关闭窗口；从不声称 SVN 更新已经停止。
   * @author ddj 2026年09月24号
   */
  const dismiss = () => {
    if (!closeMode.explicit) return
    if (closeMode.confirm && !window.confirm('更新任务连接中断。关闭窗口不会停止可能仍在运行的 SVN 更新，确定暂时关闭？')) return
    props.onClose()
  }
  const phase = pendingRows && processFinished ? '正在加载更新明细…'
    : state?.phase === 'completed' ? '更新完成' : state?.phase === 'failed' ? '更新失败'
    : state?.phase === 'cancelled' ? '更新已停止' : state?.phase === 'cancelling' ? '正在停止…' : '正在更新…'
  return React.createElement(ModalShell, {
    dialogClass: 'edrv-update-dialog', width: 'min(1320px, calc(100vw - 48px))',
    cardStyle: { height: 'min(680px, calc(100vh - 48px))', boxSizing: 'border-box', maxHeight: 'none' },
    closeOnEsc: closeMode.passive, closeOnMask: closeMode.passive, onClose: dismiss,
  },
    updateHead(props, state, phase, closable, dismiss),
    updateTable(props, rows, view, selection, finished),
    updateStatus(state, error, cleaned),
    updateFoot(props, state, closable, finished, cancel, dismiss, closeMode.confirm, cleaned, cleanup),
    state?.rawTail && (state.phase === 'failed' || state.truncated)
      ? React.createElement('details', { className: 'edrv-update-raw' },
          React.createElement('summary', null, '查看原始输出'), React.createElement('pre', null, state.rawTail)) : null,
    selection.menu && state ? React.createElement(ContextMenu, {
      x: selection.menu.x, y: selection.menu.y,
      entries: menuEntries(props, state, selection.menu, rows, selection.selected), zIndex: 193,
      onClose: () => selection.setMenu(null),
    }) : null)
}
