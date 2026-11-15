/**
 * 模板语言规则的结构校验（不需要浏览器/Monaco 运行时）。
 *
 * 校验目标：每个模板语言都有 id/扩展名/别名/根状态，规则里引用的状态真实存在，
 * 分隔符内代码状态可达；注册函数幂等且只用公开的 Monaco languages API。
 *
 * @author ddj 2026年11月15号
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TEMPLATE_LANGUAGE_IDS,
  TEMPLATE_SPECS,
  configurationOf,
  isTemplateLang,
  registerTemplates,
  resetTemplates,
} from '../src/client/monaco/templateLanguages.js'

/** 递归收集规则里引用的 @state（排除 @pop）。 */
function referencedStates(rules: unknown[], into: Set<string> = new Set()): Set<string> {
  for (const rule of rules) {
    if (!Array.isArray(rule)) continue
    const target = rule[2]
    if (typeof target === 'string' && target.startsWith('@') && target !== '@pop') into.add(target.slice(1))
    if (Array.isArray(rule[1]) && Array.isArray(rule[1][0])) referencedStates(rule[1] as unknown[], into)
  }
  return into
}

/** 造一个只记录调用的最小 Monaco 门面。 */
function fakeMonaco() {
  const registrations: string[] = []
  return {
    registrations,
    monaco: {
      languages: {
        register: vi.fn((description: { id: string }) => { registrations.push(description.id) }),
        setMonarchTokensProvider: vi.fn(),
        setLanguageConfiguration: vi.fn(),
      },
    },
  }
}

beforeEach(() => {
  resetTemplates()
})

describe('模板语言规则', () => {
  it('id 清单与规则一致且无重复', () => {
    const ids = TEMPLATE_SPECS.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual([...TEMPLATE_LANGUAGE_IDS].sort())
  })

  it('每个语言都有扩展名、别名与根状态', () => {
    for (const spec of TEMPLATE_SPECS) {
      expect(spec.extensions.length, `${spec.id} 缺少扩展名`).toBeGreaterThan(0)
      for (const extension of spec.extensions) expect(extension.startsWith('.'), `${spec.id} 扩展名须带点`).toBe(true)
      expect(spec.aliases.length, `${spec.id} 缺少别名`).toBeGreaterThan(0)
      expect(Array.isArray(spec.tokenizer.tokenizer.root), `${spec.id} 缺少 root 状态`).toBe(true)
      expect(spec.tokenizer.tokenizer.root.length).toBeGreaterThan(0)
    }
  })

  it('规则引用的状态都存在（拼错状态名会静默失效）', () => {
    for (const spec of TEMPLATE_SPECS) {
      const states = spec.tokenizer.tokenizer
      for (const [name, rules] of Object.entries(states)) {
        for (const referenced of referencedStates(rules as unknown[])) {
          expect(states[referenced], `${spec.id}.${name} 引用了不存在的状态 @${referenced}`).toBeDefined()
        }
      }
    }
  })

  it('模板分隔符能把代码带入独立状态（不是只染色不切换）', () => {
    // Haml / Slim 是行内规则（`-`/`=` 代码行按行染色，不需要跨行状态），其余语言靠分隔符入栈
    const lineOriented = new Set(['haml', 'slim'])
    for (const spec of TEMPLATE_SPECS) {
      if (lineOriented.has(spec.id)) continue
      const root = spec.tokenizer.tokenizer.root as unknown[]
      const pushes = root.filter((rule) => Array.isArray(rule) && typeof rule[2] === 'string' && rule[2] !== '@pop')
      expect(pushes.length, `${spec.id} 没有任何进入分隔符状态的规则`).toBeGreaterThan(0)
    }
  })

  it('language configuration 带括号与注释配置', () => {
    for (const spec of TEMPLATE_SPECS) {
      const configuration = configurationOf(spec)
      expect(configuration.brackets.length).toBeGreaterThan(0)
      expect(configuration.autoClosingPairs.length).toBeGreaterThan(0)
      const comments = configuration.comments ?? {}
      expect(Boolean(comments.blockComment) || Boolean(comments.lineComment), `${spec.id} 缺少注释配置`).toBe(true)
    }
  })
})

describe('注册', () => {
  it('一次注册全部语言，重复调用不重复注册', () => {
    const { monaco, registrations } = fakeMonaco()
    expect(registerTemplates(monaco)).toBe(true)
    expect(registrations).toEqual(TEMPLATE_LANGUAGE_IDS)
    expect(monaco.languages.setMonarchTokensProvider).toHaveBeenCalledTimes(TEMPLATE_LANGUAGE_IDS.length)

    expect(registerTemplates(monaco)).toBe(true)
    expect(registrations).toEqual(TEMPLATE_LANGUAGE_IDS)
  })

  it('缺少 Monaco 语言 API 时安全返回 false', () => {
    expect(registerTemplates(undefined)).toBe(false)
    expect(registerTemplates({})).toBe(false)
  })

  it('isTemplateLang 只认本文档注册的 id', () => {
    expect(isTemplateLang('nunjucks')).toBe(true)
    expect(isTemplateLang('typescript')).toBe(false)
    expect(isTemplateLang(undefined)).toBe(false)
  })
})
