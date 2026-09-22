/**
 * dsh-vscode-mode host — 调试会话管理器（DAP 桥核心，适配器通用）。
 * 单例调试会话：spawn 扩展清单声明的 DAP 适配器（node js 或原生 exe）↔ 本管理器翻译成
 * edrv.dap.* 视图。要点（emmylua 源自适配器源码逆向，探针验证；通用语义对齐 DAP 3.x）：
 * - 帧协议与 LSP 相同（Content-Length）→ 复用 lsp/jsonrpc.ts；
 * - initialize → attach/launch 响应后适配器异步连目标，连上才发 initialized 事件，
 *   此时需把已存断点全量重发；随后按能力位发 configurationDone（emmylua 未声明该能力
 *   不发，行为不变；clrdbg 等声明了必须发，否则目标挂起等待）；
 * - 停帧后 stackTrace/scopes/variables/evaluate 才有效（适配器未连接时 evaluate 永不回包，
 *   必须守卫 + 请求级超时）；
 * - stackTrace 期间 emmylua 适配器可能发 findFileReq **反向请求**等 findFileRsp
 *   （chunkname→文件由 IDE 侧解析），本管理器经注入的文件索引回调应答；
 *   其它适配器直接上报可打开的源码路径，不走该扩展事件；
 * - 线程：emmylua 固定 threadId=1；通用适配器取 stopped 事件的真实 threadId，
 *   栈/单步/暂停均携带；
 * - emmylua 的 scopes frameId 是 stacks 数组下标（私有语义），标准适配器用原生 frame id；
 * - 适配器对无效 pid 会未捕获异常崩溃 → attach 前必须先经进程枚举校验 pid。
 * 作者 ddj 2026年09月29号 / 2026年09月21号
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { createFrameParser, encodeMessage } from '../lsp/jsonrpc.js'
import { sourceBaseOf, sourceKeyOf, sourcePathOf, normalizeSourcePath } from './sourcePath.js'
import { bpAcksOfResponse, DAP_ACTIONS, needsConfigurationDone, requestOfConfig, threadIdOfStopped, type DapAction, type DapBreakpointInput, type DapBreakpointAck, type DapDebugConfig, type DapEventView, type DapFrameView, type DapPhase, type DapPollResult, type DapScopeView, type DapStateView, type DapVariableView } from '../shared/dap.js'
import { dapRequest, eventBody, initializeArgs, isDapEvent, isDapResponse, responseBody, type DapEvent, type DapMessage, type DapRequest } from './protocol.js'
import type { DapAdapterSpec } from './provider.js'
import { log } from '../log.js'

const EVENT_CAP = 500
const REQUEST_TIMEOUT_MS = 8000
/** stderr 尾部缓冲上限（字符）：退出时附带进 fail 消息，根因（如缺 .NET 运行时）直达调试控制台。 */
const STDERR_TAIL_CAP = 2000
/** fail 消息附带的 stderr 尾部行数上限（防长堆栈刷屏）。 */
const STDERR_TAIL_LINES = 6
/** emmylua 兼容 shim 的来源扩展 id（extensionPath/pid 等缺省注入仅对其生效）。 */
const EMMYLUA_EXT_ID = 'tangzx.emmylua'

/** 判断 source 是否已经是可定位的源码路径（exts 由调用方按当前适配器给出）。 */
function hasSourceExtension(value: string, exts: readonly string[]): boolean {
  const path = normalizeSourcePath(value).toLowerCase()
  if (!path) return false
  return exts.some((ext) => path.endsWith(String(ext).toLowerCase()))
}

/**
 * 是否为「裸 chunkname」：无目录分隔符且非盘符/UNC 前缀。
 *
 * 这类值（如 xLua 上报的 `GuideSystemMgr`）被 {@link sourcePathOf} 处理后仍是原串，
 * 客户端会按工作区根拼接（`<cwd>/GuideSystemMgr`）——该路径必然不存在，
 * 于是断点命中后页签打不开、报「文件加载失败」。故反查失败时须判定为未解析，
 * 而不是把它当成文件路径下发。
 * @author ddj 2026年09月21号
 * @param value 适配器上报的 source 值
 * @returns 是否裸 chunkname
 */
function isBareChunk(value: string): boolean {
  const text = normalizeSourcePath(value)
  if (!text) return false
  if (text.includes('/')) return false
  return !/^[a-z]:/i.test(text)
}

