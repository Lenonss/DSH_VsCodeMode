/**
 * dsh-vscode-mode client — 调试会话 store（单例）：host 状态轮询镜像 + 动作封装。
 * - 轮询：phase 非 idle/terminated 时 400ms 拉 `edrv.dap.poll`（增量事件游标）；
 *   空闲时停表（零开销）。host 不可达/降级（旧 host 无方法）静默空转。
 * - paused → state.topFrame 驱动 `edrv:debug-stopped` 事件（EditorView 跳转高亮）。
 * - 断点：本地表（localStorage per scope）+ `edrv.dap.setBreakpoints` 同步 host；
 *   host 不可达时仅本地，下次 start 由 manager.flushBreakpoints 全量下发。
 * 作者 ddj 2026年09月29号
 */
import { rpc } from '../rpc.js'
import type { DapAction, DapAdapterInfo, DapBreakpointInput, DapDebugConfig, DapEventView, DapFrameView, DapPhase, DapPollResult, DapProcessInfo, DapScopeView, DapStateView, DapVariableView } from '../../shared/dap.js'
import { bpLinesOf, loadBpMap, removeAll, saveBpMap, setAllEnabled, toggleBp, updateBpFields, type BpEntry, type BpMap } from './breakpoints.js'
import { resolvePidPlan } from './pidPick.js'
import { dapTrace } from './trace.js'

/** 客户端轮询间隔（调试活跃期）。 */
const POLL_MS = 400
/** 事件缓存上限（调试控制台渲染源，批次 3 消费）。 */
const EVENT_CAP = 400
/** 记忆配置名的 localStorage key。 */
const CFG_KEY = 'edrv.dap.selectedConfig'

/** 对外快照（useSyncExternalStore 口径：version 驱动重渲）。 */
export interface DapSnapshot {
  version: number
  phase: DapPhase
  configName?: string
  configType?: string
  pid?: number
  error?: string
  topFrame: DapStateView['topFrame']
  configs: DapDebugConfig[]
  /** 已发现适配器可用性（下拉置灰与原因提示；旧 host 无此数据时为空表）。 */
  adapters: DapAdapterInfo[]
  selectedConfig: string | null
  /** 当前选中的调用栈帧 id。 */
  selectedFrameId: number
  /** 进程选择器候选（非 null = 工具条切选择模式，多候选附加时出现）。 */
  candidates: DapProcessInfo[] | null
  /** 断点回执版本（适配器真实回执到达时推进，驱动空心断点重渲）。 */
  bpAckVersion: number
}

/** store 单例类型。 */
export interface DapStore {
  subscribe(fn: () => void): () => void
  getSnapshot(): DapSnapshot
  outputs(): DapEventView[]
  setWorkspace(path: string): void
  workspace(): string
  ensureConfigs(force?: boolean): Promise<DapDebugConfig[]>
  selectConfig(name: string): void
  currentConfig(): DapDebugConfig | null
  processes(processName?: string): Promise<DapProcessInfo[]>
  start(pid?: number): Promise<void>
  /** 确认进程选择器（按选定 pid 重新启动）。 */
  confirmPick(pid: number): void
  /** 取消进程选择器。 */
  cancelPick(): void
  stop(): Promise<void>
  startOrContinue(): void
  /** 运行到行（临时断点 + 继续；命中后自动清理，不影响用户断点）。 */
  runTo(cwd: string, path: string, line: number): Promise<void>
  action(action: DapAction): Promise<void>
  toggleAt(scope: string, cwd: string, path: string, line: number): BpMap
  setBpEnabled(scope: string, cwd: string, path: string, line: number, enabled: boolean): void
  /** 全量启停所有断点（跨文件；逐含断点文件全量同步 host）。 */
  setAllBpEnabled(scope: string, cwd: string, enabled: boolean): void
  /** 清空所有断点（逐文件同步空载荷；Monaco 装饰与 host 断点同步清空）。 */
  removeAllBps(scope: string, cwd: string): void
  applyBpFields(scope: string, cwd: string, path: string, line: number, fields: { condition?: string; hitCondition?: string; logMessage?: string }): void
  bpMapOf(scope: string): BpMap
  pointsOf(path: string, list: BpEntry[]): DapBreakpointInput[]
  syncPoints(cwd: string, path: string, list: BpEntry[]): void
  /** 断点回执查询（适配器在线时的真实 verified/挪行；无回执返回 null）。 */
  ackOf(path: string, line: number): { verified: boolean; line: number; message?: string } | null
  /** 客户端（重）装配后与 host 对账：采纳在跑的会话状态并按需续轮询（幂等）。 */
  resync(): Promise<void>
  /** 选择当前栈帧；暂停态下驱动 Variables/Watch/REPL 上下文切换。 */
  selectFrame(frameId: number): void
  stackTrace(): Promise<DapFrameView[]>
  scopes(frameId: number): Promise<DapScopeView[]>
  variables(ref: number): Promise<DapVariableView[]>
  evaluate(expression: string, frameId?: number): Promise<{ result: string; type?: string; ref: number }>
}

