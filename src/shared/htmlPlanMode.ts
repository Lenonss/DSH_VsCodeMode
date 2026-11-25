/**
 * dsh-vscode-mode shared — HTML 计划模式的跨平面常量。
 *
 * 宿主注册投影、命令与退出工具，客户端 chip 与计划签都要认同一套名字；
 * 放 shared 里避免 host/client 两侧各写一份字面量后悄悄漂移。
 * @author ddj 2026年11月25号
 */

//region 常量

/** 会话投影 key（`sessionProjections.register` 的 key，也是客户端 `useProjection` 的入参）。 */
export const HTML_PLAN_MODE_KEY = 'html-plan'

/** 进入/离开模式的命令名（官方命令语法：小写字母开头）。 */
export const HTML_PLAN_COMMAND = 'html-plan'

/** 离开模式的完整命令行（chip 与退出工具共用）。 */
export const HTML_PLAN_OFF_LINE = '/html-plan off'

/** 客户端捕获计划提交时要识别的工具名。 */
export const HTML_PLAN_EXIT_TOOL = 'exit_html_plan_mode'

/** 官方计划模式的退出工具名（保持识别，普通计划不受影响）。 */
export const OFFICIAL_PLAN_EXIT_TOOL = 'exit_plan_mode'

//endregion
