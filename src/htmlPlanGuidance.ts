/**
 * dsh-vscode-mode host — HTML 计划模式的规则文本（纯函数，无 IO）。
 *
 * 对齐官方 `dsh-plan-mode` 的 `plan:policy` / `plan:status`：规则段落首次进入后常驻，
 * 开头一句限定「只在模式活跃时适用」；状态段落每个请求按活跃状态给一句话。
 * 文案拆成纯函数，便于单测三种状态（未进入 / 活跃 / 已退出）。
 * @author ddj 2026年11月25号
 */

//region 常量

/** 规则段落首句：与官方 plan:policy 同款的范围限定。 */
export const HTML_PLAN_POLICY_SCOPE = 'The following instructions apply only while HTML plan mode is active.'

/** 模式活跃时的状态句（对齐官方 plan:status）。 */
export const HTML_PLAN_STATUS_ACTIVE = 'HTML plan mode is active. Follow the html-plan instructions.'

/** 模式退出后的状态句（对齐官方 plan:status）。 */
export const HTML_PLAN_STATUS_INACTIVE = 'HTML plan mode is inactive. The html-plan instructions no longer apply.'

//endregion

//region 规则正文

/**
 * HTML 计划模式的规则正文（不含首句范围限定）。
 * @author ddj 2026年11月25号
 * @author ddj 2026年11月26号（默认路径改为「只交 Markdown」，弱模型也能拿到同样的计划页）
 * @returns 多行规则文本
 */
export function htmlPlanRulesText(): string {
  return [
    'HTML 计划模式已开启（与官方计划模式同级）。',
    '',
    '限制：只探索、只规划；不改源码，不运行会修改文件的命令。',
    '交付物：一页计划页。页面由插件负责生成，默认不需要你写 HTML。',
    '',
    '【默认】只提交计划正文（Markdown），插件按正文渲染标准计划页。正文写成：',
    '  - 第一行「# 计划：<标题>」，紧接着 1~3 行摘要；',
    '  - 每条主张一个「## <一句话主张>」，依据写在下面（列表、代码、表格都行）；',
    '  - 「## 为什么」写用户诉求；「## 决策清单」每条写「问题 | 选项A | 选项B」；',
    '  - 「## 不改什么」写这次明确不动的东西。',
    '  写成这样，任何模型（含 GPT 系列）都能得到与作者页同样的版式。',
    '',
    '【可选】只有需要界面稿、流程图这类图示时，才写 plans/<slug>/plan.html：',
    '  - 必须引用 runtime/htmlplan.css 与 runtime/htmlplan.js（插件会自动打包）；',
    '  - 只用 doc-plan / doc-claim / doc-ask 等运行时元素，不要自带布局 CSS、不要自己画卡片；',
    '  - 提交正文里单独一行「HTML 计划页：plans/<slug>/plan.html」。',
    '  没有 doc-plan / doc-claim 的页面会被当成文档页，计划签默认改用标准页。',
    '',
    '提交：调用 exit_html_plan_mode；plan 正文第一行必须是「# 计划：<标题>」。',
    '不要运行打包命令，不要为页面退出模式，不要调用 exit_plan_mode（那是另一个模式的工具）。',
    '如果用户还没有给出任务，先用一句话问清要规划什么，再开始。',
  ].join('\n')
}

/**
 * 规则段落正文：首次进入后常驻，用首句限定适用范围。
 * @author ddj 2026年11月25号
 * @returns 可直接作为 systemPrompt section 文本的多行字符串
 */
export function htmlPlanPolicyText(): string {
  return HTML_PLAN_POLICY_SCOPE + '\n\n' + htmlPlanRulesText()
}

/**
 * 状态段落正文：未进入过模式时为空；进入过则按活跃状态二选一。
 * @author ddj 2026年11月25号
 * @param entered 是否进入过 HTML 计划模式
 * @param active 当前是否活跃
 * @returns 一行状态文本；未进入时为空串
 */
export function htmlPlanStatusText(entered: boolean, active: boolean): string {
  if (!entered) return ''
  return active ? HTML_PLAN_STATUS_ACTIVE : HTML_PLAN_STATUS_INACTIVE
}

//endregion
