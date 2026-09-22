/** DAP 会话语义集成测试：迷你假适配器（node 子进程）验证握手收尾/真实回执/线程/语言过滤。作者 ddj 2026年09月21号 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DapSession, type DapSessionDeps } from '../src/dap/manager.js'
import type { DapAdapterSpec } from '../src/dap/provider.js'
import type { DapDebugConfig } from '../src/shared/dap.js'

/** 本轮创建的临时目录与会话（afterEach 统一回收，防子进程泄漏拖住 vitest）。 */
const dirs: string[] = []
const sessions: DapSession[] = []

afterEach(() => {
  while (sessions.length) sessions.pop()!.dispose()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** 轮询等待条件成立（默认 5s 超时）。 */
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitFor 超时')
}

/**
 * 迷你假适配器（讲 DAP over stdio）：
 * initialize 声明 supportsConfigurationDoneRequest → initialized；
 * configurationDone 后回执 CONFIG_DONE 输出并发出 stopped(threadId=42)；
 * setBreakpoints 回执挪行 +1；stackTrace 回显 threadId 并返回原生 frame id=7。
 */
function writeFakeAdapter(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dap-fake-'))
  dirs.push(dir)
  const file = join(dir, 'fake-adapter.cjs')
  writeFileSync(file, `
let buf = ''
let seq = 1
const send = (msg) => {
  const body = JSON.stringify(msg)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
const handle = (msg) => {
  if (msg.type !== 'request') return
  if (msg.command === 'initialize') {
    send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: 'initialize', body: { supportsConfigurationDoneRequest: true } })
    send({ seq: seq++, type: 'event', event: 'initialized' })
    return
  }
  if (msg.command === 'configurationDone') {
    send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: msg.command })
    send({ seq: seq++, type: 'event', event: 'output', body: { output: 'CONFIG_DONE\\n' } })
    setTimeout(() => send({ seq: seq++, type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 42 } }), 30)
    return
  }
  if (msg.command === 'setBreakpoints') {
    const bps = (msg.arguments.breakpoints || []).map((b) => ({ verified: true, line: b.line + 1 }))
    send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: msg.command, body: { breakpoints: bps } })
    return
  }
  if (msg.command === 'stackTrace') {
    send({ seq: seq++, type: 'event', event: 'output', body: { output: 'STACK_THREAD=' + msg.arguments.threadId + '\\n' } })
    send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: msg.command, body: { stackFrames: [{ id: 7, name: 'main', line: 3, source: { name: 'a.cs', path: 'C:/x/a.cs' } }] } })
    return
  }
  send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: msg.command })
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const m = /Content-Length: (\\d+)\\r\\n\\r\\n/.exec(buf)
    if (!m) break
    const start = m[0].length
    if (buf.length < start + Number(m[1])) break
    handle(JSON.parse(buf.slice(start, start + Number(m[1]))))
    buf = buf.slice(start + Number(m[1]))
  }
})
`)
  return file
}

/**
 * 迷你假 emmylua 适配器：attach 请求参数原样回显（ATTACH_ARGS=<json>），
 * 用于锁定 manager.requestArgs 的 emmylua 缺省注入（extensionPath/pid/sourcePaths）。
 */
function writeEchoAdapter(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dap-echo-'))
  dirs.push(dir)
  const file = join(dir, 'echo-adapter.cjs')
  writeFileSync(file, `
let buf = ''
let seq = 1
const send = (msg) => {
  const body = JSON.stringify(msg)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
const handle = (msg) => {
  if (msg.type !== 'request') return
  if (msg.command === 'initialize') {
    send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: 'initialize', body: {} })
    return
  }
  if (msg.command === 'attach') {
    send({ seq: seq++, type: 'event', event: 'output', body: { output: 'ATTACH_ARGS=' + JSON.stringify(msg.arguments) + '\\n' } })
    send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: 'attach' })
    send({ seq: seq++, type: 'event', event: 'initialized' })
    return
  }
  send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: msg.command })
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const m = /Content-Length: (\\d+)\\r\\n\\r\\n/.exec(buf)
    if (!m) break
    const start = m[0].length
    if (buf.length < start + Number(m[1])) break
    handle(JSON.parse(buf.slice(start, start + Number(m[1]))))
    buf = buf.slice(start + Number(m[1]))
  }
})
`)
  return file
}

/**
 * 写一个「attach 成功后立即空 terminated、不发 initialized」的假适配器。
 * 复现 DotRush unity 连接被拒的时序（attach 响应 success → 连目标失败 → 空 terminated），
 * 用于锁定初始化前终止的控制台提示。
 * @author ddj 2026年09月22号
 * @returns 适配器脚本路径
 */
function writeEarlyTermAdapter(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dap-eterm-'))
  dirs.push(dir)
  const file = join(dir, 'early-term-adapter.cjs')
  writeFileSync(file, `
let buf = ''
let seq = 1
const send = (msg) => {
  const body = JSON.stringify(msg)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
const handle = (msg) => {
  if (msg.type !== 'request') return
  if (msg.command === 'initialize') {
    send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: 'initialize', body: {} })
    return
  }
  if (msg.command === 'attach' || msg.command === 'launch') {
    send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: msg.command, body: {} })
    setTimeout(() => send({ seq: seq++, type: 'event', event: 'terminated', body: {} }), 30)
    return
  }
  send({ seq: seq++, type: 'response', request_seq: msg.seq, success: true, command: msg.command })
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const m = /Content-Length: (\\d+)\\r\\n\\r\\n/.exec(buf)
    if (!m) break
    const start = m[0].length
    if (buf.length < start + Number(m[1])) break
    handle(JSON.parse(buf.slice(start, start + Number(m[1]))))
    buf = buf.slice(start + Number(m[1]))
  }
})
`)
  return file
}

/** 起一个指向假适配器的会话（通用扩展形态，exts=[.cs]）。 */
function startFakeSession(adapterJs: string): DapSession {
  const deps: DapSessionDeps = { findFiles: async () => [] }
  const session = new DapSession(deps)
  sessions.push(session)
  const spec: DapAdapterSpec = { type: 'fake', command: process.execPath, args: [adapterJs], extensionPath: '', extensionId: 'x.mock', exts: ['.cs'], detail: '' }
  const config: DapDebugConfig = { name: 'fake', type: 'fake', request: 'launch' }
  session.start(spec, config, 'C:/ws')
  return session
}

/**
 * 写一个「启动即报错退出」的假适配器：stderr 打印致命原因后立即退出。
 * 用于锁定 fail 消息附带 stderr 根因（回归：缺 .NET 运行时只显示裸 exit code 无法排查）。
 * @author ddj 2026年09月22号
 * @returns 适配器脚本路径
 */
function writeCrashAdapter(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dap-crash-'))
  dirs.push(dir)
  const file = join(dir, 'crash-adapter.cjs')
  writeFileSync(file, `
process.stderr.write('FATAL: You must install or update .NET to run this application\\n')
process.exit(7)
`)
  return file
}

describe('DapSession emmylua 参数注入（回归：attach 必带 extensionPath）', () => {
  it('attach 参数注入 extensionPath/pid/sourcePaths（缺注入适配器拼 undefined 路径即崩）', async () => {
    const deps: DapSessionDeps = { findFiles: async () => [] }
    const session = new DapSession(deps)
    sessions.push(session)
    const spec: DapAdapterSpec = { type: 'emmylua_attach', command: process.execPath, args: [writeEchoAdapter()], extensionPath: '/fake/ext/root', extensionId: 'tangzx.emmylua', exts: ['.lua'], detail: '' }
    const config: DapDebugConfig = { name: '通过进程ID附加', type: 'emmylua_attach', request: 'attach' }
    session.start(spec, config, 'C:/ws', 1234)
    await waitFor(() => session.poll(0).events.some((e) => e.text?.startsWith('ATTACH_ARGS=')))
    const line = session.poll(0).events.find((e) => e.text?.startsWith('ATTACH_ARGS='))!.text!
    const args = JSON.parse(line.slice('ATTACH_ARGS='.length)) as Record<string, unknown>
    expect(args.extensionPath).toBe('/fake/ext/root')
    expect(args.pid).toBe(1234)
    expect(args.sourcePaths).toEqual(['C:/ws'])
    expect(session.stateOf().phase).toBe('running')
  }, 15000)
})

describe('DapSession 通用适配器语义（假适配器集成）', () => {
  it('握手收尾 configurationDone + 真实断点回执（挪行）+ stopped threadId + 原生 frame id + 语言过滤', async () => {
    const session = startFakeSession(writeFakeAdapter())
    await waitFor(() => session.stateOf().phase === 'running')

    // 真实回执：适配器把断点挪到 +1 行（旧实现恒 verified:true 且不挪行）
    const acks = await session.setBreakpoints('C:/ws/a.cs', [{ path: 'a.cs', line: 10 }])
    expect(acks).toEqual([{ line: 11, verified: true }])

    await waitFor(() => session.stateOf().phase === 'paused')
    const frames = await session.stackTrace()
    expect(frames).toHaveLength(1)
    expect(frames[0]!.id).toBe(7)

    const events = session.poll(0).events
    expect(events.some((e) => e.text?.includes('CONFIG_DONE'))).toBe(true)
    expect(events.some((e) => e.text?.includes('STACK_THREAD=42'))).toBe(true)

    // 语言过滤：.lua 断点不入 .cs 适配器 → verified=false + 原因，且不污染断点表
    const rejected = await session.setBreakpoints('C:/ws/b.lua', [{ path: 'b.lua', line: 5 }])
    expect(rejected).toEqual([{ line: 5, verified: false, message: '当前调试器不处理该文件类型' }])
  }, 15000)
})

describe('DapSession 退出根因透传（回归：stderr 只进 log.debug 控制台不可见）', () => {
  it('适配器带 stderr 退出 → 调试控制台事件含 exit code 与 stderr 摘要', async () => {
    const session = startFakeSession(writeCrashAdapter())
    await waitFor(() => session.poll(0).events.some((e) => e.kind === 'output' && (e.text ?? '').includes('适配器退出')))
    const line = session.poll(0).events.find((e) => e.kind === 'output' && (e.text ?? '').includes('适配器退出'))!.text!
    expect(line).toContain('code=7')
    expect(line).toContain('You must install or update .NET')
    expect(session.stateOf().phase).toBe('terminated')
  }, 15000)
})

/**
 * 起一个指向 attach 回显适配器的通用（非 emmylua）会话，回读 attach 请求参数。
 * @author ddj 2026年09月22号
 * @param config 调试配置（type/raw 由用例给定）
 * @param pid 选中的附加目标 pid（模拟进程选择器结果）
 * @returns 回显出的 attach 参数 JSON
 */
async function echoAttachArgs(config: DapDebugConfig, pid?: number): Promise<Record<string, unknown>> {
  const deps: DapSessionDeps = { findFiles: async () => [] }
  const session = new DapSession(deps)
  sessions.push(session)
  const spec: DapAdapterSpec = { type: config.type, command: process.execPath, args: [writeEchoAdapter()], extensionPath: '', extensionId: 'x.mock', exts: ['.cs'], detail: '' }
  session.start(spec, config, 'C:/ws', pid)
  await waitFor(() => session.poll(0).events.some((e) => e.text?.startsWith('ATTACH_ARGS=')))
  const line = session.poll(0).events.find((e) => e.text?.startsWith('ATTACH_ARGS='))!.text!
  return JSON.parse(line.slice('ATTACH_ARGS='.length)) as Record<string, unknown>
}

describe('DapSession cwd 注入与 unity processId 豁免（回归：EditorInstance.json 定位失败 / processId 被当端口）', () => {
  it('unity attach：注入 cwd=工作区根、豁免 processId（否则被当端口覆盖连错端口）', async () => {
    const args = await echoAttachArgs({ name: 'Unity Debugger', type: 'unity', request: 'attach' }, 2272)
    expect(args.cwd).toBe('C:/ws')
    expect(args.processId).toBeUndefined()
  }, 15000)

  it('unity attach：launch.json 显式 cwd 优先于工作区根注入', async () => {
    const config: DapDebugConfig = { name: 'Unity Debugger', type: 'unity', request: 'attach', raw: { cwd: 'D:/Work/UnityProj' } }
    const args = await echoAttachArgs(config)
    expect(args.cwd).toBe('D:/Work/UnityProj')
  }, 15000)

  it('通用 attach（非 unity）：仍注入选中 pid 为 processId + cwd 兜底', async () => {
    const args = await echoAttachArgs({ name: 'net', type: 'coreclr', request: 'attach' }, 4321)
    expect(args.processId).toBe(4321)
    expect(args.cwd).toBe('C:/ws')
  }, 15000)
})

describe('DapSession 初始化前终止提示（回归：空 terminated 控制台无声「已结束」）', () => {
  it('attach 成功但未收到 initialized 即 terminated → 控制台输出失败阶段与日志指引', async () => {
    const session = startFakeSession(writeEarlyTermAdapter())
    await waitFor(() => session.poll(0).events.some((e) => e.kind === 'terminated'))
    const events = session.poll(0).events
    const hint = events.find((e) => e.kind === 'output' && (e.text ?? '').includes('初始化完成前终止'))
    expect(hint).toBeTruthy()
    expect(hint!.text).toContain('attach/连接目标失败')
    expect(session.stateOf().phase).toBe('terminated')
  }, 15000)
})
