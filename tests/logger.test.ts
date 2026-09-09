/**
 * dsh-vscode-mode — 统一日志模块单测：格式拼接、级别路由、child 作用域、bind 换出口、ctxLogSink 回退。
 * 作者 ddj 2026-09-08
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { consoleSink, createLogger, ctxLogSink, formatLine, LOG_PREFIX } from '../src/shared/logger.js'

type SinkLog = { level: string; line: string }

/** 收集型出口（测试断言用）。 */
function collectingSink(logs: SinkLog[]) {
  return (level: string, line: string): void => {
    logs.push({ level, line })
  }
}

describe('formatLine', () => {
  it('无 scope 输出插件前缀', () => {
    expect(formatLine('', 'hello')).toBe(LOG_PREFIX + ' hello')
  })

  it('有 scope 输出 [前缀:scope] 形式', () => {
    expect(formatLine('debug', 'hello')).toBe(LOG_PREFIX + ':debug hello')
  })

  it('消息非字符串时转字符串', () => {
    expect(formatLine('', 42 as unknown as string)).toBe(LOG_PREFIX + ' 42')
  })
})

describe('createLogger', () => {
  it('四级别路由到出口并带统一前缀', () => {
    const logs: SinkLog[] = []
    const logger = createLogger(collectingSink(logs))
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(logs.map((l) => l.level)).toEqual(['debug', 'info', 'warn', 'error'])
    expect(logs.map((l) => l.line)).toEqual([
      LOG_PREFIX + ' d',
      LOG_PREFIX + ' i',
      LOG_PREFIX + ' w',
      LOG_PREFIX + ' e',
    ])
  })

  it('child 叠加作用域（嵌套派生用点分隔）', () => {
    const logs: SinkLog[] = []
    const logger = createLogger(collectingSink(logs)).child('debug')
    logger.error('text')
    expect(logs[0].line).toBe(LOG_PREFIX + ':debug text')
    const nested = logger.child('deep')
    nested.info('x')
    expect(logs[1].line).toBe(LOG_PREFIX + ':debug.deep x')
  })

  it('bind 换出口对整棵实例树生效（含已派生 child）', () => {
    const first: SinkLog[] = []
    const second: SinkLog[] = []
    const logger = createLogger(collectingSink(first))
    const child = logger.child('debug')
    logger.warn('a')
    logger.bind(collectingSink(second))
    logger.warn('b')
    child.error('c')
    expect(first.map((l) => l.line)).toEqual([LOG_PREFIX + ' a'])
    expect(second.map((l) => l.line)).toEqual([LOG_PREFIX + ' b', LOG_PREFIX + ':debug c'])
  })
})

describe('ctxLogSink', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn()
  })

  it('ctx.logger 方法可用时走 logger', () => {
    const calls: string[] = []
    const sink = ctxLogSink({ logger: { info: (msg: string) => calls.push(msg) } })
    sink('info', LOG_PREFIX + ' hello')
    expect(calls).toEqual([LOG_PREFIX + ' hello'])
  })

  it('缺 logger 或缺方法时回退 console 对应级别', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanup.push(() => spy.mockRestore())
    ctxLogSink({})('warn', LOG_PREFIX + ' fallback')
    expect(spy).toHaveBeenCalledWith(LOG_PREFIX + ' fallback')
    const spyDebug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    cleanup.push(() => spyDebug.mockRestore())
    ctxLogSink({ logger: { info: () => {} } })('debug', LOG_PREFIX + ' lvl')
    expect(spyDebug).toHaveBeenCalledWith(LOG_PREFIX + ' lvl')
  })
})

describe('consoleSink', () => {
  it('按级别映射 console 方法', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const restore = () => spy.mockRestore()
    consoleSink()('error', LOG_PREFIX + ' boom')
    expect(spy).toHaveBeenCalledWith(LOG_PREFIX + ' boom')
    restore()
  })
})
