/**
 * dsh-vscode-mode client — 快捷菜单配置弹窗的通用选择控件。
 *
 * 提供三件控件：多选下拉（技能/规则）、限定工作区下拉（全部/当前/更多）、设置项开关与分段。
 * 弹层用 position: fixed 挂在 body 之上的坐标，因此不受弹窗 body 的 overflow 裁剪；
 * 组件仍用 React.createElement（项目内无 JSX），样式落在 quickmenu.css 的 edrv-qm-pick* 类上。
 * 作者 ddj 2026年10月30号
 */
import React from 'react'
import { selectionLabel, toggleWorkspace, workspaceLabel } from '../../shared/quickPick.js'

/** 下拉里一个可选项。 */
export interface PickOption {
  /** 稳定键：技能名 / 工作区绝对路径 / 规则 bindingKey。 */
  key: string
  label: string
  /** 次要说明（来源目录、绝对路径等）。 */
  hint?: string
  /** 校验状态：ok 不显示圆点，warn / error 显示对应颜色圆点。 */
  state?: 'ok' | 'warn' | 'error'
  /** 状态原因（作为 title 提示）。 */
  reason?: string
}

/** 一组可选项（技能按来源、规则按作用域分组）。 */
export interface PickGroup {
  key: string
  label: string
  options: PickOption[]
}

/** 一个工作区选项。 */
export interface PickWorkspaceItem {
  path: string
  title: string
}

/** 分段控件中的一个值。 */
export interface PickSegOption {
  value: string
  label: string
}

/** 弹层位置：靠下展开给 top，向上展开给 bottom。 */
interface PanelPos {
  left: number
  width: number
  maxHeight: number
  top?: number
  bottom?: number
}

/** 定位弹层需要的句柄。 */
interface Anchored {
  open: boolean
  style: React.CSSProperties
  triggerRef: React.RefObject<HTMLButtonElement>
  panelRef: React.RefObject<HTMLDivElement>
  toggle(): void
  close(): void
}

/** 弹层最小/最大高度（决定向上还是向下展开）。 */
const PANEL_MIN = 180
const PANEL_MAX = 320
/** 弹层与触发器/视口边缘的间距。 */
const PANEL_GAP = 6
const EDGE_GAP = 8

/**
 * 拼接 className，过滤假值。
 * @author ddj 2026年10月30号
 * @param names 候选类名（false / undefined 会被忽略）
 * @returns 空格分隔的 className
 */
function classes(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(' ')
}

/**
 * 按触发器位置计算弹层坐标，空间不足时向上展开。
 * @author ddj 2026年10月30号
 * @param trigger 触发器元素
 * @returns 弹层定位参数
 */
function placePanel(trigger: HTMLElement): PanelPos {
  const rect = trigger.getBoundingClientRect()
  const width = Math.max(rect.width, 280)
  const below = window.innerHeight - rect.bottom - PANEL_GAP - EDGE_GAP
  const above = rect.top - PANEL_GAP - EDGE_GAP
  const useAbove = below < PANEL_MIN && above > below
  const maxHeight = Math.max(PANEL_MIN, Math.min(PANEL_MAX, useAbove ? above : below))
  const maxLeft = Math.max(EDGE_GAP, window.innerWidth - width - EDGE_GAP)
  const left = Math.min(Math.max(EDGE_GAP, rect.left), maxLeft)

  if (useAbove) {
    return { left, width, maxHeight, bottom: window.innerHeight - rect.top + PANEL_GAP }
  }
  return { left, width, maxHeight, top: rect.bottom + PANEL_GAP }
}

/**
 * 受控弹层的位置与开合状态。
 *
 * Esc 的处理依赖「子组件 effect 先于父组件 effect 执行」：本 hook 在 ModalShell 内部的
 * 子组件里挂载，因此先注册 window 捕获监听，才能在弹层打开时拦下 Esc，避免连外层弹窗一起关掉。
 * @author ddj 2026年10月30号
 * @returns 弹层句柄
 */
