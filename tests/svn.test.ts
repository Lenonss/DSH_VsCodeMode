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
  patchExtOf,
  processNameOf,
  updateResultOf,
} from '../src/svn.js'
import { TORTOISE_EXE, tortoiseLaunchArgv } from '../src/shared/svn.js'
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
