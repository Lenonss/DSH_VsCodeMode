// @ts-nocheck
/**
 * 统一 AI 任务层单测（22-agent-tools-and-commit）。
 * 守护：失败分类稳定（UNAVAILABLE/NO_MODEL/TIMEOUT/STREAM/PARSE/EMPTY），JSON 提取宽松。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import { parseJsonObject, runJsonTask } from '../src/ai/llmTask.js'

const cfg = { enabled: true, provider: '', model: '', effort: '', taskProvider: 'p', taskModel: 'm' }

/** 构造按 chunks 回放的假 llm。 */
function fakeLlm(chunks) {
  return {
    stream() {
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

function ctxOf(llm) {
  return { get: (name) => (name === 'llm' ? llm : null) }
}

const base = { system: 'sys', prompt: 'data', timeoutMs: 5000, maxTokens: 100 }

describe('parseJsonObject', () => {
  it('取首个 { 到末个 }，容忍围栏与解释文字', () => {
    expect(parseJsonObject('说明\n```json\n{"a":1}\n```\n结尾')).toEqual({ a: 1 })
  })
  it('无 JSON 时抛错', () => {
    expect(() => parseJsonObject('没有对象')).toThrow()
  })
})

describe('runJsonTask', () => {
  it('llm 缺失 → UNAVAILABLE', async () => {
    const out = await runJsonTask(ctxOf(null), cfg, base)
    expect(out.ok).toBe(false)
    expect(out.code).toBe('UNAVAILABLE')
  })

  it('正常回流 → ok 且带模型标识', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: '{"subject":' },
      { type: 'text-delta', text: '"fix: x"}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const out = await runJsonTask(ctxOf(llm), cfg, base)
    expect(out.ok).toBe(true)
    expect(out.raw).toEqual({ subject: 'fix: x' })
    expect(out.model).toBe('p/m')
  })

  it('流失败 → STREAM；空输出 → EMPTY；非 JSON → PARSE', async () => {
    const streamFail = await runJsonTask(ctxOf(fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'E_X', message: 'boom' } } }])), cfg, base)
    expect(streamFail.code).toBe('STREAM')
    const empty = await runJsonTask(ctxOf(fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])), cfg, base)
    expect(empty.code).toBe('EMPTY')
    const bad = await runJsonTask(ctxOf(fakeLlm([{ type: 'text-delta', text: '不是 JSON' }, { type: 'finish', reason: { kind: 'stop' } }])), cfg, base)
    expect(bad.code).toBe('PARSE')
  })

  it('provider 未注册 → NO_MODEL 且给可操作提示', async () => {
    const llm = fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter registered for provider "huoshan"' } } }])
    const out = await runJsonTask(ctxOf(llm), cfg, base)
    expect(out.ok).toBe(false)
    expect(out.code).toBe('NO_MODEL')
    expect(out.error).toContain('未注册')
    expect(out.error).toContain('p/m')
  })
})