function useAnchored(): Anchored {
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState<PanelPos | null>(null)
  const openRef = React.useRef(false)
  openRef.current = open

  const close = React.useCallback(() => {
    setOpen(false)
    setPos(null)
  }, [])

  const toggle = React.useCallback(() => {
    if (openRef.current) {
      close()
      return
    }

    const trigger = triggerRef.current
    setPos(trigger ? placePanel(trigger) : null)
    setOpen(true)
  }, [close])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !openRef.current) return
      // 只收掉弹层：ModalShell 同样在 window 捕获阶段监听 Esc，必须阻止它继续执行
      event.stopImmediatePropagation()
      event.preventDefault()
      close()
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close])

  React.useEffect(() => {
    if (!open) return

    const reposition = () => {
      const trigger = triggerRef.current
      if (trigger) setPos(placePanel(trigger))
    }
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      close()
    }
    const onScroll = (event: Event) => {
      const target = event.target as Node | null
      if (target && panelRef.current?.contains(target)) return
      reposition()
    }

    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close])

  const style: React.CSSProperties = pos
    ? { left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }
    : {}

  return { open, style, triggerRef, panelRef, toggle, close }
}

/**
 * 收集所有分组的选项键→标签映射。
 * @author ddj 2026年10月30号
 * @param groups 分组选项
 * @returns 选项键到标签的映射
 */
function labelsOf(groups: PickGroup[]): Map<string, string> {
  const labels = new Map<string, string>()
  for (const group of groups) {
    for (const option of group.options) labels.set(option.key, option.label)
  }
  return labels
}

/**
 * 统计已选项里带警告/错误状态的数量。
 * @author ddj 2026年10月30号
 * @param groups 分组选项
 * @param selected 已选键
 * @returns 异常状态条目数
 */
function issueCount(groups: PickGroup[], selected: string[]): number {
  const picked = new Set(selected)
  let count = 0
  for (const group of groups) {
    for (const option of group.options) {
      if (picked.has(option.key) && option.state && option.state !== 'ok') count += 1
    }
  }
  return count
}

/** 触发器按钮的属性。 */
interface TriggerProps {
  triggerRef: React.RefObject<HTMLButtonElement>
  buttonId?: string
  summary: string
  open: boolean
  disabled: boolean
  issueCount?: number
  hint?: string
  onClick(): void
}

/**
 * 下拉触发器：显示当前选择摘要与展开箭头。
 * @author ddj 2026年10月30号
 * @param props 触发器属性
 * @returns 触发器按钮
 */
function PickTrigger(props: TriggerProps) {
  return React.createElement(
    'button',
    {
      ref: props.triggerRef,
      id: props.buttonId,
      type: 'button',
      className: classes('edrv-qm-pick-trigger', props.open && 'edrv-qm-pick-trigger--open'),
      disabled: props.disabled,
      title: props.hint,
      'aria-haspopup': 'listbox',
      'aria-expanded': props.open,
      onClick: props.onClick,
    },
    React.createElement('span', { className: 'edrv-qm-pick-summary' }, props.summary),
    props.issueCount
      ? React.createElement('span', { className: 'edrv-qm-pick-badge' }, String(props.issueCount))
      : null,
    React.createElement('span', { className: 'edrv-qm-pick-caret', 'aria-hidden': 'true' }),
  )
}

/** 弹层属性。 */
interface PanelProps {
  panelRef: React.RefObject<HTMLDivElement>
  style: React.CSSProperties
  labelledBy?: string
  children?: React.ReactNode
}

/**
 * 绝对定位的弹层容器。
 * @author ddj 2026年10月30号
 * @param props 弹层属性
 * @returns 弹层节点
 */
function PickPanel(props: PanelProps) {
  return React.createElement(
    'div',
    {
      ref: props.panelRef,
      className: 'edrv-qm-pick-panel',
      style: props.style,
      role: 'listbox',
      'aria-labelledby': props.labelledBy,
    },
    props.children,
  )
}

/** 单个可选项的属性。 */
interface OptionProps {
  option: PickOption
  picked: boolean
  onToggle(key: string): void
}

/**
 * 可勾选的多选项行。
 * @author ddj 2026年10月30号
 * @param props 选项属性
 * @returns 选项按钮
 */
