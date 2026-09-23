/**
 * host SVN 能力测试：TortoiseProc argv 构造、工作副本根查找、TortoiseProc 候选序、
 * update 输出宽松解析、createSvnRpc handlers（显隐数据源 + CLI 探测 TTL + 白名单）、
 * P2 变更/基线差异/批量动作 handlers（argv 形态 + 路径守卫 + 容错分支）。
 * 平台注意：断言不写死盘符/分隔符（CI 跑 ubuntu），路径仅做 contains/引用相等比较。
 * 作者 ddj 2026-09-16
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  CHANGES_CAP,
  createSvnRpc,
  findSvnRoot,
  findTortoiseProc,
  foregroundHelperArgv,
  ignoreNameErrorOf,
  patchExtOf,
  processNameOf,
  updateResultOf,
} from '../src/svn.js'
import { FILE_SIZES_CAP, TORTOISE_EXE, tortoiseLaunchArgv } from '../src/shared/svn.js'
import { AI_INBOX_TTL_MS } from '../src/svn.js'
import { SVN_LOG_SHOW_ALL_CAP } from '../src/svnLog.js'
import { svnEditorActions } from '../src/client/svnStatus.js'

describe('tortoiseLaunchArgv', () => {
  it('argv 形状：exe + /command:<action> + /path:<abs>（含空格路径原样传递）', () => {
    const argv = tortoiseLaunchArgv('C:\\T\\TortoiseProc.exe', 'commit', 'D:\\my dir\\a b.txt')
    expect(argv).toEqual(['C:\\T\\TortoiseProc.exe', '/command:commit', '/path:D:\\my dir\\a b.txt'])
  })

  it('六种动作全部映射到同名 TortoiseProc 命令', () => {
    for (const action of ['update', 'commit', 'log', 'diff', 'blame', 'revert'] as const) {
      const argv = tortoiseLaunchArgv('exe', action, 'x')
      expect(argv[1]).toBe('/command:' + action)
    }
    expect(tortoiseLaunchArgv('exe', 'log', 'x')).toHaveLength(3)
    expect(tortoiseLaunchArgv('exe', 'log', 'x')[0]).toBe('exe')
    expect(tortoiseLaunchArgv('exe', 'log', 'x')[2]).toContain(TORTOISE_EXE === 'TortoiseProc.exe' ? '/path:' : '/path:')
  })
})

describe('findSvnRoot', () => {
  it('起始目录即含 .svn 时直接返回', async () => {
    const hit = await findSvnRoot('/wc', async (p) => p === join('/wc', '.svn'))
    expect(hit).toBe('/wc')
  })

  it('向上遍历命中最近祖先', async () => {
    const svnDirs = new Set([join('/wc', '.svn'), join('/wc/sub', '.svn')])
    // /wc/sub/deep 起步：先命中 /wc/sub（最近祖先），而非 /wc
    const hit = await findSvnRoot('/wc/sub/deep', async (p) => svnDirs.has(p))
    expect(hit).toBe('/wc/sub')
  })

  it('超过 10 层未命中返回 null（不会无限上溯）', async () => {
    const deep = ['/', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].join('/')
    const hit = await findSvnRoot(deep, async () => false)
    expect(hit).toBeNull()
  })

  it('到达根仍无命中返回 null', async () => {
    expect(await findSvnRoot('/alone', async () => false)).toBeNull()
  })
})

describe('findTortoiseProc', () => {
  it('非 win32 平台恒不可用', async () => {
    const hit = await findTortoiseProc('', async () => true, 'linux', 'C:\\bin')
    expect(hit).toBeNull()
  })

  it('候选序：设置目录 bin 子目录优先，其次目录直含，再 PATH 逐项', async () => {
    const seen: string[] = []
    const hit = await findTortoiseProc('C:\\tsvn', async (p) => {
      seen.push(p)
      return seen.length === 3 // 第三个候选命中（bin/目录直含落空 → PATH 首项兜底）
    }, 'win32', 'C:\\p1;C:\\p2')
    expect(hit).toBe(seen[2])
    expect(seen[0]).toContain('bin')
    expect(seen[0]).toContain(TORTOISE_EXE)
    expect(seen[1]).not.toContain('bin')
    expect(seen[2]).toContain('C:\\p1')
  })

  it('设置目录直含 exe 时次选命中', async () => {
    let call = 0
    const hit = await findTortoiseProc('C:\\tsvn', async () => ++call === 2, 'win32', '')
    expect(call).toBe(2)
    expect(hit).not.toBeNull()
  })

  it('全落空返回 null', async () => {
    expect(await findTortoiseProc('C:\\tsvn', async () => false, 'win32', 'C:\\p1')).toBeNull()
  })
})

describe('updateResultOf', () => {
  it('英文输出解析修订版号（取最后一处 = 汇总行）', () => {
    const res = updateResultOf('U    a.ts\nUpdated to revision 12345.\n', '', 0)
    expect(res.revision).toBe(12345)
    expect(res.summary).toContain('r12345')
    expect(res.conflicts).toEqual([])
  })

  it('中文输出解析「版本 N」', () => {
    const res = updateResultOf('已更新到版本 456。', '', 0)
    expect(res.revision).toBe(456)
  })

  it('冲突行收集（首列 C 与属性列 C）', () => {
    const out = 'C    conf.txt\n _C  prop.txt\nU    ok.ts\nUpdated to revision 9.'
    const res = updateResultOf(out, '', 0)
    expect(res.conflicts).toEqual(['conf.txt', 'prop.txt'])
    expect(res.summary).toContain('冲突 2 项')
  })

  it('无版本信息时摘要兜底「更新完成」且 output 保留原文', () => {
    const res = updateResultOf('At revision 7.', 'svn: warning', 0)
    expect(res.output).toContain('At revision 7.')
    expect(res.output).toContain('svn: warning')
    expect(res.summary.length).toBeGreaterThan(0)
  })

  it('失败输出同样可解析（修订版号与冲突照常提取，退出码由调用方判定）', () => {
    const res = updateResultOf('', 'svn: E175013: Access denied', 1)
    expect(res.output).toContain('E175013')
    expect(res.revision).toBeUndefined()
  })
})

// --region createSvnRpc handlers

/** 会话 mock（sessionOf 单会话缺省语义）。 */
function makeCtx(spawn: ((spec: Record<string, unknown>) => unknown) | null, cwd: string, fsMock?: unknown) {
  const session = { id: 's1', header: { cwd } }
  return {
    get: (name: string) => {
      if (name === 'subprocess') return spawn ? { spawn } : null
      if (name === 'sessions') return { list: () => [session] }
      if (name === 'fs') return fsMock ?? null
      return undefined
    },
  }
}

/** settings mock（未配置覆盖，走默认解析）。 */
const makeSettings = () => ({ svn: () => ({ svnPath: '', tortoisePath: '' }) })

/** 构造 deps（可覆盖查找器/时钟/子进程）。 */
function makeDeps(over: Record<string, unknown> = {}) {
  const base = {
    ctx: makeCtx(null, '/nowc'),
    settings: makeSettings(),
    ...over,
  }
  return base as Parameters<typeof createSvnRpc>[0]
}

