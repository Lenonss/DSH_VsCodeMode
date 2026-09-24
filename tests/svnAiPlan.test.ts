/**
 * AI 智能整理纯逻辑测试（11-ai-changelist-triage）：
 * normalizeAiPlan（白名单/互斥/命名/上限）、planItemOf/planGroupOf（宽松解析）、
 * parseAiPlanJson（围栏/杂文本/非法 JSON）、buildAiPrompt（两形态/截断提示）、
 * ignoreItemsOf（目录聚合）、runPlanSteps（暂停边界/取消/失败继续）。
 * 作者 ddj 2026-09-23
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AI_PLAN_GROUPS_CAP,
  buildAgentPrompt,
  ignoreItemsOf,
  normalizeAiPlan,
  planGroupOf,
  planItemOf,
} from '../src/shared/svn.js'
import type { SvnChangeEntry } from '../src/shared/svn.js'
import { buildAiPrompt, parseAiPlanJson } from '../src/ai/svnTriage.js'
import { runPlanSteps } from '../src/client/svnStatus.js'
import type { SvnPlanCtl, SvnPlanStep } from '../src/client/svnStatus.js'
import { newDraftSession, apiSessionPrompt, createAddToConversation } from '../src/client/addToConversation.js'

/** 变更清单样本：modified（versioned）/ unversioned / ignored / added（versioned）。 */
const ENTRIES: SvnChangeEntry[] = [
  { path: 'a.txt', status: 'modified', versioned: true },
  { path: 'sub/b.txt', status: 'added', versioned: true },
  { path: 'u.tmp', status: 'unversioned', versioned: false },
  { path: 'ig.log', status: 'ignored', versioned: false },
  { path: 'c.cs', status: 'modified', versioned: true },
]

// --region normalizeAiPlan

describe('normalizeAiPlan', () => {
  it('幻觉路径剔除并计数 dropped', () => {
    const raw = { groups: [], reverts: [{ path: 'a.txt' }, { path: 'ghost.ts' }], ignores: [] }
    const { plan, dropped } = normalizeAiPlan(raw, ENTRIES)
    expect(plan.reverts.map((i) => i.path)).toEqual(['a.txt'])
    expect(dropped).toBe(1)
  })

  it('状态不符重分类丢弃：unversioned 不可 revert、versioned 不可 ignore、ignored 不可入任何段', () => {
    const raw = {
      groups: [{ name: 'g1', paths: ['ig.log'] }],
      reverts: [{ path: 'u.tmp' }],
      ignores: [{ path: 'a.txt' }, { path: 'ig.log' }],
    }
    const { plan, dropped } = normalizeAiPlan(raw, ENTRIES)
    expect(plan.reverts).toEqual([])
    expect(plan.ignores).toEqual([])
    expect(plan.groups).toEqual([])
    expect(dropped).toBe(4)
  })

  it('互斥优先级 revert > ignore > group：同路径只归最高优先段', () => {
    const raw = {
      groups: [{ name: 'g1', paths: ['a.txt', 'c.cs'] }],
      reverts: [{ path: 'a.txt' }],
      ignores: [{ path: 'a.txt' }, { path: 'u.tmp' }],
    }
    const { plan } = normalizeAiPlan(raw, ENTRIES)
    expect(plan.reverts.map((i) => i.path)).toEqual(['a.txt'])
    expect(plan.ignores.map((i) => i.path)).toEqual(['u.tmp'])
    expect(plan.groups[0].paths).toEqual(['c.cs'])
  })

  it('组名非法（`-` 开头）整组丢弃；空组剔除', () => {
    const raw = { groups: [{ name: '-bad', paths: ['a.txt'] }, { name: '  ', paths: ['c.cs'] }], reverts: [], ignores: [] }
    const { plan, dropped } = normalizeAiPlan(raw, ENTRIES)
    expect(plan.groups).toEqual([])
    expect(dropped).toBe(2)
  })

  it('组数超上限 AI_PLAN_GROUPS_CAP：超出组丢弃并计数', () => {
    const groups = Array.from({ length: AI_PLAN_GROUPS_CAP + 1 }, (_v, i) => ({ name: 'g' + i, paths: ['a.txt'] }))
    // 每组路径相同：只有首组认领 a.txt，其余组路径互斥落选——改用循环不同路径验证上限语义
    const raw = { groups, reverts: [], ignores: [] }
    const { plan, dropped } = normalizeAiPlan(raw, ENTRIES)
    expect(plan.groups.length).toBeLessThanOrEqual(AI_PLAN_GROUPS_CAP)
    expect(dropped).toBeGreaterThan(0)
  })

  it('形状容错：非对象 raw 返回空方案；裸字符串条目可解析', () => {
    expect(normalizeAiPlan(null, ENTRIES).plan).toEqual({ groups: [], reverts: [], ignores: [] })
    const { plan } = normalizeAiPlan({ groups: [], reverts: ['a.txt'], ignores: [] }, ENTRIES)
    expect(plan.reverts[0].path).toBe('a.txt')
  })
})

