/** 附加目标 pid 决策测试。作者 ddj 2026年09月29号 */
import { describe, expect, it } from 'vitest'
import { resolvePidPlan } from '../src/client/dap/pidPick.js'
import type { DapProcessInfo } from '../src/shared/dap.js'

const unity: DapProcessInfo = { pid: 143460, title: 'IslandSplash_BugFix2 - Login - Unity', path: 'C:\\Unity.exe', name: 'Unity.exe' }
const buddy: DapProcessInfo = { pid: 128316, title: 'IslandSplash_BugFix2 - RankView.lua - CodeBuddy CN', path: 'D:\\CodeBuddy.exe', name: 'CodeBuddy CN.exe' }

describe('resolvePidPlan', () => {
  it('0 命中 → none + 文案', () => {
    const plan = resolvePidPlan([], 'IslandSplash_BugFix2')
    expect(plan.kind).toBe('none')
    expect(plan.kind === 'none' && plan.message).toContain('IslandSplash_BugFix2')
  })

  it('唯一命中 → auto pid', () => {
    const plan = resolvePidPlan([unity], 'IslandSplash_BugFix2')
    expect(plan).toEqual({ kind: 'auto', pid: 143460 })
  })

  it('多候选 → picker（Unity + CodeBuddy 同名标题场景）', () => {
    const plan = resolvePidPlan([buddy, unity], 'IslandSplash_BugFix2')
    expect(plan.kind).toBe('picker')
    expect(plan.kind === 'picker' && plan.items).toHaveLength(2)
  })
})