/** 注入依赖：工作区文件索引（findFile 反向匹配用）。 */
export interface DapSessionDeps {
  /** 按 chunkname 搜索并排序工作区文件，返回绝对路径列表。 */
  findFiles(workspacePath: string, chunk: string): Promise<string[]>
  /** 诊断 trace（workspacePath → debug log），不改变调试逻辑。 */
  trace?: (workspacePath: string, message: string) => void
}

/** 内部待发断点（绝对路径口径）。 */
interface PendingBp {
  file: string
  line: number
  condition?: string
  hitCondition?: string
  logMessage?: string
}

/**
 * 单例调试会话。生命周期：start → starting →（initialized）running →（stopped）paused
 * →（terminated/disconnect）terminated → dispose 回 idle。
 * @author ddj 2026年09月29号
 */
export class DapSession {
  private readonly deps: DapSessionDeps
  private child: ChildProcess | null = null
  private phase: DapPhase = 'idle'
  private config: DapDebugConfig | null = null
  private workspacePath = ''
  private pid: number | undefined
  private error: string | undefined
  /** spawn 的扩展根目录（emmylua 兼容 shim 注入 extensionPath）。 */
  private extPath = ''
  /** 来源扩展 id（emmylua 兼容 shim 与 frameId 语义判定）。 */
  private extId = ''
  /** 当前适配器可下断点扩展名（断点语言过滤；空 = 不限）。 */
  private exts: string[] = []
  /** initialize 响应 capabilities（configurationDone 门控）。 */
  private caps: Record<string, unknown> | null = null
  /** 当前停帧线程（多线程适配器取 stopped 事件真实 threadId；emmylua 恒 1）。 */
  private threadId = 1
  /** 断点（绝对路径），initialized 与每次 setBreakpoints 时全量下发。 */
  private breakpoints: PendingBp[] = []
  /** findFileReq chunkname → 已排序候选首路径（frame source.path 缺失时回退）。 */
  private readonly sourceFiles = new Map<string, string>()
  /** 停帧调用栈缓存（paused 期间供 stackTrace/topFrame）。 */
  private frames: DapFrameView[] = []
  private stateTop: DapStateView['topFrame'] = null
  private events: DapEventView[] = []
  private eventSeq = 0
  private msgSeq = 1
  /** 适配器 stderr 尾部缓冲（保留末尾 STDERR_TAIL_CAP 字符，退出 fail 消息附带用）。 */
  private stderrTail = ''
  private readonly pending = new Map<number, { resolve: (r: DapMessage | null) => void; timer: NodeJS.Timeout }>()

  constructor(deps: DapSessionDeps) {
    this.deps = deps
  }

  /** 当前状态视图。 */
  stateOf(): DapStateView {
    return {
      phase: this.phase,
      configName: this.config?.name,
      configType: this.config?.type,
      pid: this.pid,
      error: this.error,
      topFrame: this.phase === 'paused' ? this.stateTop : null,
    }
  }

  /**
   * 启动调试会话（异步推进：spawn → initialize → attach/launch）。
   * @author ddj 2026年09月29号
   * @param spec 适配器启动规格
   * @param config 调试配置
   * @param workspacePath 工作区绝对路径（断点/findFile 基准）
   * @param pid 附加目标 pid（attach 型必填且必须已校验存在）
   */
  start(spec: DapAdapterSpec, config: DapDebugConfig, workspacePath: string, pid?: number): void {
    if (this.child) this.killChild()
    this.config = config
    this.workspacePath = workspacePath
    this.extPath = spec.extensionPath
    this.extId = spec.extensionId
    this.exts = spec.exts
    this.caps = null
    this.threadId = 1
    this.pid = pid
    this.error = undefined
    this.stderrTail = ''
    this.frames = []
    this.sourceFiles.clear()
    this.stateTop = null
    this.setPhase('starting')
    try {
      this.spawnAdapter(spec)
      void this.handshake(spec, config)
    } catch (error) {
      this.fail('启动适配器失败：' + String(error))
    }
  }

  /** 停止会话（disconnect 尽力发送 + 杀进程树）。 */
  stop(): void {
    if (!this.child) { this.setPhase('idle'); return }
    this.request('disconnect').catch(() => {})
    this.killChild()
    this.pushEvent({ kind: 'terminated' })
    this.setPhase('terminated')
  }