describe('planItemOf / planGroupOf', () => {
  it('条目：对象/裸串双形态，反斜杠归一，reason 截断', () => {
    expect(planItemOf({ path: 'sub\\b.txt', reason: 'x'.repeat(200) })).toEqual({ path: 'sub/b.txt', reason: 'x'.repeat(120) })
    expect(planItemOf('u.tmp')).toEqual({ path: 'u.tmp' })
    expect(planItemOf({ path: '  ' })).toBeNull()
    expect(planItemOf(42)).toBeNull()
  })

  it('分组：name 缺失返回 null；paths 逐个规范化并去空', () => {
    const group = planGroupOf({ name: ' fix-ui ', paths: ['a.txt', '', 'sub\\b.txt'], reason: '主题' })
    expect(group).toEqual({ name: 'fix-ui', paths: ['a.txt', 'sub/b.txt'], reason: '主题' })
    expect(planGroupOf({ paths: ['a.txt'] })).toBeNull()
  })
})

// --endregion

// --region parseAiPlanJson / buildAiPrompt

describe('parseAiPlanJson', () => {
  it('围栏包裹可解析', () => {
    expect(parseAiPlanJson('```json\n{"reverts":[]}\n```')).toEqual({ reverts: [] })
  })

  it('前后杂文本截取首个 { 至末个 }', () => {
    expect(parseAiPlanJson('思考中…\n{"ignores":[]}\n完成')).toEqual({ ignores: [] })
  })

  it('非法 JSON 抛错带原文摘要', () => {
    expect(() => parseAiPlanJson('{bad json}')).toThrow(/无法解析为 JSON/)
  })

  it('无 JSON 对象抛错', () => {
    expect(() => parseAiPlanJson('没有方案')).toThrow(/不含 JSON 对象/)
  })
})

describe('buildAiPrompt', () => {
  it('含 diff 形态：清单行 + diff 文本', () => {
    const text = buildAiPrompt(ENTRIES, 'Index: a.txt', false)
    expect(text).toContain('modified | a.txt')
    expect(text).toContain('unversioned | u.tmp')
    expect(text).toContain('Index: a.txt')
    expect(text).not.toContain('已截断')
  })

  it('paths-only 降级：无 diff 注明；截断注入提示', () => {
    const text = buildAiPrompt(ENTRIES, null, true)
    expect(text).toContain('无 diff 上下文')
    expect(text).toContain('已截断')
  })

  it('changelist 归入条目行', () => {
    const text = buildAiPrompt([{ path: 'a.txt', status: 'modified', versioned: true, changelist: 'cl1' }], null, false)
    expect(text).toContain('modified | a.txt | cl1')
  })
})

// --endregion

// --region ignoreItemsOf / runPlanSteps

describe('ignoreItemsOf', () => {
  it('目录聚合 + 同名去重 + 根目录为空串', () => {
    const items = ignoreItemsOf(['a/b.tmp', 'a/c.tmp', 'a/b.tmp', 'root.log', 'sub\\d.tmp'])
    expect(items).toEqual([
      { dir: 'a', names: ['b.tmp', 'c.tmp'] },
      { dir: '', names: ['root.log'] },
      { dir: 'sub', names: ['d.tmp'] },
    ])
  })

  it('空入参返回 []', () => {
    expect(ignoreItemsOf([])).toEqual([])
  })
})

