/** LSP/DAP 共用进程树终止；POSIX 子进程必须 detached 成为独立进程组。 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { childEnv } from './childEnv.js'

type Logger = (line: string) => void

/**
 * 按平台回收进程树；Windows 在父进程仍存活时直接 taskkill /T，避免先杀父丢失后代。
 * @public
 * @author ddj 2026年09月28号
 * @param child 已启动的独立进程组根
 * @param logger 可选错误记录器
 * @param sync 宿主 exit 事件中必须同步完成
 * @param platform 当前系统，测试可注入
 */
export function killTree(child: ChildProcess, logger?: Logger, sync = false, platform = process.platform): void {
  if (!child.pid) return
  try {
    if (platform !== 'win32') {
      process.kill(-child.pid, 'SIGKILL')
      return
    }
    const args = ['/PID', String(child.pid), '/T', '/F']
    const options = { windowsHide: true, stdio: 'ignore' as const, env: childEnv() }
    if (sync) {
      const result = spawnSync('taskkill', args, { ...options, timeout: 5000 })
      if (result.error) logger?.('taskkill error: ' + String(result.error))
      return
    }
    const killer = spawn('taskkill', args, options)
    killer.once('error', (error) => logger?.('taskkill error: ' + String(error)))
    killer.unref()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') logger?.('kill tree error: ' + String(error))
  }
}

/**
 * 停止独立进程树；POSIX 先通知整组，定时升级不依赖根进程 alive 状态。
 * @public
 * @author ddj 2026年09月28号
 * @param child 进程树根
 * @param logger 可选诊断输出
 * @param platform 当前系统，测试可注入
 * @returns 可立即强杀的收尾函数（幂等）
 */
export function stopTree(child: ChildProcess, logger?: Logger, platform = process.platform): () => void {
  let finished = false
  let timer: NodeJS.Timeout | undefined
  /** @private @author ddj 2026年09月28号 @description 强杀树并清理升级定时器。 */
  const finish = (): void => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    killTree(child, logger, false, platform)
  }
  if (platform === 'win32') { finish(); return finish }
  try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch { /* 根可能已经退出，仍保留升级 */ }
  timer = setTimeout(finish, 1500)
  timer.unref()
  return finish
}
