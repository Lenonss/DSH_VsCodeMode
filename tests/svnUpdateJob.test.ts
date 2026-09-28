/**
 * 原生 SVN 更新任务：先探测、逐条进度、同根去重、取消与有限重放。
 * @author ddj 2026年09月24号
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { SvnUpdateJobs } from '../src/svnUpdateJob.js'
import type { UpdateProcess } from '../src/svnUpdateJob.js'

/**
 * 受控退出：测试明确控制真实任务何时结束。
 * @author ddj 2026年09月24号
 * @returns 可手动结束的进程和只读探针替身
 */
function fakeTerminal() {
  const output = new PassThrough()
  let exit: (value: { exitCode: number | null }) => void = () => {}
  const done = new Promise<{ exitCode: number | null }>((resolve) => { exit = resolve })
  const terminate = vi.fn(async () => { output.end(); exit({ exitCode: null }) })
  const update = { output, done, terminate }
  const spawnTerminal = vi.fn(async (spec: Record<string, unknown>) => {
    const argv = spec.argv as string[]
    if (argv.includes('--version')) {
      return { output: Readable.from(['1.14.5\n']), done: Promise.resolve({ exitCode: 0 }), terminate: async () => {} }
    }
    return update
  })
  const service = { spawnTerminal, spawn: vi.fn() } as unknown as UpdateProcess
  return { service, update, exit, spawnTerminal, terminate }
}

const target = { root: '/wc', cwd: '/wc', path: '.', exe: 'svn' }

/**
 * 仅用于一次性临时仓库的 SVN 命令；输出不进入模型或工作副本。
 * @author ddj 2026年09月24号
 * @param argv CLI 与参数
 * @param cwd 临时目录
 */
async function runCli(argv: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(argv[0] + ' 退出码 ' + code)))
  })
}

/**
 * 用真实 SVN stdout/stderr 构造 DSH 非管道通道的测试替身，不启动第二套 GUI。
 * @author ddj 2026年09月24号
 * @returns 子进程服务
 */
function realProcess(): UpdateProcess {
  return {
    spawn: () => { throw new Error('测试应使用流式终端') },
    spawnTerminal: async (spec) => {
      const argv = spec.argv as string[]
      const child = spawn(argv[0], argv.slice(1), { cwd: spec.cwd as string, stdio: ['ignore', 'pipe', 'pipe'] })
      const output = new PassThrough()
      child.stdout.pipe(output, { end: false })
      child.stderr.pipe(output, { end: false })
      const done = new Promise<{ exitCode: number | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => { output.end(); resolve({ exitCode: code }) })
      })
      return { output, done, terminate: async () => { child.kill() } }
    },
  }
}

/**
 * 等到探测结束并启动真正的 update（不依赖任意时长 sleep）。
 * @author ddj 2026年09月24号
 * @param spawnTerminal 进程替身
 */
async function waitUpdate(spawnTerminal: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(spawnTerminal.mock.calls.some((call) => (call[0].argv as string[]).includes('update'))).toBe(true))
}

