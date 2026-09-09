/**
 * dsh-vscode-mode tests — AI 内联补全：窗口裁剪 / prompt 拼装 / 输出清理 /
 * 流汇聚（aiInlineComplete：正常/早停/超时/错误/未开启/llm 缺失/自动路由）。
 * 作者 ddj
 */
import { describe, it, expect } from 'vitest'
import {
  AI_PREFIX_MAX, AI_SUFFIX_MAX, buildInlinePrompt, cleanInlineText, inlineWorth, trimInlineWindow,
  type AiInlineRequest,
} from '../src/shared/ai.js'
import { aiInlineComplete, aiModels, resetAiDirCache, type AiInlineDeps } from '../src/ai/inline.js'

describe('shared/ai 窗口与门槛', () => {
  it('trimInlineWindow：前缀保尾、后缀保头', () => {
    const pre = 'a'.repeat(AI_PREFIX_MAX + 100)
    const suf = 'b'.repeat(AI_SUFFIX_MAX + 100)
    const out = trimInlineWindow(pre, suf)
    expect(out.prefix.length).toBe(AI_PREFIX_MAX)
    expect(out.prefix.endsWith('a'.repeat(10))).toBe(true)
    expect(out.suffix.length).toBe(AI_SUFFIX_MAX)
    expect(out.suffix.startsWith('b'.repeat(10))).toBe(true)
  })

  it('inlineWorth：短前缀/纯空白不请求；尾空白（赋值形态）放行', () => {
    expect(inlineWorth('')).toBe(false)
    expect(inlineWorth('abc')).toBe(false)
    expect(inlineWorth('   \n  ')).toBe(false)
    expect(inlineWorth('local x = ')).toBe(true) // `= ` 后停顿是最自然触发（debug H4 修复）
    expect(inlineWorth('local x = 1')).toBe(true)
  })

  it('cleanInlineText：剥围栏/剥 CURSOR 复述/截行数/去空行', () => {
    expect(cleanInlineText('```lua\nprint(1)\nprint(2)\n```', '')).toBe('print(1)\nprint(2)')
    expect(cleanInlineText('前缀<CURSOR>插入内容', '前缀开头文本')).toBe('插入内容')
    expect(cleanInlineText('a\nb\nc\nd', '')).toBe('a\nb\nc')
    expect(cleanInlineText('\n\n x \n\n', '')).toBe(' x') // 首行前导空格保留（续行缩进有语义）
    expect(cleanInlineText('', '')).toBe('')
  })

  it('cleanInlineText：剥前缀尾片段复述', () => {
    const prefix = 'local t = {}'
    expect(cleanInlineText('local t = {} -- 注释', prefix)).toBe(' -- 注释')
  })

  it('buildInlinePrompt：含文件名与 CURSOR 标记', () => {
    const req: AiInlineRequest = { path: 'a/b.lua', prefix: 'x = ', suffix: 'y' }
    const prompt = buildInlinePrompt(req)
    expect(prompt).toContain('b.lua')
    expect(prompt).toContain('x = <CURSOR>y')
  })
})

/** fake llm 流：按脚本吐块。 */
function fakeLlm(script: Array<{ type: string; text?: string; kind?: string }>, opts: { fail?: boolean } = {}) {
  return {
    listProviders: () => [{ id: 'p1', name: 'P1' }],
    listModels: async () => [{ provider: 'p1', id: 'm1', name: 'M1' }],
    resolveModelInfo: async () => ({ provider: 'p1', id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'off', name: '关' }], defaultEffort: 'off' } }),
    stream: opts.fail
      ? () => ({ async *[Symbol.asyncIterator]() { throw new Error('boom') } })
      : async function * () {
        for (const c of script) yield c
      },
  }
}

function depsOf(llm: unknown, cfg: { enabled?: boolean; provider?: string; model?: string; effort?: string } = {}): AiInlineDeps {
  return {
    ctx: { get: (name: string) => (name === 'llm' ? llm : undefined) },
    config: { get: () => ({ enabled: cfg.enabled ?? true, provider: cfg.provider ?? '', model: cfg.model ?? '', effort: cfg.effort ?? '' }) },
  }
}