describe('createSvnRpc svn.status', () => {
  it('无会话时报错', async () => {
    const { handlers } = createSvnRpc(makeDeps({ ctx: { get: () => undefined } }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.status']({} as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('会话不存在')
  })

  it('受管理 + CLI 可用：managed/svnCli 为 true 且 wcRoot 透传', async () => {
    let spawns = 0
    const spawn = () => {
      spawns += 1
      return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
    }
    const deps = makeDeps({
      ctx: makeCtx(spawn, '/wc'),
      findRoot: async () => '/wc',
      findTortoise: async () => null,
    })
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.status']({} as never) as { ok: boolean; managed?: boolean; svnCli?: boolean; wcRoot?: string | null }
    expect(res.ok).toBe(true)
    expect(res.managed).toBe(true)
    expect(res.svnCli).toBe(true)
    expect(res.wcRoot).toBe('/wc')
    expect(spawns).toBe(1)
  })

  it('CLI 探测 TTL：窗口内 force 重测不重复 spawn，跨窗口才重探', async () => {
    let nowMs = 1_000_000
    let spawns = 0
    const spawn = () => {
      spawns += 1
      return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
    }
    const { handlers } = createSvnRpc(makeDeps({
      ctx: makeCtx(spawn, '/wc'),
      findRoot: async () => '/wc',
      findTortoise: async () => null,
      now: () => nowMs,
    }))
    const call = (handlers as Record<string, (a: never) => unknown>)['svn.status']
    await call({ force: true } as never)
    nowMs += 60_000
    await call({ force: true } as never)
    expect(spawns).toBe(1)
    nowMs += 5 * 60_000 + 1
    await call({ force: true } as never)
    expect(spawns).toBe(2)
  })
})

describe('createSvnRpc svn.update / svn.tortoise', () => {
  it('未受管理工作区：update 与 tortoise 均拒绝', async () => {
    const { handlers } = createSvnRpc(makeDeps({
      findRoot: async () => null,
      findTortoise: async () => null,
    }))
    const call = handlers as Record<string, (a: never) => unknown>
    const upd = await call['svn.update']({ path: '' } as never) as { ok: boolean; error?: string }
    const tor = await call['svn.tortoise']({ action: 'commit', path: '' } as never) as { ok: boolean; error?: string }
    expect(upd.ok).toBe(false)
    expect(upd.error).toContain('不受 SVN 管理')
    expect(tor.ok).toBe(false)
    expect(tor.error).toContain('不受 SVN 管理')
  })

  it('update 成功：argv 带 --non-interactive 且解析出修订版号', async () => {
    const specs: Array<Record<string, unknown>> = []
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: 'Updated to revision 42.' }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    }
    const { handlers } = createSvnRpc(makeDeps({
      ctx: makeCtx(spawn, '/wc'),
      findRoot: async () => '/wc',
      findTortoise: async () => null,
    }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.update']({ path: 'src' } as never) as { ok: boolean; revision?: number; summary?: string }
    expect(res.ok).toBe(true)
    expect(res.revision).toBe(42)
    const updateSpec = specs.find((s) => (s.argv as string[]).includes('update'))
    expect(updateSpec).toBeDefined()
    expect(updateSpec?.argv).toContain('--non-interactive')
  })

  it('tortoise 动作白名单：未知动作拒绝且不 spawn（白名单校验先于任何探测）', async () => {
    let spawns = 0
    const spawn = () => {
      spawns += 1
      return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
    }
    const { handlers } = createSvnRpc(makeDeps({
      ctx: makeCtx(spawn, '/wc'),
      findRoot: async () => '/wc',
      findTortoise: async () => 'C:\\T\\TortoiseProc.exe',
      now: () => 2_000_000,
    }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.tortoise']({ action: 'merge' as never, path: 'a.ts' } as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('未知动作')
    expect(spawns).toBe(0)
  })

  it('tortoise 成功：目标解析为绝对路径并按 argv 发射', async () => {
    const specs: Array<Record<string, unknown>> = []
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
    }
    const fsMock = {
      resolve: async () => 'T',
      stat: async () => ({ type: 'file' }),
      processPath: () => 'D:\\my dir\\a b.txt',
    }
    const { handlers } = createSvnRpc(makeDeps({
      ctx: makeCtx(spawn, '/wc', fsMock),
      findRoot: async () => '/wc',
      findTortoise: async () => 'C:\\T\\TortoiseProc.exe',
      now: () => 3_000_000,
    }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.tortoise']({ action: 'commit', path: 'a b.txt' } as never) as { ok: boolean; launched?: string }
    expect(res.ok).toBe(true)
    expect(res.launched).toBe('D:\\my dir\\a b.txt')
    const tortoiseSpec = specs.find((s) => (s.argv as string[]).some((a) => a.startsWith('/command:')))
    expect(tortoiseSpec?.argv).toEqual(['C:\\T\\TortoiseProc.exe', '/command:commit', '/path:D:\\my dir\\a b.txt'])
  })

  it('tortoise（win32）：TortoiseProc 之后补发 SwitchToThisWindow 前台助手', async () => {
    const specs: Array<Record<string, unknown>> = []
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
    }
    const fsMock = { resolve: async () => 'T', stat: async () => ({ type: 'file' }), processPath: () => 'D:\\a.txt' }
    const { handlers } = createSvnRpc(makeDeps({
      ctx: makeCtx(spawn, '/wc', fsMock),
      findRoot: async () => '/wc',
      findTortoise: async () => 'C:\\T\\TortoiseProc.exe',
      now: () => 5_000_000,
      platform: 'win32',
    }))
    await (handlers as Record<string, (a: never) => unknown>)['svn.tortoise']({ action: 'log', path: 'a.txt' } as never) as { ok: boolean }
    const helper = specs.find((s) => (s.argv as string[])[0] === 'powershell')
    expect(helper).toBeDefined()
    const script = String(((helper?.argv ?? []) as string[]).at(-1))
    expect(script).toContain('SwitchToThisWindow')
    expect(script).toContain('"TortoiseProc"')
    expect(helper?.cwd).toBeTypeOf('string') // cwd 契约：必填字符串
  })

  it('tortoise（非 win32）：不发前台助手', async () => {
    const specs: Array<Record<string, unknown>> = []
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
    }
    const fsMock = { resolve: async () => 'T', stat: async () => ({ type: 'file' }), processPath: () => '/x/a.txt' }
    const { handlers } = createSvnRpc(makeDeps({
      ctx: makeCtx(spawn, '/wc', fsMock),
      findRoot: async () => '/wc',
      findTortoise: async () => 'C:\\T\\TortoiseProc.exe',
      now: () => 6_000_000,
      platform: 'linux',
    }))
    await (handlers as Record<string, (a: never) => unknown>)['svn.tortoise']({ action: 'log', path: 'a.txt' } as never) as { ok: boolean }
    expect(specs.find((s) => (s.argv as string[])[0] === 'powershell')).toBeUndefined()
  })

  it('tortoise 目标不存在时拒绝', async () => {
    const spawn = () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} })
    const fsMock = { resolve: async () => 'T', stat: async () => null, processPath: () => 'X' }
    const { handlers } = createSvnRpc(makeDeps({
      ctx: makeCtx(spawn, '/wc', fsMock),
      findRoot: async () => '/wc',
      findTortoise: async () => 'C:\\T\\TortoiseProc.exe',
      now: () => 4_000_000,
    }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.tortoise']({ action: 'log', path: 'ghost.ts' } as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('路径不存在')
  })
})

// --endregion

// --region P2 svn.changes / svn.diffBase / svn.revert / svn.add

/** 一次 status --xml 的假输出（含 changelist 与冲突残留）。 */
const STATUS_XML_OUT = [
  '<status><target path=".">',
  '<entry path="."><wc-status props="modified" item="normal" revision="1"/></entry>',
  '<entry path="a.txt"><wc-status item="modified" revision="2" props="none"/></entry>',
  '<entry path="sub\\b.txt"><wc-status item="added" revision="-1" props="none"/></entry>',
  '<entry path="u.txt"><wc-status item="unversioned" props="none"/></entry>',
  '</target><changelist name="cl1"><entry path="c.txt"><wc-status item="conflicted" revision="3" props="none"/></entry></changelist></status>',
].join('')

/** 构造带 spawn 记录的 deps（status --xml 返回给定输出；--version 探测恒成功）。 */
function makeChangesDeps(xml: string, over: Record<string, unknown> = {}) {
  const specs: Array<Record<string, unknown>> = []
  const spawn = (spec: Record<string, unknown>) => {
    specs.push(spec)
    const argv = spec.argv as string[]
    if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
    return {
      done: Promise.resolve({ exitCode: 0 }),
      collected: { stdout: { readFrom: () => ({ text: xml }) }, stderr: { readFrom: () => ({ text: '' }) } },
    }
  }
  return {
    specs,
    deps: makeDeps({ ctx: makeCtx(spawn, '/wc'), findRoot: async () => '/wc', findTortoise: async () => null, ...over }),
  }
}

describe('createSvnRpc svn.changes', () => {
  it('argv 带 --xml --no-ignore 且以工作副本根为 cwd；解析出条目与 changelist 分组', async () => {
    const { specs, deps } = makeChangesDeps(STATUS_XML_OUT)
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.changes']({} as never) as {
      ok: boolean; wcRoot?: string; entries?: Array<{ path: string; status: string; changelist?: string }>; truncated?: boolean
    }
    expect(res.ok).toBe(true)
    expect(res.wcRoot).toBe('/wc')
    expect(res.truncated).toBe(false)
    const paths = res.entries?.map((entry) => entry.path)
    // 根条目（path="."）被跳过；`sub\b.txt` 归一为 `sub/b.txt`
    expect(paths).toEqual(['a.txt', 'sub/b.txt', 'u.txt', 'c.txt'])
    expect(res.entries?.find((entry) => entry.path === 'c.txt')?.changelist).toBe('cl1')
    const statusSpec = specs.find((spec) => (spec.argv as string[]).includes('status'))
    expect(statusSpec?.argv).toEqual(expect.arrayContaining(['--non-interactive', 'status', '--xml', '--no-ignore']))
    expect(statusSpec?.cwd).toBe('/wc')
  })

  it('TTL 缓存：窗口内重复调用只跑一次 status，force 强制重查', async () => {
    let nowMs = 1_000_000
    const { specs, deps } = makeChangesDeps(STATUS_XML_OUT, { now: () => nowMs })
    const { handlers } = createSvnRpc(deps)
    const call = (handlers as Record<string, (a: never) => unknown>)['svn.changes']
    await call({} as never)
    await call({} as never)
    const countStatus = () => specs.filter((spec) => (spec.argv as string[]).includes('status')).length
    expect(countStatus()).toBe(1)
    nowMs += 6_000 // 超过 CHANGES_TTL_MS
    await call({} as never)
    expect(countStatus()).toBe(2)
    await call({ force: true } as never)
    expect(countStatus()).toBe(3)
  })

  it('未受管理工作区：拒绝且不 spawn status', async () => {
    let spawns = 0
    const spawn = () => {
      spawns += 1
      return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
    }
    const { handlers } = createSvnRpc(makeDeps({
      ctx: makeCtx(spawn, '/nowc'),
      findRoot: async () => null,
      findTortoise: async () => null,
    }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.changes']({} as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不受 SVN 管理')
    expect(spawns).toBe(1) // 仅 --version 探测
  })

  it('status 非零退出：返回错误并带原文尾部', async () => {
    const spawn = (spec: Record<string, unknown>) => {
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      return {
        done: Promise.resolve({ exitCode: 1 }),
        collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: 'svn: E155007: not a working copy' }) } },
      }
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc'), findRoot: async () => '/wc', findTortoise: async () => null }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.changes']({} as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('E155007')
  })

  it('条目上限常量导出且为正值（面板截断提示依据）', () => {
    expect(CHANGES_CAP).toBeGreaterThan(0)
  })
})

