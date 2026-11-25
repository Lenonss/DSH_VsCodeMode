/**
 * dsh-vscode-mode host — 慢操作与事件循环阻塞观测。
 * 职责：把「哪一步慢、卡了多久」写进插件日志，供卡顿定位；低于阈值零输出。
 * 说明：宿主是单进程单事件循环，任何同步大活都会把所有 RPC 一起拖住，
 * 所以除了单操作耗时，还要单独盯事件循环的最大延迟，并带上最近一次慢操作归因。
 * @author ddj 2026年11月25号
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { performance } from 'node:perf_hooks'
import { log } from './log.js'

/** 单操作耗时告警阈值（毫秒）。 */
export const SLOW_MS = 300
/** 事件循环单次阻塞告警阈值（毫秒）。 */
export const BLOCKED_MS = 500

/** 最近一次超过阈值的操作，用于阻塞归因。 */
let recent: { name: string; ms: number } | undefined

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 记录一次操作耗时；超过阈值落一条 warn，并记住它供阻塞归因。
 * @param name 操作名（如 `rpc:edrv.review.list`）
 * @param ms 耗时毫秒
 * @param note 附加说明（如条目数）
 * @returns 无
 */
export function noteOperation(name: string, ms: number, note = ''): void {
  if (ms < SLOW_MS) return
  recent = { name, ms }
  log.warn(`[slow] ${name} ${Math.round(ms)}ms${note ? ' ' + note : ''}`)
}

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 开始计时；返回的函数在调用时结算。用闭包而不用 async 包装，避免改动既有返回类型。
 * @param name 操作名
 * @param note 附加说明
 * @returns 结算函数
 */
export function beginOperation(name: string, note = ''): () => void {
  const started = performance.now()
  return () => { noteOperation(name, performance.now() - started, note) }
}

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 启动事件循环看门狗：每个周期检查最大延迟，超过阈值就记一条并带上最近慢操作。
 * @param intervalMs 检查周期（毫秒）
 * @returns 可释放句柄
 */
export function startLoopWatchdog(intervalMs = 5000): { dispose(): void } {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  try { histogram.enable() } catch { /* 观测不可用不影响主流程 */ }
  const timer = setInterval(() => {
    try {
      const worst = histogram.max / 1e6
      histogram.reset()
      if (!Number.isFinite(worst) || worst < BLOCKED_MS) return
      const cause = recent ? `；最近慢操作 ${recent.name} ${Math.round(recent.ms)}ms` : ''
      log.warn(`[slow] 事件循环阻塞 ${Math.round(worst)}ms${cause}`)
    } catch { /* 统计失败不影响业务 */ }
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    dispose(): void {
      clearInterval(timer)
      try { histogram.disable() } catch { /* 已释放 */ }
    },
  }
}