describe('ai/inline 流汇聚', () => {
  it('text-delta 汇聚 + reasoning-delta 不进补全', async () => {
    const llm = fakeLlm([
      { type: 'reasoning-delta', text: 'thinking...' },
      { type: 'text-delta', text: 'print(' },
      { type: 'text-delta', text: '1)' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const out = await aiInlineComplete(depsOf(llm), { path: 'a.lua', prefix: 'local x = ', suffix: '' })
    expect(out.text).toBe('print(1)')
  })

  it('未开启 → 空结果且不发请求', async () => {
    const llm = fakeLlm([{ type: 'text-delta', text: 'x' }])
    const out = await aiInlineComplete(depsOf(llm, { enabled: false }), { path: 'a.lua', prefix: 'local x', suffix: '' })
    expect(out.text).toBe('')
  })

  it('llm 缺失 → 诊断 note', async () => {
    const out = await aiInlineComplete(depsOf(null), { path: 'a.lua', prefix: 'local x', suffix: '' })
    expect(out.text).toBe('')
    expect(out.note).toContain('llm')
  })

  it('流错误 → 诊断 note 不抛出', async () => {
    const llm = fakeLlm([], { fail: true })
    const out = await aiInlineComplete(depsOf(llm), { path: 'a.lua', prefix: 'local x', suffix: '' })
    expect(out.text).toBe('')
    expect(out.note).toContain('boom')
  })

  it('模型输出为复述/空 → 空结果', async () => {
    const llm = fakeLlm([{ type: 'text-delta', text: 'local x = ' }, { type: 'finish', reason: { kind: 'stop' } }])
    const out = await aiInlineComplete(depsOf(llm), { path: 'a.lua', prefix: 'local x = ', suffix: '' })
    expect(out.text).toBe('')
  })

  it('用户配置路由优先（含 effort 透传）', async () => {
    let captured: unknown = null
    const llm = fakeLlm([{ type: 'text-delta', text: 'y' }])
    llm.stream = (options: unknown) => { captured = options; return fakeLlm([{ type: 'text-delta', text: 'y' }]).stream() }
    const out = await aiInlineComplete(depsOf(llm, { provider: 'px', model: 'mx', effort: 'low' }), { path: 'a.lua', prefix: 'local x = 1', suffix: '' })
    expect(out.text).toBe('y')
    expect((captured as { provider: string; model: string; reasoningEffort?: string }).provider).toBe('px')
    expect((captured as { reasoningEffort?: string }).reasoningEffort).toBe('low')
  })

  it('空 effort → 请求不带 reasoningEffort', async () => {
    let captured: unknown = null
    const llm = fakeLlm([{ type: 'text-delta', text: 'y' }])
    llm.stream = (options: unknown) => { captured = options; return fakeLlm([{ type: 'text-delta', text: 'y' }]).stream() }
    await aiInlineComplete(depsOf(llm), { path: 'a.lua', prefix: 'local x = 1', suffix: '' })
    expect((captured as { reasoningEffort?: string }).reasoningEffort).toBeUndefined()
  })
})

describe('ai/inline 模型目录', () => {
  it('目录聚合 provider/model/档位（缓存命中）', async () => {
    resetAiDirCache()
    let calls = 0
    const llm = {
      listProviders: () => { calls += 1; return [{ id: 'p1', name: 'P1' }] },
      listModels: async () => [{ provider: 'p1', id: 'm1', name: 'M1' }, { provider: 'p1', id: 'm2', name: 'M2' }],
      resolveModelInfo: async (_p: string, m: string) => m === 'm1'
        ? { provider: 'p1', id: m, name: m, reasoning: { efforts: [{ id: 'off', name: '关' }, { id: 'high', name: '高' }], defaultEffort: 'off' } }
        : { provider: 'p1', id: m, name: m },
      stream: async function * () {},
    }
    const ctx = { get: () => llm }
    const first = await aiModels(ctx)
    expect(first.providers[0].models[0].efforts.length).toBe(2)
    expect(first.providers[0].models[0].defaultEffort).toBe('off')
    expect(first.providers[0].models[1].efforts.length).toBe(0)
    await aiModels(ctx)
    expect(calls).toBe(1) // 缓存命中：provider 枚举只跑一次
    const forced = await aiModels(ctx, true)
    expect(forced.providers.length).toBe(1)
    expect(calls).toBe(2)
  })

  it('单模型 resolve 失败降级为无档位条目', async () => {
    resetAiDirCache()
    const llm = {
      listProviders: () => [{ id: 'p1', name: 'P1' }],
      listModels: async () => [{ provider: 'p1', id: 'bad', name: 'Bad' }],
      resolveModelInfo: async () => { throw new Error('nope') },
      stream: async function * () {},
    }
    const view = await aiModels({ get: () => llm })
    expect(view.providers[0].models[0].efforts).toEqual([])
  })

  it('llm 缺失 → 空目录 + note', async () => {
    resetAiDirCache()
    const view = await aiModels({ get: () => null })
    expect(view.providers).toEqual([])
    expect(view.note).toContain('llm')
  })
})