describe('createSvnRpc svn.fileSizes（W2-5 批量大小查询）', () => {
  /** fs mock：resolve 保真回传，stat 报固定大小；可选对指定路径抛错。 */
  const fsMock = (over: { failPaths?: string[] } = {}) => ({
    resolve: async (p: string) => {
      if (over.failPaths?.includes(p)) throw new Error('boom')
      return p
    },
    stat: async () => ({ type: 'file', size: 7 }),
  })

  it('批量查询：结果与输入等长同序（并发分批不改变载荷语义）', async () => {
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(null, '/wc', fsMock()) }))
    const paths = Array.from({ length: 40 }, (_, i) => 'dir/f' + i + '.txt')
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.fileSizes']({ paths } as never) as { ok: boolean; sizes?: Array<{ path: string; size: number | null }> }
    expect(res.ok).toBe(true)
    expect(res.sizes!.length).toBe(40)
    expect(res.sizes!.map((item) => item.path)).toEqual(paths)
    expect(res.sizes!.every((item) => item.size === 7)).toBe(true)
  })

  it('路径上限：超出 FILE_SIZES_CAP 的部分不查询（client 预截断对齐）', async () => {
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(null, '/wc', fsMock()) }))
    const paths = Array.from({ length: FILE_SIZES_CAP + 30 }, (_, i) => 'f' + i + '.txt')
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.fileSizes']({ paths } as never) as { ok: boolean; sizes?: Array<{ path: string; size: number | null }> }
    expect(res.ok).toBe(true)
    expect(res.sizes!.length).toBe(FILE_SIZES_CAP)
  })

  it('单条失败按 null：不因个别路径异常整体报错；空 paths 直接成功', async () => {
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(null, '/wc', fsMock({ failPaths: ['bad.txt'] })) }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.fileSizes']({ paths: ['ok.txt', 'bad.txt', ''] } as never) as { ok: boolean; sizes?: Array<{ path: string; size: number | null }> }
    expect(res.ok).toBe(true)
    expect(res.sizes![0]).toEqual({ path: 'ok.txt', size: 7 })
    expect(res.sizes![1]).toEqual({ path: 'bad.txt', size: null })
    expect(res.sizes![2]).toEqual({ path: '', size: null })
    const empty = await (handlers as Record<string, (a: never) => unknown>)['svn.fileSizes']({ paths: [] } as never) as { ok: boolean; sizes?: unknown[] }
    expect(empty.ok).toBe(true)
    expect(empty.sizes).toEqual([])
  })
})

describe('createSvnRpc svn.diffBase', () => {
  /**
   * fs mock：resolve/processPath 保真回传路径（runSvn 会用二者把 cwd 归一成真实路径，
   * 若不保真就无法断言「以工作副本根为 cwd」），stat 报文本文件，readText 返回工作区内容。
   */
  const fsMock = (working: string) => ({
    resolve: async (p: string) => p,
    stat: async () => ({ type: 'file', size: working.length }),
    readText: async () => working,
    processPath: (t: unknown) => String(t),
  })

  it('成功：argv 为 cat -r BASE -- <rel> 并使用工作副本根为 cwd', async () => {
    const specs: Array<Record<string, unknown>> = []
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: 'BASE-CONTENT' }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc', fsMock('WORK-CONTENT')), findRoot: async () => '/wc', findTortoise: async () => null }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffBase']({ path: 'a.txt' } as never) as { ok: boolean; base?: string | null; working?: string }
    expect(res.ok).toBe(true)
    expect(res.base).toBe('BASE-CONTENT')
    expect(res.working).toBe('WORK-CONTENT')
    const catSpec = specs.find((spec) => (spec.argv as string[]).includes('cat'))
    expect(catSpec?.argv).toEqual(expect.arrayContaining(['cat', '-r', 'BASE', '--', 'a.txt']))
    expect(catSpec?.cwd).toBe('/wc')
  })

  it('无 pristine（added）：cat 失败但返回 ok + base=null + reason=no-pristine（非报错面板）', async () => {
    const spawn = (spec: Record<string, unknown>) => {
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      return {
        done: Promise.resolve({ exitCode: 1 }),
        collected: {
          stdout: { readFrom: () => ({ text: '' }) },
          stderr: { readFrom: () => ({ text: "svn: E200009: 'x' has no pristine version until it is committed" }) },
        },
      }
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc', fsMock('NEW')), findRoot: async () => '/wc', findTortoise: async () => null }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffBase']({ path: 'new.txt' } as never) as { ok: boolean; base?: string | null; reason?: string; working?: string }
    expect(res.ok).toBe(true)
    expect(res.base).toBeNull()
    expect(res.reason).toBe('no-pristine')
    expect(res.working).toBe('NEW')
  })

  it('cat 失败但原因非 pristine：标记 cat-failed', async () => {
    const spawn = (spec: Record<string, unknown>) => {
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      return {
        done: Promise.resolve({ exitCode: 1 }),
        collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: 'svn: E170013: unable to connect' }) } },
      }
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc', fsMock('X')), findRoot: async () => '/wc', findTortoise: async () => null }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffBase']({ path: 'a.txt' } as never) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(true)
    expect(res.reason).toBe('cat-failed')
  })

  it('路径守卫：空路径与越界路径拒绝', async () => {
    const spawn = () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} })
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc', fsMock('X')), findRoot: async () => '/wc', findTortoise: async () => null }))
    const call = (handlers as Record<string, (a: never) => unknown>)['svn.diffBase']
    expect(((await call({ path: '' } as never)) as { ok: boolean }).ok).toBe(false)
    expect(((await call({ path: '../x' } as never)) as { ok: boolean }).ok).toBe(false)
  })

  it('超大文件拒绝（>8MB）', async () => {
    const spawn = () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} })
    const big = {
      resolve: async () => 'T',
      stat: async () => ({ type: 'file', size: 9 * 1024 * 1024 }),
      readText: async () => 'x',
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc', big), findRoot: async () => '/wc', findTortoise: async () => null }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffBase']({ path: 'a.txt' } as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('过大')
  })
})