function PickOptionRow(props: OptionProps) {
  const option = props.option
  const state = option.state ?? 'ok'

  return React.createElement(
    'button',
    {
      type: 'button',
      role: 'option',
      className: classes('edrv-qm-pick-option', props.picked && 'edrv-qm-pick-option--on'),
      'aria-selected': props.picked,
      title: option.reason ?? option.hint,
      onClick: () => props.onToggle(option.key),
    },
    React.createElement(
      'span',
      {
        className: classes('edrv-qm-pick-check', props.picked && 'edrv-qm-pick-check--on'),
        'aria-hidden': 'true',
      },
      props.picked ? '✓' : '',
    ),
    React.createElement('span', { className: 'edrv-qm-pick-name' }, option.label),
    state === 'ok'
      ? null
      : React.createElement('span', {
          className: classes('edrv-qm-pick-dot', 'edrv-qm-pick-dot--' + state),
          'aria-hidden': 'true',
        }),
    option.hint ? React.createElement('span', { className: 'edrv-qm-pick-hint' }, option.hint) : null,
  )
}

/** 多选下拉的属性。 */
export interface PickMultiProps {
  buttonId?: string
  groups: PickGroup[]
  selected: string[]
  /** 摘要计数单位，如「个技能」「条规则」。 */
  unit: string
  emptyText: string
  disabled?: boolean
  disabledHint?: string
  onToggle(key: string): void
}

/**
 * 多选下拉：技能与规则共用，按来源分组展示。
 * @author ddj 2026年10月30号
 * @param props 多选下拉属性
 * @returns 多选下拉组件
 */
export function PickMulti(props: PickMultiProps) {
  const anchor = useAnchored()
  const labels = labelsOf(props.groups)
  const summaryNames = props.selected.map((key) => labels.get(key) ?? key)
  const summary = selectionLabel(summaryNames, props.unit)
  const issues = issueCount(props.groups, props.selected)
  const groups = props.groups.filter((group) => group.options.length > 0)

  const rows = groups.map((group) =>
    React.createElement(
      'div',
      { key: group.key, className: 'edrv-qm-pick-group' },
      React.createElement('div', { className: 'edrv-qm-pick-group-title' }, group.label),
      group.options.map((option) =>
        React.createElement(PickOptionRow, {
          key: option.key,
          option,
          picked: props.selected.includes(option.key),
          onToggle: props.onToggle,
        }),
      ),
    ),
  )

  return React.createElement(
    'div',
    { className: 'edrv-qm-pick' },
    React.createElement(PickTrigger, {
      triggerRef: anchor.triggerRef,
      buttonId: props.buttonId,
      summary,
      open: anchor.open,
      disabled: props.disabled === true,
      issueCount: issues,
      hint: props.disabled ? props.disabledHint : undefined,
      onClick: anchor.toggle,
    }),
    anchor.open
      ? React.createElement(
          PickPanel,
          { panelRef: anchor.panelRef, style: anchor.style, labelledBy: props.buttonId },
          rows.length > 0
            ? React.createElement('div', { className: 'edrv-qm-pick-list' }, rows)
            : React.createElement('div', { className: 'edrv-qm-pick-empty' }, props.emptyText),
        )
      : null,
  )
}

/** 限定工作区下拉的属性。 */
export interface PickWorkspaceProps {
  buttonId?: string
  workspaces: PickWorkspaceItem[]
  selected: string[] | null
  cwd?: string
  inherited?: boolean
  inheritedHint?: string
  onChange(next: string[] | null): void
}

/**
 * 限定工作区下拉：全部 / 当前 / 更多（更多展开全部工作区多选）。
 * @author ddj 2026年10月30号
 * @param props 工作区下拉属性
 * @returns 工作区下拉组件
 */
