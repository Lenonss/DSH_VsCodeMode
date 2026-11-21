/**
 * dsh-vscode-mode client — HTML 计划页签面板：状态条 + 官方动作 + 沙箱 iframe。
 *
 * 页面由 agent 按 html-plan 技能打包成单文件；这里只负责呈现与转交用户动作：
 * 同意执行 / 继续规划走官方 userQuestions 答案通道，退出计划模式走官方 /plan off，
 * 页面答复经桥接脚本回填对话输入框。iframe 一律 sandbox 且不给 allow-same-origin。
 * @author ddj 2026年11月21号
 */
import React from 'react'
import { rpc } from '../rpc.js'
import {
  buildPlanSrcDoc,
  derivePlanUiState,
  planPagePathOf,
  resolvePlanPagePath,
  unresolvedRuntimeRefs,
  type PendingReview,
} from './planPage.js'
import {
  answerPlanReview,
  exitPlanMode,
  fillComposer,
  readPendingReview,
  readPlanProjection,
  revealPlanReview,
  submitPlanResponse,
  subscribePlanFaces,
} from './planActions.js'

/** 面板输入（由 EditorView 从计划页签装配）。 */
export interface HtmlPlanPanelProps {
  sessionId?: string
  cwd?: string
  address?: string
  title?: string
  htmlPath?: string
  markdown?: string
}

/** 本地刚完成的动作（用于状态文案，不持久化）。 */
type PlanAct = 'approved' | 'revising' | 'exited'
type ReadResult = { ok?: boolean; content?: string; error?: string }

/**
 * HTML 计划面板。
 * @author ddj 2026年11月21号
 * @param props 会话/工作区/计划页路径与标题
 * @returns 计划页签正文
 */
