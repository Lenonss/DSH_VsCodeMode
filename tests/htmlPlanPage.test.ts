/**
 * client HTML 计划页纯逻辑测试：标记解析、路径归位、打包检测、状态推导、审批答案。
 * @author ddj 2026年11月21号
 */
import { describe, expect, it } from 'vitest'
import {
  buildPlanSrcDoc,
  derivePlanUiState,
  findPendingReview,
  isMissingPage,
  planPagePathOf,
  planRepairInstruction,
  planSlugOf,
  resolvePlanPagePath,
  reviewAnswerOf,
  unresolvedRuntimeRefs,
} from '../src/client/htmlPlan/planPage.js'

const BACKTICK = String.fromCharCode(96)

describe('planPagePathOf', () => {
  it('中英文冒号都识别，去掉反引号与引号', () => {
    expect(planPagePathOf('# 计划：x\nHTML 计划页：plans/a/plan.packed.html')).toBe('plans/a/plan.packed.html')
    expect(planPagePathOf('HTML 计划页: plans/a/plan.packed.html')).toBe('plans/a/plan.packed.html')
    expect(planPagePathOf('HTML 计划页：' + BACKTICK + 'plans/a/plan.packed.html' + BACKTICK)).toBe('plans/a/plan.packed.html')
    expect(planPagePathOf('HTML 计划页：  "plans/a/plan.html"  ')).toBe('plans/a/plan.html')
  })

  it('反斜杠归一为 /；无标记/非字符串返回 null', () => {
    expect(planPagePathOf('HTML 计划页：plans\\a\\plan.html')).toBe('plans/a/plan.html')
    expect(planPagePathOf('# 计划：没有页面')).toBeNull()
    expect(planPagePathOf(undefined)).toBeNull()
    expect(planPagePathOf(42)).toBeNull()
  })
})

describe('resolvePlanPagePath', () => {
  it('相对路径按 cwd 拼接；绝对路径原样归一', () => {
    expect(resolvePlanPagePath('C:\\repo\\ws', 'plans/a/plan.html')).toBe('C:/repo/ws/plans/a/plan.html')
    expect(resolvePlanPagePath('/home/u/ws/', './plans/a/plan.html')).toBe('/home/u/ws/plans/a/plan.html')
    expect(resolvePlanPagePath('C:\\repo', 'C:\\repo\\plans\\a\\plan.html')).toBe('C:/repo/plans/a/plan.html')
    expect(resolvePlanPagePath('/home/u', '/tmp/plan.html')).toBe('/tmp/plan.html')
  })

  it('空 cwd 保持相对路径；空输入返回空串', () => {
    expect(resolvePlanPagePath('', 'plans/a/plan.html')).toBe('plans/a/plan.html')
    expect(resolvePlanPagePath('C:\\repo', '')).toBe('')
  })
})

describe('unresolvedRuntimeRefs', () => {
  it('未打包页面列出运行时引用；打包后为空', () => {
    const raw = '<link rel="stylesheet" href="runtime/htmlplan.css"><script src="runtime/htmlplan.js" defer></script>'
    expect(unresolvedRuntimeRefs(raw)).toEqual(['runtime/htmlplan.css', 'runtime/htmlplan.js'])
    expect(unresolvedRuntimeRefs('<style>body{}</style><script>1</script>')).toEqual([])
    expect(unresolvedRuntimeRefs(undefined)).toEqual([])
  })

  it('引用运行时代码的 doc-code 不算「未打包」', () => {
    const packed = '<style data-htmlplan>a{}</style><script data-htmlplan>1</script>' +
      '<doc-code src="skills/x/runtime/htmlplan.js" lines="1-2"></doc-code>'
    expect(unresolvedRuntimeRefs(packed)).toEqual([])
  })
})

describe('isMissingPage', () => {
  it('按 code 与文案识别「页面还没生成」，其它读取失败不误判', () => {
    expect(isMissingPage({ ok: false, code: 'file-missing', error: '文件不存在' })).toBe(true)
    expect(isMissingPage({ ok: false, error: '打开失败：ENOENT' })).toBe(true)
    expect(isMissingPage({ ok: false, error: '读取失败：EACCES' })).toBe(false)
    expect(isMissingPage({ ok: false, error: '文件过大（>8MB）' })).toBe(false)
    expect(isMissingPage({ ok: true, content: 'x' })).toBe(false)
    expect(isMissingPage(undefined)).toBe(false)
  })
})

describe('planSlugOf / planRepairInstruction', () => {
  it('从声明的路径取 slug，取不到回落 html-plan', () => {
    expect(planSlugOf('plans/html-plan-own-answer/plan.packed.html')).toBe('html-plan-own-answer')
    expect(planSlugOf('C:/ws/plans\\x/plan.html')).toBe('x')
    expect(planSlugOf('')).toBe('html-plan')
    expect(planSlugOf('docs/a.md')).toBe('html-plan')
  })

  it('修复指令要求先落盘再声明，并禁止让用户退出计划模式', () => {
    const text = planRepairInstruction('plans/a-b/plan.packed.html')
    expect(text).toContain('plans/a-b/plan.html')
    expect(text).toContain('runtime/plan.mjs a-b')
    expect(text).toContain('HTML 计划页：plans/a-b/plan.packed.html')
    expect(text).toContain('exit_plan_mode')
    expect(text).toContain('不要让我退出计划模式')
    expect(text).toContain('不要只写路径不生成文件')
  })
})

