/**
 * dsh-vscode-mode host — 诊断文件通道（client 上报 → 缓冲批量落盘）。
 * 通道：edrv.debug RPC → 内存缓冲（满/空闲触发）→ 串行读改写
 *       `~/.dsh/dsh-vscode-mode/logs/debug.<cwdHash>.log`（512KB 上限截断保留尾部）。
 * 设计：console 不一定落盘，文件可靠；写失败静默忽略（调试日志不阻塞业务）。
 * 迁移自 src/rpc.ts（enqueueDebug/flushDebug），逻辑一字不改，仅终端回显改走统一日志器。
 * 作者 ddj 2026-09-08
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEBUG_LOG, debugLogFile, pluginLogRoot } from './paths.js'
import { log } from './log.js'
import type { Ctx } from './store.js'

/** cwd → 内存缓冲：行数组 + 累计字节数 + 待触发 flush 定时器（攒批落盘，避免每条日志全文件读改写）。 */
const debugBuffers = new Map<string, { lines: string[]; len: number; timer: ReturnType<typeof setTimeout> | null }>()
/** cwd → Promise 链：串行化 debug 日志落盘（fs read+write 非原子，避免并发丢行）。 */
const debugWriteQueues = new Map<string, Promise<void>>()
/** debug 日志单文件上限：超限截断保留尾部，防文件无限增长拖慢每次追加。 */
const DEBUG_LOG_CAP = 512 * 1024
/** debug 日志批量缓冲上限：攒满即落盘（一次读改写），上限内不逐条写文件。 */
const DEBUG_BUF_CAP = 32 * 1024
/** debug 日志空闲 flush 延迟：缓冲未满时，静默一段时间后落盘一次。 */
const DEBUG_FLUSH_IDLE_MS = 1000
/** cwd → 已清理旧工作区 debug 日志标记（一次性）。 */
const debugLegacyCleaned = new Set<string>()
/** 诊断回显日志器（终端回显统一带 `[dsh-vscode-mode:debug]` 前缀）。 */
const debugLog = log.child('debug')

/**
 * 批量落盘一条 debug 日志缓冲：读旧文件 → 追加 → 超上限截断保留尾部 → 一次写回。
 * 串行链保证同一 cwd 的读改写不交错丢行；写失败静默忽略（调试日志不阻塞业务）。
 * @author ddj 2026年09月08号
 * @param cwd 工作区（日志落 ~/.dsh/dsh-vscode-mode/logs/debug.<cwdHash>.log）
 * @param batch 本批日志行
 */
function flushDebug(cwd: string, batch: string[]): Promise<void> {
  const prev = debugWriteQueues.get(cwd) ?? Promise.resolve()
  const task = prev.then(async () => {
    try {
      await mkdir(pluginLogRoot(), { recursive: true })
      const target = debugLogFile(cwd)
      const old = await readFile(target, 'utf8').catch(() => '')
      const appended = old + batch.map((l) => new Date().toISOString() + ' ' + l + '\n').join('')
      const next = appended.length > DEBUG_LOG_CAP ? appended.slice(-Math.floor(DEBUG_LOG_CAP / 2)) : appended
      await writeFile(target, next, 'utf8')
      // 迁移后一次性清理旧工作区 debug 日志（best-effort）
      if (!debugLegacyCleaned.has(cwd)) {
        debugLegacyCleaned.add(cwd)
        await rm(join(cwd, DEBUG_LOG), { force: true }).catch(() => {})
      }
    } catch (e) { /* 写日志失败忽略 */ }
  })
  debugWriteQueues.set(cwd, task)
  return task
}

/**
 * 记录一条 client 上报的诊断日志：入队缓冲批量落盘 + 终端回显（`[dsh-vscode-mode:debug]` 前缀）。
 * @author ddj 2026年09月08号
 * @param _ctx DSH 上下文（入参保留：诊断通道按 cwd 隔离，当前不需要 ctx，未来过滤用）
 * @param cwd 工作区（日志文件按 cwd hash 隔离）
 * @param text 单条日志文本（不含换行）
 */
export function debugRecord(_ctx: Ctx, cwd: string, text: string): void {
  const st = debugBuffers.get(cwd) ?? { lines: [], len: 0, timer: null }
  st.lines.push(text)
  st.len += text.length
  const flush = () => {
    st.timer = null
    const batch = st.lines
    st.lines = []
    st.len = 0
    void flushDebug(cwd, batch)
  }
  if (st.len >= DEBUG_BUF_CAP) {
    if (st.timer) clearTimeout(st.timer)
    flush()
  } else if (!st.timer) {
    st.timer = setTimeout(flush, DEBUG_FLUSH_IDLE_MS)
  }
  debugBuffers.set(cwd, st)
  debugLog.error(text)
}
