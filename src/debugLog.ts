/**
 * dsh-vscode-mode host — 诊断文件通道（client 上报 → 缓冲批量落盘）+ 日志文件管理。
 * 通道：edrv.debug RPC → 内存缓冲（满/空闲触发）→ 串行读改写
 *       `~/.dsh/dsh-vscode-mode/logs/debug.<cwdHash>.log`（512KB 上限截断保留尾部）。
 * 设计：console 不一定落盘，文件可靠；写失败静默忽略（调试日志不阻塞业务）。
 * 管理：edrv.dlog.* RPC 用的清单/尾部读取/清空三能力；file 参数一律先过
 *       isDebugLogName 白名单（纯文件名、无路径分隔），杜绝穿越出日志根。
 * 作者 ddj 2026-09-08 / 2026-09-17
 */
import { mkdir, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEBUG_LOG, dshHome, debugLogFile, pluginLogRoot } from './paths.js'
import { log } from './log.js'
import type { LoggerLevel } from './shared/logger.js'
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
/** 诊断回显日志器（终端回显统一带 `[dsh-vscode-mode:debug]` 前缀，级别跟随上报级别）。 */
const debugLog = log.child('debug')

/** 诊断日志文件名白名单（cwd hash 命名；请求回传的 file 参数必须整名匹配，防路径穿越）。 */
const DEBUG_LOG_NAME = /^debug\.[0-9a-f]{16}\.log$/

/**
 * 文件名是否为合法诊断日志名（白名单整名匹配，杜绝路径穿越）。
 * @author ddj 2026年09月17号
 * @param name 请求回传的文件名（可为空）
 * @returns 是否合法
 */
export function isDebugLogName(name: string | null | undefined): name is string {
  return typeof name === 'string' && DEBUG_LOG_NAME.test(name)
}

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
 * 记录一条 client 上报的诊断日志：入队缓冲批量落盘 + 终端回显（级别跟随，缺省 debug）。
 * 落盘行格式 `<iso> [level] text`；级别标记在入队时补齐，flush 侧无感。
 * @author ddj 2026年09月08号 / 2026年09月17号
 * @param _ctx DSH 上下文（入参保留：诊断通道按 cwd 隔离，当前不需要 ctx，未来过滤用）
 * @param cwd 工作区（日志文件按 cwd hash 隔离）
 * @param text 单条日志文本（不含换行）
 * @param level 日志级别（缺省 debug；落盘行与终端回显均带此级别）
 */
export function debugRecord(_ctx: Ctx, cwd: string, text: string, level: LoggerLevel = 'debug'): void {
  const tagged = '[' + level + '] ' + text
  const st = debugBuffers.get(cwd) ?? { lines: [], len: 0, timer: null }
  st.lines.push(tagged)
  st.len += tagged.length
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
  debugLog[level](text)
}

/**
 * 清单：日志根下全部诊断日志文件（名字/字节/mtime；非法名跳过），mtime 新的在前。
 * @author ddj 2026年09月17号
 * @param home DSH home（测试可注入；缺省按环境解析）
 * @returns 清单项数组
 */
export async function listDebugLogs(home = dshHome()): Promise<{ name: string; bytes: number; mtimeMs: number }[]> {
  const names = await readdir(pluginLogRoot(home)).catch(() => [] as string[])
  const items: { name: string; bytes: number; mtimeMs: number }[] = []
  for (const name of names) {
    if (!isDebugLogName(name)) continue
    const info = await stat(join(pluginLogRoot(home), name)).catch(() => null)
    if (!info?.isFile()) continue
    items.push({ name, bytes: info.size, mtimeMs: info.mtimeMs })
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return items
}

/**
 * 尾部读取一份诊断日志：保留文件尾 maxBytes 字节（缺省 256KB），truncated 标记截头。
 * 单文件本体受 DEBUG_LOG_CAP=512KB 约束，整读为字符串的成本可接受。
 * @author ddj 2026年09月17号
 * @param name 日志文件名（isDebugLogName 白名单校验，非法直接 null）
 * @param maxBytes 尾部保留字节数（缺省 256KB）
 * @param home DSH home（测试可注入）
 * @returns 读取结果；文件不存在或名字非法返回 null
 */
export async function readDebugLog(name: string | null | undefined, maxBytes = 256 * 1024, home = dshHome()): Promise<{ name: string; path: string; content: string; size: number; truncated: boolean } | null> {
  if (!isDebugLogName(name)) return null
  const target = join(pluginLogRoot(home), name)
  const info = await stat(target).catch(() => null)
  if (!info?.isFile()) return null
  const text = await readFile(target, 'utf8').catch(() => null)
  if (text === null) return null
  const cut = Math.max(0, text.length - maxBytes)
  return { name, path: target, content: cut > 0 ? text.slice(cut) : text, size: info.size, truncated: cut > 0 }
}

/**
 * 清空一份诊断日志（truncate 到 0，保留文件本身）。
 * @author ddj 2026年09月17号
 * @param name 日志文件名（isDebugLogName 白名单校验）
 * @param home DSH home（测试可注入）
 * @returns 是否清空成功（文件不存在视为未成功，文案由调用方给）
 */
export async function clearDebugLog(name: string | null | undefined, home = dshHome()): Promise<boolean> {
  if (!isDebugLogName(name)) return false
  return await truncate(join(pluginLogRoot(home), name)).then(() => true).catch(() => false)
}
