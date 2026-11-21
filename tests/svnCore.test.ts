// @ts-nocheck
/**
 * SVN 执行核心单测（22-agent-tools-and-commit）。
 * 守护：只读门禁对写类子命令生效、位置参数拒 '-' 前缀、超时倍数放大、连接错误分类。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import {
  SvnReadOnlyError,
  classifySvnError,
  createSvnRunner,
  svnCommandIsWrite,
  svnCommandOf,
  svnErrorOf,
  svnGraceOf,
  svnOperandErrorOf,
  svnScaleOf,
} from '../src/svnCore.js'

/** 假 spawn：记录调用参数，返回固定成功输出。 */
function fakeSpawn(record) {
  return (options) => {
    record.push(options)
    return {
      collected: { stdout: { readFrom: () => ({ text: 'ok' }) }, stderr: { readFrom: () => ({ text: '' }) } },
      done: Promise.resolve({ exitCode: 0 }),
    }
  }
}

function runnerWith(settings, record) {
  return createSvnRunner({
    ctx: { get: () => null },
    settings: { svn: () => settings },
    spawn: () => fakeSpawn(record),
  })
}

describe('svnCommandOf / svnCommandIsWrite', () => {
  it('跳过前置选项后取子命令', () => {
    expect(svnCommandOf(['--non-interactive', 'commit', '-m', 'x'])).toBe('commit')
  })
  it('写类子命令覆盖提交/修改/属性/更新', () => {
    for (const verb of ['commit', 'add', 'delete', 'revert', 'update', 'cleanup', 'propset', 'propdel', 'changelist', 'export']) {
      expect(svnCommandIsWrite([verb])).toBe(true)
    }
  })
  it('只读子命令不误判', () => {
    for (const verb of ['status', 'diff', 'log', 'cat', 'info', 'list', 'blame', 'propget', 'proplist']) {
      expect(svnCommandIsWrite([verb])).toBe(false)
    }
  })
})

describe('只读门禁与超时倍数', () => {
  it('只读开启时写命令抛 SvnReadOnlyError，只读命令照常', async () => {
    const record = []
    const runner = runnerWith({ svnPath: 'svn', readOnly: true }, record)
    await expect(runner.run('/w', ['commit', '--', 'a.txt'], 1000)).rejects.toBeInstanceOf(SvnReadOnlyError)
    const outcome = await runner.run('/w', ['status'], 1000)
    expect(outcome.code).toBe(0)
    expect(record).toHaveLength(1)
  })

  it('只读关闭时写命令放行', async () => {
    const record = []
    const runner = runnerWith({ svnPath: 'svn', readOnly: false }, record)
    const outcome = await runner.run('/w', ['commit', '--', 'a.txt'], 1000)
    expect(outcome.code).toBe(0)
    expect(record[0].argv[0]).toBe('svn')
    expect(record[0].argv).toContain('--non-interactive')
  })

  it('超时按设置倍数放大', async () => {
    const record = []
    const runner = runnerWith({ svnPath: 'svn', commandTimeoutScale: 3 }, record)
    await runner.run('/w', ['status'], 1000)
    expect(record[0].graceMs).toBe(3000)
  })

  it('倍数越界夹到 0.2–20，非数值回落 1', () => {
    expect(svnScaleOf(100)).toBe(20)
    expect(svnScaleOf(0.01)).toBe(0.2)
    expect(svnScaleOf('x')).toBe(1)
    expect(svnGraceOf(1000, 2)).toBe(2000)
  })
})

describe('操作数与错误分类', () => {
  it('位置参数拒 - 开头（防 --config-dir 注入）', () => {
    expect(svnOperandErrorOf('--config-dir=/tmp')).toContain('不能以 - 开头')
    expect(svnOperandErrorOf('svn:ignore')).toBeNull()
    expect(svnOperandErrorOf('  ')).toBe('参数不能为空')
  })

  it('连接错误分类给可读文案', () => {
    expect(classifySvnError('svn: E170013: Unable to connect').kind).toBe('offline')
    expect(classifySvnError('svn: E210005: No repository found').kind).toBe('no-repository')
    expect(classifySvnError('svn: E155015: remains in conflict').kind).toBe('conflict')
    expect(classifySvnError('svn: E155007: not a working copy').kind).toBe('not-wc')
    expect(classifySvnError('').kind).toBe('other')
  })

  it('异常归一化保留只读拒绝码', () => {
    const info = svnErrorOf(new SvnReadOnlyError())
    expect(info.code).toBe('SVN_READONLY')
    expect(svnErrorOf(new Error('boom'))).toEqual({ error: 'boom' })
  })
})