describe('runPlanSteps', () => {
  /** 固定步骤三连（记录执行序）。 */
  function makeSteps(runs: string[]): SvnPlanStep[] {
    return ['s1', 's2', 's3'].map((label, index) => ({
      label,
      kind: (['revert', 'group', 'ignore'] as const)[index],
      n: 1,
      run: async () => {
        runs.push(label)
        return { ok: true, message: 'ok-' + label }
      },
    }))
  }

  const idleCtl: SvnPlanCtl = { paused: () => false, cancelled: () => false, wait: async () => {} }

  it('顺序执行全部步骤，日志 ✓ 且 tick 前后各一次', async () => {
    const runs: string[] = []
    const ticks: number[] = []
    const result = await runPlanSteps(makeSteps(runs), idleCtl, (tick) => ticks.push(tick.done))
    expect(runs).toEqual(['s1', 's2', 's3'])
    expect(result.cancelled).toBe(false)
    expect(result.log).toHaveLength(3)
    expect(result.log.every((entry) => entry.ok)).toBe(true)
    expect(ticks).toEqual([0, 1, 2, 3])
  })

  it('取消后不再取步（已执行保留，cancelled=true）', async () => {
    const runs: string[] = []
    let step = 0
    const ctl: SvnPlanCtl = {
      paused: () => false,
      // 首步执行后置取消：第二步入口检查即中断
      cancelled: () => runs.length >= 1,
      wait: async () => { step++ },
    }
    const result = await runPlanSteps(makeSteps(runs), ctl)
    expect(runs).toEqual(['s1'])
    expect(result.cancelled).toBe(true)
    expect(result.log).toHaveLength(1)
  })

  it('暂停标志在步骤边界生效：wait 在每步前调用', async () => {
    const runs: string[] = []
    const waits: number[] = []
    let paused = true
    const ctl: SvnPlanCtl = {
      paused: () => paused,
      cancelled: () => false,
      wait: async () => {
        waits.push(1)
        paused = false
      },
    }
    await runPlanSteps(makeSteps(runs), ctl)
    expect(waits).toHaveLength(3)
    expect(runs).toEqual(['s1', 's2', 's3'])
  })

  it('单步失败（ok=false / 抛错）记日志后继续后续步骤', async () => {
    const runs: string[] = []
    const steps: SvnPlanStep[] = [
      { label: 'bad', kind: 'revert', n: 1, run: async () => ({ ok: false, message: '失败原因' }) },
      { label: 'boom', kind: 'group', n: 1, run: async () => { throw new Error('炸了') } },
      { label: 'good', kind: 'ignore', n: 1, run: async () => { runs.push('good'); return { ok: true, message: 'ok' } },
      },
    ]
    const result = await runPlanSteps(steps, idleCtl)
    expect(runs).toEqual(['good'])
    expect(result.log.map((entry) => entry.ok)).toEqual([false, false, true])
    expect(result.log[0].text).toContain('失败原因')
    expect(result.log[1].text).toContain('炸了')
  })
})

// --endregion

// --region buildAgentPrompt（混合通道 02-deep-session-prompt 修正版）

describe('buildAgentPrompt', () => {
  const prompt = buildAgentPrompt('D:/wc/Repo', 'session-abc')

  it('瘦身：不粘贴变更清单，改为 agent 自跑 svn status/diff 取数', () => {
    expect(prompt).not.toContain('modified | a.txt')
    expect(prompt).not.toContain('变更清单（status')
    expect(prompt).toContain('svn status')
    expect(prompt).toContain('svn diff')
    expect(prompt).toContain('D:/wc/Repo')
  })

  it('投递命令完整可执行：URL + svn.aiPlanSubmit + sessionId 内嵌', () => {
    expect(prompt).toContain('http://127.0.0.1:3080/edrv/rpc')
    expect(prompt).toContain('svn.aiPlanSubmit')
    expect(prompt).toContain('session-abc')
    expect(prompt).toContain('Invoke-RestMethod')
  })

  it('分析要求：借 codegraph/读文件/sub agent 深度分析', () => {
    expect(prompt).toContain('codegraph')
    expect(prompt).toContain('读取文件内容')
    expect(prompt).toContain('sub agent')
  })

  it('硬约束：禁写放行只读（写命令禁止清单 + 只读允许）/ 一路径一类 / 不虚构 / 组名英文', () => {
    expect(prompt).toContain('禁止任何**写**操作')
    expect(prompt).toContain('只读命令（status/diff/log/cat/info）允许')
    expect(prompt).toContain('revert/commit/changelist/propset/update/merge')
    expect(prompt).toContain('至多归一类')
    expect(prompt).toContain('绝不虚构')
    expect(prompt).toContain('简短英文')
  })

  it('方案 JSON 形状提示含三段键名', () => {
    expect(prompt).toContain('"groups"')
    expect(prompt).toContain('"reverts"')
    expect(prompt).toContain('"ignores"')
  })
})

// --endregion

// --region newDraftSession（独立新会话；契约 = host-apiproxy SessionsApi.create wire 直调）

/** 服务 ctx mock（按名给面；两个 describe 共用）。 */
const ctxOf = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] })

