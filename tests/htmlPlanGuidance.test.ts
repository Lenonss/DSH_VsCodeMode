/**
 * HTML 计划模式规则文本测试：范围限定句、规则正文与状态三态。
 * @author ddj 2026年11月25号
 */
import { describe, expect, it } from 'vitest'
import {
  HTML_PLAN_POLICY_SCOPE,
  HTML_PLAN_STATUS_ACTIVE,
  HTML_PLAN_STATUS_INACTIVE,
  htmlPlanPolicyText,
  htmlPlanRulesText,
  htmlPlanStatusText,
} from '../src/htmlPlanGuidance.js'

describe('htmlPlanRulesText', () => {
  it('写明限制、页面来源、提交工具与不得使用的官方工具', () => {
    const text = htmlPlanRulesText()
    expect(text).toContain('只探索')
    expect(text).toContain('plans/<slug>/plan.html')
    expect(text).toContain('exit_html_plan_mode')
    expect(text).toContain('exit_plan_mode')
    expect(text).toContain('不要运行打包命令')
  })
})

describe('htmlPlanPolicyText', () => {
  it('首句是范围限定，后接规则正文', () => {
    const text = htmlPlanPolicyText()
    expect(text.startsWith(HTML_PLAN_POLICY_SCOPE)).toBe(true)
    expect(text).toContain(htmlPlanRulesText())
  })
})

describe('htmlPlanStatusText', () => {
  it('未进入过模式时为空串；进入后按活跃状态二选一', () => {
    expect(htmlPlanStatusText(false, false)).toBe('')
    expect(htmlPlanStatusText(false, true)).toBe('')
    expect(htmlPlanStatusText(true, true)).toBe(HTML_PLAN_STATUS_ACTIVE)
    expect(htmlPlanStatusText(true, false)).toBe(HTML_PLAN_STATUS_INACTIVE)
  })
})
