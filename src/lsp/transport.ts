/** LSP 双向 stdio 传输；外部进程使用清理后的环境及独立进程组。 */
import { spawn } from 'node:child_process'
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { createFrameParser } from './jsonrpc.js'
import { childEnv } from '../childEnv.js'
import { killTree, stopTree } from '../processTree.js'

const STDERR_CAP = 256 << 10
export interface TransportSpec {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
}
export interface Transport {
  write(chunk: Buffer): boolean
  onMessage: ((message: unknown) => void) | null
  stderr(): string
  onExit: ((code: number | null, signal: string | null) => void) | null
  dispose(): void
  readonly alive: boolean
  readonly pid: number | undefined
}
const running = new Set<ChildProcess>()

/** 当前仍归本模块管理的进程。 */
export function liveChildren(): ReadonlySet<ChildProcess> { return running }

/**
 * 建立传输状态与回收路径；根进程退出也立即回收剩余进程组。
 * @private
 * @author ddj 2026年09月28号
 * @param child 新建子进程
 * @param onMessage 协议消息回调
 * @param logger 诊断回调
 * @returns 传输句柄与错误缓冲写入器
 */
function makeTransport(child: ChildProcessWithoutNullStreams, onMessage: (message: unknown) => void, logger?: (line: string) => void) {
  let alive = true
  let disposed = false
  let stderrBuf = Buffer.alloc(0)
  let finish: (() => void) | undefined
  const transport: Transport = {
    /** @public @author ddj 2026年09月28号 @param chunk 协议帧 @returns 是否可写 */
    write(chunk: Buffer): boolean {
      if (!alive || !child.stdin.writable) return false
      child.stdin.write(chunk)
      return true
    },
    onMessage,
    /** @public @author ddj 2026年09月28号 @returns 有界错误缓冲 */
    stderr(): string { return stderrBuf.toString('utf8') },
    onExit: null,
    /** @public @author ddj 2026年09月28号 @description 停止整个进程树，根退出不取消回收。 */
    dispose(): void {
      if (disposed) return
      disposed = true
      finish = stopTree(child, logger)
    },
    get alive() { return alive },
    get pid() { return child.pid },
  }
  /** @private @author ddj 2026年09月28号 @param code 退出码 @param signal 退出信号 */
  const emitExit = (code: number | null, signal: string | null): void => {
    if (!alive) return
    alive = false
    disposed = true
    if (finish) finish()
    else killTree(child, logger)
    running.delete(child)
    transport.onExit?.(code, signal)
  }
  child.on('error', (error) => { logger?.('spawn error: ' + String(error)); emitExit(null, null) })
  child.on('exit', emitExit)
  child.on('close', emitExit)
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBuf.length < STDERR_CAP) stderrBuf = Buffer.concat([stderrBuf, chunk], Math.min(stderrBuf.length + chunk.length, STDERR_CAP))
    logger?.(chunk.toString('utf8'))
  })
  return transport
}

/**
 * 启动语言服务器并接入协议流，显式 env 在父环境清理后覆盖。
 * @public
 * @author ddj 2026年09月28号
 * @param spec 启动参数，不经 shell
 * @param onMessage stdout 协议消息回调
 * @param logger 诊断日志
 * @returns 传输句柄
 * @throws spawn 的同步参数错误
 */
export function spawnServer(spec: TransportSpec, onMessage: (message: unknown) => void, logger?: (line: string) => void): Transport {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: childEnv(spec.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  running.add(child)
  const transport = makeTransport(child, onMessage, logger)
  const parser = createFrameParser()
  child.stdout.on('data', (chunk: Buffer) => {
    for (const message of parser.push(chunk)) transport.onMessage?.(message)
  })
  // 写入管道在退出竞态中可能异步 EPIPE，必须监听以免宿主未处理异常。
  child.stdin.on('error', (error) => logger?.('stdin error: ' + String(error)))
  return transport
}

/**
 * 回收本模块所有进程树。
 * @public
 * @author ddj 2026年09月28号
 * @param sync 宿主 exit 钩子使用同步 taskkill
 */
export function disposeAllServers(sync = false): void {
  for (const child of running) killTree(child, undefined, sync)
  running.clear()
}

let exitHooked = false
/**
 * 注册宿主退出回收；不夺取宿主原有信号退出语义。
 * @public
 * @author ddj 2026年09月28号
 * @description exit 用同步回收；仅在宿主已有信号监听时追加收尾。
 */
export function hookExitReclaim(): void {
  if (exitHooked) return
  exitHooked = true
  process.on('exit', () => disposeAllServers(true))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    if (process.listenerCount(signal) === 0) continue
    process.on(signal, () => disposeAllServers())
  }
}
