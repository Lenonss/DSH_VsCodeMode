/**
 * lsp/memberScope.ts 单测 — 成员补全结果集的形态分类。
 *
 * 背景：`ECommon.` 这类成员位置偶尔被错答为外层作用域集（`this` 成员）或全局集
 * （含 `this`/`...` 与大量 `CS_*`）。本文件锁定分类边界，保证诊断日志不会把
 * 正常成员集误标成异常形态（否则取证结论会被日志本身污染）。
 * 作者 ddj 2026-09-24
 */
import { describe, expect, it } from 'vitest'
import { classifyMemberSet } from '../src/client/monaco/lsp/memberScope.js'

/** 真实 `ECommon.lua` 成员样本（正确形态）。 */
const ECOMMON_SAMPLE = ['ActivityId', 'ActivityTimePartStyle', 'ResId', 'SlidePlace', 'UserHeartState']

/** 2026-09-24 在 RechargeHeartView.lua 真实键盘复现到的 87 条错答样本开头。 */
const OUTER_SCOPE_SAMPLE = ['AddFrame', 'AddTimer', 'BuyHeart', 'Canvas', 'CanvasGroup', 'ClearAllTimers']

/** 全局集样本：`this` 标记 + xLua 绑定桩。 */
const GLOBALS_SAMPLE = ['this', 'CS_IslandSplash_Extensions_Common_ArrayExtension', 'CS_UnityEngine_Fake']

describe('classifyMemberSet', () => {
  it('空数组 → empty，计数为 0', () => {
    const out = classifyMemberSet([])
    expect(out.kind).toBe('empty')
    expect(out.total).toBe(0)
    expect(out.csCount).toBe(0)
    expect(out.csRatio).toBe(0)
  })

  it('非数组输入 → 按空处理（不抛错）', () => {
    expect(classifyMemberSet(null as never).kind).toBe('empty')
    expect(classifyMemberSet(undefined as never).total).toBe(0)
  })

  it('正常 ECommon 成员集 → member，不误报异常形态', () => {
    const out = classifyMemberSet(ECOMMON_SAMPLE.map((label) => ({ label })))
    expect(out.kind).toBe('member')
    expect(out.total).toBe(5)
    expect(out.csCount).toBe(0)
    expect(out.head).toEqual(['ActivityId', 'ActivityTimePartStyle', 'ResId'])
  })

  it('外层作用域集（this 成员特征名 ≥ 2）→ outerScope', () => {
    const out = classifyMemberSet(OUTER_SCOPE_SAMPLE.map((label) => ({ label })))
    expect(out.kind).toBe('outerScope')
    expect(out.total).toBe(6)
    expect(out.csCount).toBe(0)
  })

  it('含 this 标记 → globals', () => {
    const out = classifyMemberSet(GLOBALS_SAMPLE.map((label) => ({ label })))
    expect(out.kind).toBe('globals')
    expect(out.csCount).toBe(2)
  })

  it('含 ... 标记 → globals', () => {
    expect(classifyMemberSet([{ label: '...' }, { label: 'Foo' }]).kind).toBe('globals')
  })

  it('CS_* 占比过半（无 this/...）→ globals', () => {
    const items = ['CS_A', 'CS_B', 'CS_C', 'RealMember'].map((label) => ({ label }))
    expect(classifyMemberSet(items).kind).toBe('globals')
  })

  it('CS_* 占比恰好一半 → 不算 globals，归 other', () => {
    const items = ['CS_A', 'CS_B', 'Foo', 'Bar'].map((label) => ({ label }))
    const out = classifyMemberSet(items)
    expect(out.kind).toBe('other')
    expect(out.csRatio).toBe(0.5)
  })

  it('仅 1 个 this 特征名 → 不判 outerScope（避免误报）', () => {
    expect(classifyMemberSet([{ label: 'BuyHeart' }, { label: 'RealMember' }]).kind).toBe('member')
  })

  it('外层特征名与 CS_* 同现 → 仍归 globals（优先判全局）', () => {
    const items = ['BuyHeart', 'Canvas', 'CS_A', 'CS_B', 'CS_C', 'CS_D'].map((label) => ({ label }))
    expect(classifyMemberSet(items).kind).toBe('globals')
  })

  it('filterText 优先参与 CS_* 与标记判定', () => {
    const items = [{ label: '显示名', filterText: 'CS_Real_Stub' }, { label: 'x' }, { label: 'y' }]
    expect(classifyMemberSet(items).csCount).toBe(1)
  })

  it('大小写不敏感：This / cs_ 前缀', () => {
    expect(classifyMemberSet([{ label: 'This' }]).kind).toBe('globals')
    expect(classifyMemberSet([{ label: 'cs_a' }]).csCount).toBe(0)
  })

  it('headSize 可控，且不超过条目数', () => {
    const items = ['a', 'b'].map((label) => ({ label }))
    expect(classifyMemberSet(items, 10).head).toEqual(['a', 'b'])
    expect(classifyMemberSet(items, 0).head).toEqual([])
  })
})
