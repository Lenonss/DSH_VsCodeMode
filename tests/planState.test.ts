import { afterEach, describe, expect, it } from 'vitest'
import { cachedPlan, clearPlanState, createPlanFeed, isPlanAddress, isPlanPath, planCallIdOf, planDocument, planFromEntries, rememberPlan, type PlanEntry, type PlanWindow } from '../src/client/planState.js'
afterEach(clearPlanState)
/** @private @author ddj 2026年10月08号 @param seq Sequence. @param type Event kind. @param data Payload. @returns Durable event entry. */
function entry(seq: number, type: string, data: unknown): PlanEntry { return { type: 'event', event: { type, seq, data } } }
/** @private @author ddj 2026年10月08号 @param revision Revision. @param entries Delta. @param kind Mutation. @returns Event window fixture. */
function windowOf(revision: number, entries: PlanEntry[], kind = 'append'): PlanWindow { return { revision, entries, change: { kind, entries } } }
/** @private @author ddj 2026年10月08号 @param seq Sequence. @param id Tool id. @param path Target. @param content Text. @returns Write call. */
function write(seq: number, id: string, path = 'plans/a.md', content = '# Plan'): PlanEntry {
  return entry(seq, 'tool/call', { callId: id, name: 'write', arguments: JSON.stringify({ file_path: path, content }) })
}
/** @private @author ddj 2026年10月08号 @param seq Sequence. @param id Call id. @param isError Failure. @returns Completed write. */
function result(seq: number, id: string, isError = false): PlanEntry { return entry(seq, 'tool/result', { message: { toolCallId: id, isError } }) }

describe('plan identities', () => {
  it('recognizes workspace and DSH plans, not arbitrary Markdown or similarly named directories', () => {
    expect(isPlanPath('plans/feature/00.md', '/work')).toBe(true)
    expect(isPlanPath('/work/plans/00.markdown', '/work')).toBe(true)
    expect(isPlanPath('C:\\WORK\\plans\\a.md', 'c:/work')).toBe(true)
    expect(isPlanPath('/home/u/.dsh/plans/a.md', '/work')).toBe(true)
    for (const path of ['README.md', 'plans/a.ts', '/other/plans/a.md', '/work/plans2/a.md', '/WORK/plans/a.md']) expect(isPlanPath(path, '/work')).toBe(false)
  })
  it('validates encoded session, review and subagent identities', () => {
    for (const address of ['dsh-resource://plan/s/c', 'dsh-resource://plan-review/s/window%3A1', 'dsh-resource://plan/subagent/p/c/continuable/t']) expect(isPlanAddress(address)).toBe(true)
    for (const address of ['dsh-resource://plan/s', 'dsh-resource://plan/s/c/extra', 'dsh-resource://plan/s/%ZZ', 'dsh-resource://plan/s/%2F', '/plans/a.md']) expect(isPlanAddress(address)).toBe(false)
  })
  it('requires a complete Markdown heading and never invents a disk path', () => {
    expect(planDocument('dsh-resource://plan/s/c', { markdown: '# 实施计划\n内容' })).toEqual({ address: 'dsh-resource://plan/s/c', markdown: '# 实施计划\n内容', title: '实施计划' })
    // HTML 计划页标记：命中时文档携带 htmlPath（计划页签切到 iframe 渲染）。
    expect(planDocument('dsh-resource://plan/s/c', { markdown: '# 实施计划\nHTML 计划页：plans/a/plan.packed.html' })).toEqual({
      address: 'dsh-resource://plan/s/c',
      markdown: '# 实施计划\nHTML 计划页：plans/a/plan.packed.html',
      title: '实施计划',
      htmlPath: 'plans/a/plan.packed.html',
    })
    expect(planDocument('dsh-resource://plan/s/c', { markdown: 'partial' })).toBeUndefined()
  })
})

