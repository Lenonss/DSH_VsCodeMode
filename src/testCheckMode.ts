/**
 * dsh-vscode-mode host — 测试验收模式（`/test-check`，独立模式，结构对齐 `htmlPlanMode.ts`）。
 *
 * 四件套：
 * 1. `sessionProjections` 注册 `test-check` 投影：折叠 `/test-check` 命令事件，得到 `{ active, entered, id }`；
 *    `entered` 粘性，让规则段落「首次进入后常驻」。
 * 2. 两条系统提示 section：`test-check:policy`（常驻规则，首句限定只在活跃时适用）与
 *    `test-check:status`（每个请求按 active 输出一句话）。
 * 3. 两个工具：`test_check_report`（每验一项必须带证据上报）与 `test_check_finish`（导出快照），
 *    从首次进入起常驻准入（`when`），执行时再校验模式活跃。
 * 4. `/test-check [off|任务]` 命令：切模式 + 建单目录 + 把任务送进会话。
 *
 * 与官方 `/plan`、`/html-plan` 的关系：本模式独立，不碰官方 plan 投影；成功进入那两者时
 * 本模式折回 inactive（三模式互斥，同一时刻只有一个在管规则）。
 * @author ddj 2026年11月25号
 */
import { z } from 'zod'
import { log } from './log.js'
import { loadHostModule } from './hostImport.js'
import { cwdOfSession, type Ctx } from './store.js'
import { checkCommand, type CheckInvocation, type CheckStage } from './testCheckCommand.js'
import { testCheckPolicyText, testCheckStatusText } from './testCheckGuidance.js'
import { exportSnapshot, projectRootOf, writeEvent } from './testCheckStore.js'
import { policyTextOf } from './testCheckPolicy.js'
import {
  TEST_CHECK_COMMAND,
  TEST_CHECK_DEFAULT_ID,
  TEST_CHECK_FINISH_TOOL,
  TEST_CHECK_MODE_KEY,
  TEST_CHECK_OFF_LINE,
  TEST_CHECK_REPORT_TOOL,
  normalizeStatus,
  parseCheckInput,
  testCheckIdOf,
  type TestCheckCounts,
  type TestCheckEvidence,
} from './shared/testCheck.js'

//region 结构面

/** 投影状态（只描述模式本身）。 */
export interface CheckModeState {
  /** 模式当前是否活跃。 */
  active: boolean
  /** 是否进入过模式（粘性；规则段落据此常驻）。 */
  entered: boolean
  /** 当前单子 id（退出后保留，便于 chip/页签继续显示同一张单）。 */
  id: string
  /** 尚未结算的命令事件（run 与 done 配对用）。 */
  running: { commandId: string; off: boolean; id: string } | null
}

/** 投影初始状态。 */
export const TEST_CHECK_INITIAL: CheckModeState = { active: false, entered: false, id: '', running: null }

/** 投影定义里运行时的最小结构面。 */
interface ProjectionHandleLike {
  stateOf: (session: unknown) => unknown
}

/** 会话投影服务最小结构面。 */
interface ProjectionsLike {
  register?: (definition: unknown) => Promise<ProjectionHandleLike>
}

/** 系统提示服务最小结构面。 */
interface SystemPromptLike {
  section?: (spec: unknown) => unknown
  getSectionOrder?: (name: string) => number
}

/** 工具服务最小结构面。 */
interface ToolsLike {
  register?: (definition: unknown, options?: { when?: (context: { agent: { session: unknown } }) => boolean }) => unknown
}

/** 命令服务最小结构面。 */
interface CommandsLike {
  register?: (definition: unknown) => unknown
  execute?: (agent: unknown, line: string, attachments: readonly unknown[], signal?: AbortSignal) => Promise<{ result?: { kind?: string; text?: string } } | undefined>
}

/** 工具执行上下文最小结构面。 */
interface ToolExec {
  agent?: { session?: unknown } | undefined
  signal?: AbortSignal
}

