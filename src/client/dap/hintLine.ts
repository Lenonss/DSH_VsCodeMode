/**
 * dsh-vscode-mode client — 断点 hover 预览判定（纯函数，可单测）。
 * 对齐 VS Code `breakpointEditorContribution` 的 onMouseMove 分支：
 *   `(target.type === GUTTER_GLYPH_MARGIN || target.type === GUTTER_LINE_NUMBERS) &&
 *    canSetBreakpointsIn(model) && marginFreeFromNonDebugDecorations(line)` → 显示 hint。
 * 本插件口径：glyph 区（type=2）与行号区（type=3）且该行**尚无断点**时给出预览。
 * 作者 ddj 2026年09月29号
 */

/** Monaco MouseTargetType 相关值（实测 0.42-dev：GUTTER_GLYPH_MARGIN=2 / GUTTER_LINE_NUMBERS=3）。 */
export const TARGET_GUTTER_GLYPH = 2
export const TARGET_GUTTER_LINE = 3

/**
 * 判定 hover 是否应显示断点预览，返回预览行号（0 = 不显示）。
 * @author ddj 2026年09月29号
 * @param targetType Monaco 鼠标目标类型
 * @param line 目标行号（0/undefined = 无）
 * @param existingLines 当前文件已有断点的行号集合
 * @returns 预览行号；0 表示不显示
 */
export function hintLineFor(targetType: number | undefined, line: number | undefined, existingLines: readonly number[]): number {
  if (targetType !== TARGET_GUTTER_GLYPH && targetType !== TARGET_GUTTER_LINE) return 0
  const target = Math.floor(Number(line) || 0)
  if (target < 1) return 0
  // 已有断点的行不显示预览（避免与实心红点重叠）
  if (existingLines.includes(target)) return 0
  return target
}