describe('SvnUpdateJobs', () => {
  it('先只读探测，中文路径分块也逐条可见；同工作副本不重复执行', async () => {
    const fake = fakeTerminal()
    const jobs = new SvnUpdateJobs(() => fake.service, 'win32')
    const first = jobs.start(target)
    const again = jobs.start({ ...target, path: 'src' })
    expect(again.jobId).toBe(first.jobId)
    await waitUpdate(fake.spawnTerminal)
    const before = jobs.poll('/wc', first.jobId, 0)
    expect(before.rows).toEqual([])
    fake.update.output.write(Buffer.from('U    dir/中'))
    fake.update.output.write(Buffer.from('文.lua\nA    new.txt\nC    conflict.txt\n'))
    await vi.waitFor(() => expect(jobs.poll('/wc', first.jobId, 0).rows).toHaveLength(3))
    const progress = jobs.poll('/wc', first.jobId, 0)
    expect(progress.phase).toBe('running')
    expect(progress.rows[0].relPath).toContain('中文.lua')
    expect(progress.counts).toMatchObject({ U: 1, A: 1, C: 1 })
    fake.update.output.end('Updated to revision 42.\n')
    fake.exit({ exitCode: 0 })
    await vi.waitFor(() => expect(jobs.active('/wc')?.phase).toBe('completed'))
    const final = jobs.poll('/wc', first.jobId, progress.nextSeq)
    expect(final.revision).toBe(42)
    expect(final.rows.at(-1)?.label).toContain('Updated to revision')
    expect(fake.spawnTerminal.mock.calls.filter((call) => (call[0].argv as string[]).includes('update'))).toHaveLength(1)
    jobs.dispose()
  })

  it('选项形态的文件名必须在 -- 后，不能作为 update 选项执行', async () => {
    const fake = fakeTerminal()
    const jobs = new SvnUpdateJobs(() => fake.service, 'win32')
    jobs.start({ ...target, path: '--set-depth=exclude' })
    await waitUpdate(fake.spawnTerminal)
    const spec = fake.spawnTerminal.mock.calls.find((call) => (call[0].argv as string[]).includes('update'))?.[0]
    expect((spec?.argv as string[]).slice(-2)).toEqual(['--', '--set-depth=exclude'])
    jobs.dispose()
  })

  it('更新终端分配未完成时取消，晚到的真实句柄仍被回收', async () => {
    let resolveUpdate: (handle: { output: PassThrough; done: Promise<{ exitCode: number | null }>; terminate: () => Promise<void> }) => void = () => {}
    const terminate = vi.fn(async () => {})
    const spawnTerminal = vi.fn(async (spec: Record<string, unknown>) => {
      if ((spec.argv as string[]).includes('--version')) {
        return { output: Readable.from(['1.14.5\n']), done: Promise.resolve({ exitCode: 0 }), terminate: async () => {} }
      }
      return await new Promise<{ output: PassThrough; done: Promise<{ exitCode: number | null }>; terminate: () => Promise<void> }>((resolve) => { resolveUpdate = resolve })
    })
    const jobs = new SvnUpdateJobs(() => ({ spawnTerminal, spawn: vi.fn() } as unknown as UpdateProcess), 'win32')
    const started = jobs.start(target)
    await waitUpdate(spawnTerminal)
    expect(jobs.cancel('/wc', started.jobId).phase).toBe('cancelling')
    await vi.waitFor(() => expect(jobs.active('/wc')?.phase).toBe('cancelled'))
    resolveUpdate({ output: new PassThrough(), done: new Promise(() => {}), terminate })
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(1))
    jobs.dispose()
  })

  it('取消请求终止受管进程；结果标为部分更新而非成功', async () => {
    const fake = fakeTerminal()
    const jobs = new SvnUpdateJobs(() => fake.service, 'win32')
    const start = jobs.start(target)
    await waitUpdate(fake.spawnTerminal)
    await vi.waitFor(() => expect(jobs.active('/wc')?.phase).toBe('running'))
    const cancelling = jobs.cancel('/wc', start.jobId)
    expect(cancelling.phase).toBe('cancelling')
    await vi.waitFor(() => expect(jobs.active('/wc')?.phase).toBe('cancelled'))
    expect(fake.terminate).toHaveBeenCalledTimes(1)
    jobs.dispose()
  })

  it('只允许同根且 ID 相同的会话读取和取消任务', async () => {
    const fake = fakeTerminal()
    const jobs = new SvnUpdateJobs(() => fake.service, 'win32')
    const start = jobs.start(target)
    expect(() => jobs.poll('/other', start.jobId, 0)).toThrow('工作区不匹配')
    expect(() => jobs.cancel('/wc', 'another-job')).toThrow('工作区不匹配')
    jobs.dispose()
  })

  it('只读 version 探针卡住时取消会终止探针且不启动 update', async () => {
    const terminate = vi.fn(async () => {})
    const spawnTerminal = vi.fn(async () => ({
      output: new PassThrough(), done: new Promise<{ exitCode: number | null }>(() => {}), terminate,
    }))
    const jobs = new SvnUpdateJobs(() => ({ spawnTerminal, spawn: vi.fn() } as unknown as UpdateProcess), 'win32')
    const started = jobs.start(target)
    await vi.waitFor(() => expect(spawnTerminal).toHaveBeenCalledTimes(1))
    expect(jobs.cancel('/wc', started.jobId).phase).toBe('cancelling')
    expect((spawnTerminal.mock.calls[0][0].signal as AbortSignal).aborted).toBe(true)
    await vi.waitFor(() => expect(jobs.active('/wc')?.phase).toBe('cancelled'))
    const probeHandle = await spawnTerminal.mock.results[0].value
    expect(probeHandle.terminate).toBe(terminate)
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(1))
    expect(spawnTerminal.mock.calls.some((call) => (call[0].argv as string[]).includes('update'))).toBe(false)
    jobs.dispose()
  })

  it('探针超时会结束任务并释放同根工作副本', async () => {
    vi.useFakeTimers()
    try {
      const terminate = vi.fn(async () => {})
      const spawnTerminal = vi.fn(async () => ({
        output: new PassThrough(), done: new Promise<{ exitCode: number | null }>(() => {}), terminate,
      }))
      const jobs = new SvnUpdateJobs(() => ({ spawnTerminal, spawn: vi.fn() } as unknown as UpdateProcess), 'win32')
      const started = jobs.start(target)
      await vi.advanceTimersByTimeAsync(8_001)
      expect(jobs.poll('/wc', started.jobId, 0).phase).toBe('failed')
      expect(jobs.active('/wc')?.error).toContain('超时')
      expect(terminate).toHaveBeenCalledTimes(1)
      jobs.dispose()
    } finally { vi.useRealTimers() }
  })

  it('捕获通道都不支持时只做 version 探测，绝不启动 update', async () => {
    const spawn = vi.fn(() => { throw new Error('spawn EPERM') })
    const jobs = new SvnUpdateJobs(() => ({ spawn } as unknown as UpdateProcess), 'linux')
    const start = jobs.start(target)
    await vi.waitFor(() => expect(jobs.active('/wc')?.phase).toBe('failed'))
    expect(jobs.poll('/wc', start.jobId, 0).error).toContain('输出通道不可用')
    expect(spawn).toHaveBeenCalledTimes(1)
    jobs.dispose()
  })

  it('失败时保留已更新的行；分页游标不会一次返回整仓记录', async () => {
    const fake = fakeTerminal()
    const jobs = new SvnUpdateJobs(() => fake.service, 'win32')
    const started = jobs.start(target)
    await waitUpdate(fake.spawnTerminal)
    fake.update.output.end(Array.from({ length: 300 }, (_, i) => 'U    src/f' + i + '.cs').join('\n') + '\nsvn: E170001: auth failed\n')
    fake.exit({ exitCode: 1 })
    await vi.waitFor(() => expect(jobs.active('/wc')?.phase).toBe('failed'))
    const first = jobs.poll('/wc', started.jobId, 0)
    const second = jobs.poll('/wc', started.jobId, first.nextSeq)
    expect(first.rows).toHaveLength(250)
    expect(first.nextSeq).toBe(250)
    expect(first.totalSeq).toBe(301)
    expect(second.rows).toHaveLength(51)
    expect(first.counts.U).toBe(300)
    expect(first.error).toContain('E170001')
    jobs.dispose()
  })

  it('收集输出发生丢头时显示截断告警而不伪造完整计数', async () => {
    const spawn = vi.fn((spec: Record<string, unknown>) => {
      const version = (spec.argv as string[]).includes('--version')
      const stdout = version
        ? { readFrom: () => ({ text: '1.14.5\n', nextOffset: 7, lossy: false }) }
        : { readFrom: () => ({ text: 'partial line\nU    tail.cs\nUpdated to revision 42.\n', nextOffset: 1024, lossy: true }) }
      const stderr = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout, stderr }, terminate: () => {} }
    })
    const jobs = new SvnUpdateJobs(() => ({ spawn } as unknown as UpdateProcess), 'linux')
    const started = jobs.start(target)
    await vi.waitFor(() => expect(jobs.active('/wc')?.phase).toBe('completed'))
    const result = jobs.poll('/wc', started.jobId, 0)
    expect(result.truncated).toBe(true)
    expect(result.counts.U).toBe(1)
    expect(result.revision).toBe(42)
    expect(result.rows[0].label).toContain('输出前段已截断')
    jobs.dispose()
  })
})

