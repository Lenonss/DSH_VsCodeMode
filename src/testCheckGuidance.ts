/**
 * dsh-vscode-mode host — 测试验收模式的规则文本（纯函数，无 IO）。
 *
 * 结构照 `htmlPlanGuidance.ts`：规则段落首次进入后常驻，首句限定「只在模式活跃时适用」；
 * 状态段落每个请求按活跃状态给一句话。规则里写死「必须带证据上报」——这是这个模式存在的理由。
 * @author ddj 2026年11月25号
 */

//region 常量

/** 规则段落首句：与其他模式的 policy 段同款范围限定。 */
export const TEST_CHECK_SCOPE = 'The following instructions apply only while test-check mode is active.'

/** 模式活跃时的状态句。 */
export const TEST_CHECK_STATUS_ACTIVE = 'Test-check mode is active. Every item must be reported with evidence.'

/** 模式退出后的状态句。 */
export const TEST_CHECK_STATUS_INACTIVE = 'Test-check mode is inactive. The test-check instructions no longer apply.'

//endregion

//region 规则正文

/**
 * 规则正文（不含首句范围限定）。
 * @author ddj 2026年11月25号
 * @returns 多行规则文本
 */
export function testCheckRulesText(): string {
  return [
    '测试验收模式已开启（独立模式，与 /plan、/html-plan 并列，互不覆盖）。',
    '',
    '目标：把这次任务的验收点逐条验掉，结果落在验收单里，人和 AI 看到的是同一份状态。',
    '',
    '规则：',
    '1. 先看验收单：<项目根>/.dsh/test-check/<id>/items.json；没有就用 write 按模板建单，',
    '   测试点 ID 形如 settings.claude-style.004（<scope>.<area>.<3 位序号>），全局唯一、只增不改号。',
    '2. 每验一项必须调用 test_check_report 上报，且必须带证据：summary 至少写清测试名、命令或日志路径。',
    '3. 不许口头通过：没跑过就不许报 pass；跑不起来就报 blocked 并在 summary 里写清卡在哪。',
    '4. 全部验完调用 test_check_finish：导出 docs/acceptance-<id>.html，模式随之退出。',
    '   还要留在模式里补验就带 stay: true；手动退出用 /test-check off（底部栏 chip 等价）。',
    '5. 模式退出后不要再上报；下次同一任务再进来会回到同一张单（id 由任务文本派生）。',
    '不要调用 exit_plan_mode / exit_html_plan_mode：那是另外两个模式的工具。',
  ].join('\n')
}

/**
 * 规则段落正文：首次进入后常驻，用首句限定适用范围。
 *
 * 项目级规则拼在内建规则后面，标一个来源标题：来自文件时写文件路径，
 * 来自默认规则时说明「左侧面板可改」，让模型知道这段要求是谁定的。
 * @author ddj 2026年11月25号 / 2026年11月26号
 * @param overlay 生效的项目级规则正文（默认规则或文件内容）
 * @param fromFile 是否来自 `.dsh/test-check/policy.md`（false = 默认规则）
 * @returns 可直接作为 systemPrompt section 文本的多行字符串
 */
export function testCheckPolicyText(overlay = '', fromFile = true): string {
  const base = TEST_CHECK_SCOPE + '\n\n' + testCheckRulesText()
  const extra = String(overlay ?? '').trim()
  if (!extra) return base
  const heading = fromFile
    ? '### 项目自己的验收规则（来自 .dsh/test-check/policy.md）'
    : '### 项目测试规范（默认规则；左侧「测试验收」面板可改）'
  return base + '\n\n' + heading + '\n\n' + extra
}

/**
 * 状态段落正文：未进入过模式时为空；进入过则按活跃状态二选一。
 * @author ddj 2026年11月25号
 * @param entered 是否进入过测试验收模式
 * @param active 当前是否活跃
 * @returns 一行状态文本；未进入时为空串
 */
export function testCheckStatusText(entered: boolean, active: boolean): string {
  if (!entered) return ''
  return active ? TEST_CHECK_STATUS_ACTIVE : TEST_CHECK_STATUS_INACTIVE
}

//endregion
