/** Session-bound plan submission regressions. @author ddj 2026年09月28号 */
import { describe, expect, it, vi } from 'vitest'
import { planToolOptions } from '../src/svnPlanTool.js'

describe('svn_plan_submit', () => {
  it('derives the target session from execution, ignoring fabricated request ownership', async () => {
    const submit = vi.fn(async () => ({ ok: true as const, accepted: 1, dropped: 0 }))
    const tool = planToolOptions(submit)
    const plan = { groups: [{ name: 'fix', paths: ['a.ts'] }], reverts: [], ignores: [] }
    const supplied = { plan, sessionId: 'foreign' }
    await tool.execute(supplied, { agent: { session: { id: 'owner' } } })
    expect(submit).toHaveBeenCalledWith({ sessionId: 'owner', plan })
    expect(Object.keys(tool.parameters)).toEqual(['plan'])
  })
  it('rejects missing sessions and cancellation without touching the inbox', async () => {
    const submit = vi.fn(async () => ({ ok: true as const, accepted: 1, dropped: 0 }))
    const tool = planToolOptions(submit)
    await expect(tool.execute({ plan: {} }, {})).resolves.toMatchObject({ ok: false })
    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute({ plan: {} }, { agent: { session: { id: 'owner' } }, signal: controller.signal })).resolves.toMatchObject({ ok: false })
    expect(submit).not.toHaveBeenCalled()
  })
  it('preserves existing validation failures and renders the result', async () => {
    const result = { ok: false as const, error: 'no allowed paths' }
    const tool = planToolOptions(async () => result)
    expect(await tool.execute({ plan: {} }, { agent: { session: { id: 'owner' } } })).toEqual(result)
    expect(tool.output.render({ plan: {} }, result)).toEqual([{ type: 'text', text: JSON.stringify(result) }])
  })
})
