/**
 * dsh-vscode-mode client — 断点行内编辑浮层（逐项对齐 VS Code/CodeBuddy breakpointWidget）。
 *
 * 权威结构（CodeBuddy workbench.desktop.main.js）：
 * - **View Zone**（`changeViewZones(z => z.addZone({ afterLineNumber, heightInLines, domNode, afterColumnAffinity:1 }))`）
 *   → 占据**整个编辑区宽度**并把下方内容推开（不是 content widget：后者宽度受限且不推挤）：
 *   `_getWidth(i) = i.width - i.minimap.minimapWidth - i.verticalScrollbarWidth`。
 * - 左侧「模式下拉」四项（表达式 / 命中次数 / 日志消息 / 等待断点）+ 右侧**单行输入框**；
 *   切换模式时各模式内容独立记忆（rememberInput/getInputValue），「等待断点」模式隐藏输入框。
 * - 无「确定」按钮（仅「等待断点」模式有）：`Enter` 提交（primary:3）、`Escape` 取消（primary:9），
 *   提示写进输入框占位。
 * - 打开期间给**目标行**挂高亮装饰（`edrv-dap-bp-editing`），关闭时移除。
 * 文案逐字取自 CodeBuddy 官方中文语言包（索引 7259/7262~7265）。
 * 作者 ddj 2026年09月29号
 */
import { setEditingLine } from './decorate.js'

/** 模式索引（与权威实现 context 一致：0 表达式 / 1 命中次数 / 2 日志消息 / 3 等待断点）。 */
export const BP_MODE = { EXPRESSION: 0, HIT_COUNT: 1, LOG_MESSAGE: 2, WAIT: 3 } as const

/** 模式 → 字段键（等待断点无输入字段）。 */
export type BpFieldKey = 'condition' | 'hitCondition' | 'logMessage'

/** 浮层输入。 */
export interface BpWidgetInput {
  line: number
  entry: { condition?: string; hitCondition?: string; logMessage?: string }
  /** 打开时选中的模式（「添加条件断点…」→ 表达式、「添加记录点…」→ 日志消息）。 */
  mode?: number
  onSave: (fields: { condition: string; hitCondition: string; logMessage: string }) => void
  onClose: () => void
}

/** 浮层宿主（编辑器 + zone 句柄），由调用方持有用于关闭。 */
export interface BpWidgetHost {
  close: () => void
}

/** 模式项（顺序与权威实现一致）。 */
const MODES: readonly { mode: number; label: string; placeholder: string }[] = [
  { mode: BP_MODE.EXPRESSION, label: '表达式', placeholder: '在表达式结果为真时中断。按 "Enter" 键确认，"Escape" 键取消。' },
  { mode: BP_MODE.HIT_COUNT, label: '命中次数', placeholder: '在满足命中次数条件时中断。按 "Enter" 键确认，"Escape" 键取消。' },
  { mode: BP_MODE.LOG_MESSAGE, label: '日志消息', placeholder: '断点命中时记录的消息。{} 内的表达式将被替换。按 "Enter" 键确认，"Escape" 键取消。' },
  { mode: BP_MODE.WAIT, label: '等待断点', placeholder: '选择此断点命中前必须先命中的断点。' },
]
/** 模式清单（调试面板行内编辑器同源复用：标签与占位文案一致）。 */
export { MODES }

/** 模式 → 字段键映射（等待断点返回 null）；调试面板行内编辑器同源复用。 */
export function fieldOfMode(mode: number): BpFieldKey | null {
  if (mode === BP_MODE.EXPRESSION) return 'condition'
  if (mode === BP_MODE.HIT_COUNT) return 'hitCondition'
  if (mode === BP_MODE.LOG_MESSAGE) return 'logMessage'
  return null
}

/**
 * 打开断点行内编辑浮层（View Zone：整编辑区宽 + 推开内容 + 目标行高亮）。
 * @author ddj 2026年09月29号
 * @param editor Monaco 编辑器
 * @param input 目标行、初始值、初始模式、保存/取消回调
 * @returns 宿主句柄（close 关闭浮层）
 */