export function PickWorkspace(props: PickWorkspaceProps) {
  const anchor = useAnchored()
  const [more, setMore] = React.useState(false)
  const summary = workspaceLabel(props.selected, props.cwd)
  const picked = props.selected ?? []
  const disabled = props.inherited === true
  const currentPath = props.cwd

  // 全部/当前是「一个值」的快捷项；「更多」不再高亮，避免与下方多选冲突
  const isAll = picked.length === 0
  const isCurrent = picked.length === 1 && !!currentPath && summary.mode === 'current'

  const onPickAll = () => {
    props.onChange(null)
    anchor.close()
  }
  const onPickCurrent = () => {
    if (!currentPath) return
    props.onChange([currentPath])
    anchor.close()
  }

  const quick = [
    React.createElement(PickOptionRow, {
      key: '__all__',
      option: { key: '__all__', label: '全部工作区', hint: '菜单在所有工作区可见' },
      picked: isAll,
      onToggle: onPickAll,
    }),
    React.createElement(PickOptionRow, {
      key: '__current__',
      option: {
        key: '__current__',
        label: '当前工作区',
        hint: currentPath || '当前没有活跃工作区',
      },
      picked: isCurrent,
      onToggle: onPickCurrent,
    }),
  ]

  const rows = props.workspaces.map((workspace) =>
    React.createElement(PickOptionRow, {
      key: workspace.path,
      option: { key: workspace.path, label: workspace.title, hint: workspace.path },
      picked: picked.some((path) => path === workspace.path),
      onToggle: (path: string) => props.onChange(toggleWorkspace(props.selected, path)),
    }),
  )

  const moreToggle = React.createElement(
    'button',
    {
      type: 'button',
      className: classes('edrv-qm-pick-more', more && 'edrv-qm-pick-more--on'),
      'aria-expanded': more,
      onClick: () => setMore(!more),
    },
    more ? '收起工作区列表' : '更多工作区（' + String(props.workspaces.length) + '）',
  )

  return React.createElement(
    'div',
    { className: 'edrv-qm-pick' },
    React.createElement(PickTrigger, {
      triggerRef: anchor.triggerRef,
      buttonId: props.buttonId,
      summary: summary.label,
      open: anchor.open,
      disabled,
      hint: disabled ? props.inheritedHint : '点开选择生效范围',
      onClick: anchor.toggle,
    }),
    anchor.open
      ? React.createElement(
          PickPanel,
          { panelRef: anchor.panelRef, style: anchor.style, labelledBy: props.buttonId },
          React.createElement('div', { className: 'edrv-qm-pick-list' }, quick),
          moreToggle,
          more ? React.createElement('div', { className: 'edrv-qm-pick-list' }, rows) : null,
        )
      : null,
  )
}

/** 开关属性。 */
export interface PickSwitchProps {
  buttonId?: string
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange(next: boolean): void
}

/**
 * 开关行：左侧标题与说明，右侧滑动开关。
 * @author ddj 2026年10月30号
 * @param props 开关属性
 * @returns 开关行
 */
export function PickSwitch(props: PickSwitchProps) {
  return React.createElement(
    'div',
    { className: 'edrv-qm-switch-row' },
    React.createElement(
      'div',
      { className: 'edrv-qm-switch-text' },
      React.createElement('div', { className: 'edrv-qm-pick-name' }, props.label),
      props.hint ? React.createElement('div', { className: 'edrv-qm-pick-hint' }, props.hint) : null,
    ),
    React.createElement(
      'button',
      {
        id: props.buttonId,
        type: 'button',
        role: 'switch',
        className: classes('edrv-qm-switch', props.checked && 'edrv-qm-switch--on'),
        'aria-checked': props.checked,
        'aria-label': props.label,
        disabled: props.disabled === true,
        onClick: () => props.onChange(!props.checked),
      },
      React.createElement('span', { className: 'edrv-qm-switch-knob', 'aria-hidden': 'true' }),
    ),
  )
}

/** 分段控件属性。 */
export interface PickSegProps {
  options: PickSegOption[]
  value: string
  disabled?: boolean
  label?: string
  onChange(next: string): void
}

/**
 * 分段控件：等宽按钮组，用于 1–5 层数这类小范围枚举。
 * @author ddj 2026年10月30号
 * @param props 分段控件属性
 * @returns 分段控件
 */
export function PickSeg(props: PickSegProps) {
  return React.createElement(
    'div',
    { className: 'edrv-qm-seg', role: 'group', 'aria-label': props.label },
    props.options.map((option) =>
      React.createElement(
        'button',
        {
          key: option.value,
          type: 'button',
          className: classes('edrv-qm-seg-btn', option.value === props.value && 'edrv-qm-seg-btn--on'),
          'aria-pressed': option.value === props.value,
          disabled: props.disabled === true,
          onClick: () => props.onChange(option.value),
        },
        option.label,
      ),
    ),
  )
}
