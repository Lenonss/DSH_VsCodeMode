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
  isMissingPage,
  planAttachInfoOf,
  planPagePathOf,
  planRepairInstruction,
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
type ReadResult = { ok?: boolean; content?: string; error?: string; code?: string }

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
  const [missing, setMissing] = React.useState(false)
  const [repairing, setRepairing] = React.useState(false)
  const frameRef = React.useRef<HTMLIFrameElement | null>(null)
  const pollRef = React.useRef<number | null>(null)
  const pageRef = React.useRef({ absPath, declared, sessionId })
  pageRef.current = { absPath, declared, sessionId }

  /** 停掉等待页面出现的轮询（卸载/重读/成功时都调一次）。 */
  function stopPolling(): void {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }
  React.useEffect(() => stopPolling, [])

  // 读取计划页：路径缺失/读取失败/未打包都在面板内说明，不抛错、不白屏。
  React.useEffect(() => {
    let alive = true
    setHtml(null)
    setError(null)
    setStaleRefs([])
    setMissing(false)
    if (!absPath) {
      setError('计划未声明 HTML 页路径（计划正文缺少「HTML 计划页：…」一行）')
      return () => { alive = false }
    }
    rpc('edrv.read', { sessionId, path: absPath }).then((raw) => {
      if (!alive) return
      const result = raw as ReadResult
      if (result?.ok !== true) {
        const pageMissing = isMissingPage(result)
        setMissing(pageMissing)
        setError(pageMissing ? '计划页还没生成：' + absPath : '读取计划页失败：' + String(result?.error ?? '未知原因'))
        return
      }
      const text = String(result.content ?? '')
      stopPolling()
      setHtml(text)
      setStaleRefs(unresolvedRuntimeRefs(text))
    }).catch((cause) => {
      if (alive) setError('读取计划页失败：' + String(cause))
    })
    return () => { alive = false }
  }, [absPath, sessionId, reloadToken])

  // 计划状态读取一律不可抛：侧栏 slot 里抛一次异常就会把整片正文刷空（连编辑器一起消失）。
  const refresh = React.useCallback(() => {
    try {
      setProjection(readPlanProjection(sessionId))
      setReview(readPendingReview(sessionId))
    } catch {
      setProjection(undefined)
      setReview(null)
    }
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
  const attachments = html === null ? { total: 0, pending: 0 } : planAttachInfoOf(html)

  /**
   * 把页面答复直接发给 agent：成功清空并回传成功，失败回传原因且保留文本。
   * 有待审批时答复会先送进 agent 当前回合、再结算批准，两者落在同一次请求里。
   * @author ddj 2026年11月21号
   * @author ddj 2026年11月24号（文案改为「答复与批准同一步送达」）
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
      ? hadReview ? '答复已随批准送进当前回合，agent 会带着答复开始执行' : '已回复并发送给 agent'
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

  /**
   * 读一次计划页；读到就渲染并停掉轮询（轮询时用 ref 里的最新路径，避免闭包过期）。
   * @author ddj 2026年11月23号
   */
  async function retryRead(): Promise<void> {
    const { absPath: path, sessionId: sid } = pageRef.current
    if (!path) return
    try {
      const raw = await rpc('edrv.read', { sessionId: sid, path })
      const result = raw as ReadResult
      if (result?.ok !== true) return
      stopPolling()
      setMissing(false)
      setError(null)
      setHtml(String(result.content ?? ''))
      setStaleRefs(unresolvedRuntimeRefs(result.content))
      setNotice('计划页已生成')
    } catch {
      /* 下一轮再试 */
    }
  }

  /**
   * 让 agent 现场生成计划页：先发修复指令，再每 2 秒读一次，最多等 90 秒。
   *
   * 有待审批卡片时把「继续规划」和修复指令一起交给 agent（先 steer 指令再结算），
   * 否则 agent 会先按「继续规划」开始修订、指令等到下一回合才被读到。
   * 计划模式允许写计划交付物，所以这里不要求用户退出计划模式。
   * @author ddj 2026年11月23号
   * @author ddj 2026年11月24号（与「继续规划」一起提交，保证同一步送达）
   */
  async function regenerate(): Promise<void> {
    if (repairing) return
    setRepairing(true)
    const hadReview = reviewRef.current
    const result = await submitPlanResponse(sessionId, planRepairInstruction(declared), false)
    setRepairing(false)
    if (!result.ok) {
      setNotice(String(result.error ?? '发送失败'))
      return
    }
    refresh()
    setNotice(hadReview
      ? '已提交「继续规划」并让 agent 生成计划页，等文件出现（最多 90 秒）…'
      : '已让 agent 生成计划页，等文件出现（最多 90 秒）…')
    stopPolling()
    let waited = 0
    pollRef.current = window.setInterval(() => {
      waited += 1
      void retryRead()
      if (waited >= 45) {
        stopPolling()
        setRepairing(false)
        setNotice('还没等到计划页：可以再点一次「生成 HTML 计划页」，或让 agent 跑技能的 runtime/plan.mjs 打包')
      }
    }, 2000)
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
    (missing || !absPath ? React.createElement('button', {
      className: 'edrv-pill edrv-pill-accent',
      disabled: repairing || !sessionId,
      title: '让 agent 现在就写 plans/<slug>/plan.html 并打包（计划模式里允许写计划文件）',
      onClick: () => { void regenerate() },
    }, repairing ? '生成中…' : '生成 HTML 计划页') : null),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost', title: '重新读取计划页',
      onClick: () => { setCopied(''); setReloadToken((value) => value + 1) },
    }, '⟳'))

  const noticeLine = notice ? React.createElement('div', { className: 'edrv-htmlplan-notice' }, notice) : null

  let stage
  if (error) {
    const canRepair = missing || !absPath
    stage = React.createElement('div', { className: 'edrv-empty', role: 'alert' },
      React.createElement('div', null, error),
      React.createElement('div', { style: { fontSize: 12, opacity: 0.75 } },
        canRepair
          ? '点下面的按钮让 agent 现在就写页面并打包；也可以关掉页签回到 Markdown 计划预览。'
          : '可关闭页签回到 Markdown 计划预览；或让 agent 重新打包计划页。'),
      canRepair ? React.createElement('button', {
        className: 'edrv-pill edrv-pill-accent', style: { marginTop: 10 },
        disabled: repairing || !sessionId,
        title: '让 agent 写 plans/<slug>/plan.html 并打包（计划模式里允许写计划文件）',
        onClick: () => { void regenerate() },
      }, repairing ? '生成中…' : '生成 HTML 计划页') : null)
  } else if (html === null) {
    stage = React.createElement('div', { className: 'edrv-empty' }, '读取计划页…')
  } else {
    const warnLines: string[] = []
    if (staleRefs.length) warnLines.push('页面未打包：仍引用 ' + staleRefs.join('、') + '。样式/脚本可能缺失，先重新打包再提交。')
    if (attachments.pending) warnLines.push(String(attachments.pending) + ' 个附件没内联：点开是空链接，重新打包后再提交。')
    const warn = warnLines.length
      ? React.createElement('div', { className: 'edrv-htmlplan-warn' },
          warnLines.join(' '),
          React.createElement('button', {
            className: 'edrv-pill edrv-pill-accent', style: { marginLeft: 8 },
            disabled: repairing || !sessionId,
            title: '让 agent 重新跑 plan.mjs 打包这一页',
            onClick: () => { void regenerate() },
          }, repairing ? '打包中…' : '重新打包'))
      : null
    stage = React.createElement(React.Fragment, null,
      warn,
      React.createElement('iframe', {
        ref: frameRef,
        className: 'edrv-htmlplan-frame',
        title,
        sandbox: 'allow-scripts allow-forms allow-popups allow-downloads',
        srcDoc: buildPlanSrcDoc(html),
      }))
  }

  return React.createElement('div', { className: 'edrv-htmlplan' }, chrome, noticeLine, stage)
}