describe('createSvnRpc svn.log argv（P1-4 stopOnCopy / P1-6 range，G1/G3 守护）', () => {
  const spawnAll = (specs: Array<Record<string, unknown>>) => (spec: Record<string, unknown>) => {
    specs.push(spec)
    return {
      done: Promise.resolve({ exitCode: 0 }),
      collected: { stdout: { readFrom: () => ({ text: '<log></log>' }) }, stderr: { readFrom: () => ({ text: '' }) } },
    }
  }
  const run = async (args: Record<string, unknown>) => {
    const specs: Array<Record<string, unknown>> = []
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawnAll(specs), '/wc'), findRoot: async () => '/wc', findTortoise: async () => null }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.log'](args as never) as { ok: boolean }
    const logArgv = ((specs.find((s) => (s.argv as string[]).includes('log')) ?? { argv: [] }).argv as string[])
    return { res, logArgv }
  }

  it('默认窗口：-r HEAD:1（G1），不带 --stop-on-copy 与 -g', async () => {
    const { res, logArgv } = await run({ path: 'Assets' })
    expect(res.ok).toBe(true)
    expect(logArgv.slice(logArgv.indexOf('log'))).toEqual(['log', '-r', 'HEAD:1', '-l', '100', '--xml', '-v', '--', 'Assets'])
  })

  it('stopOnCopy：--stop-on-copy 必须在 -- 之前（G3）', async () => {
    const { res, logArgv } = await run({ path: 'Assets', stopOnCopy: true })
    expect(res.ok).toBe(true)
    expect(logArgv).toContain('--stop-on-copy')
    expect(logArgv.indexOf('--stop-on-copy')).toBeLessThan(logArgv.indexOf('--'))
  })

  it('showMerged（P1-5）：argv 加 -g 且必须在 -- 之前（G3）', async () => {
    const { res, logArgv } = await run({ path: 'Assets', showMerged: true })
    expect(res.ok).toBe(true)
    expect(logArgv).toContain('-g')
    expect(logArgv.indexOf('-g')).toBeLessThan(logArgv.indexOf('--'))
  })

  it('showMerged + stopOnCopy 同时勾选：两个选项都在 -- 之前', async () => {
    const { res, logArgv } = await run({ path: 'Assets', showMerged: true, stopOnCopy: true })
    expect(res.ok).toBe(true)
    const dash = logArgv.indexOf('--')
    expect(logArgv.indexOf('-g')).toBeLessThan(dash)
    expect(logArgv.indexOf('--stop-on-copy')).toBeLessThan(dash)
  })

  it('Show Range：-r START:END 替代 HEAD:1（P1-6）', async () => {
    const { res, logArgv } = await run({ path: 'Assets', startRev: 100, endRev: 200 })
    expect(res.ok).toBe(true)
    expect(logArgv).toEqual(expect.arrayContaining(['-r', '100:200']))
  })

  it('Show All 上限（P1-7）：limit 超过 SVN_LOG_SHOW_ALL_CAP 时按上限 clamp，请求仍带 -l', async () => {
    const { res, logArgv } = await run({ path: 'Assets', limit: SVN_LOG_SHOW_ALL_CAP + 1000 })
    expect(res.ok).toBe(true)
    expect(logArgv).toEqual(expect.arrayContaining(['-l', String(SVN_LOG_SHOW_ALL_CAP)]))
  })
})

describe('createSvnRpc svn.diffWorking（P1-1 与工作副本比较）', () => {
  /** fs mock：可指定类型与大小。 */
  const fsMock = (size = 10, type = 'file') => ({
    resolve: async (p: string) => p,
    stat: async () => ({ type, size }),
    readText: async () => 'WORK-CONTENT',
    processPath: (t: unknown) => String(t),
  })
  const mk = (fs: object) => createSvnRpc(makeDeps({ ctx: makeCtx(() => ({ done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: 'REV-CONTENT' }) }, stderr: { readFrom: () => ({ text: '' }) } } }), '/wc', fs), findRoot: async () => '/wc', findTortoise: async () => null }))

  it('成功：左 = cat -r REV 内容，右 = 工作副本内容，cwd 为工作副本根', async () => {
    const { handlers } = mk(fsMock())
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffWorking']({ path: 'a.txt', revision: 7 } as never) as { ok: boolean; left?: string | null; right?: string | null }
    expect(res.ok).toBe(true)
    expect(res.left).toBe('REV-CONTENT')
    expect(res.right).toBe('WORK-CONTENT')
  })

  it('该版本尚无此文件：ok=true、left=null、reason=not-exist（非报错面板）', async () => {
    const fs = fsMock()
    const { handlers } = createSvnRpc(makeDeps({
      ctx: makeCtx((spec: Record<string, unknown>) => {
        const argv = spec.argv as string[]
        if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
        if (argv.includes('cat')) return {
          done: Promise.resolve({ exitCode: 1 }),
          collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: 'svn: E160013: not found' }) } },
        }
        return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      }, '/wc', fs),
      findRoot: async () => '/wc',
      findTortoise: async () => null,
    }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffWorking']({ path: 'new.txt', revision: 7 } as never) as { ok: boolean; left?: string | null; reason?: string }
    expect(res.ok).toBe(true)
    expect(res.left).toBeNull()
    expect(res.reason).toBe('not-exist')
  })

  it('目录与超大文件拒绝', async () => {
    const dir = mk(fsMock(10, 'dir'))
    const resDir = await ((dir.handlers) as Record<string, (a: never) => unknown>)['svn.diffWorking']({ path: 'Assets', revision: 7 } as never) as { ok: boolean; error?: string }
    expect(resDir.ok).toBe(false)
    const big = mk(fsMock(9 * 1024 * 1024))
    const resBig = await ((big.handlers) as Record<string, (a: never) => unknown>)['svn.diffWorking']({ path: 'a.bin', revision: 7 } as never) as { ok: boolean; error?: string }
    expect(resBig.ok).toBe(false)
    expect(resBig.error).toContain('过大')
  })
})

describe('createSvnRpc svn.diffPair（P1-2 比较两个修订）', () => {
  /** fs mock：与 diffBase 同款（resolve/processPath 保真，stat 报文本文件）。 */
  const fsMock = () => ({
    resolve: async (p: string) => p,
    stat: async () => ({ type: 'file', size: 1 }),
    readText: async () => '',
    processPath: (t: unknown) => String(t),
  })

  it('成功：两侧各 cat -r <rev> -- <rel>，cwd 为工作副本根，左右内容按 revA/revB 对应', async () => {
    const specs: Array<Record<string, unknown>> = []
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      const rev = argv[argv.indexOf('-r') + 1]
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: 'R' + rev }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc', fsMock()), findRoot: async () => '/wc', findTortoise: async () => null }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffPair']({ path: 'a.txt', revA: 5, revB: 3 } as never) as { ok: boolean; left?: string | null; right?: string | null }
    expect(res.ok).toBe(true)
    expect(res.left).toBe('R5')
    expect(res.right).toBe('R3')
    const cats = specs.filter((spec) => (spec.argv as string[]).includes('cat'))
    expect(cats).toHaveLength(2)
    expect(cats[0].argv).toEqual(expect.arrayContaining(['cat', '-r', '5', '--', 'a.txt']))
    expect(cats[1].argv).toEqual(expect.arrayContaining(['cat', '-r', '3', '--', 'a.txt']))
    expect(cats[0].cwd).toBe('/wc')
  })

  it('单侧缺失（该版本尚无此文件）：ok=true、该侧 null、reason=not-exist（非报错面板）', async () => {
    const spawn = (spec: Record<string, unknown>) => {
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      const rev = argv[argv.indexOf('-r') + 1]
      if (rev === '5') {
        return {
          done: Promise.resolve({ exitCode: 1 }),
          collected: {
            stdout: { readFrom: () => ({ text: '' }) },
            stderr: { readFrom: () => ({ text: "svn: E160013: Path 'x' not found" }) },
          },
        }
      }
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: 'R3' }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc', fsMock()), findRoot: async () => '/wc', findTortoise: async () => null }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.diffPair']({ path: 'a.txt', revA: 5, revB: 3 } as never) as { ok: boolean; left?: string | null; right?: string | null; reason?: string }
    expect(res.ok).toBe(true)
    expect(res.left).toBeNull()
    expect(res.right).toBe('R3')
    expect(res.reason).toBe('not-exist')
  })

  it('版本号守卫：非正数版本拒绝', async () => {
    const spawn = () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} })
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc', fsMock()), findRoot: async () => '/wc', findTortoise: async () => null }))
    const call = (handlers as Record<string, (a: never) => unknown>)['svn.diffPair']
    expect(((await call({ path: 'a.txt', revA: 0, revB: 3 }) as never) as { ok: boolean }).ok).toBe(false)
    expect(((await call({ path: 'a.txt', revA: 5 }) as never) as { ok: boolean }).ok).toBe(false)
  })
})