/** 安装选项（测试可替换宿主模块加载与消息构造）。 */
export interface CheckModeOptions {
  /** 把纯文本包成宿主用户消息；缺省从 `@deepseek-ai/dsh-llm` 取 createUserMessage。 */
  buildUserMessage?: (text: string) => unknown
  /** 附件准备（默认落盘到 `.dsh/test-check/<id>/assets/`）；测试可替换。 */
  prepareAttachments?: (invocation: CheckInvocation, id: string) => Promise<CheckStage>
  /** 宿主模块加载（测试可注入假的）。 */
  loadModule?: (specifier: string) => Promise<unknown>
  /** 宿主上下文（取会话工作区与附件服务）。 */
  hostCtx?: unknown
}

//endregion

//region 投影折叠（纯）

/**
 * 折叠一条会话事件到模式状态。
 *
 * 只认 `command/run` 与配对的 `command/done`：本命令成功则按 off 收尾；进入官方 `/plan`
 * 或 `/html-plan` 时把本模式折回 inactive（同一时刻只有一个模式在管规则）。
 * @author ddj 2026年11月25号
 * @param state 上一状态
 * @param event 会话事件（只读 type/data）
 * @returns 新状态；不关心的事件返回原引用
 */
export function foldCheckMode(state: CheckModeState, event: unknown): CheckModeState {
  const row = event !== null && typeof event === 'object' ? event as { type?: unknown; data?: unknown } : {}
  const type = typeof row.type === 'string' ? row.type : ''
  const data = row.data !== null && typeof row.data === 'object' ? row.data as Record<string, unknown> : {}

  if (type === 'command/run') {
    const name = typeof data.name === 'string' ? data.name : ''
    const args = typeof data.args === 'string' ? data.args : ''
    const commandId = typeof data.commandId === 'string' ? data.commandId : ''
    const keyword = args.trim().toLowerCase()
    if (name === TEST_CHECK_COMMAND) {
      const parsed = parseCheckInput(args)
      const id = parsed.action === 'off' ? '' : testCheckIdOf(parsed.task)
      return { ...state, running: { commandId, off: parsed.action === 'off', id } }
    }
    if (name === 'plan' || name === 'html-plan') {
      // 另一个模式被「进入」时关闭本模式；它们自己的 off 动作不算。
      if (keyword === 'off') return state
      return { ...state, running: { commandId, off: true, id: '' } }
    }
    return state
  }

  if (type === 'command/done') {
    const running = state.running
    if (!running) return state
    if (String(data.commandId ?? '') !== running.commandId) return state
    if (data.kind !== 'success') return { ...state, running: null }
    if (running.off) return { ...state, active: false, running: null }
    return { active: true, entered: true, id: running.id, running: null }
  }

  return state
}

/** 投影定义（key/版本/校验/折叠/wire 视图）。 */
export const checkProjectionDefinition = {
  key: TEST_CHECK_MODE_KEY,
  stateVersion: 1,
  stateSchema: z.object({
    active: z.boolean(),
    entered: z.boolean(),
    id: z.string(),
    running: z.object({ commandId: z.string(), off: z.boolean(), id: z.string() }).strict().nullable(),
  }).strict(),
  init: (): CheckModeState => TEST_CHECK_INITIAL,
  apply: (state: CheckModeState, event: unknown): CheckModeState => foldCheckMode(state, event),
  wire: {
    viewSchema: z.object({ active: z.boolean(), id: z.string() }).strict(),
    view: (state: CheckModeState) => ({ active: state.active, id: state.id }),
  },
}

//endregion

//region 工具定义

/** 上报工具依赖。 */
export interface ReportToolDeps {
  /** 会话工作区。 */
  cwdOf: (session: unknown) => string | null
  /** 会话当前单子 id。 */
  idOf: (session: unknown) => string
  /** 模式是否活跃。 */
  activeOf: (session: unknown) => boolean
}