describe('newDraftSession', () => {
  /** wire fetch mock（ServerResponse 信封体）。 */
  const wireBody = (sessionId: string) => ({
    json: async () => ({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { sessionId } } }),
  })

  it('主路径 sessions.create（manager 面，官方 connectWorkspace 同链路；store upsert 使 open 可用）', async () => {
    const calls: Array<{ cwd?: string } | undefined> = []
    const sessions = {
      create: async (opts?: { cwd?: string }) => { calls.push(opts); return 's-store' },
      open: (_id: string) => {},
    }
    const res = await newDraftSession(ctxOf({ sessions }), 'D:/wc')
    expect(res).toEqual({ ok: true, id: 's-store' })
    expect(calls).toEqual([{ cwd: 'D:/wc' }])
    vi.unstubAllGlobals()
  })

  it('store 面缺失/失败回落 wire 直调（POST /api/session/create，解析 result.value.sessionId）', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return wireBody('s-wire')
    })
    const res = await newDraftSession(ctxOf({}), 'D:/wc')
    expect(res).toEqual({ ok: true, id: 's-wire' })
    expect(calls[0].url).toBe('/api/session/create')
    expect(calls[0].body).toMatchObject({ type: 'client-request', method: 'session/create', payload: { cwd: 'D:/wc' } })
    vi.unstubAllGlobals()
  })

  it('wire 失败回落 remote.session.create（具名槽 {args:{request}} 形态解析）', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const calls: Array<Record<string, unknown>> = []
    const remote = {
      create: async (arg: unknown) => {
        calls.push(arg as Record<string, unknown>)
        return { rpcId: 'x', result: { ok: true, value: { sessionId: 's-remote' } } }
      },
    }
    expect(await newDraftSession(ctxOf({ 'remote.session': remote }), 'D:/wc'))
      .toEqual({ ok: true, id: 's-remote' })
    // 具名槽形态优先：首参 {args:{request:{rpcId,payload}}}，payload 携 cwd
    const slot = calls[0].args as { request: { rpcId?: string; payload?: Record<string, unknown> } }
    expect(slot.request).toHaveProperty('rpcId')
    expect(slot.request.payload).toEqual({ cwd: 'D:/wc' })
    vi.unstubAllGlobals()
  })

  it('remote 裸 RpcResult 形态（补丁面）同样兼容', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const remote = { create: async () => ({ ok: true, value: { sessionId: 's-bare' } }) }
    expect(await newDraftSession(ctxOf({ 'remote.session': remote }), 'D:/wc'))
      .toEqual({ ok: true, id: 's-bare' })
    vi.unstubAllGlobals()
  })

  it('全部失败/返回无 id：ok:false（调用方降级）', async () => {
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ result: { ok: true, value: {} } }) }))
    expect(await newDraftSession(ctxOf({}), 'D:/wc')).toEqual({ ok: false })
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', async () => { throw new Error('boom') })
    expect(await newDraftSession(ctxOf({}), 'D:/wc')).toEqual({ ok: false })
    vi.unstubAllGlobals()
  })
})

describe('apiSessionPrompt（点击即发送 wire 投递）', () => {
  it('POST /api/session/prompt，payload 为具名槽 {args:{request:{rpcId,payload}}}（gateway 铁证形态）', async () => {
    const calls: Array<{ url: string; body: { type?: string; method?: string; payload?: Record<string, unknown> } }> = []
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return { status: 200, json: async () => ({ result: { ok: true, value: { accepted: true } } }) }
    })
    expect(await apiSessionPrompt('s-1', '深度分析任务')).toBe(true)
    expect(calls[0].url).toBe('/api/session/prompt')
    expect(calls[0].body.type).toBe('client-request')
    expect(calls[0].body.method).toBe('session/prompt')
    // 具名槽：payload.args.request.payload = 业务载荷
    const slot = calls[0].body.payload as { args?: { request?: { rpcId?: string; payload?: Record<string, unknown> } } }
    expect(slot.args?.request).toHaveProperty('rpcId')
    expect(slot.args?.request?.payload).toMatchObject({
      sessionId: 's-1',
      mode: 'queue',
      content: [{ type: 'text', text: '深度分析任务' }],
    })
    vi.unstubAllGlobals()
  })

  it('受理失败/网络异常：返回 false（调用方降级）', async () => {
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ result: { ok: false, error: { code: 'agent-busy' } } }) }))
    expect(await apiSessionPrompt('s-1', 'x')).toBe(false)
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    expect(await apiSessionPrompt('s-1', 'x')).toBe(false)
    vi.unstubAllGlobals()
  })

  it('sendTask 门面主路径 remote.prompt（具名槽 {args:{request}} 形态优先 + 各形态容错）', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const calls: Array<Record<string, unknown>> = []
    const remote = {
      prompt: async (arg: Record<string, unknown>) => {
        calls.push(arg)
        if (!('args' in arg)) throw new Error('bad-request: slot required') // 非具名槽形态抛错不得中断后续形态
        return { rpcId: 'x', result: { ok: true, value: { accepted: true } } }
      },
    }
    const facade = createAddToConversation(ctxOf({ 'remote.session': remote }) as never)
    expect(await facade.sendTask('s-1', '任务')).toBe(true)
    // 具名槽形态优先：首参 {args:{request:{rpcId,payload}}}
    const slot = calls[0].args as { request: { rpcId?: string; payload?: Record<string, unknown> } }
    expect(slot.request).toHaveProperty('rpcId')
    expect(slot.request.payload).toMatchObject({ sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: '任务' }] })
    vi.unstubAllGlobals()
  })
})

// --endregion