describe('createSvnRpc svn.revert / svn.add', () => {
  /** 记录 spawn spec 的 deps（status --version 成功、其余成功）。 */
  function makeMutateDeps(over: Record<string, unknown> = {}) {
    const specs: Array<Record<string, unknown>> = []
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: "Reverted 'a.txt'" }) }, stderr: { readFrom: () => ({ text: '' }) } } }
    }
    return { specs, deps: makeDeps({ ctx: makeCtx(spawn, '/wc'), findRoot: async () => '/wc', findTortoise: async () => null, ...over }) }
  }

  it('revert：argv 为 revert -R -- <paths>，cwd 为工作副本根', async () => {
    const { specs, deps } = makeMutateDeps()
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.revert']({ paths: ['a.txt', 'sub/b.txt'] } as never) as { ok: boolean; count?: number; summary?: string }
    expect(res.ok).toBe(true)
    const spec = specs.find((item) => (item.argv as string[]).includes('revert'))
    expect(spec?.argv).toEqual(['svn', '--non-interactive', 'revert', '-R', '--', 'a.txt', 'sub/b.txt'])
    expect(spec?.cwd).toBe('/wc')
    expect(res.count).toBe(1)
  })

  it('add：argv 为 add -- <paths>', async () => {
    const { specs, deps } = makeMutateDeps()
    const { handlers } = createSvnRpc(deps)
    await (handlers as Record<string, (a: never) => unknown>)['svn.add']({ paths: ['new.txt'] } as never)
    const spec = specs.find((item) => (item.argv as string[]).includes('add'))
    expect(spec?.argv).toEqual(['svn', '--non-interactive', 'add', '--', 'new.txt'])
  })

  it('空清单拒绝；超上限拒绝；越界路径拒绝（均在 spawn 前拦截）', async () => {
    const { specs, deps } = makeMutateDeps()
    const { handlers } = createSvnRpc(deps)
    const call = (handlers as Record<string, (a: never) => unknown>)['svn.revert']
    expect(((await call({ paths: [] } as never)) as { error?: string }).error).toContain('未选择')
    const many = Array.from({ length: 65 }, (_v, i) => 'f' + i + '.txt')
    expect(((await call({ paths: many } as never)) as { error?: string }).error).toContain('最多')
    expect(((await call({ paths: ['../x'] } as never)) as { error?: string }).error).toContain('路径不合法')
    // 越界/超限都在执行前拦截：没有 revert 子命令被 spawn
    expect(specs.some((spec) => (spec.argv as string[]).includes('revert'))).toBe(false)
  })

  it('非零退出：返回失败并带原文尾部', async () => {
    const spawn = (spec: Record<string, unknown>) => {
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      return {
        done: Promise.resolve({ exitCode: 1 }),
        collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: 'svn: E200009: Illegal target' }) } },
      }
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc'), findRoot: async () => '/wc', findTortoise: async () => null }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.add']({ paths: ['a.txt'] } as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('E200009')
  })

  it('动作成功后作废变更缓存：下次 changes 重新 status（不返回陈旧清单）', async () => {
    const specs: Array<Record<string, unknown>> = []
    let statusRuns = 0
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      if (argv.includes('status')) {
        statusRuns += 1
        return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: STATUS_XML_OUT }) }, stderr: { readFrom: () => ({ text: '' }) } } }
      }
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: "Reverted 'a.txt'" }) }, stderr: { readFrom: () => ({ text: '' }) } } }
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc'), findRoot: async () => '/wc', findTortoise: async () => null }))
    const call = handlers as Record<string, (a: never) => unknown>
    await call['svn.changes']({} as never)
    await call['svn.changes']({} as never)
    expect(statusRuns).toBe(1)
    await call['svn.revert']({ paths: ['a.txt'] } as never)
    await call['svn.changes']({} as never)
    expect(statusRuns).toBe(2)
  })
})

describe('createSvnRpc svn.changelist（P5 分区管理）', () => {
  /** 记录 spawn spec 的 deps（--version/status/changelist 均成功，成功输出静默）。 */
  function makeClDeps(over: Record<string, unknown> = {}) {
    const specs: Array<Record<string, unknown>> = []
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
    }
    return { specs, deps: makeDeps({ ctx: makeCtx(spawn, '/wc'), findRoot: async () => '/wc', findTortoise: async () => null, ...over }) }
  }

  it('关联：argv 为 changelist <name> -- <paths>，cwd 为工作副本根', async () => {
    const { specs, deps } = makeClDeps()
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.changelist']({ paths: ['a.txt', 'sub/b.txt'], name: 'my cl' } as never) as { ok: boolean }
    expect(res.ok).toBe(true)
    const spec = specs.find((item) => (item.argv as string[]).includes('changelist'))
    expect(spec?.argv).toEqual(['svn', '--non-interactive', 'changelist', 'my cl', '--', 'a.txt', 'sub/b.txt'])
    expect(spec?.cwd).toBe('/wc')
  })

  it('解除：argv 为 changelist --remove -- <paths>；remove 分支不校验分区名', async () => {
    const { specs, deps } = makeClDeps()
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.changelist']({ paths: ['a.txt'], remove: true } as never) as { ok: boolean }
    expect(res.ok).toBe(true)
    const spec = specs.find((item) => (item.argv as string[]).includes('changelist'))
    expect(spec?.argv).toEqual(['svn', '--non-interactive', 'changelist', '--remove', '--', 'a.txt'])
  })

  it('分区名校验：空名/`-` 开头/缺名在 spawn 前拦截', async () => {
    const { specs, deps } = makeClDeps()
    const { handlers } = createSvnRpc(deps)
    const call = (handlers as Record<string, (a: never) => unknown>)['svn.changelist']
    expect(((await call({ paths: ['a.txt'], name: '  ' } as never)) as { error?: string }).error).toContain('不能为空')
    expect(((await call({ paths: ['a.txt'], name: '-x' } as never)) as { error?: string }).error).toContain('不能以 - 开头')
    expect(((await call({ paths: ['a.txt'] } as never)) as { error?: string }).error).toContain('不能为空')
    // spawn 前拦截：没有任何进程被拉起
    expect(specs.length).toBe(0)
  })

  it('成功后作废变更缓存：下次 changes 重新 status（分组不陈旧）', async () => {
    const specs: Array<Record<string, unknown>> = []
    let statusRuns = 0
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      if (argv.includes('status')) {
        statusRuns += 1
        return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: STATUS_XML_OUT }) }, stderr: { readFrom: () => ({ text: '' }) } } }
      }
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc'), findRoot: async () => '/wc', findTortoise: async () => null }))
    const call = handlers as Record<string, (a: never) => unknown>
    await call['svn.changes']({} as never)
    await call['svn.changes']({} as never)
    expect(statusRuns).toBe(1)
    await call['svn.changelist']({ paths: ['a.txt'], name: 'cl1' } as never)
    await call['svn.changes']({} as never)
    expect(statusRuns).toBe(2)
  })
})