/** 上报工具回执。 */
export interface ReportToolResult {
  ok: boolean
  item?: string
  status?: string
  file?: string
  counts?: TestCheckCounts
  error?: string
}

/** 上报工具参数。 */
interface ReportArgs {
  item?: unknown
  status?: unknown
  summary?: unknown
  kind?: unknown
  command?: unknown
  exitCode?: unknown
  path?: unknown
}

/**
 * 构造 `test_check_report` 定义（每验一项必须调用它，且必须带证据）。
 * @author ddj 2026年11月25号
 * @param deps 会话解析与模式状态
 * @returns 工具定义参数
 */
export function reportToolOptions(deps: ReportToolDeps) {
  /**
   * 上报一条结果；参数问题返回可读原因，不抛错。
   * @author ddj 2026年11月25号
   * @param args 模型参数
   * @param exec 执行上下文
   * @returns 回执
   */
  async function execute(args: ReportArgs, exec: ToolExec): Promise<ReportToolResult> {
    const session = exec?.agent?.session
    if (!deps.activeOf(session)) return { ok: false, error: '测试验收模式未激活：先 /test-check 进入模式' }
    const cwd = deps.cwdOf(session)
    if (!cwd) return { ok: false, error: '上报需要所属会话的工作区' }
    if (exec?.signal?.aborted) return { ok: false, error: '上报已取消' }

    const item = typeof args?.item === 'string' ? args.item.trim() : ''
    const status = normalizeStatus(args?.status)
    const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
    if (!item) return { ok: false, error: 'item 必填：写验收单里的测试点 id（如 settings.claude-style.004）' }
    if (!status) return { ok: false, error: 'status 必填，只能是 pass / fail / blocked / skip' }
    if (!summary) return { ok: false, error: 'summary 必填：它就是这次验证的证据（测试名、命令或日志路径）' }

    const evidence: TestCheckEvidence = {
      kind: typeof args.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'test',
      summary,
    }
    if (typeof args.command === 'string' && args.command.trim()) evidence.command = args.command.trim()
    if (typeof args.exitCode === 'number' && Number.isFinite(args.exitCode)) evidence.exitCode = args.exitCode
    if (typeof args.path === 'string' && args.path.trim()) evidence.path = args.path.trim()

    try {
      const written = await writeEvent({
        cwd,
        id: deps.idOf(session),
        item,
        status,
        evidence,
      })
      return { ok: true, item, status, file: written.file, counts: written.view.counts }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** @author ddj 2026年11月25号 @param _args 参数 @param result 回执 @returns 模型可见文本 */
  function render(_args: ReportArgs, result: ReportToolResult): Array<{ type: string; text: string }> {
    if (!result?.ok) return [{ type: 'text', text: '上报未记录：' + String(result?.error ?? '未知原因') }]
    const counts = result.counts
    const tally = counts ? '（通过 ' + String(counts.pass) + '/' + String(counts.total) + ' · 失败 ' + String(counts.fail) + ' · 需复验 ' + String(counts.stale) + '）' : ''
    return [{ type: 'text', text: '已记录 ' + String(result.item) + ' = ' + String(result.status) + ' → ' + String(result.file ?? '') + tally }]
  }

  return {
    name: TEST_CHECK_REPORT_TOOL,
    description: 'Record one acceptance result with evidence. Every verified item must be reported here; '
      + 'a pass without evidence does not count. Args: item (id from items.json), status (pass|fail|blocked|skip), '
      + 'summary (the evidence: test name, command or log path).',
    parameters: {
      item: { type: 'string', required: true, description: 'Test point id from items.json, e.g. settings.claude-style.004.' },
      status: { type: 'string', required: true, description: 'pass | fail | blocked | skip.' },
      summary: { type: 'string', required: true, description: 'The evidence in one line: test file and counts, command, or log path.' },
      kind: { type: 'string', description: 'Evidence kind: test | command | file | log | manual (default test).' },
      command: { type: 'string', description: 'The command that produced the evidence, if any.' },
      exitCode: { type: 'number', description: 'Exit code of that command.' },
      path: { type: 'string', description: 'Evidence file path in the workspace (relative to the project root).' },
    },
    output: { schema: { type: 'json' }, render },
    isConcurrencySafe: false,
    execute,
  }
}

/** 收尾工具依赖。 */
export interface FinishToolDeps {
  /** 会话工作区。 */
  cwdOf: (session: unknown) => string | null
  /** 会话当前单子 id。 */
  idOf: (session: unknown) => string
  /** 模式是否活跃。 */
  activeOf: (session: unknown) => boolean
  /** 退出模式（执行 `/test-check off`）。 */
  exitMode: (agent: unknown, signal?: AbortSignal) => Promise<{ ok: boolean; error?: string }>
}

/** 收尾工具回执。 */
export interface FinishToolResult {
  ok: boolean
  path?: string
  counts?: TestCheckCounts
  /** 导出后是否已退出模式。 */
  exited?: boolean
  /** 退出失败的原因（导出本身仍然成功）。 */
  exitError?: string
  error?: string
}

/**
 * 构造 `test_check_finish` 定义：导出 `docs/acceptance-<id>.html`，默认随后退出模式。
 *
 * 收尾就是流程终点，所以默认把模式一起关掉；要留在模式里继续补验，带 `stay: true`。
 * 退出失败不影响导出结果，只在回执里说明并让模型手动 `/test-check off`。
 * @author ddj 2026年11月25号
 * @param deps 会话解析、模式状态与退出动作
 * @returns 工具定义参数
 */
export function finishToolOptions(deps: FinishToolDeps) {
  /**
   * 导出快照，默认随后退出模式；失败返回可读原因。
   * @author ddj 2026年11月25号
   * @param args 参数（stay 为真时保留模式）
   * @param exec 执行上下文
   * @returns 回执
   */
  async function execute(args: { stay?: unknown }, exec: ToolExec): Promise<FinishToolResult> {
    const session = exec?.agent?.session
    if (!deps.activeOf(session)) return { ok: false, error: '测试验收模式未激活：先 /test-check 进入模式' }
    const cwd = deps.cwdOf(session)
    if (!cwd) return { ok: false, error: '导出需要所属会话的工作区' }
    let result: { path: string; view: { counts: TestCheckCounts } }
    try {
      result = await exportSnapshot({ cwd, id: deps.idOf(session) })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    if (args?.stay === true) return { ok: true, path: result.path, counts: result.view.counts, exited: false }
    const exited = await deps.exitMode(exec?.agent, exec?.signal)
    return exited.ok
      ? { ok: true, path: result.path, counts: result.view.counts, exited: true }
      : { ok: true, path: result.path, counts: result.view.counts, exited: false, exitError: exited.error ?? '未知原因' }
  }

  /** @author ddj 2026年11月25号 @param _args 参数 @param result 回执 @returns 模型可见文本 */
  function render(_args: unknown, result: FinishToolResult): Array<{ type: string; text: string }> {
    if (!result?.ok) return [{ type: 'text', text: '导出失败：' + String(result?.error ?? '未知原因') }]
    const counts = result.counts
    const tally = counts
      ? '（通过 ' + String(counts.pass) + '/' + String(counts.total)
        + (counts.todo + counts.stale > 0 ? '，未验 ' + String(counts.todo) + ' · 需复验 ' + String(counts.stale) : '')
        + '）'
      : ''
    const mode = result.exited
      ? '；测试验收模式已退出。'
      : result.exitError
        ? '；模式没能自动退出（' + result.exitError + '），请手动执行 /test-check off。'
        : '；模式保留（stay），验完用 /test-check off 离开。'
    return [{ type: 'text', text: '验收快照已导出：' + String(result.path ?? '') + tally + mode }]
  }

  return {
    name: TEST_CHECK_FINISH_TOOL,
    description: 'Export the acceptance sheet to docs/acceptance-<id>.html and leave test-check mode. '
      + 'Pass stay: true to keep the mode active for one more round of verification.',
    parameters: {
      stay: { type: 'boolean', description: 'Keep test-check mode active after exporting (default false: finish also leaves the mode).' },
    },
    output: { schema: { type: 'json' }, render },
    isConcurrencySafe: false,
    execute,
  }
}

//endregion

//region 装配

/**
 * 从（注入作用域的）宿主上下文取服务：优先 `ctx.get`，退回同名属性。
 * @author ddj 2026年11月25号
 * @param ctx 宿主上下文
 * @param name 服务名
 * @returns 服务实例或 undefined
 */
function serviceOf(ctx: unknown, name: string): unknown {
  const scope = ctx as { get?: (key: string) => unknown } | undefined
  if (scope && typeof scope.get === 'function') {
    try {
      const value = scope.get(name)
      if (value !== undefined) return value
    } catch {
      /* 未注入的服务在旧宿主上可能抛错：退回属性读取 */
    }
  }
  return (ctx as Record<string, unknown> | undefined)?.[name]
}

/**
 * 在宿主生命期里执行一次注册：有 `effect` 就交给它托管卸载，没有就直接跑。
 * @author ddj 2026年11月25号
 * @param ctx 宿主上下文
 * @param run 注册动作
 * @param label 诊断标签
 * @returns 无
 */
function effectOf(ctx: unknown, run: () => unknown, label: string): void {
  const scope = ctx as { effect?: (action: () => unknown, label?: string) => unknown } | undefined
  if (scope && typeof scope.effect === 'function') {
    scope.effect(run, label)
    return
  }
  run()
}

/**
 * 加载可选宿主模块；失败返回 undefined（不阻断装配）。
 * @author ddj 2026年11月25号
 * @param load 加载函数
 * @param specifier 模块名
 * @returns 模块命名空间或 undefined
 */
async function safeLoad(load: (specifier: string) => Promise<unknown>, specifier: string): Promise<unknown> {
  try {
    return await load(specifier)
  } catch (error) {
    log.warn('宿主模块加载失败（' + specifier + '）：' + (error instanceof Error ? error.message : String(error)))
    return undefined
  }
}

/**
 * 装配测试验收模式：用 `ctx.inject` 等齐四项宿主服务后再注册。
 *
 * 服务齐了才装配（缺任何一项都不做半截模式）；旧宿主没有 `sessionProjections` 时
 * 调用会一直等待、不报错——`/test-check` 自然不可用，其余功能不受影响。
 * @author ddj 2026年11月25号
 * @param ctx 宿主上下文
 * @param options 安装选项
 * @returns 是否已调度装配
 */
export function installCheckMode(ctx: Ctx, options: CheckModeOptions = {}): boolean {
  if (typeof ctx?.inject !== 'function') {
    log.warn('/test-check 未装配：DSH 未提供 ctx.inject')
    return false
  }
  try {
    ctx.inject(
      ['sessionProjections', 'systemPrompt', 'tools', 'commands'],
      (sctx: unknown) => {
        void setupCheckMode(sctx, { ...options, hostCtx: sctx }).catch((error: unknown) => {
          log.warn('/test-check 装配失败：' + (error instanceof Error ? error.message : String(error)))
        })
      },
    )
    return true
  } catch (error) {
    log.warn('/test-check 装配调度失败：' + (error instanceof Error ? error.message : String(error)))
    return false
  }
}

/**
 * 真正把投影、两条 section、两个工具与命令挂到宿主上。
 * @author ddj 2026年11月25号
 * @param ctx 已注入服务的宿主上下文
 * @param options 安装选项
 * @returns 是否装配成功
 */
export async function setupCheckMode(ctx: unknown, options: CheckModeOptions = {}): Promise<boolean> {
  const loadModule = typeof options.loadModule === 'function' ? options.loadModule : loadHostModule
  const projections = serviceOf(ctx, 'sessionProjections') as ProjectionsLike | undefined
  if (!projections || typeof projections.register !== 'function') {
    log.warn('/test-check 未装配：宿主没有 sessionProjections 服务（测试验收模式不可用）')
    return false
  }

  let handle: ProjectionHandleLike
  try {
    handle = await projections.register(checkProjectionDefinition as unknown)
  } catch (error) {
    log.warn('/test-check 未装配：会话投影注册失败：' + (error instanceof Error ? error.message : String(error)))
    return false
  }

  /** @author ddj 2026年11月25号 @param session 会话 @returns 投影状态（异常按未进入处理） */
  function stateOf(session: unknown): CheckModeState {
    if (!session) return TEST_CHECK_INITIAL
    try {
      const raw = handle.stateOf(session) as Partial<CheckModeState> | undefined
      return {
        active: raw?.active === true,
        entered: raw?.entered === true,
        id: typeof raw?.id === 'string' ? raw.id : '',
        running: raw?.running ?? null,
      }
    } catch {
      return TEST_CHECK_INITIAL
    }
  }
  /** @author ddj 2026年11月25号 @param session 会话 @returns 是否活跃 */
  function activeOf(session: unknown): boolean {
    return stateOf(session).active === true
  }
  /** @author ddj 2026年11月25号 @param session 会话 @returns 是否进入过模式 */
  function enteredOf(session: unknown): boolean {
    return stateOf(session).entered === true
  }
  /** @author ddj 2026年11月25号 @param session 会话 @returns 当前单子 id（缺省用默认 id） */
  function idOf(session: unknown): string {
    const id = stateOf(session).id
    return id || TEST_CHECK_DEFAULT_ID
  }
  /** @author ddj 2026年11月25号 @param session 会话 @returns 会话工作区 */
  function cwdOf(session: unknown): string | null {
    if (!session) return null
    try {
      return cwdOfSession(ctx as never, session as never)
    } catch {
      return null
    }
  }
  /** @author ddj 2026年11月25号 @param session 会话 @returns 项目根（拿不到工作区时为空串） */
  function rootOf(session: unknown): string {
    const cwd = cwdOf(session)
    if (!cwd) return ''
    try {
      return projectRootOf(cwd)
    } catch {
      return ''
    }
  }

  // 两条系统提示 section（对齐官方 plan:policy / plan:status）。
  const systemPrompt = serviceOf(ctx, 'systemPrompt') as SystemPromptLike | undefined
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    let baseOrder = 550
    try {
      if (typeof systemPrompt.getSectionOrder === 'function') {
        const order = systemPrompt.getSectionOrder('PLAN_POLICY')
        if (typeof order === 'number' && Number.isFinite(order)) baseOrder = order
      }
    } catch {
      /* 旧宿主没有该常量表：用回退顺序 */
    }
    const policy = {
      name: 'vscode-mode:test-check-policy',
      retirement: 'Test-check mode is no longer available. Its instructions no longer apply.',
      order: baseOrder + 0.7,
      /** @author ddj 2026年11月25号 / 2026年11月26号 @param asm 装配上下文 @returns 规则文本或空串 */
      text: (asm: { agent?: { session?: unknown } }) => {
        const session = asm?.agent?.session
        if (!enteredOf(session)) return ''
        const policy = policyTextOf(rootOf(session))
        return testCheckPolicyText(policy.text, !policy.isDefault)
      },
    }
    const status = {
      name: 'vscode-mode:test-check-status',
      replacement: '',
      order: baseOrder + 1.7,
      /** @author ddj 2026年11月25号 @param asm 装配上下文 @returns 一行状态或空串 */
      text: (asm: { agent?: { session?: unknown } }) => {
        const session = asm?.agent?.session
        if (!session) return ''
        const state = stateOf(session)
        return testCheckStatusText(state.entered, state.active)
      },
    }
    effectOf(ctx, () => systemPrompt.section!(policy), 'vscode-mode: test-check policy section')
    effectOf(ctx, () => systemPrompt.section!(status), 'vscode-mode: test-check status section')
  } else {
    log.warn('/test-check 规则未注入：宿主没有 systemPrompt.section 服务')
  }

  // 两个工具：从首次进入起常驻准入（对齐官方渐进式披露），执行时再校验活跃。
  try {
    const toolsModule = await loadModule('@deepseek-ai/dsh-tools') as { defineTool?: (options: unknown) => unknown }
    if (typeof toolsModule?.defineTool === 'function') {
      const deps = {
        cwdOf,
        idOf,
        activeOf,
        exitMode: (agent: unknown, signal?: AbortSignal) => runExitLine(ctx, agent, signal),
      }
      const definitions = [
        toolsModule.defineTool(reportToolOptions(deps)),
        toolsModule.defineTool(finishToolOptions(deps)),
      ]
      effectOf(ctx, () => {
        const tools = serviceOf(ctx, 'tools') as ToolsLike | undefined
        if (!tools || typeof tools.register !== 'function') {
          log.warn('test_check_report / test_check_finish 未注册：宿主没有 tools 服务')
          return undefined
        }
        for (const definition of definitions) {
          tools.register(definition, { when: (context) => enteredOf(context?.agent?.session) })
        }
        return undefined
      }, 'vscode-mode: test-check tools')
    } else {
      log.warn('test_check_report / test_check_finish 未注册：无法从宿主加载 defineTool')
    }
  } catch (error) {
    log.warn('test_check_report / test_check_finish 未注册：' + (error instanceof Error ? error.message : String(error)))
  }

  // 命令：`/test-check [off|任务]`（commands 已在注入列表里，不会缺席）。
  const llm = await safeLoad(loadModule, '@deepseek-ai/dsh-llm') as { createUserMessage?: (input: unknown) => unknown } | undefined
  const buildUserMessage = typeof options.buildUserMessage === 'function'
    ? options.buildUserMessage
    : (typeof llm?.createUserMessage === 'function'
        ? (text: string) => llm!.createUserMessage!({ content: [{ type: 'text', text }], source: { kind: 'user' } })
        : undefined)

  const commands = serviceOf(ctx, 'commands') as CommandsLike | undefined
  if (!commands || typeof commands.register !== 'function') {
    log.warn('/test-check 命令未注册：commands 服务不支持 register')
    return false
  }
  try {
    const definition = checkCommand({
      buildUserMessage,
      prepareAttachments: options.prepareAttachments,
      hostCtx: options.hostCtx ?? ctx,
    })
    effectOf(ctx, () => commands.register!(definition), 'vscode-mode: test-check command')
    log.info('/test-check 已注册：测试验收模式（投影 + 规则 + 上报/导出工具）')
  } catch (error) {
    log.warn('/test-check 注册失败：' + (error instanceof Error ? error.message : String(error)))
    return false
  }
  return true
}

/**
 * 执行 `/test-check off` 并归一成败（收尾工具自动退出用）。
 * @author ddj 2026年11月25号
 * @param ctx 宿主上下文
 * @param agent 调用方 agent
 * @param signal 取消信号
 * @returns ok + 失败原因
 */
async function runExitLine(ctx: unknown, agent: unknown, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  const commands = serviceOf(ctx, 'commands') as CommandsLike | undefined
  if (!commands || typeof commands.execute !== 'function') return { ok: false, error: '命令服务不可用' }
  try {
    const execution = await commands.execute(agent, TEST_CHECK_OFF_LINE, [], signal)
    if (!execution) return { ok: false, error: '命令没有返回结果' }
    const kind = execution.result?.kind
    if (kind === 'success') return { ok: true }
    return { ok: false, error: String(execution.result?.text ?? '未知原因') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

//endregion