  /** 释放会话（插件卸载/进程退出）：杀进程树并复位。 */
  dispose(): void {
    this.killChild()
    this.setPhase('idle')
  }

  /**
   * poll：状态 + since 之后的增量事件（纯读，无副作用）。
   * @author ddj 2026年09月29号
   * @param since 客户端已有游标
   */
  poll(since: number): DapPollResult {
    const events = this.events.filter((e) => e.seq > since)
    const nextSeq = this.eventSeq
    return { state: this.stateOf(), events, nextSeq }
  }

  /**
   * 设置某文件断点（DAP per-source replace-all 语义）。
   * 不属于当前适配器语言的文件不入适配器（防跨语言串发），回执 verified=false 带原因；
   * 适配器在线时消费真实回执（可能挪行/判不可验证），离线时按旧口径乐观回执（start 后 flush 重发）。
   * @author ddj 2026年09月29号 / 2026年09月21号
   * @param absFile 目标文件绝对路径
   * @param items 该文件断点行列表
   */
  async setBreakpoints(absFile: string, items: DapBreakpointInput[]): Promise<DapBreakpointAck[]> {
    const allowed = this.bpAllowed(absFile)
    this.breakpoints = this.breakpoints.filter((bp) => bp.file !== absFile)
    if (allowed) {
      for (const p of items) {
        this.breakpoints.push({ file: absFile, line: p.line, condition: p.condition, hitCondition: p.hitCondition, logMessage: p.logMessage })
      }
    }
    const res = allowed
      ? await this.request('setBreakpoints', {
          source: { name: absFile.split(/[\\/]/).pop() ?? '', path: absFile },
          breakpoints: items.map((p) => ({ line: p.line, condition: p.condition, hitCondition: p.hitCondition, logMessage: p.logMessage })),
        })
      : null
    if (!res || !isDapResponse(res) || !res.success) {
      return items.map((p) => ({ line: p.line, verified: allowed, ...(allowed ? {} : { message: '当前调试器不处理该文件类型' }) }))
    }
    return bpAcksOfResponse(responseBody(res), items)
  }

  /** 调用栈（paused 限定；threadId 取当前停帧线程）。 */
  async stackTrace(): Promise<DapFrameView[]> {
    if (this.phase !== 'paused') return this.frames
    const res = await this.request('stackTrace', { threadId: this.threadId })
    if (!res || !isDapResponse(res) || !res.success) return this.frames
    const raw = responseBody(res).stackFrames
    if (!Array.isArray(raw)) return this.frames
    this.frames = await Promise.all(raw.map((item, index) => this.frameViewOf(item, index)))
    this.stateTop = this.frames[0]
      ? { file: this.frames[0].file, rawFile: this.frames[0].rawFile, line: this.frames[0].line, name: this.frames[0].name }
      : null
    return this.frames
  }

  /** 作用域列表（paused 限定；frameId 语义随适配器：emmylua=栈下标，标准=原生 frame id）。 */
  async scopes(frameId: number): Promise<DapScopeView[]> {
    if (this.phase !== 'paused') return []
    const res = await this.request('scopes', { frameId })
    if (!res || !isDapResponse(res) || !res.success) return []
    const raw = responseBody(res).scopes
    if (!Array.isArray(raw)) return []
    return raw.map((item) => {
      const s = item as Record<string, unknown>
      return {
        name: String(s.name ?? ''),
        ref: typeof s.variablesReference === 'number' ? s.variablesReference : 0,
        hint: typeof s.presentationHint === 'string' ? s.presentationHint : undefined,
      }
    })
  }

  /** 变量子级（paused 限定）。 */
  async variables(ref: number): Promise<DapVariableView[]> {
    if (this.phase !== 'paused') return []
    const res = await this.request('variables', { variablesReference: ref })
    if (!res || !isDapResponse(res) || !res.success) return []
    const raw = responseBody(res).variables
    if (!Array.isArray(raw)) return []
    return raw.map((item) => {
      const v = item as Record<string, unknown>
      return {
        name: String(v.name ?? ''),
        value: String(v.value ?? ''),
        type: typeof v.type === 'string' ? v.type : undefined,
        ref: typeof v.variablesReference === 'number' ? v.variablesReference : 0,
      }
    })
  }