// --endregion


describe('foregroundHelperArgv / processNameOf（前台置顶助手）', () => {
  it('processNameOf：去路径去 .exe', () => {
    expect(processNameOf('C:\\Program Files\\TortoiseSVN\\bin\\TortoiseProc.exe')).toBe('TortoiseProc')
    expect(processNameOf('/usr/bin/svn')).toBe('svn')
  })

  it('助手 argv：powershell 隐藏窗口，脚本含 SwitchToThisWindow 与进程名，无用户数据', () => {
    const argv = foregroundHelperArgv('TortoiseProc')
    expect(argv[0]).toBe('powershell')
    expect(argv).toContain('-WindowStyle')
    expect(argv).toContain('Hidden')
    const script = argv.at(-1) as string
    expect(script).toContain('SwitchToThisWindow')
    expect(script).toContain('"TortoiseProc"')
    expect(script).not.toContain('Program Files') // 脚本按进程名发现窗口，不嵌路径
  })
})

describe('svnEditorActions（编辑区右键动作表）', () => {
  const base = { wcRoot: '/wc', svnPath: 'svn', tortoiseExe: 'C:\\T\\TortoiseProc.exe' }
  /** 自研已就绪的能力集合（P2 差异/还原 + P3 日志）。 */
  const features = ['diff', 'revert', 'log'] as const

  it('未加载/未受管理返回空数组（整组隐藏）', () => {
    expect(svnEditorActions(null)).toEqual([])
    expect(svnEditorActions({ ...base, managed: false, svnCli: true, tortoise: true })).toEqual([])
  })

  it('受管理且仅 CLI 可用：自研项（更新 + 比较 + 日志），无 Tortoise 项', () => {
    const actions = svnEditorActions({ ...base, managed: true, svnCli: true, tortoise: false, svnFeatures: features })
    expect(actions.map((item) => item.id)).toEqual(['edrv.svnEditorUpdate', 'edrv.svnEditorDiff', 'edrv.svnEditorLog'])
    expect(actions[0].kind).toBe('update')
    expect(actions[1]).toMatchObject({ kind: 'cli', actionId: 'diff-base' })
  })

  it('受管理且 Tortoise 可用：自研项 + 未被覆盖的 Tortoise 项（差异/日志/还原被覆盖而隐藏）', () => {
    const actions = svnEditorActions({ ...base, managed: true, svnCli: true, tortoise: true, svnFeatures: features })
    expect(actions.map((item) => item.id)).toEqual([
      'edrv.svnEditorUpdate',
      'edrv.svnEditorDiff',
      'edrv.svnEditorLog',
      // 提交与追溯无自研实现 → 保留官方入口
      'edrv.svnEditorCommit',
      'edrv.svnEditorBlame',
    ])
    const commit = actions.find((item) => item.id === 'edrv.svnEditorCommit')
    expect(commit).toMatchObject({ kind: 'tortoise', tortoiseAction: 'commit' })
    // 被自研覆盖的三项不再出现（这正是用户「点到官方弹窗」的根因）
    expect(actions.some((item) => item.id === 'edrv.svnEditorTortoiseDiff')).toBe(false)
    expect(actions.some((item) => item.id === 'edrv.svnEditorTortoiseRevert')).toBe(false)
    expect(actions.some((item) => item.id === 'edrv.svnEditorTortoiseLog')).toBe(false)
  })

  it('自研能力为空（旧 payload/未探测）：全部 Tortoise 项恢复显示（降级可用）', () => {
    const actions = svnEditorActions({ ...base, managed: true, svnCli: true, tortoise: true })
    const ids = actions.map((item) => item.id)
    // Tortoise 五项全在（提交/日志/差异/追溯/还原）
    expect(ids).toContain('edrv.svnEditorCommit')
    expect(ids).toContain('edrv.svnEditorTortoiseLog')
    expect(ids).toContain('edrv.svnEditorTortoiseDiff')
    expect(ids).toContain('edrv.svnEditorBlame')
    expect(ids).toContain('edrv.svnEditorTortoiseRevert')
    // 自研项同时也在（能力标志缺失只影响「是否隐藏 Tortoise」，不影响自研项本身）
    expect(ids).toContain('edrv.svnEditorDiff')
    expect(ids).toContain('edrv.svnEditorLog')
  })

  it('受管理但 CLI 不可用且 Tortoise 可用：仅未被覆盖的 Tortoise 项（提交/追溯）', () => {
    const actions = svnEditorActions({ ...base, managed: true, svnCli: false, tortoise: true, svnFeatures: features })
    expect(actions.map((item) => item.kind)).toEqual(['tortoise', 'tortoise'])
    expect(actions.map((item) => item.tortoiseAction)).toEqual(['commit', 'blame'])
  })

  it('状态门禁渗透到编辑区：未版本控制文件只出「加入版本控制」', () => {
    const actions = svnEditorActions(
      { ...base, managed: true, svnCli: true, tortoise: true, svnFeatures: features },
      { versioned: false, status: 'unversioned', diffable: true },
    )
    const ids = actions.map((item) => item.id)
    expect(ids).toContain('edrv.svnEditorAdd')
    // 未版本控制：无可比较基线、无改动可还原、无提交历史
    expect(ids).not.toContain('edrv.svnEditorDiff')
    expect(ids).not.toContain('edrv.svnEditorRevert')
    expect(ids).not.toContain('edrv.svnEditorLog')
  })
})

describe('patchExtOf（W2-1 补丁 -x 扩展选项组合）', () => {
  it('缺省 = 空串（不传 -x，保持 svn 默认 unified 3）', () => {
    expect(patchExtOf({})).toBe('')
    expect(patchExtOf({ whitespace: 'none', ignoreEol: false, unified: 3 })).toBe('')
  })

  it('空白语义互斥取后值；ignoreEol 与 unified 组合用空格连接（单个 -x 值）', () => {
    expect(patchExtOf({ whitespace: 'b' })).toBe('-b')
    expect(patchExtOf({ whitespace: 'w' })).toBe('-w')
    expect(patchExtOf({ whitespace: 'b', ignoreEol: true })).toBe('-b --ignore-eol-style')
    expect(patchExtOf({ whitespace: 'b', ignoreEol: true, unified: 8 })).toBe('-b --ignore-eol-style -U8')
  })

  it('unified 越界/非法回落不传（防 -x 值注入非法选项）', () => {
    expect(patchExtOf({ unified: 0 })).toBe('-U0')
    expect(patchExtOf({ unified: 101 })).toBe('')
    expect(patchExtOf({ unified: Number.NaN })).toBe('')
    expect(patchExtOf({ unified: 2.9 })).toBe('-U2')
  })
})

// --region AI 智能整理（svn.aiPlan / svn.ignore，11-ai-changelist-triage）

