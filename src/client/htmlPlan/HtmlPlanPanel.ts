/**
 * dsh-vscode-mode client — HTML 计划页签面板：状态条 + 官方动作 + 沙箱 iframe。
 *
 * 页面来源按优先级解析：作者页（已打包直接显示、未打包自动打包、声明缺失时试备用路径）
 * → HTML 计划模式下用计划正文渲染标准页 → 报错（并把回落控制权交回 EditorView）。
 * 同意执行 / 继续规划走官方 userQuestions 答案通道，退出计划模式走官方 /plan off，
 * 页面答复经桥接脚本回填对话输入框。iframe 一律 sandbox 且不给 allow-same-origin。
 * @author ddj 2026年11月21号
 * @author ddj 2026年11月25号（HTML 计划模式：模式徽标、标准页、页面来源与 Markdown 回落）
 * @author ddj 2026年11月26号（作者页没有计划结构时改用标准页，页签可切回作者页）
 */
import React from 'react'
import { rpc } from '../rpc.js'
import {
  buildPlanSrcDoc,
  deriveHtmlPlanUiState,
  derivePlanUiState,
  hasPlanRuntime,
  hasPlanStructure,
  isMissingPage,
  planAttachInfoOf,
  planPageAltPath,
  planPageDecisionOf,
  planPagePathOf,
  planRepairInstruction,
  resolvePlanPagePath,
  unresolvedRuntimeRefs,
  type PendingReview,
  type PlanPageRead,
} from './planPage.js'
import {
  answerPlanReview,
  exitHtmlPlanMode,
  exitPlanMode,
  fillComposer,
  readHtmlPlanMode,
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
  /** 计划由 HTML 计划模式提交：允许插件渲染自动页，缺页不再视为错误。 */
  htmlPlanMode?: boolean
  /** 页面无法生成时交回 EditorView 回落官方 Markdown。 */
  onMarkdownFallback?: () => void
}

/** 本地刚完成的动作（用于状态文案，不持久化）。 */
type PlanAct = 'approved' | 'revising' | 'exited'
type ReadResult = { ok?: boolean; content?: string; error?: string; code?: string }
type PageSource = 'authored' | 'packed' | 'auto'
/** 页面显示偏好：作者页与标准页之间切换。 */
type PageViewMode = 'auto' | 'authored' | 'standard'

/** 页面来源徽标文案。 */
const SOURCE_LABEL: Record<PageSource, string> = {
  authored: '作者页',
  packed: '已打包',
  auto: '标准页',
}

/**
 * HTML 计划面板。
 * @author ddj 2026年11月21号
 * @param props 会话/工作区/计划页路径、标题与模式
 * @returns 计划页签正文
 */
