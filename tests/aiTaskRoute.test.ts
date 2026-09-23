/**
 * AI 任务模型路由测试（plans/ai-task-model）：taskRouteOf 优先级回落矩阵。
 * 回落序：任务 provider/model 双非空直用 → routeOf（补全配置 → 自动首个）；
 * effort 同序：taskEffort → cfg.effort → 空串（不携带）。
 * 作者 ddj 2026-09-23
 */
import { describe, expect, it } from 'vitest'
import { routeOf, taskRouteOf } from '../src/ai/inline.js'
import type { LlmRuntimeLike } from '../src/ai/llmTypes.js'
import type { AiConfigView } from '../src/shared/ai.js'

/** llm mock（记录 listProviders/listModels 调用，验证是否走目录解析）。 */
function makeLlm(log: string[] = []): LlmRuntimeLike {
  return {
    listProviders: () => { log.push('providers'); return [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }] },
    listModels: async (provider: string) => {
      log.push('models:' + provider)
      return provider === 'p2' ? [{ provider: 'p2', id: 'm2', name: 'M2' }] : [{ provider: 'p1', id: 'm1', name: 'M1' }]
    },
    resolveModelInfo: async () => ({ provider: '', id: '', name: '' }),
    stream: () => { throw new Error('not used') },
  } as unknown as LlmRuntimeLike
}

/** 配置构造（缺省全空）。 */
function cfgOf(over: Partial<AiConfigView> = {}): AiConfigView {
  return { enabled: false, provider: '', model: '', effort: '', ...over }
}

describe('taskRouteOf', () => {
  it('任务 provider/model 双非空：直用任务模型（不查目录）', async () => {
    const log: string[] = []
    const route = await taskRouteOf(makeLlm(log), cfgOf({ taskProvider: 'p2', taskModel: 'm2' }))
    expect(route).toEqual({ provider: 'p2', model: 'm2', effort: '' })
    expect(log).toEqual([])
  })

  it('任务配置空：回落补全配置（provider/model 双非空直用）', async () => {
    const route = await taskRouteOf(makeLlm(), cfgOf({ provider: 'p1', model: 'm1' }))
    expect(route).toEqual({ provider: 'p1', model: 'm1', effort: '' })
  })

  it('双空：自动取目录首个 provider 首个模型', async () => {
    const route = await taskRouteOf(makeLlm(), cfgOf())
    expect(route).toEqual({ provider: 'p1', model: 'm1', effort: '' })
  })

  it('任务单侧非空（仅 taskProvider）：按 routeOf 语义回落（task 双非空才生效）', async () => {
    // taskProvider 非空但 taskModel 空 → 不构成任务路由，整体回落补全配置链
    const route = await taskRouteOf(makeLlm(), cfgOf({ taskProvider: 'p2' }))
    expect(route).toEqual({ provider: 'p1', model: 'm1', effort: '' })
  })

  it('effort 回落：taskEffort > cfg.effort > 空串', async () => {
    const both = await taskRouteOf(makeLlm(), cfgOf({ taskProvider: 'p2', taskModel: 'm2', taskEffort: 'high', effort: 'low' }))
    expect(both?.effort).toBe('high')
    const follow = await taskRouteOf(makeLlm(), cfgOf({ taskProvider: 'p2', taskModel: 'm2', effort: 'low' }))
    expect(follow?.effort).toBe('low')
    const empty = await taskRouteOf(makeLlm(), cfgOf({ taskProvider: 'p2', taskModel: 'm2' }))
    expect(empty?.effort).toBe('')
  })

  it('不可路由：目录为空时返回 null', async () => {
    const llm = { ...makeLlm(), listProviders: () => [] } as unknown as LlmRuntimeLike
    expect(await taskRouteOf(llm, cfgOf())).toBeNull()
  })
})

describe('routeOf（补全路径零变化守护）', () => {
  it('补全配置双非空直用；空则自动首个', async () => {
    expect(await routeOf(makeLlm(), cfgOf({ provider: 'p2', model: 'm2' }))).toEqual({ provider: 'p2', model: 'm2' })
    expect(await routeOf(makeLlm(), cfgOf())).toEqual({ provider: 'p1', model: 'm1' })
  })
})