/**
 * 在一次性工作副本造出本地/远端同文件修改，只核对 SVN 自己产生的 C 行。
 * @author ddj 2026年09月24号
 * @param url 临时仓库 URL
 * @param wc 临时工作副本
 * @param tmp 临时根目录
 * @param jobs 被测任务管理器
 */
async function checkConflict(url: string, wc: string, tmp: string, jobs: SvnUpdateJobs): Promise<void> {
  await writeFile(join(wc, 'initial.txt'), 'local change\n')
  const remote = join(tmp, 'remote.txt')
  await writeFile(remote, 'remote change\n')
  await runCli(['svnmucc', '--non-interactive', '-m', 'revision three', 'put', remote, url + '/initial.txt'], tmp)
  const started = jobs.start({ root: wc, cwd: wc, path: '', exe: 'svn' })
  await vi.waitFor(() => expect(jobs.active(wc)?.phase).toBe('completed'), { timeout: 15_000 })
  const result = jobs.poll(wc, started.jobId, 0)
  expect(result.revision).toBe(3)
  expect(result.counts.C).toBeGreaterThan(0)
  expect(result.rows.some((row) => row.action === 'C' && row.path.includes('initial.txt'))).toBe(true)
}

const HAS_MUCC = spawnSync('svnmucc', ['--version'], { stdio: 'ignore' }).status === 0
const HAS_SVN = spawnSync('svnadmin', ['--version'], { stdio: 'ignore' }).status === 0
  && spawnSync('svn', ['--version', '--quiet'], { stdio: 'ignore' }).status === 0