let version = 0
let bpVersion = 0
let pollSeq = 0
let timer: ReturnType<typeof setInterval> | null = null
let workspacePath = ''
let selectedConfig: string | null = null
let configs: DapDebugConfig[] = []
let adapters: DapAdapterInfo[] = []
let configsDirty = true
let state: DapStateView = { phase: 'idle', topFrame: null }
let selectedFrameId = 0
let outputs: DapEventView[] = []
let lastTopKey = ''
let bpScope = ''
let bpMap: BpMap = {}
let candidates: DapProcessInfo[] | null = null
/** 断点回执（key = path:line 请求行；适配器在线时真实回执，start/stop 清空）。 */
const bpAcks = new Map<string, { verified: boolean; line: number; message?: string }>()
let bpAckVersion = 0
/** 运行到行的临时断点（命中/离开暂停后自动移除，不动用户断点表）。 */
let runToFile = ''
let runToLine = 0
let runToCwd = ''
let runToScope = ''
/** 本次运行到行是否真的插入了临时断点（目标行已有用户断点时不需要插，清理时也不得动它）。 */
let runToAdded = false
/** runTo 自身发起的 continue：不得立即清理刚下发的临时断点。 */
let runToContinuing = false
/** 对账进行中标记（重复 apply/挂载不并发打多轮 poll）。 */
let resyncing = false
const listeners = new Set<() => void>()

/** 通知订阅者（版本推进）。 */
function emit(): void {
  version += 1
  for (const fn of listeners) fn()
}

/** 首帧 key（同文件同行不重复派发跳转）。 */
function topKeyOf(top: NonNullable<DapStateView['topFrame']>): string {
  return top.file + ':' + top.line
}

/** 运行到行命中后的清理：仅移除本次插入的临时断点（用户断点表始终不受影响）。 */
function clearRunTo(store: { bpMapOf: (scope: string) => BpMap; syncPoints: (cwd: string, path: string, list: BpEntry[]) => void }): void {
  if (!runToFile || !runToAdded) { runToFile = ''; runToLine = 0; runToCwd = ''; runToScope = ''; runToAdded = false; return }
  const file = runToFile
  const cwd = runToCwd
  const line = runToLine
  const scope = runToScope
  runToFile = ''
  runToLine = 0
  runToCwd = ''
  runToScope = ''
  runToAdded = false
  const list = (store.bpMapOf(scope)[file] ?? []).filter((it) => it.line !== line)
  store.syncPoints(cwd, file, list)
}

/** 应用一轮 poll 结果。 */
function applyPoll(result: DapPollResult): void {
  const prevPhase = state.phase
  state = result.state
  pollSeq = result.nextSeq
  let changed = prevPhase !== state.phase
  if (result.events.length) {
    outputs.push(...result.events)
    if (outputs.length > EVENT_CAP) outputs.splice(0, outputs.length - EVENT_CAP)
  }
  // 运行到行：命中目标行（暂停且首帧即目标）→ 移除临时断点
  if (state.phase === 'paused' && state.topFrame && runToFile) {
    const hit = state.topFrame.file?.replace(/\\/g, '/') === runToFile
    if (hit) clearRunTo(dapStore)
  }
  if (state.phase === 'paused' && state.topFrame) {
    const key = topKeyOf(state.topFrame)
    if (key !== lastTopKey) {
      lastTopKey = key
      selectedFrameId = 0
      changed = true
      dapTrace('stopped', { topFrame: state.topFrame, selectedFrameId })
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('edrv:debug-stopped', {
          detail: { file: state.topFrame.file, line: state.topFrame.line },
        }))
      }
    }
  } else if (state.phase !== 'paused') {
    selectedFrameId = 0
  }
  if (state.phase === 'idle' || state.phase === 'terminated') stopTimer()
  if (changed) emit()
}

