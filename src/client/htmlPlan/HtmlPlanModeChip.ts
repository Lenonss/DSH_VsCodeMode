/**
 * dsh-vscode-mode client — 底部栏的 HTML 计划模式 chip。
 *
 * 参照官方 `dsh-client-ui-plan` 的 `PlanChip`：读取会话投影判断模式是否活跃，
 * 活跃时在输入框工具行显示一个 chip，点击执行 `/html-plan off` 退出模式。
 *
 * 槽位选 `conversation.input.left`（list，会话级）：官方计划 chip 占着
 * `conversation.input.plan`（single），这里不去抢；注册沿用本插件跨版本的
 * `ctx.slots.inject` 写法，旧宿主没有该槽位时不报错、chip 自然不出现。
 * @author ddj 2026年11月25号
 */
import React from 'react'
import { log } from '../log.js'
import { HTML_PLAN_MODE_KEY, HTML_PLAN_OFF_LINE } from '../../shared/htmlPlanMode.js'

//region 结构面

/** chip 的 slot 运行时注入面。 */
export interface HtmlPlanChipInjected {
  /** 离开 HTML 计划模式（执行 /html-plan off）。 */
  exitHtmlPlanMode: () => Promise<string | null>
}

/** chip 组件 props（slot 标准 props + 注入面）。 */
export interface HtmlPlanModeChipProps extends Partial<HtmlPlanChipInjected> {
  /** 当前会话。 */
  sessionId?: string
  /** 官方标准 kit：按 key 读会话投影。 */
  useProjection?: (key: string) => unknown
  /** 输入框是否锁定。 */
  locked?: boolean
}

/** slots 服务最小结构面。 */
interface SlotsLike {
  inject: (name: string, register: () => unknown) => unknown
  register: (spec: unknown, render: unknown) => unknown
}

/** 客户端上下文最小结构面。 */
interface ChipCtx {
  slots?: SlotsLike
  get?: (name: string) => unknown
}

/** remote.commands 服务最小结构面。 */
interface RemoteCommandsLike {
  execute?: (sessionId: string, line: string, attachments: readonly unknown[]) => Promise<unknown>
}

//endregion

//region 动作

/**
 * 取异常的展示文案。
 * @author ddj 2026年11月25号
 * @param error 捕获值
 * @returns 可读文本
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

/**
 * 把官方命令执行结果归一成「成功返回 null，失败返回一行原因」。
 * @author ddj 2026年11月25号
 * @param raw 官方 `remote.commands.execute` 的返回值
 * @returns null 或失败原因
 */
export function exitFailureOf(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return raw === false ? '官方服务拒绝了本次操作' : null
  const row = raw as { ok?: unknown; value?: unknown; error?: unknown }
  if (row.ok === false) {
    const detail = row.error as { message?: unknown } | string | undefined
    return typeof detail === 'string' ? detail : (typeof detail?.message === 'string' ? detail.message : '官方服务拒绝了本次操作')
  }
  if (row.ok === true && row.value === undefined) return '未知命令：/html-plan off'
  return null
}

//endregion

//region 组件

/**
 * 底部栏 chip：模式活跃时出现，点击离开。
 * @author ddj 2026年11月25号
 * @param props slot 运行时 props 与注入面
 * @returns chip 元素；模式不活跃时为 null
 */
export function HtmlPlanModeChip(props: HtmlPlanModeChipProps) {
  const [leaving, setLeaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const mode = typeof props.useProjection === 'function'
    ? props.useProjection(HTML_PLAN_MODE_KEY) as { active?: boolean } | undefined
    : undefined
  if (mode?.active !== true) return null

  const exit = props.exitHtmlPlanMode
  const leave = (): void => {
    if (typeof exit !== 'function' || leaving) return
    setLeaving(true)
    setError(null)
    void exit().then((failure) => {
      setLeaving(false)
      setError(failure)
    }, (reason: unknown) => {
      setLeaving(false)
      setError(messageOf(reason))
    })
  }

  return React.createElement('span', { className: 'edrv-htmlplan-chip-wrap' },
    React.createElement('button', {
      type: 'button',
      className: 'edrv-htmlplan-chip',
      title: 'HTML 计划模式已开启：点击执行 /html-plan off 离开',
      'aria-label': '离开 HTML 计划模式',
      disabled: props.locked === true || leaving,
      onClick: leave,
    },
      React.createElement('span', { className: 'edrv-htmlplan-chip-glyph', 'aria-hidden': true }, '◆'),
      'HTML 计划模式',
      React.createElement('span', { className: 'edrv-htmlplan-chip-x', 'aria-hidden': true }, '✕')),
    (error ? React.createElement('span', { className: 'edrv-htmlplan-chip-error', role: 'status', title: error }, '离开失败') : null))
}

//endregion

//region 装配

/**
 * 把 chip 装到 `conversation.input.left` 列表槽。
 * @author ddj 2026年11月25号
 * @param ctx 客户端上下文
 * @returns 卸载函数；槽位/服务不可用时 null
 */
export function installHtmlPlanModeChip(ctx: unknown): (() => void) | null {
  const client = ctx as ChipCtx | undefined
  const slots = client?.slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    log.warn('HTML 计划模式 chip 未注册：slots 服务不可用')
    return null
  }

  /** @author ddj 2026年11月25号 @param sessionId 会话 @returns 失败原因或 null */
  async function exitHtmlPlanMode(sessionId: string): Promise<string | null> {
    if (!sessionId) return '当前没有活动会话'
    const remote = typeof client?.get === 'function'
      ? client.get('remote.commands') as RemoteCommandsLike | undefined
      : undefined
    if (!remote || typeof remote.execute !== 'function') return '当前 DSH 不支持在插件内执行命令'
    try {
      return exitFailureOf(await remote.execute(sessionId, HTML_PLAN_OFF_LINE, []))
    } catch (error) {
      return messageOf(error)
    }
  }

  try {
    const disposer = slots.inject('conversation.input.left', () => slots.register({
      name: 'conversation.input.left',
      id: 'edrv-html-plan-mode',
      order: 20,
      label: 'HTML 计划模式',
      /** @author ddj 2026年11月25号 @param sessionId 会话 @returns 注入面 */
      inject: (sessionId: string): HtmlPlanChipInjected => ({
        exitHtmlPlanMode: () => exitHtmlPlanMode(String(sessionId ?? '')),
      }),
    }, HtmlPlanModeChip))
    return typeof disposer === 'function' ? disposer as () => void : null
  } catch (error) {
    log.warn('HTML 计划模式 chip 注册失败（' + messageOf(error) + '），已跳过')
    return null
  }
}

//endregion
