/** 待审采集作用域、异步收尾与故障隔离。 @author ddj 2026年11月04号 */
import { describe, expect, it, vi } from 'vitest'
import { installPending, readText } from '../src/pending/capture.js'

/**
 * @private
 * @author ddj 2026年11月04号
 * @description 构造当前目录投影与可控文件提供方，不依赖宿主路径语法。
 * @returns 采集上下文、内容及调用入口
 */
function harness() {
  let cwd = '/current'
  let handler: any
  const files = new Map([['/current/a.ts', 'A'], ['/other/a.ts', 'OTHER']])
  const fs = {
    resolve: vi.fn(async (path: string, opts: { cwd: string }) => opts.cwd + '/' + path),
    processPath: (target: string) => target,
    readBytes: async (target: string) => Buffer.from(await fs.readText(target), 'utf8'),
    readText: vi.fn(async (target: string) => {
      if (!files.has(target)) throw Object.assign(new Error('missing'), { code: 'FS_NOT_FOUND' })
      return files.get(target)!
    }),
  }
  const ctx: any = {
    get: (name: string) => name === 'fs' ? fs : name === 'workingDirectory' ? { get: () => cwd } : undefined,
    on: (event: string, listener: any) => { if (event === 'tools/execute') handler = listener },
  }
  const sink = vi.fn()
  const capture = installPending(ctx, sink)
  const exec = { name: 'write', arguments: { path: 'a.ts' }, agent: { session: { id: 's1', header: { cwd: '/initial' } } } }
  return { fs, files, sink, capture, cd: (path: string) => { cwd = path }, run: (next: () => Promise<unknown>) => handler(exec, next) }
}

describe('待审采集', () => {
  it('按当前投影分桶，工具中 cd 后仍读取写前冻结目标', async () => {
    const fixture = harness()
    const result = await fixture.run(async () => {
      fixture.files.set('/current/a.ts', 'B')
      fixture.cd('/other')
      return 'original-result'
    })
    expect(result).toBe('original-result')
    expect(fixture.fs.resolve).toHaveBeenCalledTimes(1)
    expect(fixture.sink).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/current', identity: '/current/a.ts', before: 'A', after: 'B' }))
  })

  it('dispose 发生于写后读取中时不再落库', async () => {
    const fixture = harness()
    fixture.fs.readText.mockImplementationOnce(async () => 'A').mockImplementationOnce(async () => {
      fixture.capture.dispose()
      return 'B'
    })
    expect(await fixture.run(async () => 17)).toBe(17)
    expect(fixture.sink).not.toHaveBeenCalled()
  })

  it('写后读取异常不吞原始工具错误', async () => {
    const fixture = harness()
    fixture.fs.readText.mockImplementationOnce(async () => 'A').mockRejectedValueOnce(new Error('read failed'))
    const failure = new Error('tool failed')
    await expect(fixture.run(async () => { throw failure })).rejects.toBe(failure)
    expect(fixture.sink).not.toHaveBeenCalled()
  })

  it('同目标在读回结束前保持 busy，嵌套采集不读取第二份预像', async () => {
    const fixture = harness()
    fixture.fs.readText.mockImplementationOnce(async () => 'A').mockImplementationOnce(async () => {
      await fixture.run(async () => 'nested')
      return 'B'
    })
    await fixture.run(async () => 'outer')
    expect(fixture.fs.readText).toHaveBeenCalledTimes(2)
    expect(fixture.sink).toHaveBeenCalledTimes(1)
  })

  it('预像不可读时跳过采集但仍执行工具；过大不冒充缺失', async () => {
    const fixture = harness()
    const failure = Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' })
    fixture.fs.readText.mockRejectedValue(failure)
    await expect(readText(fixture.fs, '/current/a.ts')).rejects.toBe(failure)
    expect(await fixture.run(async () => 'executed')).toBe('executed')
    expect(fixture.sink).not.toHaveBeenCalled()
  })
})
