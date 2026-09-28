/**
 * dsh-vscode-mode host — SVN update job with incremental output and bounded replay.
 * @author ddj 2026年09月24号
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { SvnUpdateCounts, SvnUpdatePhase, SvnUpdatePoll, SvnUpdateRow, SvnUpdateState } from './shared/svn.js'
import { updateLineOf } from './svnText.js'

const ROW_CAP = 20_000
const PAGE_SIZE = 250
const RAW_CAP = 32_000
const LINE_CAP = 16_000
const JOB_CAP = 16
const RESULT_TTL_MS = 10 * 60_000
const UPDATE_MAX_MS = 60 * 60_000
const COLLECT_MS = 100

interface OutputRead { text: string; nextOffset: number; lossy: boolean }
interface OutputReader { readFrom(offset: number): OutputRead }
interface ExitFacts { exitCode: number | null; code?: number | null }
interface ManagedHandle {
  done: Promise<ExitFacts>
  terminate(): void
  collected?: { stdout?: OutputReader; stderr?: OutputReader }
}
interface TerminalHandle {
  done: Promise<ExitFacts>
  terminate(): Promise<void>
  output: Readable
}
export interface UpdateProcess {
  spawn(spec: Record<string, unknown>): ManagedHandle
  spawnTerminal?: (spec: Record<string, unknown>) => Promise<TerminalHandle>
}
export interface UpdateTarget {
  cwd: string
  root: string
  path: string
  exe: string
}
interface UpdateJob {
  id: string
  root: string
  cwd: string
  target: string
  phase: SvnUpdatePhase
  counts: SvnUpdateCounts
  revision: number | null
  error: string
  rawTail: string
  truncated: boolean
  startedAt: number
  endedAt: number | null
  rows: SvnUpdateRow[]
  seq: number
  pending: string
  cancelled: boolean
  exited: boolean
  probeAbort?: AbortController
  timer?: ReturnType<typeof setInterval>
  deadline?: ReturnType<typeof setTimeout>
  stop?: () => void
}

/**
 * 创建每个任务独立的 SVN 状态计数。
 * @author ddj 2026年09月24号
 * @returns 初始计数
 */
function emptyCounts(): SvnUpdateCounts {
  return { A: 0, U: 0, D: 0, G: 0, C: 0, E: 0, R: 0 }
}

/**
 * 工作副本根作为并发键；Windows 路径大小写不敏感。
 * @author ddj 2026年09月24号
 * @param root 工作副本根
 * @param platform 目标平台
 * @returns 并发键
 */
function rootKey(root: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? root.toLowerCase() : root
}

/**
 * 有状态更新任务：原 RPC 与新后台任务独立，测试可注入进程服务/时钟。
 * @author ddj 2026年09月24号
 */
export class SvnUpdateJobs {
  private readonly jobs = new Map<string, UpdateJob>()
  private readonly platform: NodeJS.Platform
  private readonly now: () => number

  /**
   * 建立任务管理器。
   * @author ddj 2026年09月24号
   * @param service DSH subprocess 服务获取器
   * @param platform 平台
   * @param now 时钟
   */
  constructor(
    private readonly service: () => UpdateProcess | null,
    platform: NodeJS.Platform = process.platform,
    now: () => number = Date.now,
  ) {
    this.platform = platform
    this.now = now
  }

  /**
   * 同根重复点击只返回当前任务；旧结果可由 active 取回，新点击启动新任务。
   * @author ddj 2026年09月24号
   * @param target 已验证的工作副本目标
   * @returns 任务初始状态
   */
  start(target: UpdateTarget): SvnUpdateState {
    this.prune()
    const key = rootKey(target.root, this.platform)
    const old = this.jobs.get(key)
    if (old && !this.isFinal(old.phase)) return this.stateOf(old)
    if (!old && this.jobs.size >= JOB_CAP) throw new Error('同时保留的 SVN 更新任务过多，请稍后重试')
    const job: UpdateJob = {
      id: randomUUID(), root: target.root, cwd: target.cwd, target: target.path,
      phase: 'starting', counts: emptyCounts(), revision: null, error: '', rawTail: '',
      truncated: false, startedAt: this.now(), endedAt: null, rows: [], seq: 0,
      pending: '', cancelled: false, exited: false,
    }
    this.jobs.set(key, job)
    void this.launch(job, target.exe)
    return this.stateOf(job)
  }

