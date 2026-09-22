/**
 * dsh-vscode-mode client — Monaco 调试装饰：断点圆点（gutter）与停帧行高亮。
 * 装饰 id 挂在 editor 实例属性上（与 diffRender/underline/navFlash 同款隔离模式），
 * 独立 collection 互不干扰；range 用 IRange 形状普通对象（Monaco 内部归一化，
 * 与 navFlashRangeOf 产物同口径）；编辑器销毁时装饰随实例消失，无需显式清理。
 * 作者 ddj 2026年09月29号
 */

/** editor 上的装饰 id 槽位 key。 */
const BP_KEY = '__edrvDapBpDecorations'
const PAUSED_KEY = '__edrvDapPausedDecorations'
const EDITING_KEY = '__edrvDapEditingDecorations'
const HINT_KEY = '__edrvDapHintDecorations'
/** 当前 hover 预览行（避免同一行重复设置装饰）。 */
const HINT_LINE = '__edrvDapHintLine'

/** Monaco editor 最小子集（deltaDecorations 旧 API，工程内既有口径）。 */
interface DecoEditor {
  deltaDecorations(oldIds: string[], next: unknown[]): string[]
}

/** IRange 形状普通对象。 */
function lineRange(line: number): unknown {
  return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }
}

/**
 * 应用断点装饰（全量替换：启用行红点 + 未验证行空心红圈 + 禁用行灰点）。
 * 未验证 = 适配器真实回执 verified:false（如该行无可执行代码），对齐 VS Code 空心圆语义。
 * @author ddj 2026年09月29号 / 2026年09月21号
 * @param editor Monaco 编辑器
 * @param enabledLines 启用断点行
 * @param disabledLines 禁用断点行
 * @param unverifiedLines 启用但未验证的行（缺省视为全部已验证）
 */
export function applyBpDecorations(editor: unknown, enabledLines: number[], disabledLines: number[], unverifiedLines: readonly number[] = []): void {
  const ed = editor as DecoEditor | null
  if (!ed?.deltaDecorations) return
  const make = (line: number, cls: string) => ({
    range: lineRange(line),
    options: { isWholeLine: true, glyphMarginClassName: cls, glyphMarginHoverMessage: { value: '断点（点击行首圆点处切换）' } },
  })
  const next = [
    ...enabledLines.map((line) => make(line, unverifiedLines.includes(line) ? 'edrv-dap-bp-unverified' : 'edrv-dap-bp')),
    ...disabledLines.map((line) => make(line, 'edrv-dap-bp-off')),
  ]
  const slot = ed as unknown as Record<string, unknown>
  const prev = slot[BP_KEY] as string[] | undefined
  slot[BP_KEY] = ed.deltaDecorations(prev ?? [], next)
}

/**
 * 设置停帧行装饰（null/0 清除；整行浅底 + gutter 箭头）。
 * @author ddj 2026年09月29号
 * @param editor Monaco 编辑器
 * @param line 停帧行
 */
export function setPausedLine(editor: unknown, line: number | null): void {
  const ed = editor as DecoEditor | null
  if (!ed?.deltaDecorations) return
  const slot = ed as unknown as Record<string, unknown>
  const prev = slot[PAUSED_KEY] as string[] | undefined
  if (!line) {
    if (prev?.length) ed.deltaDecorations(prev, [])
    slot[PAUSED_KEY] = []
    return
  }
  slot[PAUSED_KEY] = ed.deltaDecorations(prev ?? [], [{
    range: lineRange(line),
    options: {
      isWholeLine: true,
      className: 'edrv-dap-paused-line',
      glyphMarginClassName: 'edrv-dap-paused-glyph',
    },
  }])
}

/**
 * 设置「断点编辑中」目标行高亮（打开行内浮层期间；null 清除）。
 * 对齐 VS Code：编辑断点时目标行整行高亮，明确正在编辑哪一行。
 * @author ddj 2026年09月29号
 * @param editor Monaco 编辑器
 * @param line 目标行（null 清除）
 */
export function setEditingLine(editor: unknown, line: number | null): void {
  const ed = editor as DecoEditor | null
  if (!ed?.deltaDecorations) return
  const slot = ed as unknown as Record<string, unknown>
  const prev = slot[EDITING_KEY] as string[] | undefined
  if (!line) {
    if (prev?.length) ed.deltaDecorations(prev, [])
    slot[EDITING_KEY] = []
    return
  }
  slot[EDITING_KEY] = ed.deltaDecorations(prev ?? [], [{
    range: lineRange(line),
    options: { isWholeLine: true, className: 'edrv-dap-editing-line' },
  }])
}

/**
 * 设置 glyph 区 hover 预览断点（半透明小红点；null 清除）。
 * 对齐 VS Code：鼠标悬停在可下断点的行首区域时，显示低透明度断点预览 + pointer 光标
 * （其 `.codicon-debug-hint { cursor: pointer; opacity: .4 }` 同源语义）。
 * 同一行重复调用直接返回（onMouseMove 高频，避免无谓装饰抖动）。
 * @author ddj 2026年09月29号
 * @param editor Monaco 编辑器
 * @param line 预览行（null/0 清除）
 */
export function setHintLine(editor: unknown, line: number | null): void {
  const ed = editor as DecoEditor | null
  if (!ed?.deltaDecorations) return
  const slot = ed as unknown as Record<string, unknown>
  const current = (slot[HINT_LINE] as number | undefined) ?? 0
  const next = line ?? 0
  if (current === next) return
  slot[HINT_LINE] = next
  const prev = slot[HINT_KEY] as string[] | undefined
  if (!next) {
    if (prev?.length) ed.deltaDecorations(prev, [])
    slot[HINT_KEY] = []
    return
  }
  slot[HINT_KEY] = ed.deltaDecorations(prev ?? [], [{
    range: lineRange(next),
    options: { isWholeLine: true, glyphMarginClassName: 'edrv-dap-bp-hint' },
  }])
}
