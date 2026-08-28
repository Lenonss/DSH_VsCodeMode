/**
 * dsh-vscode-mode host — LSP 语言服务器进程传输层。
 * 基于 node:child_process.spawn（stdio pipe 双向流）。刻意不用 DSH ctx.subprocess
 * 抽象：LSP 需要持续写 stdin + 流式读 stdout，而该抽象 stdin 不可写、输出为一次性收集。
 * 作者 ddj 2026-08-27
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createFrameParser } from './jsonrpc.js'

const STDERR_CAP = 256 << 10

export interface TransportSpec {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface Transport {
  /** 写一行帧到 stdin（自动加换行）。 */
  write(chunk: Buffer): boolean
  /** 推送 stdout 解析出的原始消息（内部由帧解析器调用）。 */
  onMessage: ((message: unknown) => void) | null
  /** stderr 收集缓冲（有界，供诊断）。 */
  stderr(): string
  /** 进程退出/崩溃回调（code/signal）。 */
  onExit: ((code: number | null, signal: string | null) => void) | null
  /** 优雅关闭后强杀（Windows 下连带进程树）。 */
  dispose(): void
  /** 是否仍存活。 */
  readonly alive: boolean
  readonly pid: number | undefined
}

const running = new Set<ChildProcess>()

/** 当前仍在运行的 LSP 子进程（供 disposeAll / 诊断）。 */
export function liveChildren(): ReadonlySet<ChildProcess> {
  return running
}

/**
 * 启动语言服务器进程。
 * @author ddj 2026年08月27号
 * @param spec 启动参数（argv 数组，不经 shell，Windows 引号安全）
 * @param onMessage stdout 消息回调
 * @param logger 诊断日志（可选）
 * @returns 传输句柄
 */
export function spawnServer(spec: TransportSpec, onMessage: (message: unknown) => void, logger?: (line: string) => void): Transport {
  const { argv, cwd, env } = spec
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  running.add(child)
  let stderrBuf = Buffer.alloc(0)
  let alive = true
  const parser = createFrameParser()

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBuf.length < STDERR_CAP) {
      stderrBuf = Buffer.concat([stderrBuf, chunk], Math.min(stderrBuf.length + chunk.length, STDERR_CAP))
    }
    logger?.(chunk.toString('utf8'))
  })

  let exited = false
  const emitExit = (code: number | null, signal: string | null): void => {
    if (exited) return
    exited = true
    alive = false
    running.delete(child)
    transport.onExit?.(code, signal)
  }
  child.on('error', (error) => {
    logger?.('spawn error: ' + String(error))
    emitExit(null, null)
  })
  child.on('exit', (code, signal) => emitExit(code, signal))
  child.on('close', (code, signal) => emitExit(code, signal))

  const transport: Transport = {
    write(chunk: Buffer): boolean {
      if (!alive || !child.stdin.writable) return false
      child.stdin.write(chunk)
      return true
    },
    onMessage,
    stderr(): string {
      return stderrBuf.toString('utf8')
    },
    onExit: null,
    dispose(): void {
      if (!alive) return
      // 先 SIGTERM 让服务器有机会清理，1.5s 后强杀进程树
      child.kill()
      const timer = setTimeout(() => {
        if (!alive) return
        alive = false
        running.delete(child)
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          } else {
            child.kill('SIGKILL')
          }
        } catch (error) {
          logger?.('force kill error: ' + String(error))
        }
      }, 1500)
      timer.unref?.()
    },
    get alive() {
      return alive
    },
    get pid() {
      return child.pid
    },
  }
  // stdout 帧解析 → onMessage（LSP 响应/通知；onMessage 由 client 接管后动态生效）
  child.stdout.on('data', (chunk: Buffer) => {
    for (const message of parser.push(chunk)) transport.onMessage?.(message)
  })
  return transport
}

/** 强杀全部运行中的 LSP 子进程（插件卸载/退出用）。 */
export function disposeAllServers(): void {
  for (const child of running) {
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    } catch (error) {
      /* 忽略单个清理失败 */
    }
  }
  running.clear()
}