describe('buildPlanSrcDoc', () => {
  it('注入一次桥接脚本，重复调用幂等', () => {
    const once = buildPlanSrcDoc('<html><body><p>x</p></body></html>')
    expect(once).toContain('data-edrv-htmlplan-bridge')
    expect(once.indexOf('</body>')).toBeGreaterThan(once.indexOf('data-edrv-htmlplan-bridge'))
    // 答复面板「回复」：注入按钮并回传 respond；父级结果按 source 校验消费。
    expect(once).toContain('type: "respond"')
    expect(once).toContain('edrv-plan-host')
    expect(once).toContain('hookSheet')
    expect(once).toContain('回复并执行')
    expect(once).toContain('reviewPending')
    expect(buildPlanSrcDoc(once)).toBe(once)
    // 桥接是拼进页面的字符串：用 new Function 做一次语法编译，防止运行期白屏。
    const match = /<script data-edrv-htmlplan-bridge>([\s\S]*?)<\/script>/.exec(once)
    expect(match).not.toBeNull()
    expect(() => new Function(match![1])).not.toThrow()
  })

  it('无 body 标签时追加；空输入返回空串', () => {
    const doc = buildPlanSrcDoc('<p>x</p>')
    expect(doc.startsWith('<p>x</p>')).toBe(true)
    expect(doc).toContain('data-edrv-htmlplan-bridge')
    expect(buildPlanSrcDoc('')).toBe('')
  })
})

describe('derivePlanUiState', () => {
  it('不可用 / 切换中 / 待审批 / 计划中 / 未开启', () => {
    expect(derivePlanUiState(undefined, false).mode).toBe('unknown')
    expect(derivePlanUiState({ active: true, pending: true }, false).label).toBe('计划状态切换中')
    expect(derivePlanUiState({ active: true, pending: false }, true).mode).toBe('reviewing')
    expect(derivePlanUiState({ active: true, pending: false }, false).mode).toBe('planning')
    expect(derivePlanUiState({ active: false, pending: false }, false).mode).toBe('off')
  })

  it('本地动作优先：批准中/已批准/继续规划/已退出', () => {
    expect(derivePlanUiState({ active: true }, false, 'approved').label).toBe('已批准 · 等待退出计划模式')
    expect(derivePlanUiState({ active: false }, false, 'approved').label).toBe('已批准 · 已退出计划模式')
    expect(derivePlanUiState({ active: false }, false, 'exited').mode).toBe('exited')
    expect(derivePlanUiState({ active: true }, false, 'revising').mode).toBe('revising')
  })
})

describe('findPendingReview', () => {
  const review = [{ callId: 'c1', questions: [{ id: 'plan-review', intent: 'plan-review', options: [{ label: 'Approve' }, { label: 'Keep planning' }] }] }]
  const keep = [{ callId: 'c2', questions: [{ id: 'plan-review', intent: 'plan-review', options: ['Approve', 'Keep planning'] }] }]
  const nested = [{ pending: { callId: 'c3', questions: [{ id: 'plan-review', options: ['Approve'] }] } }]

  it('识别平铺/字符串选项/嵌套 pending', () => {
    expect(findPendingReview(review)).toEqual({ callId: 'c1', questionId: 'plan-review', approveLabel: 'Approve', keepLabel: 'Keep planning' })
    expect(findPendingReview(keep)?.approveLabel).toBe('Approve')
    expect(findPendingReview(nested)?.callId).toBe('c3')
  })

  it('非 plan-review、缺 callId、畸形快照返回 null', () => {
    expect(findPendingReview([{ callId: 'c4', questions: [{ id: 'q', options: ['A', 'B'] }] }])).toBeNull()
    expect(findPendingReview([{ questions: review[0].questions }])).toBeNull()
    expect(findPendingReview(null)).toBeNull()
    expect(findPendingReview({ items: review })?.callId).toBe('c1')
  })
})

describe('reviewAnswerOf', () => {
  const item = { callId: 'c1', questionId: 'plan-review', approveLabel: 'Approve', keepLabel: 'Keep planning' }

  it('批准/继续规划各选对应标签', () => {
    expect(reviewAnswerOf(item, true)).toEqual({ answers: [{ id: 'plan-review', selected: ['Approve'], custom: '' }] })
    expect(reviewAnswerOf(item, false)).toEqual({ answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: '' }] })
  })

  it('无问题/无继续规划选项返回 null', () => {
    expect(reviewAnswerOf(null, true)).toBeNull()
    expect(reviewAnswerOf({ ...item, keepLabel: null }, false)).toBeNull()
  })
})