  /**
   * 游标分页取状态；即使前端掉线，有限窗口仍可重新读取。
   * @author ddj 2026年09月24号
   * @param root 已验证会话的工作副本根
   * @param jobId 任务 id
   * @param since 最后一条已读序号
   * @returns 一页增量及状态
   */
  poll(root: string, jobId: string, since: number): SvnUpdatePoll {
    const job = this.getJob(root, jobId)
    const offset = job.rows[0]?.seq ?? job.seq + 1
    const cursor = Math.max(offset - 1, Number.isFinite(since) ? Math.floor(since) : 0)
    const start = Math.max(0, cursor - offset + 1)
    const rows = job.rows.slice(start, start + PAGE_SIZE)
    return { ...this.stateOf(job), rows, offset, totalSeq: job.seq, nextSeq: rows.at(-1)?.seq ?? cursor }
  }

  /**
   * 请求终止整个受管进程范围；真实退出前保持 cancelling 状态。
   * @author ddj 2026年09月24号
   * @param root 已验证会话的工作副本根
   * @param jobId 任务 id
   * @returns 当前状态
   */
  cancel(root: string, jobId: string): SvnUpdateState {
    const job = this.getJob(root, jobId)
    if (!this.isFinal(job.phase) && !job.exited) {
      job.cancelled = true
      job.phase = 'cancelling'
      job.probeAbort?.abort(new Error('用户已取消 SVN 更新'))
      try { job.stop?.() } catch (error) { job.error = String(error) }
    }
    return this.stateOf(job)
  }

  /**
   * 按当前会话工作副本恢复进行中或最近一次结果。
   * @author ddj 2026年09月24号
   * @param root 已验证的工作副本根
   * @returns 状态或 null
   */
  active(root: string): SvnUpdateState | null {
    this.prune()
    const job = this.jobs.get(rootKey(root, this.platform))
    return job ? this.stateOf(job) : null
  }

  /**
   * 插件卸载回收任务与定时器。
   * @author ddj 2026年09月24号
   */
  dispose(): void {
    for (const job of this.jobs.values()) {
      if (job.timer) clearInterval(job.timer)
      if (job.deadline) clearTimeout(job.deadline)
      if (!this.isFinal(job.phase)) {
        job.cancelled = true
        job.probeAbort?.abort(new Error('SVN 插件已卸载'))
        try { job.stop?.() } catch { /* 卸载继续清理其它任务 */ }
      }
    }
    this.jobs.clear()
  }

  /**
   * 先用只读 version 探测捕获通道，再允许启动会修改工作副本的 update。
   * @author ddj 2026年09月24号
   * @param job 待启动任务
   * @param exe 已配置 SVN CLI
   */
  private async launch(job: UpdateJob, exe: string): Promise<void> {
    const controller = new AbortController()
    job.probeAbort = controller
    const probeDeadline = setTimeout(() => controller.abort(new Error('SVN 输出探测超时（8 秒）')), 8000)
    probeDeadline.unref?.()
    try {
      const service = this.service()
      if (!service) throw new Error('subprocess 服务不可用')
      const modes = this.platform === 'win32' ? ['terminal', 'collect'] : ['collect', 'terminal']
      let mode: string | null = null
      let reason = ''
      for (const candidate of modes) {
        controller.signal.throwIfAborted()
        try { await this.probe(service, exe, job.cwd, candidate, controller.signal); mode = candidate; break }
        catch (error) {
          if (controller.signal.aborted) throw error
          reason = String(error)
        }
      }
      if (job.cancelled) { this.finish(job, null); return }
      if (!mode) throw new Error('SVN 输出通道不可用：' + reason)
      clearTimeout(probeDeadline)
      await this.startUpdate(job, service, mode, exe, controller)
    } catch (error) {
      job.error = String(error)
      this.finish(job, null)
    } finally {
      clearTimeout(probeDeadline)
      job.probeAbort = undefined
    }
  }

  /**
   * 分配实际更新句柄时继续允许取消；未完成的分配不盲目重试更新。
   * @author ddj 2026年09月24号
   * @param job 当前任务
   * @param service DSH 子进程服务
   * @param mode 已探测可用的流式通道
   * @param exe SVN 可执行文件
   * @param controller 启动阶段的取消信号
   */
  private async startUpdate(job: UpdateJob, service: UpdateProcess, mode: string, exe: string, controller: AbortController): Promise<void> {
    const argv = [exe, '--non-interactive', 'update', '--', job.target || '.']
    job.phase = 'running'
    job.stop = () => controller.abort(new Error('更新启动期间被取消'))
    job.deadline = setTimeout(() => {
      job.error = 'SVN 更新超过 60 分钟，已请求停止；工作副本可能已部分更新'
      try { job.stop?.() } catch { /* 退出路径仍会报告错误 */ }
    }, UPDATE_MAX_MS)
    job.deadline.unref?.()
    if (mode === 'terminal' && service.spawnTerminal) {
      const pending = service.spawnTerminal({ ...this.terminalSpec(argv, job.cwd), signal: controller.signal })
      const handle = await this.awaitTerminal(pending, controller.signal)
      job.stop = () => { void handle.terminate().catch((error) => { job.error = String(error) }) }
      if (job.cancelled) job.stop()
      this.watchTerminal(job, handle)
    } else {
      const handle = service.spawn({ ...this.collectSpec(argv, job.cwd), signal: controller.signal })
      job.stop = () => handle.terminate()
      if (job.cancelled) job.stop()
      this.watchCollect(job, handle)
    }
  }