  /** 表达式求值（REPL/监视；paused 限定，避免适配器挂起）。 */
  async evaluate(expression: string, frameId?: number): Promise<{ result: string; type?: string; ref: number }> {
    if (this.phase !== 'paused') return { result: '未暂停：仅在断点暂停时可求值', ref: 0 }
    const res = await this.request('evaluate', { expression, frameId: frameId ?? 0, context: 'repl' })
    if (!res || !isDapResponse(res) || !res.success) return { result: '求值失败', ref: 0 }
    const body = responseBody(res)
    return {
      result: String(body.result ?? ''),
      type: typeof body.type === 'string' ? body.type : undefined,
      ref: typeof body.variablesReference === 'number' ? body.variablesReference : 0,
    }
  }

  /** 调试控制动作（线程型命令携带当前停帧线程；emmylua 单线程 threadId 恒 1 不受影响）。 */
  action(action: DapAction): void {
    if (!DAP_ACTIONS.includes(action)) return
    const command = action === 'disconnect' ? 'disconnect' : action
    void this.request(command, action === 'disconnect' ? undefined : { threadId: this.threadId }).catch(() => {})
    if (action === 'continue' || action === 'next' || action === 'stepIn' || action === 'stepOut') this.setPhase('running')
  }

  // ---------------------------------------------------------------- 内部实现