/**
 * 会话是否处于活动相位（需要继续轮询跟踪）。
 * 按「非 idle/terminated」判定：新增相位默认按活动处理，避免漏跟。
 * @author ddj 2026年09月21号
 * @param phase host 上报的会话相位
 */
function activePhase(phase: DapPhase): boolean {
  return phase !== 'idle' && phase !== 'terminated'
}

/** 确保轮询在跑。 */
function ensureTimer(): void {
  if (timer || typeof window === 'undefined') return
  timer = setInterval(() => { void pollOnce() }, POLL_MS)
}

/** 停轮询。 */
function stopTimer(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

/** 单轮 poll（失败/降级静默停表，下次动作重启）。 */
async function pollOnce(): Promise<void> {
  if (state.phase === 'idle' || state.phase === 'terminated') { stopTimer(); return }
  try {
    const res = await rpc('edrv.dap.poll', { since: pollSeq })
    if (res.ok) applyPoll(res)
    else stopTimer()
  } catch {
    stopTimer()
  }
}

/** 调试 store 单例。 */
export const dapStore: DapStore = {
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  getSnapshot() {
    return {
      version,
      phase: state.phase,
      configName: state.configName,
      configType: state.configType,
      pid: state.pid,
      error: state.error,
      topFrame: state.phase === 'paused' ? state.topFrame : null,
      configs,
      adapters,
      selectedConfig,
      bpVersion,
      selectedFrameId,
      candidates,
      bpAckVersion,
    }
  },

  outputs() {
    return outputs
  },

  setWorkspace(path) {
    if (path === workspacePath) return
    workspacePath = path
    configsDirty = true
    if (state.phase === 'idle') emit()
  },

  workspace() {
    return workspacePath
  },

  async ensureConfigs(force = false) {
    if (!workspacePath) return []
    if (!force && !configsDirty && configs.length) return configs
    try {
      const res = await rpc('edrv.dap.configs', { workspacePath })
      if (res.ok) {
        configs = res.configs
        adapters = res.adapters ?? []
        configsDirty = false
        if (!selectedConfig) {
          try { selectedConfig = localStorage.getItem(CFG_KEY) } catch { /* 忽略 */ }
        }
        if (!configs.some((c) => c.name === selectedConfig)) selectedConfig = configs[0]?.name ?? null
        emit()
      }
    } catch { /* host 降级：保持空表 */ }
    return configs
  },

  selectConfig(name) {
    selectedConfig = name
    try { localStorage.setItem(CFG_KEY, name) } catch { /* 忽略 */ }
    emit()
  },

  currentConfig() {
    return configs.find((c) => c.name === selectedConfig) ?? configs[0] ?? null
  },

  async processes(processName) {
    try {
      const res = await rpc('edrv.dap.processes', { processName })
      return res.ok ? res.items : []
    } catch {
      return []
    }
  },

  /**
   * 客户端（重）装配后与 host 对账：整页刷新 / 插件热换 bundle 会复位本模块状态，
   * 而 host 的 DapSession 常驻（可能仍停在断点）—— 不对账则 phase 恒为 idle，
   * 工具栏、变量面板与「暂停态 hover」全部静默失效。
   * 只取当前状态、以超大游标跳过历史事件（重装不该回放调试控制台）。
   * @author ddj 2026年09月21号
   */
  async resync() {
    if (timer || resyncing) return
    resyncing = true
    try {
      const res = await rpc('edrv.dap.poll', { since: Number.MAX_SAFE_INTEGER })
      if (!res.ok) return
      applyPoll({ state: res.state, events: [], nextSeq: res.nextSeq })
      if (activePhase(res.state.phase)) ensureTimer()
    } catch { /* host 降级：保持 idle，用户动作会再触发 */ } finally {
      resyncing = false
    }
  },

  async start(pid) {
    const config = this.currentConfig()
    if (!config || !workspacePath) return
    // attach 型且无 pid/processId：客户端先做 0/1/多 命中决策（多候选弹进程选择器，
    // 避免 host 侧唯一命中校验把多候选变成一条不可操作的错误文案）
    let targetPid = pid && pid > 0 ? pid : undefined
    const isAttach = config.request === 'attach' || (!config.request && config.type === 'emmylua_attach')
    if (isAttach && !targetPid && !config.processId) {
      const items = await this.processes(config.processName)
      const plan = resolvePidPlan(items, config.processName)
      if (plan.kind === 'none') {
        state = { phase: 'idle', error: plan.message, topFrame: null }
        candidates = null
        emit()
        return
      }
      if (plan.kind === 'picker') {
        candidates = plan.items
        state = { phase: 'idle', topFrame: null }
        emit()
        return
      }
      targetPid = plan.pid
    }
    try {
      const res = await rpc('edrv.dap.start', { config, workspacePath, pid: targetPid })
      if (res.ok) {
        candidates = null
        selectedFrameId = 0
        bpAcks.clear()
        bpAckVersion += 1
        state = { phase: res.phase, configName: config.name, configType: config.type, pid: targetPid, topFrame: null }
        lastTopKey = ''
        emit()
        ensureTimer()
        void pollOnce()
      } else {
        state = { phase: 'idle', error: res.error, topFrame: null }
        emit()
      }
    } catch (error) {
      state = { phase: 'idle', error: String(error), topFrame: null }
      emit()
    }
  },

  /** 确认进程选择器：按选定 pid 重新启动。 */
  confirmPick(pid) {
    candidates = null
    emit()
    void this.start(pid)
  },

  /** 取消进程选择器。 */
  cancelPick() {
    candidates = null
    emit()
  },

  async stop() {
    try { await rpc('edrv.dap.stop', {}) } catch { /* 忽略 */ }
    state = { phase: 'terminated', configName: state.configName, topFrame: null }
    selectedFrameId = 0
    bpAcks.clear()
    bpAckVersion += 1
    stopTimer()
    emit()
  },

  startOrContinue() {
    if (state.phase === 'paused') void this.action('continue')
    else if (state.phase === 'idle' || state.phase === 'terminated') void this.start()
  },

  /** 运行到行（VS Code 同款语义：临时断点 + 继续，命中后自动移除，不动用户断点表）。 */
  async runTo(cwd, path, line) {
    if (!cwd || !path || !line) return
    const scope = bpScope
    const existing = this.bpMapOf(scope)[path] ?? []
    // 目标行已有用户断点时无需插临时断点（直接继续即可命中）
    const already = existing.some((it) => it.line === line)
    runToFile = path.replace(/\\/g, '/')
    runToLine = line
    runToCwd = cwd
    runToScope = scope
    runToAdded = !already
    if (runToAdded) this.syncPoints(cwd, path, [...existing, { line, enabled: true }])
    if (state.phase === 'paused') {
      runToContinuing = true
      await this.action('continue')
      runToContinuing = false
    }
  },

  async action(action) {
    try {
      const res = await rpc('edrv.dap.command', { action })
      if (res.ok && action !== 'pause' && action !== 'disconnect') {
        state = { ...state, phase: 'running', topFrame: null }
        // 手动继续/步进时若仍有未命中的运行到行临时断点，一并清理（runTo 自身发起的 continue 除外）
        if (!runToContinuing && (action === 'continue' || action === 'next' || action === 'stepIn' || action === 'stepOut')) clearRunTo(this)
        emit()
        ensureTimer()
        void pollOnce()
      }
    } catch { /* 忽略 */ }
  },

  toggleAt(scope, cwd, path, line) {
    const next = toggleBp(this.bpMapOf(scope), path, line)
    bpMap = next.map
    bpScope = scope
    bpVersion += 1
    saveBpMap(scope, bpMap)
    emit()
    this.syncPoints(cwd, path, bpMap[path] ?? [])
    return bpMap
  },

  /** 断点启停（只改 enabled 不删条目；禁用行不下发 host）。 */
  setBpEnabled(scope, cwd, path, line, enabled) {
    const map = this.bpMapOf(scope)
    const list = (map[path] ?? []).map((it) => (it.line === line ? { ...it, enabled } : it))
    const next: BpMap = { ...map, [path]: list }
    bpMap = next
    bpVersion += 1
    saveBpMap(scope, next)
    emit()
    this.syncPoints(cwd, path, next[path] ?? [])
  },

  /** 全量启停所有断点（跨文件；已处于目标态的条目原样保留，同步幂等）。 */
  setAllBpEnabled(scope, cwd, enabled) {
    const next = setAllEnabled(this.bpMapOf(scope), enabled)
    bpMap = next
    bpScope = scope
    bpVersion += 1
    saveBpMap(scope, next)
    emit()
    if (!cwd) return
    for (const path of Object.keys(next)) this.syncPoints(cwd, path, next[path] ?? [])
  },

  /** 清空所有断点（纯函数给出曾有条目的文件清单，逐文件下发空载荷）。 */
  removeAllBps(scope, cwd) {
    const cleared = removeAll(this.bpMapOf(scope))
    bpMap = cleared.map
    bpScope = scope
    bpVersion += 1
    saveBpMap(scope, bpMap)
    emit()
    if (!cwd) return
    for (const path of cleared.files) this.syncPoints(cwd, path, [])
  },

  /** 编辑断点字段（条件/命中次数/日志；空串清除，随后全量同步）。 */
  applyBpFields(scope, cwd, path, line, fields) {
    const next = updateBpFields(this.bpMapOf(scope), path, line, fields)
    bpMap = next
    bpScope = scope
    bpVersion += 1
    saveBpMap(scope, next)
    emit()
    this.syncPoints(cwd, path, next[path] ?? [])
  },

  /** 启用条目 → DAP 断点载荷（含条件等编辑字段）。 */
  pointsOf(path, list: BpEntry[]): DapBreakpointInput[] {
    return list.filter((it) => it.enabled).map((it) => ({
      path,
      line: it.line,
      condition: it.condition,
      hitCondition: it.hitCondition,
      logMessage: it.logMessage,
    }))
  },

  /** 按完整条目同步某文件断点到 host，并消费适配器真实回执（驱动空心断点渲染）。 */
  syncPoints(cwd: string, path: string, list: BpEntry[]): void {
    if (!cwd) return
    const points = this.pointsOf(path, list)
    void rpc('edrv.dap.setBreakpoints', { workspacePath: cwd, file: path, points })
      .then((res) => {
        if (!res.ok) return
        for (const key of [...bpAcks.keys()]) {
          if (key.startsWith(path + ':')) bpAcks.delete(key)
        }
        for (let i = 0; i < res.breakpoints.length; i++) {
          const point = points[i]
          const ack = res.breakpoints[i]
          if (!point || !ack) continue
          bpAcks.set(path + ':' + point.line, { verified: ack.verified, line: ack.line, ...(ack.message ? { message: ack.message } : {}) })
        }
        bpAckVersion += 1
        emit()
      })
      .catch(() => { /* host 不可达：重连后再同步 */ })
  },

  /** 断点回执查询（适配器在线时的真实 verified/挪行；无回执返回 null）。 */
  ackOf(path: string, line: number) {
    return bpAcks.get(path + ':' + line) ?? null
  },

  bpMapOf(scope) {
    if (bpScope !== scope) {
      bpScope = scope
      bpMap = loadBpMap(scope)
    }
    return bpMap
  },

  /** 选择当前栈帧；非暂停态忽略无效选择。 */
  selectFrame(frameId) {
    if (state.phase !== 'paused' || !Number.isFinite(frameId) || frameId < 0) return
    if (selectedFrameId === frameId) return
    selectedFrameId = frameId
    emit()
  },

  async stackTrace() {
    try {
      const res = await rpc('edrv.dap.stackTrace', {})
      return res.ok ? res.frames : []
    } catch {
      return []
    }
  },

  async scopes(frameId) {
    try {
      const res = await rpc('edrv.dap.scopes', { frameId })
      return res.ok ? res.scopes : []
    } catch {
      return []
    }
  },

  async variables(ref) {
    try {
      const res = await rpc('edrv.dap.variables', { ref })
      return res.ok ? res.variables : []
    } catch {
      return []
    }
  },

  async evaluate(expression, frameId) {
    try {
      const res = await rpc('edrv.dap.evaluate', { expression, frameId })
      if (res.ok) return { result: res.result, type: res.type, ref: res.ref }
      return { result: res.error, ref: 0 }
    } catch (error) {
      return { result: String(error), ref: 0 }
    }
  },
}