describe('临时 SVN 仓库冒烟', () => {
  it.skipIf(!HAS_SVN)('真实 CLI 更新返回可见条目和修订号，无变化时也有完成态', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'edrv-svn-update-'))
    const jobs = new SvnUpdateJobs(realProcess, process.platform)
    try {
      const repo = join(tmp, 'repo')
      const wc = join(tmp, 'wc')
      const seed = join(tmp, 'seed')
      await mkdir(seed)
      await writeFile(join(seed, 'initial.txt'), 'original\n')
      await runCli(['svnadmin', 'create', repo], tmp)
      const url = pathToFileURL(repo).href
      await runCli(['svn', 'import', seed, url, '-m', 'revision one', '--non-interactive'], tmp)
      await runCli(['svn', 'checkout', url, wc, '--non-interactive'], tmp)
      const next = join(tmp, 'new file.txt')
      await writeFile(next, 'new content\n')
      await runCli(['svn', 'import', next, url + '/new%20file.txt', '-m', 'revision two', '--non-interactive'], tmp)
      const started = jobs.start({ root: wc, cwd: wc, path: '', exe: 'svn' })
      await vi.waitFor(() => expect(jobs.active(wc)?.phase).toBe('completed'), { timeout: 15_000 })
      const result = jobs.poll(wc, started.jobId, 0)
      expect(result.rows.some((row) => row.action === 'A' && row.path.includes('new file.txt'))).toBe(true)
      expect(result.revision).toBe(2)
      expect(await readFile(join(wc, 'new file.txt'), 'utf8')).toBe('new content\n')
      const clean = jobs.start({ root: wc, cwd: wc, path: '', exe: 'svn' })
      await vi.waitFor(() => expect(jobs.active(wc)?.phase).toBe('completed'), { timeout: 15_000 })
      expect(jobs.poll(wc, clean.jobId, 0).counts.A).toBe(0)
      expect(jobs.poll(wc, clean.jobId, 0).revision).toBe(2)
      if (HAS_MUCC) await checkConflict(url, wc, tmp, jobs)
    } finally {
      jobs.dispose()
      await rm(tmp, { recursive: true, force: true })
    }
  }, 30_000)
})