/** llm mock（stream 单段 text-delta + finish；fail 时走 finish(error) 适配器失败形态）。 */
function makeLlm(text: string, fail = false) {
  return {
    listProviders: () => [{ id: 'p1', name: 'P1' }],
    listModels: async () => [{ provider: 'p1', id: 'm1', name: 'M1' }],
    stream: () => ({
      [Symbol.asyncIterator]: async function* () {
        if (fail) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'E', message: 'boom' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  }
}

/** 带 llm 的会话 ctx（其余与 makeCtx 同语义）。 */
function makeAiCtx(spawn: ((spec: Record<string, unknown>) => unknown) | null, llm: unknown) {
  const base = makeCtx(spawn, '/wc')
  return {
    get: (name: string) => (name === 'llm' ? llm : (base as { get: (n: string) => unknown }).get(name)),
  }
}

describe('createSvnRpc svn.aiPlan（AI 智能整理分析）', () => {
  /** spawn 记录 + 可控 diff/status 输出的 deps。 */
  function makeAiDeps(llm: unknown, opts: { diffText?: string } = {}) {
    const specs: Array<Record<string, unknown>> = []
    let statusRuns = 0
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      if (argv.includes('status')) {
        statusRuns += 1
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: { stdout: { readFrom: () => ({ text: STATUS_XML_OUT }) }, stderr: { readFrom: () => ({ text: '' }) } },
        }
      }
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: opts.diffText ?? '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    }
    return {
      specs, statusRuns: () => statusRuns,
      deps: makeDeps({ ctx: makeAiCtx(spawn, llm), findRoot: async () => '/wc', findTortoise: async () => null }),
    }
  }

  const PLAN_JSON = JSON.stringify({
    groups: [{ name: 'g1', paths: ['sub/b.txt'], reason: '主题' }],
    reverts: [{ path: 'a.txt', reason: '噪音' }],
    ignores: [{ path: 'u.txt', reason: '生成物' }],
  })

  it('成功：方案经真实清单归一回传（含 entriesCount/diffIncluded/model）', async () => {
    const { deps } = makeAiDeps(makeLlm(PLAN_JSON), { diffText: 'Index: a.txt' })
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.aiPlan']({} as never) as {
      ok: boolean; plan?: { reverts: Array<{ path: string }>; ignores: Array<{ path: string }>; groups: Array<{ name: string; paths: string[] }> }
      entriesCount?: number; diffIncluded?: boolean; dropped?: number; model?: string
    }
    expect(res.ok).toBe(true)
    expect(res.plan?.reverts.map((i) => i.path)).toEqual(['a.txt'])
    expect(res.plan?.ignores.map((i) => i.path)).toEqual(['u.txt'])
    expect(res.plan?.groups[0]).toMatchObject({ name: 'g1', paths: ['sub/b.txt'] })
    expect(res.entriesCount).toBeGreaterThan(0)
    expect(res.diffIncluded).toBe(true)
    expect(res.model).toContain('p1')
  })

  it('force 拉变更：两次调用各自重跑 status（不吃 TTL 缓存）', async () => {
    const { deps, statusRuns } = makeAiDeps(makeLlm(PLAN_JSON))
    const { handlers } = createSvnRpc(deps)
    const call = handlers as Record<string, (a: never) => unknown>
    await call['svn.aiPlan']({} as never)
    await call['svn.aiPlan']({} as never)
    expect(statusRuns()).toBe(2)
  })

  it('llm 缺失：报 llm 服务不可用且零方案', async () => {
    const { deps } = makeAiDeps(undefined)
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.aiPlan']({} as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('llm 服务不可用')
  })

  it('非法 JSON：解析失败透传（零执行）', async () => {
    const { deps } = makeAiDeps(makeLlm('这里没有方案'))
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.aiPlan']({} as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不含 JSON 对象')
  })

  it('适配器流失败：finish(error) 转错误透传', async () => {
    const { deps } = makeAiDeps(makeLlm('', true))
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.aiPlan']({} as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('模型流失败')
  })

  it('diff 失败降级 paths-only（diffIncluded=false，分析不中断）', async () => {
    const { deps } = makeAiDeps(makeLlm(PLAN_JSON), { diffText: '' })
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.aiPlan']({} as never) as { ok: boolean; diffIncluded?: boolean }
    expect(res.ok).toBe(true)
    expect(res.diffIncluded).toBe(false)
  })

  it('任务模型优先于补全模型（ai-task-model）：stream 路由/档位取任务配置', async () => {
    // llm mock 捕获 stream options；settings.ai() 带 taskProvider/taskModel/taskEffort + 补全 provider/model 不同
    const seen: Array<Record<string, unknown>> = []
    const llm = {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => [{ provider: 'p1', id: 'm1', name: 'M1' }],
      stream: (options: Record<string, unknown>) => {
        seen.push(options)
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'text-delta', index: 0, text: PLAN_JSON }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    }
    const { deps } = makeAiDeps(llm, { diffText: '' })
    deps.settings = {
      svn: () => ({ svnPath: '', tortoisePath: '' }),
      ai: () => ({
        enabled: true, provider: 'pc', model: 'mc', effort: 'low',
        taskProvider: 'pt', taskModel: 'mt', taskEffort: 'high',
      }),
    }
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.aiPlan']({} as never) as { ok: boolean; model?: string }
    expect(res.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0].provider).toBe('pt')
    expect(seen[0].model).toBe('mt')
    expect(seen[0].reasoningEffort).toBe('high')
    expect(res.model).toBe('pt/mt')
  })

  it('任务模型缺省：回落补全模型（旧行为逐字一致）', async () => {
    const seen: Array<Record<string, unknown>> = []
    const llm = {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => [{ provider: 'p1', id: 'm1', name: 'M1' }],
      stream: (options: Record<string, unknown>) => {
        seen.push(options)
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'text-delta', index: 0, text: PLAN_JSON }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    }
    const { deps } = makeAiDeps(llm, { diffText: '' })
    deps.settings = {
      svn: () => ({ svnPath: '', tortoisePath: '' }),
      ai: () => ({ enabled: true, provider: 'pc', model: 'mc', effort: 'low' }),
    }
    const { handlers } = createSvnRpc(deps)
    await (handlers as Record<string, (a: never) => unknown>)['svn.aiPlan']({} as never)
    expect(seen[0].provider).toBe('pc')
    expect(seen[0].model).toBe('mc')
    expect(seen[0].reasoningEffort).toBe('low')
  })
})

describe('createSvnRpc svn.aiPlanSubmit / svn.aiPlanPending（混合通道收件箱）', () => {
  /** 可控时钟 + spawn 记录的 deps（status --xml 返回 STATUS_XML_OUT）。 */
  function makeInboxDeps() {
    let nowMs = 1_000_000
    const spawn = (spec: Record<string, unknown>) => {
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: { stdout: { readFrom: () => ({ text: STATUS_XML_OUT }) }, stderr: { readFrom: () => ({ text: '' }) } },
      }
    }
    return {
      now: () => nowMs,
      advance: (ms: number) => { nowMs += ms },
      deps: makeDeps({ ctx: makeCtx(spawn, '/wc'), findRoot: async () => '/wc', findTortoise: async () => null, now: () => nowMs }),
    }
  }

  const AGENT_PLAN = {
    groups: [{ name: 'g1', paths: ['sub/b.txt'], reason: '主题' }],
    reverts: [{ path: 'a.txt', reason: '噪音' }],
    ignores: [{ path: 'u.txt', reason: '生成物' }],
  }

  it('投递：白名单归一后入箱（幻觉路径丢弃计数）', async () => {
    const { deps } = makeInboxDeps()
    const { handlers } = createSvnRpc(deps)
    const call = handlers as Record<string, (a: never) => unknown>
    const plan = { ...AGENT_PLAN, reverts: [...AGENT_PLAN.reverts, { path: 'ghost.ts' }] }
    const res = await call['svn.aiPlanSubmit']({ plan } as never) as { ok: boolean; accepted?: number; dropped?: number }
    expect(res.ok).toBe(true)
    expect(res.accepted).toBe(3)
    expect(res.dropped).toBe(1)
    const got = await call['svn.aiPlanPending']({ since: 0 } as never) as { plan: { reverts: Array<{ path: string }> } | null }
    expect(got.plan?.reverts.map((i) => i.path)).toEqual(['a.txt'])
  })

  it('零接受拒收：全幻觉方案 ok:false 且不入箱', async () => {
    const { deps } = makeInboxDeps()
    const { handlers } = createSvnRpc(deps)
    const call = handlers as Record<string, (a: never) => unknown>
    const res = await call['svn.aiPlanSubmit']({ plan: { groups: [], reverts: [{ path: 'ghost.ts' }], ignores: [] } } as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('方案为空')
    const got = await call['svn.aiPlanPending']({ since: 0 } as never) as { plan: unknown }
    expect(got.plan).toBeNull()
  })

  it('覆盖式入箱：新投递顶掉旧件', async () => {
    const { deps } = makeInboxDeps()
    const { handlers } = createSvnRpc(deps)
    const call = handlers as Record<string, (a: never) => unknown>
    await call['svn.aiPlanSubmit']({ plan: AGENT_PLAN } as never)
    const next = { groups: [], reverts: [{ path: 'c.txt', reason: '误改' }], ignores: [] }
    await call['svn.aiPlanSubmit']({ plan: next } as never)
    const got = await call['svn.aiPlanPending']({ since: 0 } as never) as { plan: { reverts: Array<{ path: string }> } | null }
    expect(got.plan?.reverts.map((i) => i.path)).toEqual(['c.txt'])
  })

  it('since 过滤：早于注入时刻的旧投递不算新件', async () => {
    const { deps, now } = makeInboxDeps()
    const { handlers } = createSvnRpc(deps)
    const call = handlers as Record<string, (a: never) => unknown>
    await call['svn.aiPlanSubmit']({ plan: AGENT_PLAN } as never)
    const fresh = await call['svn.aiPlanPending']({ since: now() + 1 } as never) as { plan: unknown }
    expect(fresh.plan).toBeNull()
    const any = await call['svn.aiPlanPending']({ since: 0 } as never) as { plan: unknown }
    expect(any.plan).not.toBeNull()
  })

  it('TTL 过期：AI_INBOX_TTL_MS 后取件返回 null', async () => {
    const { deps, advance } = makeInboxDeps()
    const { handlers } = createSvnRpc(deps)
    const call = handlers as Record<string, (a: never) => unknown>
    await call['svn.aiPlanSubmit']({ plan: AGENT_PLAN } as never)
    advance(AI_INBOX_TTL_MS + 1)
    const got = await call['svn.aiPlanPending']({ since: 0 } as never) as { plan: unknown }
    expect(got.plan).toBeNull()
  })

  it('非法形状（plan 非对象）：按空方案拒收', async () => {
    const { deps } = makeInboxDeps()
    const { handlers } = createSvnRpc(deps)
    const call = handlers as Record<string, (a: never) => unknown>
    const res = await call['svn.aiPlanSubmit']({ plan: 'not-json' } as never) as { ok: boolean }
    expect(res.ok).toBe(false)
  })
})