  /**
   * 终端句柄分配与 Abort 之间的微任务间隙也必须回收晚到句柄。
   * @author ddj 2026年09月24号
   * @param pending 分配中的终端
   * @param signal 用户取消或截止信号
   * @returns 可受管的终端句柄
   */
  private async awaitTerminal(pending: Promise<TerminalHandle>, signal: AbortSignal): Promise<TerminalHandle> {
    let handle: TerminalHandle | null = null
    const stop = () => { if (handle) void handle.terminate().catch(() => {}) }
    signal.addEventListener('abort', stop, { once: true })
    try {
      const guarded = pending.then((ready) => {
        handle = ready
        if (signal.aborted) stop()
        return ready
      })
      return await this.waitProbe(guarded, signal, () => {})
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }

  /**
   * 探针/启动 Promise 可由超时和用户取消立即打断，并终止已分配的句柄。
   * @author ddj 2026年09月24号
   * @param pending 待完成操作
   * @param signal 任务取消信号
   * @param stop 停止已经分配的子进程
   * @returns 操作结果
   */
  private waitProbe<T>(pending: Promise<T>, signal: AbortSignal, stop: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let finished = false
      const abort = () => {
        if (finished) return
        finished = true
        try { stop() } catch { /* 使用取消原因报告 */ }
        reject(signal.reason ?? new Error('SVN 探测已取消'))
      }
      if (signal.aborted) { abort(); void pending.catch(() => {}); return }
      signal.addEventListener('abort', abort, { once: true })
      pending.then((value) => {
        signal.removeEventListener('abort', abort)
        if (!finished) { finished = true; resolve(value) }
      }, (error) => {
        signal.removeEventListener('abort', abort)
        if (!finished) { finished = true; reject(error) }
      })
    })
  }

  /**
   * 探针失败只换读法，不会重试一次已启动的实际 update。
   * @author ddj 2026年09月24号
   * @param service DSH 服务
   * @param exe SVN 命令
   * @param cwd 进程目录
   * @param mode 输出通道
   * @param signal 用户取消或探针超时
   */
  private async probe(service: UpdateProcess, exe: string, cwd: string, mode: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const argv = [exe, '--version', '--quiet']
    if (mode === 'terminal') {
      if (!service.spawnTerminal) throw new Error('终端输出通道不可用')
      const pending = service.spawnTerminal({ ...this.terminalSpec(argv, cwd), signal })
      const handle = await this.awaitTerminal(pending, signal)
      let text = ''
      let failure = ''
      const drained = new Promise<void>((resolve) => {
        handle.output.on('data', (chunk) => { text += String(chunk) })
        handle.output.once('end', resolve)
        handle.output.once('error', (error) => { failure = String(error); resolve() })
      })
      const outcome = await this.waitProbe(handle.done, signal, () => { void handle.terminate().catch(() => {}) })
      await this.waitProbe(Promise.race([drained, new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000)
        timer.unref?.()
      })]), signal, () => { void handle.terminate().catch(() => {}) })
      if (outcome.exitCode !== 0 || !text.trim() || failure) throw new Error('终端输出探测失败：' + failure)
      return
    }
    const handle = service.spawn({ ...this.collectSpec(argv, cwd), signal })
    const outcome = await this.waitProbe(handle.done, signal, () => handle.terminate())
    const text = handle.collected?.stdout?.readFrom(0).text ?? ''
    if (outcome.exitCode !== 0 || !text.trim()) throw new Error('收集输出探测失败')
  }

  /**
   * DSH PTY 读取：TextDecoder 保证跨数据块的 UTF-8 字符不被截断。
   * @author ddj 2026年09月24号
   * @param job 活动任务
   * @param handle 终端句柄
   */
  private watchTerminal(job: UpdateJob, handle: TerminalHandle): void {
    const decoder = new TextDecoder()
    let drained = false
    let finishOutput: () => void = () => {}
    const outputDone = new Promise<void>((resolve) => { finishOutput = resolve })
    handle.output.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      this.ingest(job, text)
    })
    handle.output.on('end', () => { drained = true; this.ingest(job, decoder.decode()); finishOutput() })
    handle.output.on('error', (error) => { job.error = '读取输出失败：' + String(error); finishOutput() })
    void handle.done.then(async (outcome) => {
      job.exited = true
      if (!drained) {
        await Promise.race([outputDone, new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 2000)
          timeout.unref?.()
        })])
      }
      this.finish(job, outcome.exitCode)
    }, (error) => { job.exited = true; job.error = String(error); this.finish(job, null) })
  }

  /**
   * 管道收集的读取器独立管理 stdout/stderr 字节偏移；只消费完整行，避免截断中文。
   * @author ddj 2026年09月24号
   * @param job 活动任务
   * @param handle 子进程句柄
   */
  private watchCollect(job: UpdateJob, handle: ManagedHandle): void {
    const offsets = { stdout: 0, stderr: 0 }
    job.timer = setInterval(() => this.readCollect(job, handle, offsets, false), COLLECT_MS)
    job.timer.unref?.()
    void handle.done.then((outcome) => {
      job.exited = true
      if (job.timer) clearInterval(job.timer)
      this.readCollect(job, handle, offsets, true)
      this.finish(job, outcome.exitCode ?? outcome.code ?? null)
    }, (error) => { job.exited = true; job.error = String(error); this.finish(job, null) })
  }

  /**
   * 从两个 bounded collector 取完整行；lossy 时标记不完整且不伪造丢失计数。
   * @author ddj 2026年09月24号
   * @param job 活动任务
   * @param handle 子进程句柄
   * @param offsets 各路已消费字节位置
   * @param final 进程已结束，可以消费末尾无换行内容
   */
  private readCollect(job: UpdateJob, handle: ManagedHandle, offsets: { stdout: number; stderr: number }, final: boolean): void {
    for (const key of ['stdout', 'stderr'] as const) {
      const reader = handle.collected?.[key]
      if (!reader) { job.truncated = true; continue }
      const read = reader.readFrom(offsets[key])
      if (read.lossy) {
        job.truncated = true
        offsets[key] = read.nextOffset
        job.pending = ''
        this.recordLine(job, '输出前段已截断，以下是可恢复的尾部记录', null)
        const firstEnd = read.text.indexOf('\n')
        if (firstEnd >= 0) this.ingest(job, read.text.slice(firstEnd + 1))
        continue
      }
      const last = final ? read.text.length : read.text.lastIndexOf('\n') + 1
      if (!last) continue
      const chunk = read.text.slice(0, last)
      offsets[key] = final ? read.nextOffset : offsets[key] + Buffer.byteLength(chunk, 'utf8')
      this.ingest(job, chunk)
    }
  }

  /**
   * 增量行缓冲：ANSI 和 CR/LF 归一；过长单行主动截断并告警。
   * @author ddj 2026年09月24号
   * @param job 活动任务
   * @param text 新输出
   */
  private ingest(job: UpdateJob, text: string): void {
    if (!text) return
    job.pending += text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    const lines = job.pending.split(/\r\n|\n|\r/)
    job.pending = lines.pop() ?? ''
    for (const line of lines) this.recordLine(job, line, updateLineOf(line))
    if (job.pending.length > LINE_CAP) {
      job.truncated = true
      this.recordLine(job, job.pending.slice(0, LINE_CAP) + '…（单行过长）', null)
      job.pending = ''
    }
  }

  /**
   * 记录有界行与原文；修订号只读 svn 自己的完成/无变化行。
   * @author ddj 2026年09月24号
   * @param job 活动任务
   * @param line 完整输出行
   * @param entry 可识别的逐文件状态
   */
  private recordLine(job: UpdateJob, line: string, entry: ReturnType<typeof updateLineOf>): void {
    const raw = line.trimEnd()
    if (!raw) return
    job.rawTail = (job.rawTail + raw + '\n').slice(-RAW_CAP)
    const rev = /(?:Updated to revision|At revision|已更新到版本|版本)\s*\.?\s*(\d+)/i.exec(raw)
    if (rev) job.revision = Number(rev[1])
    if (entry) job.counts[entry.action] += 1
    const path = entry?.path ?? ''
    const row: SvnUpdateRow = {
      seq: ++job.seq, action: entry?.action ?? null, path,
      relPath: entry ? this.relPathOf(job, path) : null,
      label: entry?.label ?? raw.trim(), raw,
    }
    job.rows.push(row)
    if (job.rows.length > ROW_CAP) { job.rows.splice(0, 1000); job.truncated = true }
  }

  /**
   * 只给工作区内的输出路径开放文件动作（不信任 CLI 文本直接当作目标）。
   * @author ddj 2026年09月24号
   * @param job 活动任务
   * @param path SVN 输出路径
   * @returns 工作区相对路径或 null
   */
  private relPathOf(job: UpdateJob, path: string): string | null {
    const abs = resolve(job.cwd, path)
    const wcRel = relative(job.root, abs)
    const rel = relative(job.cwd, abs)
    if (isAbsolute(wcRel) || wcRel === '..' || wcRel.startsWith('..\\') || wcRel.startsWith('../')) return null
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) return null
    return rel.replace(/\\/g, '/') || null
  }

  /**
   * 保留终态行供用户检查，取消不能误报成功。
   * @author ddj 2026年09月24号
   * @param job 活动任务
   * @param code 真实退出码
   */
  private finish(job: UpdateJob, code: number | null): void {
    if (this.isFinal(job.phase)) return
    if (job.pending.trim()) this.recordLine(job, job.pending, updateLineOf(job.pending))
    job.pending = ''
    if (job.timer) { clearInterval(job.timer); job.timer = undefined }
    if (job.deadline) { clearTimeout(job.deadline); job.deadline = undefined }
    job.endedAt = this.now()
    if (job.cancelled) job.phase = 'cancelled'
    else if (code === 0 && !job.error) job.phase = 'completed'
    else {
      job.phase = 'failed'
      job.error ||= 'SVN 更新失败（退出码 ' + String(code) + '）：' + job.rawTail.slice(-500)
    }
  }

  /**
   * 快照不暴露可变数组；耗时使用现场时钟或终态时间。
   * @author ddj 2026年09月24号
   * @param job 目标任务
   * @returns 纯数据快照
   */
  private stateOf(job: UpdateJob): SvnUpdateState {
    return {
      jobId: job.id, target: job.target, phase: job.phase, counts: { ...job.counts },
      revision: job.revision, elapsedMs: Math.max(0, (job.endedAt ?? this.now()) - job.startedAt),
      error: job.error, rawTail: this.isFinal(job.phase) || job.truncated ? job.rawTail : '',
      truncated: job.truncated, nextSeq: job.seq,
    }
  }

  /**
   * 任务 ID 必须属于调用会话的工作副本根。
   * @author ddj 2026年09月24号
   * @param root 已验证工作副本根
   * @param jobId 客户端任务 id
   * @returns job
   */
  private getJob(root: string, jobId: string): UpdateJob {
    this.prune()
    const job = this.jobs.get(rootKey(root, this.platform))
    if (!job || job.id !== jobId) throw new Error('SVN 更新任务不存在或工作区不匹配')
    return job
  }

  /**
   * 清理过期终态，不丢活动中的更新。
   * @author ddj 2026年09月24号
   */
  private prune(): void {
    for (const [key, job] of this.jobs) {
      if (job.endedAt !== null && this.now() - job.endedAt > RESULT_TTL_MS) this.jobs.delete(key)
    }
  }

  /**
   * 终态判断集中定义，避免取消请求被误视作结束。
   * @author ddj 2026年09月24号
   * @param phase 当前阶段
   * @returns 是否结束
   */
  private isFinal(phase: SvnUpdatePhase): boolean {
    return phase === 'completed' || phase === 'failed' || phase === 'cancelled'
  }

  /**
   * 不启 shell：每个 argv 直接传入，标准输入忽略且提供进程清理预算。
   * @author ddj 2026年09月24号
   * @param argv 可执行文件及参数
   * @param cwd 目标工作目录
   * @returns DSH terminal spec
   */
  private terminalSpec(argv: string[], cwd: string): Record<string, unknown> {
    return { argv, cwd, rows: 30, cols: 180, terminalType: 'xterm-256color', graceMs: 10_000 }
  }

  /**
   * collected reader 大于单次 RPC：后台按 100ms 消费，避免 1MB 尾部静默丢头。
   * @author ddj 2026年09月24号
   * @param argv 可执行文件及参数
   * @param cwd 目标工作目录
   * @returns DSH process spec
   */
  private collectSpec(argv: string[], cwd: string): Record<string, unknown> {
    return {
      argv, cwd, graceMs: 10_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 128 * 1024 } },
    }
  }
}