export function HtmlPlanPanel(props: HtmlPlanPanelProps) {
  const sessionId = String(props.sessionId ?? '')
  const declared = String(props.htmlPath ?? planPagePathOf(props.markdown) ?? '')
  const absPath = resolvePlanPagePath(props.cwd, declared)
  const title = String(props.title ?? 'HTML 计划')

  const [html, setHtml] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [staleRefs, setStaleRefs] = React.useState<string[]>([])
  const [projection, setProjection] = React.useState<unknown>(undefined)
  const [review, setReview] = React.useState<PendingReview | null>(null)
  const [acted, setActed] = React.useState<PlanAct | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [copied, setCopied] = React.useState('')
  const [reloadToken, setReloadToken] = React.useState(0)
  const frameRef = React.useRef<HTMLIFrameElement | null>(null)

  // 读取计划页：路径缺失/读取失败/未打包都在面板内说明，不抛错、不白屏。
  React.useEffect(() => {
    let alive = true
    setHtml(null)
    setError(null)
    setStaleRefs([])
    if (!absPath) {
      setError('计划未声明 HTML 页路径（计划正文缺少「HTML 计划页：…」一行）')
      return () => { alive = false }
    }
    rpc('edrv.read', { sessionId, path: absPath }).then((raw) => {
      if (!alive) return
      const result = raw as ReadResult
      if (result?.ok !== true) {
        setError('读取计划页失败：' + String(result?.error ?? '未知原因'))
        return
      }
      const text = String(result.content ?? '')
      setHtml(text)
      setStaleRefs(unresolvedRuntimeRefs(text))
    }).catch((cause) => {
      if (alive) setError('读取计划页失败：' + String(cause))
    })
    return () => { alive = false }
  }, [absPath, sessionId, reloadToken])

  const refresh = React.useCallback(() => {
    setProjection(readPlanProjection(sessionId))
    setReview(readPendingReview(sessionId))
  }, [sessionId])

  React.useEffect(() => {
    refresh()
    return subscribePlanFaces(sessionId, refresh)
  }, [refresh])

  /** 页面「回复」按钮回传的最新处理函数（事件监听只注册一次，经 ref 读最新闭包）。 */
  const respondRef = React.useRef<((text: string) => void) | null>(null)
  respondRef.current = (text: string) => { void sendResponse(text) }
  /** 是否有待审批：页面据此把「回复」标成「回复并执行」。 */
  const reviewRef = React.useRef(false)
  reviewRef.current = review !== null

  /** 把待审批状态告给页面（iframe ready 或审批状态变化时）。 */
  function postPlanState(): void {
    try {
      frameRef.current?.contentWindow?.postMessage({ source: 'edrv-plan-host', type: 'state', reviewPending: reviewRef.current }, '*')
    } catch {
      /* 页面未加载 */
    }
  }

  // 页面桥接：只接受来自本 iframe 的消息；复制与直接回复走同一来源校验。
  React.useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return
      const data = event.data
      if (!data || data.source !== 'edrv-htmlplan') return
      if (data.type === 'copy' && typeof data.text === 'string') setCopied(data.text)
      if (data.type === 'respond' && typeof data.text === 'string') respondRef.current?.(data.text)
      if (data.type === 'ready') postPlanState()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  React.useEffect(() => { postPlanState() }, [review])

  const state = derivePlanUiState(projection, review !== null, acted)

  /**
   * 把页面答复直接发给 agent：成功清空并回传成功，失败回传原因且保留文本。
   * @author ddj 2026年11月21号
   * @param text 答复 markdown
   */
  async function sendResponse(text: string): Promise<void> {
    if (busy) return
    const body = String(text ?? '')
    const hadReview = reviewRef.current
    setCopied(body)
    setBusy(true)
    const result = await submitPlanResponse(sessionId, body)
    setBusy(false)
    setNotice(result.ok
      ? hadReview ? '已批准并发送答复，agent 开始执行' : '已回复并发送给 agent'
      : String(result.error ?? '发送失败'))
    try {
      frameRef.current?.contentWindow?.postMessage({
        source: 'edrv-plan-host',
        type: 'respond-result',
        ok: result.ok,
        message: result.error ?? '',
      }, '*')
    } catch {
      /* 页面已卸载 */
    }
    if (result.ok) setCopied('')
    refresh()
  }

  /**
   * 执行一条官方动作；忙态防重复，失败原因原样展示。
   * @author ddj 2026年11月21号
   * @param action approve / keep / exit / fill
   */
  async function run(action: PlanAct | 'fill'): Promise<void> {
    if (busy) return
    if (action === 'fill') {
      setBusy(true)
      const result = await fillComposer(sessionId, copied)
      setBusy(false)
      setNotice(result.ok ? '已填入对话输入框（未发送）' : String(result.error ?? '填入失败'))
      return
    }
    setBusy(true)
    const result = action === 'exited' ? await exitPlanMode(sessionId) : await answerPlanReview(sessionId, action === 'approved')
    setBusy(false)
    if (result.ok) {
      setActed(action)
      setNotice(action === 'approved' ? '已批准，等待 agent 开始执行' : action === 'revising' ? '已提交「继续规划」，等待 agent 修订' : '已退出计划模式')
    } else {
      setNotice(String(result.error ?? '操作失败'))
    }
    refresh()
  }

  /**
   * 打开官方审批卡片（插件内作答不可用时的兜底入口）。
   * @author ddj 2026年11月21号
   */
  function reveal(): void {
    setNotice(revealPlanReview(sessionId) ? '已请求打开官方审批卡片' : '未找到可打开的官方审批卡片，请直接在对话中操作')
  }

  const canAnswer = review !== null && !busy
  const chrome = React.createElement('div', { className: 'edrv-htmlplan-bar' },
    React.createElement('span', { className: 'edrv-htmlplan-title', title: absPath }, title),
    React.createElement('span', { className: 'edrv-htmlplan-state edrv-htmlplan-state-' + state.mode }, state.label),
    React.createElement('span', { style: { flex: 1 } }),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost', disabled: !canAnswer,
      title: review ? '用官方批准标签作答（等同对话审批卡片的「同意执行」）' : '没有待审批的计划',
      onClick: () => { void run('approved') },
    }, '同意执行'),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost', disabled: !canAnswer || !review?.keepLabel,
      title: review?.keepLabel ? '用官方「继续规划」选项作答' : '官方审批没有继续规划选项，请在对话中要求修改',
      onClick: () => { void run('revising') },
    }, '继续规划'),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost', disabled: busy || !state.active,
      title: '等价 composer 计划徽标的 /plan off',
      onClick: () => { void run('exited') },
    }, '退出计划模式'),
    (review ? React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost', title: '打开官方审批卡片', onClick: reveal,
    }, '去对话审批') : null),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost', disabled: busy || !copied,
      title: copied ? '把页面答复填入对话输入框（不自动发送）' : '先在页面里点 Copy response',
      onClick: () => { void run('fill') },
    }, '填入对话输入框'),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost', title: '重新读取计划页',
      onClick: () => { setCopied(''); setReloadToken((value) => value + 1) },
    }, '⟳'))

  const noticeLine = notice ? React.createElement('div', { className: 'edrv-htmlplan-notice' }, notice) : null

  let stage
  if (error) {
    stage = React.createElement('div', { className: 'edrv-empty', role: 'alert' },
      React.createElement('div', null, error),
      React.createElement('div', { style: { fontSize: 12, opacity: 0.75 } }, '可关闭页签回到 Markdown 计划预览；或让 agent 重新打包计划页。'))
  } else if (html === null) {
    stage = React.createElement('div', { className: 'edrv-empty' }, '读取计划页…')
  } else {
    const warn = staleRefs.length
      ? React.createElement('div', { className: 'edrv-htmlplan-warn' },
          '页面未打包：仍引用 ' + staleRefs.join('、') + '。样式/脚本可能缺失，请运行 pack.mjs 后再提交。')
      : null
    stage = React.createElement(React.Fragment, null,
      warn,
      React.createElement('iframe', {
        ref: frameRef,
        className: 'edrv-htmlplan-frame',
        title,
        sandbox: 'allow-scripts allow-forms allow-popups',
        srcDoc: buildPlanSrcDoc(html),
      }))
  }

  return React.createElement('div', { className: 'edrv-htmlplan' }, chrome, noticeLine, stage)
}
