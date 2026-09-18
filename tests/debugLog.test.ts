/**
 * 诊断日志模块单测：文件名白名单、级别标记行格式与回显级别、批量落盘（DSH_HOME 注入临时目录）、
 * 清单/尾部读取/清空（listDebugLogs / readDebugLog / clearDebugLog）。
 * 作者 ddj 2026-09-17
 */
import { mkdtemp, readFile, rm, utimes, writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDebugLog, debugRecord, isDebugLogName, listDebugLogs, readDebugLog } from '../src/debugLog.js'
import { hashOf } from '../src/paths.js'

/** 本用例专用临时目录（每个用例重建，DSH_HOME 指向它）。 */
let home = ''

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-dlog-test-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true }).catch(() => {})
  vi.restoreAllMocks()
})

/** 日志根（与 host pluginLogRoot 同布局：<DSH_HOME>/dsh-vscode-mode/logs）。 */
function logRoot(): string {
  return join(home, 'dsh-vscode-mode', 'logs')
}

describe('isDebugLogName 白名单', () => {
  it('合法 hash 文件名通过', () => {
    expect(isDebugLogName('debug.0123456789abcdef.log')).toBe(true)
  })

  it('路径穿越 / 空值 / 非法形态一律拒绝', () => {
    expect(isDebugLogName('../debug.0123456789abcdef.log')).toBe(false)
    expect(isDebugLogName('debug.0123456789abcdef.log/x')).toBe(false)
    expect(isDebugLogName('debug.ZZZZ.log')).toBe(false)
    expect(isDebugLogName('')).toBe(false)
    expect(isDebugLogName(null)).toBe(false)
    expect(isDebugLogName(undefined)).toBe(false)
  })
})

describe('debugRecord 级别与行格式', () => {
  it('缺省 debug 级别：终端回显走 console.debug，缓冲行带 [debug] 标记', async () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    debugRecord({}, join(home, 'ws-a'), 'hello world')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain('hello world')
    // 攒满缓冲强制落盘（DEBUG_BUF_CAP=32KB），等待串行链完成
    debugRecord({}, join(home, 'ws-a'), 'x'.repeat(40 * 1024))
    const target = join(logRoot(), 'debug.' + hashOf(join(home, 'ws-a')) + '.log')
    const text = await pollFile(target)
    expect(text).toContain('[debug] hello world')
    expect(text).toContain('[debug] ' + 'x'.repeat(10))
  })

  it('显式 warn 级别：终端回显走 console.warn，行带 [warn] 标记', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    debugRecord({}, join(home, 'ws-b'), 'be careful', 'warn')
    expect(spy).toHaveBeenCalledTimes(1)
    debugRecord({}, join(home, 'ws-b'), 'y'.repeat(40 * 1024))
    const target = join(logRoot(), 'debug.' + hashOf(join(home, 'ws-b')) + '.log')
    const text = await pollFile(target)
    expect(text).toContain('[warn] be careful')
  })
})

describe('listDebugLogs / readDebugLog / clearDebugLog', () => {
  it('清单只含合法名且 mtime 新的在前', async () => {
    await mkdir(logRoot(), { recursive: true })
    const old = join(logRoot(), 'debug.0000000000000001.log')
    const neo = join(logRoot(), 'debug.0000000000000002.log')
    await writeFile(old, 'old', 'utf8')
    await writeFile(neo, 'neo', 'utf8')
    await writeFile(join(logRoot(), 'evil.log'), 'x', 'utf8')
    const past = Date.now() - 60_000
    // utimes 参数为 Date（数值按秒解释，毫秒直传在 Windows 上 EINVAL）
    await utimes(old, new Date(past), new Date(past))
    const files = await listDebugLogs(home)
    expect(files.map((f) => f.name)).toEqual(['debug.0000000000000002.log', 'debug.0000000000000001.log'])
  })

  it('尾部读取：超限截头置 truncated，缺文件/非法名返回 null', async () => {
    await mkdir(logRoot(), { recursive: true })
    const name = 'debug.0000000000000003.log'
    await writeFile(join(logRoot(), name), 'a'.repeat(300) + 'tail-marker', 'utf8')
    const read = await readDebugLog(name, 64, home)
    expect(read).not.toBeNull()
    expect(read.truncated).toBe(true)
    expect(read.content.endsWith('tail-marker')).toBe(true)
    expect(read.content.length).toBeLessThanOrEqual(64)
    expect(await readDebugLog('debug.ffffffffffffffff.log', 64, home)).toBeNull()
    expect(await readDebugLog('../escape.log', 64, home)).toBeNull()
  })

  it('清空：合法名截为 0 字节，非法名拒绝', async () => {
    await mkdir(logRoot(), { recursive: true })
    const name = 'debug.0000000000000004.log'
    await writeFile(join(logRoot(), name), 'content', 'utf8')
    expect(await clearDebugLog(name, home)).toBe(true)
    expect((await stat(join(logRoot(), name))).size).toBe(0)
    expect(await clearDebugLog('bad name.log', home)).toBe(false)
  })
})

/** 轮询等文件出现（落盘在异步串行链上；最多 ~2s）。 */
async function pollFile(target: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const text = await readFile(target, 'utf8').catch(() => null)
    if (text !== null) return text
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('debug 日志未落盘：' + target)
}
