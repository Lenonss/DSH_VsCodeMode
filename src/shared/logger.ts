/**
 * dsh-vscode-mode — 统一日志核心（双面共享，平台中立）。
 * 输出规范：
 * - 格式：`[dsh-vscode-mode][:scope] 消息`；前缀只在模块内部拼接，业务代码禁止手写前缀
 * - 级别语义：debug=诊断明细 / info=装配与路由里程碑 / warn=降级与兼容回退 / error=失败
 * - 出口：host 面经 bindHostLog(ctx) 绑定 ctx.logger（缺失回退 console）；client 面固定 console
 * - 诊断文件通道（edrv.debug → ~/.dsh/dsh-vscode-mode/logs/）见 debugLog.ts，与本模块前缀共用
 * 新增日志一律 `import { log } from '../log.js'`（client 为 './log.js'）后调 log.debug/info/warn/error；
 * 子域日志用 log.child('scope')，禁止另起 console。
 * 作者 ddj 2026-09-08
 */

/** 插件统一日志前缀（与包安装名一致）。 */
export const LOG_PREFIX = '[dsh-vscode-mode]'

/** 日志级别（与 console 方法名对齐）。 */
export type LoggerLevel = 'debug' | 'info' | 'warn' | 'error'

/** 日志出口：接收拼好前缀的整行（host 面接 ctx.logger，client 面接 console）。 */
export type LoggerSink = (level: LoggerLevel, line: string) => void

/** 默认级别到 console 方法名的映射。 */
const CONSOLE_METHODS: Record<LoggerLevel, string> = { debug: 'debug', info: 'info', warn: 'warn', error: 'error' }

/**
 * 默认出口：console（级别直映方法；方法缺失时静默丢弃，不抛错）。
 * @author ddj 2026年09月08号
 * @returns console 出口
 */
export function consoleSink(): LoggerSink {
  return (level, line) => {
    const emit = (console as unknown as Record<string, unknown>)[CONSOLE_METHODS[level]]
    if (typeof emit === 'function') (emit as (message: string) => void).call(console, line)
  }
}

/**
 * DSH host 出口工厂：转接 ctx.logger（方法级可选调用，缺服务/缺方法回退 console）。
 * @author ddj 2026年09月08号
 * @param ctx DSH host 上下文
 * @returns 日志出口
 */
export function ctxLogSink(ctx: unknown): LoggerSink {
  const base = consoleSink()
  return (level, line) => {
    const logger = (ctx as { logger?: Record<string, unknown> } | null | undefined)?.logger
    const emit = logger?.[level]
    if (typeof emit === 'function') (emit as (message: string) => void).call(logger, line)
    else base(level, line)
  }
}

/**
 * 拼一行日志：`[dsh-vscode-mode][:scope] 消息`（scope 为空省略冒号段）。
 * @author ddj 2026年09月08号
 * @param scope 子域（可空）
 * @param message 消息文本
 * @returns 整行文本
 */
export function formatLine(scope: string, message: string): string {
  const text = String(message)
  return scope ? LOG_PREFIX + ':' + scope + ' ' + text : LOG_PREFIX + ' ' + text
}

/** 日志器实例（四级别统一入口 + 换出口/派生子域）。 */
export interface PluginLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  /** 更换出口（同一实例树共享，host 装配期绑定 ctx.logger 用；client 单例不调用）。 */
  bind(sink: LoggerSink): void
  /** 派生带子域前缀的新实例（共享出口，如 log.child('debug') → `[dsh-vscode-mode:debug]`）。 */
  child(scope: string): PluginLogger
}

/** 实例树共享的出口状态（bind 换出口对整棵树生效）。 */
interface SinkState {
  sink: LoggerSink
}

/**
 * 日志器工厂（内部）：emit 时读共享出口状态，保证父 bind 后子实例跟随。
 * @author ddj 2026年09月08号
 * @param state 共享出口状态
 * @param scope 子域文本（可空）
 * @returns 日志器
 */
function makeLogger(state: SinkState, scope: string): PluginLogger {
  const emit = (level: LoggerLevel, message: string): void => state.sink(level, formatLine(scope, message))
  return {
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
    bind(next: LoggerSink): void {
      state.sink = next
    },
    child(next: string): PluginLogger {
      return makeLogger(state, scope ? scope + '.' + next : next)
    },
  }
}

/**
 * 创建插件日志器（默认 console 出口；host 面单例由 bindHostLog 换到 ctx.logger）。
 * @author ddj 2026年09月08号
 * @param sink 初始出口（缺省 console）
 * @param scope 初始子域（业务方一般经 child 派生，不直接传）
 * @returns 日志器
 */
export function createLogger(sink: LoggerSink = consoleSink(), scope = ''): PluginLogger {
  return makeLogger({ sink }, scope)
}
