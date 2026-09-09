/**
 * dsh-vscode-mode — AI 内联补全自足校验（node:test，无 vite/vitest 依赖）。
 * 背景：本机沙箱禁 spawn，vitest 的 esbuild/fork 路径无法启动；
 * 此脚本用 node 原生 test runner 覆盖 tests/aiInline.test.ts 的同一断言集。
 * 作者 ddj
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_PREFIX_MAX, AI_SUFFIX_MAX, buildInlinePrompt, cleanInlineText, inlineWorth, trimInlineWindow,
  type AiInlineRequest,
} from '../src/shared/ai.ts'
import { aiInlineComplete, aiModels, resetAiDirCache, type AiInlineDeps } from '../src/ai/inline.ts'

test('trimInlineWindow：前缀保尾、后缀保头', () => {
  const pre = 'a'.repeat(AI_PREFIX_MAX + 100)
  const suf = 'b'.repeat(AI_SUFFIX_MAX + 100)
  const out = trimInlineWindow(pre, suf)
  assert.equal(out.prefix.length, AI_PREFIX_MAX)
  assert.ok(out.prefix.endsWith('a'.repeat(10)))
  assert.equal(out.suffix.length, AI_SUFFIX_MAX)
  assert.ok(out.suffix.startsWith('b'.repeat(10)))
})

test('inlineWorth：短前缀/纯空白不请求；尾空白（赋值形态）放行', () => {
  assert.equal(inlineWorth(''), false)
  assert.equal(inlineWorth('abc'), false)
  assert.equal(inlineWorth('   \n  '), false)
  assert.equal(inlineWorth('local x = '), true) // `= ` 后停顿是最自然触发（debug H4 修复）
  assert.equal(inlineWorth('local x = 1'), true)
})

test('cleanInlineText：剥围栏/剥 CURSOR 复述/截行数/去空行', () => {
  assert.equal(cleanInlineText('```lua\nprint(1)\nprint(2)\n```', ''), 'print(1)\nprint(2)')
  assert.equal(cleanInlineText('前缀<CURSOR>插入内容', '前缀开头文本'), '插入内容')
  assert.equal(cleanInlineText('a\nb\nc\nd', ''), 'a\nb\nc')
  assert.equal(cleanInlineText('\n\n x \n\n', ''), ' x') // 首行前导空格保留（续行缩进有语义）
  assert.equal(cleanInlineText('', ''), '')
})

test('cleanInlineText：剥前缀尾片段复述', () => {
  const prefix = 'local t = {}'
  assert.equal(cleanInlineText('local t = {} -- 注释', prefix), ' -- 注释')
})

test('buildInlinePrompt：含文件名与 CURSOR 标记', () => {
  const req: AiInlineRequest = { path: 'a/b.lua', prefix: 'x = ', suffix: 'y' }
  const prompt = buildInlinePrompt(req)
  assert.ok(prompt.includes('b.lua'))
  assert.ok(prompt.includes('x = <CURSOR>y'))
})

function fakeLlm(script, opts = {}) {
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

function depsOf(llm, cfg = {}) {
  return {
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    config: { get: () => ({ enabled: cfg.enabled ?? true, provider: cfg.provider ?? '', model: cfg.model ?? '', effort: cfg.effort ?? '' }) },
  }
}

test('流汇聚：text-delta 收、reasoning-delta 不收', async () => {
  const llm = fakeLlm([
    { type: 'reasoning-delta', text: 'thinking...' },
    { type: 'text-delta', text: 'print(' },
    { type: 'text-delta', text: '1)' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const out = await aiInlineComplete(depsOf(llm), { path: 'a.lua', prefix: 'local x = ', suffix: '' })
  assert.equal(out.text, 'print(1)')
})

test('未开启 → 空结果', async () => {
  const llm = fakeLlm([{ type: 'text-delta', text: 'x' }])
  const out = await aiInlineComplete(depsOf(llm, { enabled: false }), { path: 'a.lua', prefix: 'local x', suffix: '' })
  assert.equal(out.text, '')
})

test('llm 缺失 → 诊断 note', async () => {
  const out = await aiInlineComplete(depsOf(null), { path: 'a.lua', prefix: 'local x', suffix: '' })
  assert.equal(out.text, '')
  assert.ok(out.note.includes('llm'))
})

test('流错误 → 诊断 note 不抛出', async () => {
  const llm = fakeLlm([], { fail: true })
  const out = await aiInlineComplete(depsOf(llm), { path: 'a.lua', prefix: 'local x', suffix: '' })
  assert.equal(out.text, '')
  assert.ok(out.note.includes('boom'))
})

test('复述输出 → 空结果', async () => {
  const llm = fakeLlm([{ type: 'text-delta', text: 'local x = ' }, { type: 'finish', reason: { kind: 'stop' } }])
  const out = await aiInlineComplete(depsOf(llm), { path: 'a.lua', prefix: 'local x = ', suffix: '' })
  assert.equal(out.text, '')
})

test('用户配置路由优先（含 effort 透传）', async () => {
  let captured = null
  const llm = fakeLlm([{ type: 'text-delta', text: 'y' }])
  llm.stream = (options) => { captured = options; return fakeLlm([{ type: 'text-delta', text: 'y' }]).stream() }
  const out = await aiInlineComplete(depsOf(llm, { provider: 'px', model: 'mx', effort: 'low' }), { path: 'a.lua', prefix: 'local x = 1', suffix: '' })
  assert.equal(out.text, 'y')
  assert.equal(captured.provider, 'px')
  assert.equal(captured.reasoningEffort, 'low')
})

test('空 effort → 请求不带 reasoningEffort', async () => {
  let captured = null
  const llm = fakeLlm([{ type: 'text-delta', text: 'y' }])
  llm.stream = (options) => { captured = options; return fakeLlm([{ type: 'text-delta', text: 'y' }]).stream() }
  await aiInlineComplete(depsOf(llm), { path: 'a.lua', prefix: 'local x = 1', suffix: '' })
  assert.equal(captured.reasoningEffort, undefined)
})

test('目录聚合 + 缓存 + 强制刷新', async () => {
  resetAiDirCache()
  let calls = 0
  const llm = {
    listProviders: () => { calls += 1; return [{ id: 'p1', name: 'P1' }] },
    listModels: async () => [{ provider: 'p1', id: 'm1', name: 'M1' }, { provider: 'p1', id: 'm2', name: 'M2' }],
    resolveModelInfo: async (_p, m) => m === 'm1'
      ? { provider: 'p1', id: m, name: m, reasoning: { efforts: [{ id: 'off', name: '关' }, { id: 'high', name: '高' }], defaultEffort: 'off' } }
      : { provider: 'p1', id: m, name: m },
    stream: async function * () {},
  }
  const ctx = { get: () => llm }
  const first = await aiModels(ctx)
  assert.equal(first.providers[0].models[0].efforts.length, 2)
  assert.equal(first.providers[0].models[0].defaultEffort, 'off')
  assert.equal(first.providers[0].models[1].efforts.length, 0)
  await aiModels(ctx)
  assert.equal(calls, 1)
  const forced = await aiModels(ctx, true)
  assert.equal(forced.providers.length, 1)
  assert.equal(calls, 2)
})

test('单模型 resolve 失败降级为无档位条目', async () => {
  resetAiDirCache()
  const llm = {
    listProviders: () => [{ id: 'p1', name: 'P1' }],
    listModels: async () => [{ provider: 'p1', id: 'bad', name: 'Bad' }],
    resolveModelInfo: async () => { throw new Error('nope') },
    stream: async function * () {},
  }
  const view = await aiModels({ get: () => llm })
  assert.deepEqual(view.providers[0].models[0].efforts, [])
})

test('llm 缺失 → 空目录 + note', async () => {
  resetAiDirCache()
  const view = await aiModels({ get: () => null })
  assert.deepEqual(view.providers, [])
  assert.ok(view.note.includes('llm'))
})