describe('ignoreNameErrorOf（svn:ignore 名称校验）', () => {
  it('合法：普通名/通配模式', () => {
    expect(ignoreNameErrorOf('build.log')).toBeNull()
    expect(ignoreNameErrorOf('*.tmp')).toBeNull()
  })

  it('非法：空/换行/路径分隔符/`-` 开头/非字符串', () => {
    expect(ignoreNameErrorOf('')).toContain('不能为空')
    expect(ignoreNameErrorOf('a\nb')).toContain('换行')
    expect(ignoreNameErrorOf('a/b')).toContain('路径分隔符')
    expect(ignoreNameErrorOf('a\\b')).toContain('路径分隔符')
    expect(ignoreNameErrorOf('-x')).toContain('不能以 - 开头')
    expect(ignoreNameErrorOf(42)).toContain('字符串')
  })
})

describe('createSvnRpc svn.ignore（AI 整理 svn:ignore 写入）', () => {
  /** spawn 记录 + propget 返回给定既有值的 deps。 */
  function makeIgnoreDeps(existing: string, over: Record<string, unknown> = {}) {
    const specs: Array<Record<string, unknown>> = []
    let statusRuns = 0
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      if (argv.includes('status')) {
        statusRuns += 1
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: { stdout: { readFrom: () => ({ text: STATUS_XML_OUT }) }, stderr: { readFrom: () => ({ text: '' }) } },
        }
      }
      if (argv.includes('propget')) {
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: { stdout: { readFrom: () => ({ text: existing }) }, stderr: { readFrom: () => ({ text: '' }) } },
        }
      }
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
    }
    return {
      specs, statusRuns: () => statusRuns,
      deps: makeDeps({ ctx: makeCtx(spawn, '/wc'), findRoot: async () => '/wc', findTortoise: async () => null, ...over }),
    }
  }

  it('propget 合并既有值后 propset（不整体覆盖）', async () => {
    const { specs, deps } = makeIgnoreDeps('old.txt\n')
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.ignore']({ items: [{ dir: 'gen', names: ['b.tmp'] }] } as never) as { ok: boolean; count?: number }
    expect(res.ok).toBe(true)
    expect(res.count).toBe(1)
    const get = specs.find((s) => (s.argv as string[]).includes('propget'))
    expect(get?.argv).toEqual(['svn', '--non-interactive', 'propget', 'svn:ignore', '--', 'gen'])
    const set = specs.find((s) => (s.argv as string[]).includes('propset'))
    expect(set?.argv).toEqual(['svn', '--non-interactive', 'propset', 'svn:ignore', 'old.txt\nb.tmp', '--', 'gen'])
  })

  it('重名跳过：无新增不 propset，count=0', async () => {
    const { specs, deps } = makeIgnoreDeps('b.tmp\n')
    const { handlers } = createSvnRpc(deps)
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.ignore']({ items: [{ dir: 'gen', names: ['b.tmp'] }] } as never) as { ok: boolean; count?: number }
    expect(res.ok).toBe(true)
    expect(res.count).toBe(0)
    expect(specs.some((s) => (s.argv as string[]).includes('propset'))).toBe(false)
  })

  it('根目录（dir 为空串）归一为 `.`', async () => {
    const { specs, deps } = makeIgnoreDeps('')
    const { handlers } = createSvnRpc(deps)
    await (handlers as Record<string, (a: never) => unknown>)['svn.ignore']({ items: [{ dir: '', names: ['root.log'] }] } as never)
    const set = specs.find((s) => (s.argv as string[]).includes('propset'))
    expect(set?.argv).toEqual(['svn', '--non-interactive', 'propset', 'svn:ignore', 'root.log', '--', '.'])
  })

  it('非法名/越界/空清单/超上限在 spawn 前拦截（不 propget/propset）', async () => {
    const { specs, deps } = makeIgnoreDeps('')
    const { handlers } = createSvnRpc(deps)
    const call = (handlers as Record<string, (a: never) => unknown>)['svn.ignore']
    expect(((await call({ items: [] } as never)) as { error?: string }).error).toContain('未选择')
    expect(((await call({ items: [{ dir: 'g', names: ['-x'] }] } as never)) as { error?: string }).error).toContain('不能以 - 开头')
    expect(((await call({ items: [{ dir: 'g', names: ['a\nb'] }] } as never)) as { error?: string }).error).toContain('换行')
    expect(((await call({ items: [{ dir: '../x', names: ['a'] }] } as never)) as { error?: string }).error).toContain('路径不合法')
    const many = Array.from({ length: 65 }, (_v, i) => 'f' + i)
    expect(((await call({ items: [{ dir: 'g', names: many }] } as never)) as { error?: string }).error).toContain('最多')
    expect(specs.some((s) => (s.argv as string[]).includes('propset') || (s.argv as string[]).includes('propget'))).toBe(false)
  })

  it('成功后作废变更缓存：下次 changes 重新 status（目录属性进变更清单）', async () => {
    const { specs, deps, statusRuns } = makeIgnoreDeps('')
    const { handlers } = createSvnRpc(deps)
    const call = handlers as Record<string, (a: never) => unknown>
    await call['svn.changes']({} as never)
    await call['svn.changes']({} as never)
    expect(statusRuns()).toBe(1)
    await call['svn.ignore']({ items: [{ dir: 'gen', names: ['b.tmp'] }] } as never)
    await call['svn.changes']({} as never)
    expect(statusRuns()).toBe(2)
    expect(specs.length).toBeGreaterThan(0)
  })

  it('propset 非零退出：整批失败透传原文尾部', async () => {
    const specs: Array<Record<string, unknown>> = []
    const spawn = (spec: Record<string, unknown>) => {
      specs.push(spec)
      const argv = spec.argv as string[]
      if (argv.includes('--version')) return { done: Promise.resolve({ exitCode: 0 }), collected: {} }
      if (argv.includes('status')) {
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: { stdout: { readFrom: () => ({ text: STATUS_XML_OUT }) }, stderr: { readFrom: () => ({ text: '' }) } },
        }
      }
      if (argv.includes('propget')) {
        return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
      }
      return {
        done: Promise.resolve({ exitCode: 1 }),
        collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: 'svn: E200009: not versioned' }) } },
      }
    }
    const { handlers } = createSvnRpc(makeDeps({ ctx: makeCtx(spawn, '/wc'), findRoot: async () => '/wc', findTortoise: async () => null }))
    const res = await (handlers as Record<string, (a: never) => unknown>)['svn.ignore']({ items: [{ dir: 'gen', names: ['b.tmp'] }] } as never) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('E200009')
  })
})

// --endregion
