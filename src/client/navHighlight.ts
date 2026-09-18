/**
 * dsh-vscode-mode client — 跳转目标高亮区间推导（纯函数，不依赖 monaco/DOM）。
 *
 * 背景：Monaco 原生跳转在 resolve 出定义后会把选区 `collapseToStart` 再交给 opener，
 * 于是插件拿到的是**零宽区间**（start === end）。零宽 range 挂装饰渲染不出任何可见
 * 高亮（实测 Ctrl+点击枚举成员后 `.edrv-nav-target` 存在但无视觉效果）。因此必须把
 * 零宽识别为「无区间」，并逐级回落：opener 区间 → 光标处单词 → 整行。
 * 抽成纯函数便于单测（EditorView 是 React 组件，node 侧不可直接引入）。
 * 作者 ddj 2026-09-17
 */

/** 推导所需的最小 model 能力（Monaco ITextModel 子集，测试可桩）。 */
export interface NavFlashModel {
  getLineCount(): number
  getLineMaxColumn(lineNumber: number): number
  /**
   * Monaco 实返 `{ word, startColumn, endColumn }` —— **不含** startLineNumber/endLineNumber。
   * 类型里把行号标为可选，正是为了强制调用方用当前行补齐（曾因直接透传 undefined
   * 行号产出非法装饰区间，装饰已挂但渲染不出任何高亮）。
   */
  getWordAtPosition(pos: { lineNumber: number; column: number }):
    | {
        word?: string
        startColumn: number
        endColumn: number
        startLineNumber?: number
        endLineNumber?: number
      }
    | null
}

/** 跳转目标（1-based；endLine/endColumn 缺省表示未提供区间）。 */
export interface NavFlashTarget {
  line?: number
  column?: number
  endLine?: number | null
  endColumn?: number | null
}

/** 高亮区间（Monaco IRange 形状，1-based）。 */
export interface NavFlashRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/**
 * 推导跳转目标的高亮区间。
 *
 * 逐级回落：① opener 提供的**非零宽**区间（原样夹到文档范围）；
 * ② 光标处单词（LSP 折叠选区的常态，高亮标识符本身最易辨认）；
 * ③ 整行（符号位置无单词可取时的兜底，保证一定可见）。
 * @author ddj 2026年09月17号
 * @param model 文本模型（或等价桩）
 * @param target 跳转目标
 * @returns 可渲染的高亮区间；model 不可用时返回 null
 */
export function navFlashRangeOf(model: NavFlashModel | null | undefined, target: NavFlashTarget | null | undefined): NavFlashRange | null {
  if (!model || !target) return null
  const lineCount = model.getLineCount()
  if (!Number.isFinite(lineCount) || lineCount < 1) return null
  const startLine = Math.max(1, Math.min(lineCount, Math.floor(target.line ?? 1) || 1))
  const startColumn = Math.min(Math.max(1, Math.floor(target.column ?? 1) || 1), model.getLineMaxColumn(startLine))

  const endLineRaw = target.endLine == null ? null : Math.floor(target.endLine)
  const endColumnRaw = target.endColumn == null ? null : Math.floor(target.endColumn)
  // 零宽（start === end）与缺字段一并视为「无区间」：零宽装饰不可见，必须回落
  const hasRange = endLineRaw != null && endColumnRaw != null &&
    (endLineRaw > startLine || endColumnRaw > startColumn)
  if (hasRange) {
    const endLineNumber = Math.max(startLine, Math.min(lineCount, endLineRaw))
    const endColumn = Math.max(1, Math.min(model.getLineMaxColumn(endLineNumber), endColumnRaw))
    return { startLineNumber: startLine, startColumn, endLineNumber, endColumn }
  }

  const word = model.getWordAtPosition({ lineNumber: startLine, column: startColumn })
  if (word && word.endColumn > word.startColumn) {
    // ⚠️ Monaco getWordAtPosition 不返回行号，必须用当前行补齐；直接透传 undefined
    // 会产出 startLineNumber=undefined 的非法区间——装饰挂上了却渲染不出高亮（实测踩坑）。
    const wordStartLine = word.startLineNumber ?? startLine
    const wordEndLine = word.endLineNumber ?? startLine
    return {
      startLineNumber: wordStartLine,
      startColumn: word.startColumn,
      endLineNumber: wordEndLine,
      endColumn: word.endColumn,
    }
  }
  return {
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: startLine,
    endColumn: model.getLineMaxColumn(startLine),
  }
}