  /** spawn 适配器进程并接好帧解析。 */
  private spawnAdapter(spec: DapAdapterSpec): void {
    const child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    const parser = createFrameParser()
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const message of parser.push(chunk)) this.handleMessage(message as DapMessage)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      log.debug('[dap-adapter] ' + chunk.toString('utf8').trim())
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CAP)
    })
    child.on('error', (error) => this.fail('适配器进程错误：' + String(error)))
    child.on('exit', (code) => {
      if (this.child === child && this.phase !== 'idle' && this.phase !== 'terminated') {
        this.fail('适配器退出（code=' + code + '）' + this.stderrSuffix())
      }
    })
  }

  /**
   * stderr 尾部摘要（供 fail 消息附带）：取末尾若干非空行、以 | 折叠单行化。
   * 无 stderr 内容时返回空串（不改变既有消息文案）。
   * @author ddj 2026年09月22号
   * @returns 形如「；stderr: xxx | yyy」的摘要，或空串
   */
  private stderrSuffix(): string {
    const text = this.stderrTail.trim()
    if (!text) return ''
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (!lines.length) return ''
    return '；stderr: ' + lines.slice(-STDERR_TAIL_LINES).join(' | ')
  }

  /** initialize → attach/launch 握手（initialized 事件后重发断点 + 按能力位收尾）。 */
  private async handshake(spec: DapAdapterSpec, config: DapDebugConfig): Promise<void> {
    const init = await this.request('initialize', initializeArgs(spec.type))
    if (!init || !isDapResponse(init) || !init.success) {
      this.fail('initialize 失败：' + (init && isDapResponse(init) ? init.message ?? '' : '超时'))
      return
    }
    this.caps = responseBody(init)
    const request = requestOfConfig(config)
    const res = await this.request(request, this.requestArgs(config))
    if (!res || !isDapResponse(res) || !res.success) {
      this.fail((request === 'attach' ? 'attach 失败：' : 'launch 失败：') + (res && isDapResponse(res) ? res.message ?? '' : '超时'))
    }
  }

  /**
   * attach/launch 请求参数：launch.json 原样透传（含未识别字段，对齐 VS Code 语义），
   * emmylua 兼容缺省注入（对齐扩展自身 resolveDebugConfiguration：extensionPath/pid 等）。
   * @author ddj 2026年09月21号
   * @param config 调试配置
   */
  private requestArgs(config: DapDebugConfig): Record<string, unknown> {
    const args = { ...(config.raw ?? {}) }
    // cwd 兜底注入（对齐 VS Code 扩展侧 provider：cwd 缺省 = 工作区根）。
    // DotRush unity 适配器按 <cwd>/Library/EditorInstance.json 定位编辑器实例，
    // 缺 cwd 会回退到宿主进程启动目录导致 attach 必失败（实测根因，2026-09-22）；显式 cwd 优先。
    if (args.cwd === undefined && this.workspacePath) args.cwd = this.workspacePath
    if (this.extId !== EMMYLUA_EXT_ID) {
      // unity 适配器的 processId 是端口覆盖而非进程号（DotRush LaunchConfiguration：
      // port = processId || 56000 + editorPid%1000），注入选中 pid 会连错端口 → 豁免不注入。
      const isUnity = config.type === 'unity'
      // 通用 attach：进程选择器解析出的 pid 注入 processId（coreclr 等的附加目标字段）
      if (!isUnity && this.pid && requestOfConfig(config) === 'attach' && args.processId === undefined) args.processId = this.pid
      return args
    }
    // emmylua 适配器从 attach/launch 参数读扩展根路径拼 emmy_tool.exe（EmmyAttachDebugSession：
    // this.extensionPath = args.extensionPath）——VS Code 由扩展宿主自动带上，本插件必须显式注入；
    // 缺失会拼出 undefined/.../emmy_tool.exe 致适配器立即退出（实测根因，2026-09-22）。
    if (args.extensionPath === undefined) args.extensionPath = this.extPath
    if (requestOfConfig(config) === 'attach') {
      args.pid = this.pid ?? (typeof args.pid === 'number' && args.pid > 0 ? args.pid : 0)
      if (!Array.isArray(args.sourcePaths)) args.sourcePaths = [this.workspacePath]
      if (!Array.isArray(args.ext)) args.ext = ['.lua']
      if (args.captureLog === undefined) args.captureLog = false
      return args
    }
    if (args.host === undefined) args.host = 'localhost'
    if (args.port === undefined) args.port = 9966
    if (args.ideConnectDebugger === undefined) args.ideConnectDebugger = true
    if (!Array.isArray(args.sourcePaths)) args.sourcePaths = [this.workspacePath]
    if (!Array.isArray(args.ext)) args.ext = ['.lua']
    return args
  }

  /** DAP 消息分流：响应 → pending；事件 → handleEvent。 */
  private handleMessage(message: DapMessage): void {
    if (isDapResponse(message)) {
      const entry = this.pending.get(message.request_seq)
      if (entry) { this.pending.delete(message.request_seq); entry.resolve(message) }
      return
    }
    if (isDapEvent(message)) this.handleEvent(message)
  }

  /** 事件处理：initialized/stopped/terminated/output/log/findFileReq。 */
  private handleEvent(event: DapEvent): void {
    const body = eventBody(event)
    if (event.event === 'initialized') {
      this.setPhase('running')
      this.flushBreakpoints()
      // DAP 标准握手收尾：断点下发完 → configurationDone → 目标开跑。
      // 按能力位门控：emmylua 未声明该能力（不发，行为不变）；clrdbg 等声明了（必须发，否则挂起）。
      if (needsConfigurationDone(this.caps)) void this.request('configurationDone').catch(() => {})
      return
    }
    if (event.event === 'stopped') {
      this.threadId = threadIdOfStopped(body)
      void this.handleStopped(String(body.reason ?? 'breakpoint'))
      return
    }
    if (event.event === 'terminated') {
      // 初始化完成前终止 = attach/连接目标阶段失败。DotRush 类适配器把根因写自家日志、
      // DAP 侧只发空 terminated，控制台无声「已结束」极难排查 → 补一行带日志指引的提示。
      if (this.phase === 'starting') {
        const hint = this.earlyTermHint()
        this.pushEvent({ kind: 'output', text: hint + '\n' })
        this.deps.trace?.(this.workspacePath, '[DEBUG terminated] ' + hint)
      }
      this.pushEvent({ kind: 'terminated' })
      this.setPhase('terminated')
      return
    }
    if (event.event === 'continued') { this.setPhase('running'); this.pushEvent({ kind: 'continued' }); return }
    if (event.event === 'findFileReq') { void this.respondFindFile(body); return }
    if (event.event === 'output' || event.event === 'log') {
      this.pushEvent({ kind: 'output', text: String(body.output ?? body.message ?? '') })
    }
  }

  /** 停帧：置 paused + 预拉调用栈（首帧进 state.topFrame 驱动跳转高亮）。 */
  private async handleStopped(reason: string): Promise<void> {
    this.pushEvent({ kind: 'stopped', reason })
    this.setPhase('paused')
    try { await this.stackTrace() } catch { /* 栈拉取失败不影响 paused 态 */ }
  }

  /**
   * 初始化前终止的控制台提示：指明失败阶段并给出适配器日志位置（根因常在适配器自家日志）。
   * DotRush 扩展的 monodbg 日志固定在扩展根 bin/DebuggerMono/logs，直接给绝对路径；
   * 其它适配器回退到通用指引（宿主日志 [dap-adapter] 段有 stderr 镜像）。
   * @author ddj 2026年09月22号
   * @returns 提示文本（不含换行）
   */
  private earlyTermHint(): string {
    const dotrushLog = this.extId === 'nromanov.dotrush' && this.extPath
      ? '；适配器日志：' + join(this.extPath, 'bin', 'DebuggerMono', 'logs', 'Error.log')
      : '；请查看适配器自身日志与宿主日志 [dap-adapter] 段'
    return '会话在初始化完成前终止（attach/连接目标失败）' + dotrushLog
  }

  /** findFileReq 反向应答：按完整 chunkname 排序工作区候选并缓存首命中。 */
  private async respondFindFile(body: Record<string, unknown>): Promise<void> {
    const seq = typeof body.seq === 'number' ? body.seq : -1
    const chunk = String(body.file ?? '')
    const files = await this.deps.findFiles(this.workspacePath, chunk)
    log.debug('[dap-trace] findFileReq seq=' + seq + ' chunk=' + chunk + ' candidates=' + files.length + ' first=' + (files[0] ?? ''))
    this.deps.trace?.(this.workspacePath, '[DEBUG findFileReq] seq=' + seq + ' chunk=' + chunk + ' candidates=' + files.length + ' first=' + (files[0] ?? ''))
    const first = files[0]
    if (first) {
      this.sourceFiles.set(sourceKeyOf(chunk), first)
      this.sourceFiles.set(sourceKeyOf(sourceBaseOf(chunk)), first)
    }
    this.send({ seq: this.msgSeq++, type: 'request', command: 'findFileRsp', arguments: { seq, files } })
  }

  /** 发送已存断点（initialized 后调用一次；只发属于当前适配器语言的文件）。 */
  private flushBreakpoints(): void {
    if (!this.breakpoints.length) return
    const byFile = new Map<string, PendingBp[]>()
    for (const bp of this.breakpoints) {
      if (!this.bpAllowed(bp.file)) continue
      const list = byFile.get(bp.file) ?? []
      list.push(bp)
      byFile.set(bp.file, list)
    }
    for (const [file, list] of byFile) {
      void this.request('setBreakpoints', {
        source: { name: file.split(/[\\/]/).pop() ?? '', path: file },
        breakpoints: list.map((bp) => ({ line: bp.line, condition: bp.condition, hitCondition: bp.hitCondition, logMessage: bp.logMessage })),
      }).catch(() => {})
    }
  }

  /** 断点文件是否属于当前适配器（按声明扩展名过滤；未知语言不过滤，兼容旧链路）。 */
  private bpAllowed(file: string): boolean {
    if (!this.exts.length) return true
    const lower = file.toLowerCase()
    return this.exts.some((ext) => lower.endsWith(ext))
  }

  /** 栈帧源码扩展名判定集：emmylua 沿用旧口径（.lua 家族 + 配置 ext），通用适配器用声明 exts。 */
  private frameExts(): string[] {
    if (this.extId !== EMMYLUA_EXT_ID) return this.exts
    return [...new Set([...(this.config?.ext ?? []), '.lua', '.lua.bytes'])]
  }

  /** 栈帧 id：emmylua 的 scopes 以 stacks 下标为 frameId（私有语义）；标准适配器用原生 id。 */
  private frameIdOf(raw: Record<string, unknown>, index: number): number {
    if (this.extId === EMMYLUA_EXT_ID) return index
    return typeof raw.id === 'number' ? raw.id : index
  }

  /** 发送请求（seq 自增 + 超时守卫；适配器不回包时拒绝而非悬挂）。 */
  private request(command: string, args?: unknown): Promise<DapMessage | null> {
    if (!this.child?.stdin?.writable) return Promise.resolve(null)
    const seq = this.msgSeq++
    const frame = dapRequest(seq, command, args)
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(seq); resolve(null) }, REQUEST_TIMEOUT_MS)
      this.pending.set(seq, { resolve, timer })
      this.child!.stdin!.write(encodeMessage(frame))
    })
  }

  /** 直发原始帧（反向请求应答等无需等待响应的场景）。 */
  private send(frame: DapRequest): void {
    if (!this.child?.stdin?.writable) return
    this.child.stdin.write(encodeMessage(frame))
  }

  /** 追加事件（环形截断）。 */
  private pushEvent(partial: Omit<DapEventView, 'seq'>): void {
    this.eventSeq += 1
    this.events.push({ seq: this.eventSeq, ...partial })
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP)
  }

  /** 记录错误并终止会话。 */
  private fail(message: string): void {
    this.error = message
    log.warn('[dap] ' + message)
    this.pushEvent({ kind: 'output', text: message + '\n' })
    this.pushEvent({ kind: 'terminated' })
    this.killChild()
    this.setPhase('terminated')
  }

  /** 杀适配器进程树（Windows taskkill /T /F，同 LSP transport 口径）。 */
  private killChild(): void {
    const child = this.child
    this.child = null
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.resolve(null) }
    this.pending.clear()
    if (!child) return
    try { child.kill() } catch { /* 忽略 */ }
    if (process.platform === 'win32' && child.pid) {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 忽略 */ }
    }
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 忽略 */ } }, 1500).unref?.()
  }

  /** 相位切换（running→running 等幂等跳过）。 */
  private setPhase(phase: DapPhase): void {
    if (this.phase === phase) return
    this.phase = phase
    if (phase === 'idle') { this.events = []; this.config = null; this.pid = undefined; this.error = undefined }
  }

  /** 适配器上报路径 → 帧视图（file 始终保留可打开的规范路径）。 */
  private async frameViewOf(item: unknown, index: number): Promise<DapFrameView> {
    const raw = item as Record<string, unknown>
    const source = (raw.source ?? {}) as Record<string, unknown>
    const sourcePath = typeof source.path === 'string' ? source.path : ''
    const sourceName = typeof source.name === 'string' ? source.name : ''
    const cached = this.sourceFiles.get(sourceKeyOf(sourcePath)) ?? this.sourceFiles.get(sourceKeyOf(sourceName))
    let selected = cached || sourcePath || sourceName
    const needsLookup = !selected || !hasSourceExtension(selected, this.frameExts())
    log.debug('[dap-trace] frame rawPath=' + sourcePath + ' name=' + sourceName + ' cached=' + (cached ?? '') + ' needsLookup=' + needsLookup + ' selected=' + selected)
    this.deps.trace?.(this.workspacePath, '[DEBUG frame] rawPath=' + sourcePath + ' name=' + sourceName + ' cached=' + (cached ?? '') + ' needsLookup=' + needsLookup + ' selected=' + selected)
    if (!cached && needsLookup) {
      const candidates = await this.deps.findFiles(this.workspacePath, sourceName || sourcePath)
      log.debug('[dap-trace] frameLookup source=' + (sourceName || sourcePath) + ' candidates=' + candidates.length + ' first=' + (candidates[0] ?? ''))
      this.deps.trace?.(this.workspacePath, '[DEBUG frameLookup] source=' + (sourceName || sourcePath) + ' candidates=' + candidates.length + ' first=' + (candidates[0] ?? ''))
      if (candidates[0]) {
        selected = candidates[0]
        this.sourceFiles.set(sourceKeyOf(sourceName || sourcePath), candidates[0])
      } else if (isBareChunk(sourceName || sourcePath)) {
        // 反查失败 + 裸 chunkname：无可打开路径。置空而非回退原串，
        // 避免客户端按工作区根拼出必然不存在的路径、打开注定失败的页签。
        selected = ''
      }
    }
    const finalFile = selected ? sourcePathOf(selected, this.workspacePath) : ''
    log.debug('[dap-trace] frameFinal name=' + sourceName + ' file=' + finalFile + ' line=' + String(raw.line ?? 0))
    this.deps.trace?.(this.workspacePath, '[DEBUG frameFinal] name=' + sourceName + ' file=' + finalFile + ' line=' + String(raw.line ?? 0))
    return {
      id: this.frameIdOf(raw, index),
      name: String(raw.name ?? ''),
      file: finalFile,
      rawFile: sourceName || sourcePath || selected,
      line: typeof raw.line === 'number' ? raw.line : 0,
    }
  }
}
