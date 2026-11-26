/**
 * dsh-vscode-mode client — 底部栏的「验收 x/y」chip。
 *
 * 与 HTML 计划模式 chip 共用 `conversation.input.left` 列表槽（官方计划 chip 占着
 * `conversation.input.plan`，不去抢）：模式活跃时出现，计数来自 `edrv.testCheck.get`
 * 的派生视图，点开在「文件编辑」里打开验收单页签。
 * @author ddj 2026年11月25号
 */
import React from 'react'
import { log } from '../log.js'
import { rpc } from '../rpc.js'
import { requestOpen } from '../openReceipt.js'
import { TEST_CHECK_CHIP_MS, TEST_CHECK_MODE_KEY } from '../../shared/testCheck.js'

//region 结构面

/** chip 组件 props（slot 标准 props）。 */
export interface CheckChipProps {
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

//endregion

//region 工具

/**
 * 取异常的展示文案。
 * @author ddj 2026年11月25号
 * @param error 捕获值
 * @returns 可读文本
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '未知错误')
}

//endregion

//region 组件

/**
 * 底部栏 chip：模式活跃时出现，显示通过数/总数，点击打开验收单页签。
 * @author ddj 2026年11月25号
 * @param props slot 运行时 props
 * @returns chip 元素；模式不活跃时为 null
 */
export function TestCheckChip(props: CheckChipProps) {
  const sessionId = String(props.sessionId ?? '')
  const mode = typeof props.useProjection === 'function'
    ? props.useProjection(TEST_CHECK_MODE_KEY) as { active?: boolean; id?: string } | undefined
    : undefined
  const sheetId = typeof mode?.id === 'string' && mode.id ? mode.id : 'check'
  const active = mode?.active === true

  const [tally, setTally] = React.useState('')
  const [opening, setOpening] = React.useState(false)
  const [note, setNote] = React.useState('')

  React.useEffect(() => {
    if (!active || !sessionId) {
      setTally('')
      return undefined
    }
    let alive = true
    /** 读一次计数（轮询，失败保留上一次的数字）。 */
    async function loadTally(): Promise<void> {
      try {
        const raw = await rpc('edrv.testCheck.get', { sessionId, id: sheetId })
        if (!alive || !raw.ok) return
        const counts = raw.view.counts
        setTally(String(counts.pass) + '/' + String(counts.total))
      } catch (error) {
        log.warn('验收单计数读取失败：' + messageOf(error))
      }
    }
    void loadTally()
    const timer = window.setInterval(() => { void loadTally() }, TEST_CHECK_CHIP_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [active, sessionId, sheetId])

  if (!active) return null

  /**
   * 打开验收单页签（文件编辑内的虚拟页签）。
   *
   * 宿主刚重载时编辑器可能还没挂上，第一次请求会超时（真机实测）；超时后等一拍再试一次，
   * 仍然失败才提示用户，避免「点了没反应」被误当成模式坏了。
   * @author ddj 2026年11月25号
   */
  async function openSheet(): Promise<void> {
    if (opening) return
    if (!sessionId) { setNote('当前没有活动会话'); return }
    setOpening(true)
    setNote('')
    try {
      let ok = await requestOpen(null, undefined, undefined, sessionId, {
        preview: true,
        sheet: { id: sheetId, title: '验收单 · ' + sheetId },
        timeoutMs: 4000,
      })
      if (!ok) {
        await new Promise((resolve) => { setTimeout(resolve, 300) })
        ok = await requestOpen(null, undefined, undefined, sessionId, {
          preview: true,
          sheet: { id: sheetId, title: '验收单 · ' + sheetId },
          timeoutMs: 4000,
        })
      }
      if (!ok) setNote('打开失败：编辑器没有回执，请重试')
    } catch (error) {
      setNote('打开失败：' + messageOf(error))
    }
    setOpening(false)
  }

  return React.createElement('span', { className: 'edrv-testcheck-chip-wrap' },
    React.createElement('button', {
      type: 'button',
      className: 'edrv-testcheck-chip',
      title: '测试验收模式已开启：点开验收单（离开用 /test-check off）',
      'aria-label': '打开测试验收单',
      disabled: props.locked === true || opening,
      onClick: () => { void openSheet() },
    },
      React.createElement('span', { className: 'edrv-testcheck-chip-glyph', 'aria-hidden': true }, '✓'),
      '验收 ' + (tally || '—'),
      React.createElement('span', { className: 'edrv-testcheck-chip-open', 'aria-hidden': true }, '›')),
    (note ? React.createElement('span', { className: 'edrv-testcheck-chip-error', role: 'status', title: note }, note) : null))
}

//endregion

//region 装配

/**
 * 把 chip 装到 `conversation.input.left` 列表槽。
 * @author ddj 2026年11月25号
 * @param ctx 客户端上下文
 * @returns 卸载函数；槽位/服务不可用时 null
 */
export function installCheckChip(ctx: unknown): (() => void) | null {
  const client = ctx as ChipCtx | undefined
  const slots = client?.slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    log.warn('验收单 chip 未注册：slots 服务不可用')
    return null
  }
  try {
    const disposer = slots.inject('conversation.input.left', () => slots.register({
      name: 'conversation.input.left',
      id: 'edrv-test-check',
      order: 21,
      label: '验收单',
    }, TestCheckChip))
    return typeof disposer === 'function' ? disposer as () => void : null
  } catch (error) {
    log.warn('验收单 chip 注册失败（' + messageOf(error) + '），已跳过')
    return null
  }
}

//endregion