describe('live-only plan feed', () => {
  it('opens only after successful write completion and deduplicates seq and call IDs', () => {
    const feed = createPlanFeed('s', '/work')
    expect(feed.consume(windowOf(0, [], 'replace'))).toEqual([])
    expect(feed.consume(windowOf(1, [write(1, 'a')]))).toEqual([])
    expect(feed.consume(windowOf(2, [result(2, 'a')]))).toEqual([{ path: 'plans/a.md' }])
    expect(feed.consume(windowOf(2, [result(2, 'a')]))).toEqual([])
    expect(feed.consume(windowOf(3, [write(1, 'a'), result(2, 'a')]))).toEqual([])
    expect(feed.consume(windowOf(4, [write(3, 'a'), result(4, 'a')]))).toEqual([])
  })
  it('does not open failed or ordinary writes or calls lacking a successful result', () => {
    const feed = createPlanFeed('s', '/work')
    feed.consume(windowOf(0, [], 'replace'))
    expect(feed.consume(windowOf(1, [write(1, 'fail'), result(2, 'fail', true), write(3, 'readme', 'README.md'), result(4, 'readme')]))).toEqual([])
  })
  it('baselines hydration, reconnect and pagination, while retaining an in-flight call for its live result', () => {
    const feed = createPlanFeed('s', '/work')
    expect(feed.consume(windowOf(0, [write(1, 'old'), result(2, 'old'), write(3, 'running')], 'replace'))).toEqual([])
    expect(feed.consume(windowOf(1, [write(0, 'older'), result(0, 'older')], 'prepend'))).toEqual([])
    expect(feed.consume(windowOf(2, [result(4, 'running')]))).toEqual([{ path: 'plans/a.md' }])
    expect(feed.consume(windowOf(3, [write(5, 'reconnect'), result(6, 'reconnect')], 'replace'))).toEqual([])
    expect(feed.consume(windowOf(4, [result(7, 'reconnect')]))).toEqual([])
  })
  it('handles nested PTC settled writes, rejects errors, and preserves explicit associations by session', () => {
    const feed = createPlanFeed('s', '/work')
    feed.consume(windowOf(0, [], 'replace'))
    const ptc = (seq: number, id: string, isError: boolean) => entry(seq, 'tool/ptc-dispatch', { subCallId: id, name: 'write', arguments: { file_path: 'notes/plan.md', content: '# 计划：接入' }, isError })
    expect(feed.consume(windowOf(1, [ptc(1, 'failed', true)]))).toEqual([])
    expect(isPlanPath('notes/plan.md', '/work', 's')).toBe(false)
    expect(feed.consume(windowOf(2, [ptc(2, 'ok', false)]))).toEqual([{ path: 'notes/plan.md' }])
    expect(isPlanPath('notes/plan.md', '/work', 's')).toBe(true)
    expect(isPlanPath('notes/plan.md', '/work', 'other')).toBe(false)
  })
  it('opens a complete plan submission without waiting for human approval; no result replay', () => {
    const feed = createPlanFeed('s', '/work')
    feed.consume(windowOf(0, [], 'replace'))
    const submission = entry(1, 'tool/call', { callId: 'plan', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 执行计划\n步骤' }) })
    expect(feed.consume(windowOf(1, [submission]))).toEqual([{ plan: { address: 'dsh-resource://plan/s/plan', markdown: '# 执行计划\n步骤', title: '执行计划' } }])
    expect(feed.consume(windowOf(2, [result(2, 'plan')]))).toEqual([])
  })
})

describe('plan document cache', () => {
  it('remembers live submissions so a later click reuses them', () => {
    const feed = createPlanFeed('s', '/work')
    feed.consume(windowOf(0, [], 'replace'))
    feed.consume(windowOf(1, [entry(1, 'tool/call', { callId: 'plan', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 执行计划\n步骤' }) })]))
    expect(cachedPlan('dsh-resource://plan/s/plan')).toEqual({ address: 'dsh-resource://plan/s/plan', markdown: '# 执行计划\n步骤', title: '执行计划' })
    expect(cachedPlan('dsh-resource://plan/s/other')).toBeUndefined()
    clearPlanState()
    expect(cachedPlan('dsh-resource://plan/s/plan')).toBeUndefined()
  })
  it('ignores identities and payloads that are not complete plan documents', () => {
    rememberPlan({ address: 'dsh-resource://plan/s/%ZZ', markdown: '# 计划', title: '计划' })
    rememberPlan({ address: 'dsh-resource://plan/s/c', markdown: 'partial', title: 'partial' })
    expect(cachedPlan('dsh-resource://plan/s/%ZZ')).toBeUndefined()
    expect(cachedPlan('dsh-resource://plan/s/c')).toBeUndefined()
  })
})

describe('HTML 计划模式提交', () => {
  it('exit_html_plan_mode 打开计划页签并带 htmlPlanMode', () => {
    const feed = createPlanFeed('s', '/work')
    feed.consume(windowOf(0, [], 'replace'))
    const submission = entry(1, 'tool/call', { callId: 'hp', name: 'exit_html_plan_mode', arguments: JSON.stringify({ plan: '# 执行计划\n步骤' }) })
    expect(feed.consume(windowOf(1, [submission]))).toEqual([{ plan: {
      address: 'dsh-resource://plan/s/hp',
      markdown: '# 执行计划\n步骤',
      title: '执行计划',
      htmlPlanMode: true,
    } }])
    expect(cachedPlan('dsh-resource://plan/s/hp')).toMatchObject({ htmlPlanMode: true })
  })

  it('planDocument 保留 htmlPlanMode；官方 exit_plan_mode 提交不带该字段', () => {
    expect(planDocument('dsh-resource://plan/s/c', { markdown: '# 计划', htmlPlanMode: true })).toEqual({
      address: 'dsh-resource://plan/s/c', markdown: '# 计划', title: '计划', htmlPlanMode: true,
    })
    expect(planDocument('dsh-resource://plan/s/c', { markdown: '# 计划' })).toEqual({
      address: 'dsh-resource://plan/s/c', markdown: '# 计划', title: '计划',
    })
  })
})

describe('planFromEntries / planCallIdOf', () => {
  it('从会话窗口里按 callId 找回 HTML 计划模式提交的计划', () => {
    const address = 'dsh-resource://plan/s/hp1'
    expect(planCallIdOf(address)).toBe('hp1')
    expect(planCallIdOf('dsh-resource://plan-review/s/x')).toBe('x')
    expect(planCallIdOf('not-an-address')).toBeNull()

    const entries = [entry(1, 'tool/call', { callId: 'hp1', name: 'exit_html_plan_mode', arguments: JSON.stringify({ plan: '# 计划：x\n正文' }) })]
    expect(planFromEntries('s', address, entries)).toMatchObject({ markdown: '# 计划：x\n正文', htmlPlanMode: true })

    const official = [entry(2, 'tool/call', { callId: 'hp1', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 计划：y' }) })]
    const parsed = planFromEntries('s', address, official)
    expect(parsed).toMatchObject({ markdown: '# 计划：y' })
    expect(parsed && 'htmlPlanMode' in parsed).toBe(false)
  })

  it('callId 不匹配、工具不认识或正文缺标题时返回 undefined', () => {
    const address = 'dsh-resource://plan/s/hp1'
    expect(planFromEntries('s', address, [entry(1, 'tool/call', { callId: 'other', name: 'exit_html_plan_mode', arguments: '{"plan":"# x"}' })])).toBeUndefined()
    expect(planFromEntries('s', address, [entry(1, 'tool/call', { callId: 'hp1', name: 'write', arguments: '{"plan":"# x"}' })])).toBeUndefined()
    expect(planFromEntries('s', address, [entry(1, 'tool/call', { callId: 'hp1', name: 'exit_html_plan_mode', arguments: '{"plan":"no heading"}' })])).toBeUndefined()
    expect(planFromEntries('s', address, [])).toBeUndefined()
  })
})