export function HtmlPlanPanel(props: HtmlPlanPanelProps) {
  const sessionId = String(props.sessionId ?? '')
  const htmlPlanMode = props.htmlPlanMode === true
  const declared = String(props.htmlPath ?? planPagePathOf(props.markdown) ?? '')
  const absPath = resolvePlanPagePath(props.cwd, declared)
  const title = String(props.title ?? 'HTML 计划')

  const [html, setHtml] = React.useState<string | null>(null)
  const [source, setSource] = React.useState<PageSource | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [staleRefs, setStaleRefs] = React.useState<string[]>([])
  const [projection, setProjection] = React.useState<unknown>(undefined)
  const [htmlMode, setHtmlMode] = React.useState<unknown>(undefined)
  const [review, setReview] = React.useState<PendingReview | null>(null)
  const [acted, setActed] = React.useState<PlanAct | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [copied, setCopied] = React.useState('')
  const [reloadToken, setReloadToken] = React.useState(0)
  const [missing, setMissing] = React.useState(false)
  const [repairing, setRepairing] = React.useState(false)
  /** 模型写的作者页（HTML 计划模式下保留，供「看作者页 / 用标准页」切换）。 */
  const [authored, setAuthored] = React.useState<string | null>(null)
  /** 页面显示偏好：auto=有结构就显示作者页、否则标准页；authored=只看作者页；standard=只看标准页。 */
  const [pageMode, setPageMode] = React.useState<PageViewMode>('auto')
  const frameRef = React.useRef<HTMLIFrameElement | null>(null)
  const pollRef = React.useRef<number | null>(null)
  const aliveRef = React.useRef(true)
  const pageRef = React.useRef({ absPath, declared, sessionId, markdown: props.markdown })
  pageRef.current = { absPath, declared, sessionId, markdown: props.markdown }

  /** 停掉等待页面出现的轮询（卸载/重读/成功时都调一次）。 */
  function stopPolling(): void {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }
  React.useEffect(() => () => { aliveRef.current = false; stopPolling() }, [])

  /**
   * 读一页并把结果归一成三态 + 是否需要打包。
   * @author ddj 2026年11月25号
   * @param path 绝对路径
   * @returns 读取结果
   */
  async function readPage(path: string): Promise<{ read: PlanPageRead; text: string; refs: string[] }> {
    try {
      const raw = await rpc('edrv.read', { sessionId, path })
      const result = raw as ReadResult
      if (result?.ok === true) {
        const text = String(result.content ?? '')
        return { read: 'ok', text, refs: unresolvedRuntimeRefs(text) }
      }
      return { read: isMissingPage(result) ? 'missing' : 'error', text: '', refs: [] }
    } catch {
      return { read: 'error', text: '', refs: [] }
    }
  }

  /**
   * 调 host 打包作者页；失败返回可读原因。
   * @author ddj 2026年11月25号
   * @param path 页面路径
   * @returns 打包后的 HTML 或错误
   */
  async function packPage(path: string): Promise<{ ok: boolean; html?: string; error?: string }> {
    try {
      const raw = await rpc('edrv.planPage.pack', { sessionId, path })
      const result = raw as { ok?: boolean; html?: string; error?: string }
      return result?.ok === true ? { ok: true, html: String(result.html ?? '') } : { ok: false, error: String(result?.error ?? '打包失败') }
    } catch (cause) {
      return { ok: false, error: String(cause) }
    }
  }

  /**
   * 调 host 用计划正文渲染标准页。
   * @author ddj 2026年11月25号
   * @returns 标准页 HTML 或错误
   */
  async function renderAutoPage(): Promise<{ ok: boolean; html?: string; error?: string }> {
    try {
      const raw = await rpc('edrv.planPage.render', { sessionId, markdown: String(props.markdown ?? '') })
      const result = raw as { ok?: boolean; html?: string; error?: string }
      return result?.ok === true ? { ok: true, html: String(result.html ?? '') } : { ok: false, error: String(result?.error ?? '渲染失败') }
    } catch (cause) {
      return { ok: false, error: String(cause) }
    }
  }

  // 换一页计划时清掉上一页的作者页与显示偏好，避免「看作者页」拿到上一页的内容。
  React.useEffect(() => {
    setAuthored(null)
    setPageMode('auto')
  }, [absPath, declared])

  // 读取计划页：作者页 → 自动打包 → 备用路径 → 标准页 → 报错/回落。
  React.useEffect(() => {
    aliveRef.current = true
    setHtml(null)
    setSource(null)
    setError(null)
    setStaleRefs([])
    setMissing(false)
    setNotice('')

    let alive = true
    const isAlive = (): boolean => alive && aliveRef.current

    /**
     * 页面已就绪时收口：HTML 计划模式下，没有计划结构的作者页换成标准页。
     *
     * 生成 HTML 是模型的弱项（GPT 系列常写出自造样式的文档页）：这类页面留在计划签里
     * 既占地方又不像计划，所以默认用计划正文渲染标准页；想看原页就点「看作者页」。
     * @author ddj 2026年11月26号
     * @param pageHtml 页面 HTML
     * @param pageSource 页面来源
     * @param refs 未内联的运行时引用
     * @param baseNotice 原本要展示的提示
     */
    async function applyPage(pageHtml: string, pageSource: PageSource, refs: string[], baseNotice: string): Promise<void> {
      const structured = hasPlanStructure(pageHtml)
      // 未打包的作者页必须自己引用运行时；打包页的运行时已内联，不必再查。
      const runtimeOk = pageSource === 'packed' || hasPlanRuntime(pageHtml)
      const wantStandard = pageMode === 'standard' || (pageMode === 'auto' && !(structured && runtimeOk))
      if (htmlPlanMode && wantStandard) {
        const rendered = await renderAutoPage()
        if (!isAlive()) return
        if (rendered.ok && rendered.html !== undefined) {
          setAuthored(pageHtml)
          setHtml(rendered.html)
          setStaleRefs([])
          setSource('auto')
          setMissing(false)
          setNotice((pageMode === 'standard'
            ? '标准计划页：由计划正文渲染'
            : (structured ? '作者页没有引用 htmlplan 运行时，样式会缺失' : '作者页没有计划结构（doc-plan / doc-claim）')
              + '，已改用计划正文生成标准计划页')
            + (baseNotice ? '；' + baseNotice : ''))
          return
        }
      }
      setAuthored(htmlPlanMode ? pageHtml : null)
      setHtml(pageHtml)
      setStaleRefs(refs)
      setSource(pageSource)
      setMissing(false)
      setNotice(htmlPlanMode && !(structured && runtimeOk)
        ? '正在看作者页：' + (structured ? '它没有引用 htmlplan 运行时' : '它没有计划结构（doc-plan / doc-claim）') + '，点「用标准页」换回来'
        : baseNotice)
    }

    /**
     * 页面解析主流程（异步，失败一律落到可读状态，不抛）。
     * @author ddj 2026年11月25号
     */
    async function resolvePage(): Promise<void> {
      let read: PlanPageRead = 'missing'
      let needsPack = false
      let alternateExists = false
      let rawText = ''
      let rawRefs: string[] = []
      let alternatePath = ''

      if (declared) {
        const first = await readPage(absPath)
        read = first.read
        rawText = first.text
        rawRefs = first.refs
        needsPack = first.read === 'ok' && first.refs.length > 0
        if (first.read !== 'ok') {
          const alt = planPageAltPath(declared)
          if (alt) {
            alternatePath = resolvePlanPagePath(props.cwd, alt)
            const alternate = await readPage(alternatePath)
            alternateExists = alternate.read === 'ok'
          }
        }
      }

      if (!isAlive()) return
      const decision = planPageDecisionOf({ declared, htmlPlanMode, read, needsPack, alternateExists })

      if (decision.action === 'show') {
        await applyPage(rawText, 'authored', rawRefs, '')
        return
      }

      if (decision.action === 'pack') {
        const target = resolvePlanPagePath(props.cwd, String(decision.target ?? ''))
        const packed = await packPage(target)
        if (!isAlive()) return
        if (packed.ok && packed.html !== undefined) {
          await applyPage(packed.html, 'packed', [], '已自动打包计划页')
          return
        }
        // 打包失败但作者页本身读得到：原样展示并保留告警，不吞掉内容。
        if (read === 'ok') {
          await applyPage(rawText, 'authored', rawRefs, '自动打包失败：' + String(packed.error ?? '未知原因'))
          return
        }
        // 否则继续走兜底/报错。
        setNotice('自动打包失败：' + String(packed.error ?? '未知原因'))
      }

      if (decision.action === 'auto') {
        const rendered = await renderAutoPage()
        if (!isAlive()) return
        if (rendered.ok && rendered.html !== undefined) {
          setHtml(rendered.html)
          setStaleRefs([])
          setSource('auto')
          setMissing(false)
          setNotice('标准计划页：由计划正文渲染')
          return
        }
        setError('标准页渲染失败：' + String(rendered.error ?? '未知原因') + '；已回落 Markdown 计划')
        props.onMarkdownFallback?.()
        return
      }

      // 没有作者页、也不是 HTML 计划模式：保持原行为（缺页给生成入口）。
      setMissing(read === 'missing' || alternateExists)
      if (!declared) {
        setError('计划未声明 HTML 页路径（计划正文缺少「HTML 计划页：…」一行）')
      } else if (read === 'missing') {
        setError('计划页还没生成：' + absPath)
      } else {
        setError('读取计划页失败：' + absPath)
      }
    }

    void resolvePage()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absPath, declared, htmlPlanMode, markdownKey(props.markdown), sessionId, reloadToken, props.cwd, pageMode])

  // 计划状态读取一律不可抛：侧栏 slot 里抛一次异常就会把整片正文刷空（连编辑器一起消失）。
  const refresh = React.useCallback(() => {
    try {
      setProjection(readPlanProjection(sessionId))
      setHtmlMode(readHtmlPlanMode(sessionId))
      setReview(readPendingReview(sessionId))
    } catch {
      setProjection(undefined)
      setHtmlMode(undefined)
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

  const officialState = derivePlanUiState(projection, review !== null, acted)
  const state = htmlPlanMode ? deriveHtmlPlanUiState(htmlMode, review !== null, acted) : officialState
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
    const result = action === 'exited'
      ? (htmlPlanMode ? await exitHtmlPlanMode(sessionId) : await exitPlanMode(sessionId))
      : await answerPlanReview(sessionId, action === 'approved')
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
   * 重新解析一次页面（⟳ 与轮询共用；走 reloadToken 让解析流程重跑）。
   * @author ddj 2026年11月25号
   */
  function reloadPage(): void {
    stopPolling()
    setReloadToken((value) => value + 1)
  }

  /**
   * 让 agent 现场生成计划页：先发修复指令，再每 2 秒重读一次，最多等 90 秒。
   *
   * 有待审批卡片时把「继续规划」和修复指令一起交给 agent（先 steer 指令再结算），
   * 否则 agent 会先按「继续规划」开始修订、指令等到下一回合才被读到。
   * HTML 计划模式下页面由插件负责，这里只重新解析，不再要求 agent 写文件。
   * @author ddj 2026年11月23号
   * @author ddj 2026年11月24号（与「继续规划」一起提交，保证同一步送达）
   */
  async function regenerate(): Promise<void> {
    if (repairing) return
    if (htmlPlanMode) {
      setRepairing(true)
      reloadPage()
      setRepairing(false)
      setNotice('已重新解析计划页')
      return
    }
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
      if (waited >= 45) {
        stopPolling()
        setRepairing(false)
        setNotice('还没等到计划页：可以再点一次「生成 HTML 计划页」，或让 agent 跑技能的 runtime/plan.mjs 打包')
        return
      }
      setReloadToken((value) => value + 1)
    }, 2000)
  }

  const canAnswer = review !== null && !busy
  const sourceLabel = source ? SOURCE_LABEL[source] : ''
  const chrome = React.createElement('div', { className: 'edrv-htmlplan-bar' },
    React.createElement('span', { className: 'edrv-htmlplan-title', title: absPath }, title),
    (htmlPlanMode ? React.createElement('span', { className: 'edrv-htmlplan-mode' }, 'HTML 计划模式') : null),
    (sourceLabel ? React.createElement('span', { className: 'edrv-htmlplan-src' }, sourceLabel) : null),
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
      title: htmlPlanMode ? '等价底部栏 chip 的 /html-plan off' : '等价 composer 计划徽标的 /plan off',
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
    (authored !== null ? React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost',
      title: source === 'auto'
        ? '直接看模型写的作者页（可能没有计划结构）'
        : '改看插件用计划正文生成的标准页',
      onClick: () => { setPageMode(source === 'auto' ? 'authored' : 'standard') },
    }, source === 'auto' ? '看作者页' : '用标准页') : null),
    (!htmlPlanMode && (missing || !absPath) ? React.createElement('button', {
      className: 'edrv-pill edrv-pill-accent',
      disabled: repairing || !sessionId,
      title: '让 agent 现在就写 plans/<slug>/plan.html 并打包（计划模式里允许写计划文件）',
      onClick: () => { void regenerate() },
    }, repairing ? '生成中…' : '生成 HTML 计划页') : null),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost', title: '重新读取计划页',
      onClick: () => { setCopied(''); reloadPage() },
    }, '⟳'))

  const noticeLine = notice ? React.createElement('div', { className: 'edrv-htmlplan-notice' }, notice) : null

  let stage
  if (error) {
    const canRepair = !htmlPlanMode && (missing || !absPath)
    stage = React.createElement('div', { className: 'edrv-empty', role: 'alert' },
      React.createElement('div', null, error),
      React.createElement('div', { style: { fontSize: 12, opacity: 0.75 } },
        htmlPlanMode
          ? '点 ⟳ 重新解析；仍失败可关闭页签回到 Markdown 计划预览。'
          : canRepair
            ? '点下面的按钮让 agent 现在就写页面并打包；也可以关掉页签回到 Markdown 计划预览。'
            : '可关闭页签回到 Markdown 计划预览；或让 agent 重新打包计划页。'),
      canRepair ? React.createElement('button', {
        className: 'edrv-pill edrv-pill-accent', style: { marginTop: 10 },
        disabled: repairing || !sessionId,
        title: '让 agent 写 plans/<slug>/plan.html 并打包（计划模式里允许写计划文件）',
        onClick: () => { void regenerate() },
      }, repairing ? '生成中…' : '生成 HTML 计划页') : null)
  } else if (html === null) {
    stage = React.createElement('div', { className: 'edrv-empty' }, htmlPlanMode ? '解析计划页…' : '读取计划页…')
  } else {
    const warnLines: string[] = []
    if (staleRefs.length) warnLines.push('页面未打包：仍引用 ' + staleRefs.join('、') + '。样式/脚本可能缺失。')
    if (attachments.pending) warnLines.push(String(attachments.pending) + ' 个附件没内联：点开是空链接。')
    const warn = warnLines.length
      ? React.createElement('div', { className: 'edrv-htmlplan-warn' },
          warnLines.join(' '),
          React.createElement('button', {
            className: 'edrv-pill edrv-pill-accent', style: { marginLeft: 8 },
            disabled: repairing || !sessionId,
            title: htmlPlanMode ? '重新解析计划页' : '让 agent 重新跑 plan.mjs 打包这一页',
            onClick: () => { void regenerate() },
          }, repairing ? '处理中…' : htmlPlanMode ? '重新解析' : '重新打包'))
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

/**
 * 取 markdown 的稳定依赖键（避免父级每次渲染都触发重解析）。
 * @author ddj 2026年11月25号
 * @param markdown 计划正文
 * @returns 长度 + 前缀指纹
 */
function markdownKey(markdown: unknown): string {
  const text = typeof markdown === 'string' ? markdown : ''
  return String(text.length) + ':' + text.slice(0, 64)
}