export function createBpWidget(editor: unknown, input: BpWidgetInput): BpWidgetHost {
  const ed = editor as {
    changeViewZones?: (cb: (accessor: { addZone: (zone: unknown) => string; removeZone: (id: string) => void }) => void) => void
  } | null
  let zoneId: string | null = null
  let closed = false

  // 各模式独立记忆（对齐 rememberInput / getInputValue）
  const remembered: Record<BpFieldKey, string> = {
    condition: input.entry?.condition ?? '',
    hitCondition: input.entry?.hitCondition ?? '',
    logMessage: input.entry?.logMessage ?? '',
  }
  let mode = typeof input.mode === 'number' ? input.mode : BP_MODE.EXPRESSION

  const root = document.createElement('div')
  root.className = 'edrv-bpwidget'
  root.setAttribute('data-edrv-view', '1')

  // 左侧模式下拉
  const select = document.createElement('select')
  select.className = 'edrv-bpwidget-mode'
  select.title = '断点类型'
  for (const item of MODES) {
    const opt = document.createElement('option')
    opt.value = String(item.mode)
    opt.textContent = item.label
    select.appendChild(opt)
  }
  select.value = String(mode)

  // 右侧单行输入
  const field = document.createElement('input')
  field.className = 'edrv-bpwidget-input'
  field.spellcheck = false

  root.appendChild(select)
  root.appendChild(field)

  /** 当前模式正文（等待断点模式无正文）。 */
  const currentText = (): string => {
    const key = fieldOfMode(mode)
    return key ? remembered[key] : ''
  }

  /** 模式切换：先记忆当前，再套用新模式的正文与占位。 */
  const applyMode = (): void => {
    const key = fieldOfMode(mode)
    const item = MODES.find((m) => m.mode === mode)
    field.value = currentText()
    field.placeholder = item?.placeholder ?? ''
    field.hidden = key === null
    select.value = String(mode)
    if (key !== null) { try { field.focus(); field.select() } catch { /* 忽略 */ } }
  }

  /** 记忆当前正文。 */
  const remember = (): void => {
    const key = fieldOfMode(mode)
    if (!key) return
    remembered[key] = field.value
  }

  /** 提交：记忆全部字段并回调。 */
  const save = (): void => {
    remember()
    input.onSave({ ...remembered })
  }

  select.addEventListener('change', () => {
    remember()
    mode = Number(select.value)
    applyMode()
  })
  // 输入框/下拉内点击：preventDefault 阻止 Monaco 抢焦（浏览器默认聚焦被取消后由
  // 显式 focus 补上），保证"点进去一定能输入"。
  const keepFocus = (ev: MouseEvent): void => {
    ev.preventDefault()
    ev.stopPropagation()
    const el = ev.currentTarget === select ? select : field
    try { el.focus() } catch { /* 忽略 */ }
  }
  field.addEventListener('mousedown', keepFocus)
  select.addEventListener('mousedown', keepFocus)

  const onKeyDown = (ev: KeyboardEvent): void => {
    ev.stopPropagation()
    if (ev.key === 'Enter') { ev.preventDefault(); save(); return }
    if (ev.key === 'Escape') { ev.preventDefault(); input.onClose() }
  }
  field.addEventListener('keydown', onKeyDown)
  select.addEventListener('keydown', onKeyDown)

  // ---- 全局接管（浮层存活期间）----
  // ① window 级 Enter/Esc：焦点被编辑器抢走后仍可确认/取消（对齐 VS Code 的
  //    acceptInput primary:Enter 与 closeBreakpointWidget primary:Escape 全局命令）。
  // ② 编辑器内点击浮层之外 → 关闭浮层（对齐 VS Code：点击别处即收起，想改重新右键）。
  // ③ document 级 mousedown 捕获：浮层内点击阻断 Monaco 抢焦；输入框/下拉点进去可控。
  const onWindowKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); save(); return }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); input.onClose() }
  }
  const onEditorMouseDown = (ev: MouseEvent): void => {
    const target = ev.target as Node | null
    if (target && root.contains(target)) return
    input.onClose()
  }
  const onDocMouseDownCapture = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement | null
    if (!target) return
    if (root.contains(target)) {
      if (target !== field && target !== select) {
        ev.preventDefault()
        ev.stopPropagation()
        try { field.focus() } catch { /* 忽略 */ }
      }
      return
    }
    // 浮层之外的点击（含编辑器正文/行号/glyph）→ 关闭（对齐 VS Code）
    if ((editor as { getDomNode?: () => HTMLElement | null })?.getDomNode?.()?.contains(target)) input.onClose()
  }
  window.addEventListener('keydown', onWindowKey, true)
  document.addEventListener('mousedown', onDocMouseDownCapture, true)
  const editorDom = (editor as { getDomNode?: () => HTMLElement | null })?.getDomNode?.()
  editorDom?.addEventListener('mousedown', onEditorMouseDown)
  applyMode()

  /** 关闭时解除全局接管（close 内调用）。 */
  const detachGlobal = (): void => {
    window.removeEventListener('keydown', onWindowKey, true)
    document.removeEventListener('mousedown', onDocMouseDownCapture, true)
    editorDom?.removeEventListener('mousedown', onEditorMouseDown)
  }

  // 挂 View Zone（推开内容）并把浮层铺满整个编辑区宽度。
  // ⚠️ Monaco 的 .view-zones 容器宽度只有内容区（contentWidth，从 contentLeft 起），
  //    而 VS Code 的 zone-widget 整宽 = width - minimapWidth - verticalScrollbarWidth
  //    （见其 `_getWidth`）。这里用负 left + 显式宽度补偿 contentLeft 与右侧滚动条。
  const syncWidth = (): void => {
    const layout = (editor as { getLayoutInfo?: () => Record<string, unknown> } | null)?.getLayoutInfo?.()
    if (!layout) return
    const contentLeft = Number(layout.contentLeft) || 0
    const scrollbarWidth = Number((layout as { verticalScrollbarWidth?: number }).verticalScrollbarWidth) || 0
    const width = contentLeft + (Number(layout.contentWidth) || 0) + scrollbarWidth
    // 用 important 覆盖 Monaco addZone 写入的内联 `width:100%` / `left:0` / `display:block`。
    // display 必须是 flex，否则子项不参与 flex 布局、输入框只剩默认宽度（用户反馈"输入框太短"）。
    // 注意：Monaco 在 addZone 之后仍可能重写内联样式，故此处由 onComputedHeight 反复调用兜住。
    root.style.setProperty('left', -contentLeft + 'px', 'important')
    root.style.setProperty('width', width + 'px', 'important')
    root.style.setProperty('display', 'flex', 'important')
    root.style.setProperty('align-items', 'center', 'important')
    // 行内元素从编辑器最左（行号列）开始，右侧留出滚动条宽度（对齐 VS Code zone-widget 起始位）
    root.style.setProperty('padding-left', '4px', 'important')
    root.style.setProperty('padding-right', (scrollbarWidth + 6) + 'px', 'important')
  }
  // 挂 View Zone（推开内容）并把浮层铺满整个编辑区宽度。
  // ⚠️ Monaco 的 addZone 会用内联样式强制 `width: 100%`（= .view-zones 内容区宽，不含
  //    glyph/行号/装饰列与右侧滚动条），直接设宽度会被覆盖。对齐 VS Code：在其
  //    `onComputedHeight`（每次布局回调）里重新套用整宽 = width - minimapWidth - scrollbarWidth。
  ed?.changeViewZones?.((accessor) => {
    zoneId = accessor.addZone({
      afterLineNumber: input.line,
      heightInLines: 1.6,
      domNode: root,
      afterColumnAffinity: 1,
      onComputedHeight: () => syncWidth(),
    })
  })
  setEditingLine(ed, input.line)
  // addZone 首次布局晚于本行；且 Monaco 之后仍可能重写内联样式（display/width），
  // 故布局回调 + 首帧 + 短周期守卫（浮层存活期间，关闭即停）三处兜住。
  setTimeout(() => { if (!closed) syncWidth() }, 0)
  const guard = setInterval(() => {
    if (closed) { clearInterval(guard); return }
    syncWidth()
  }, 250)
  setTimeout(() => clearInterval(guard), 3000).unref?.()

  const close = (): void => {
    if (closed) return
    closed = true
    detachGlobal()
    setEditingLine(ed, null)
    if (zoneId) {
      const id = zoneId
      zoneId = null
      try { ed?.changeViewZones?.((accessor) => accessor.removeZone(id)) } catch { /* 编辑器可能已销毁 */ }
    }
    try { root.remove() } catch { /* 忽略 */ }
  }

  // 首帧后聚焦（有输入框时聚焦输入框，否则聚焦下拉）
  setTimeout(() => {
    if (closed) return
    try { (fieldOfMode(mode) ? field : select).focus?.() } catch { /* 忽略 */ }
  }, 0)

  return { close }
}
