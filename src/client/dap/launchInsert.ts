/**
 * dsh-vscode-mode client — launch.json「添加配置」插入定位与插入文本构造（纯函数，node 可测）。
 * 插入语义对齐 VS Code「添加配置」：光标落在 `"configurations": [` 下一行行首
 * （单行数组落在 `[ 后），新配置插到数组开头；插入文本自带缩进与尾逗号，按纯文本插入
 * （不用 Monaco snippet 语法——${file}/${workspaceFolder} 是 DAP 运行期变量，必须原样落盘）。
 * needComma/缩进从「光标之后的结构」探测：键入过滤词不污染判断（词本身在光标前已被越过）。
 * 作者 ddj 2026年09月22号
 */
import { DAP_LAUNCH_REL } from '../../shared/dap.js'

/** launch.json 键行（容忍单行 `{"configurations": [` 形态；match[0] 恒以 `[ 结尾）。 */
const CONFIG_KEY_RE = /^\s*\{?\s*"configurations"\s*:\s*\[/

/** 调试配置文件路径判定（由共享 DAP_LAUNCH_REL 动态构造防漂移；工作区相对与绝对路径同口径）。 */
export const LAUNCH_JSON_RE = new RegExp(
  '(^|\\/)' + DAP_LAUNCH_REL.split('/').map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\/') + '$',
  'i',
)

/** 编辑器光标位置（1-based，Monaco 口径）。 */
interface CursorPos {
  lineNumber: number
  column: number
}

/** 数组插入定位结果。 */
export interface ConfigInsertPos {
  /** 插入起始行（1-based；多行数组 = "configurations" 行的下一行）。 */
  line: number
  /** 插入起始列（1-based；多行数组 = 1，单行数组 = `[ 后一列）。 */
  column: number
  /** 新元素行缩进字符串。 */
  indent: string
  /** 缩进单元字符串（'  ' / '    ' / '\t'，body 重排用）。 */
  unit: string
  /** 插入点后已有元素 → 新元素后需补逗号。 */
  needComma: boolean
  /** 单行数组（光标在 configurations 行内）→ 插入文本首尾自带换行/收尾缩进。 */
  inline: boolean
  /** configurations 行缩进（inline 收尾对齐 `]` 用）。 */
  cfgIndent: string
}

/**
 * 定位 launch.json configurations 数组的插入点。
 * @author ddj 2026年09月22号
 * @param text launch.json 全文（JSONC）
 * @param cursor 可选当前光标（补全触发时传入；needComma/缩进从光标后探测，忽略键入的过滤词）
 * @returns 插入定位；无 configurations 数组返回 null
 */
export function findArrayPos(text: string, cursor?: CursorPos): ConfigInsertPos | null {
  const lines = text.split('\n')
  const keyLine = lines.findIndex((line) => CONFIG_KEY_RE.test(line))
  if (keyLine < 0) return null
  const cfgLine = lines[keyLine]
  const match = CONFIG_KEY_RE.exec(cfgLine)
  if (!match) return null
  const bracketIdx = match.index + match[0].length - 1
  const cfgIndent = /^[ \t]*/.exec(cfgLine)?.[0] ?? ''
  const lineStarts = lineStartOffsets(lines)
  const eof = keyLine + 1 >= lines.length
  const keyRest = text.slice(lineStarts[keyLine] + bracketIdx + 1, lineStarts[keyLine] + cfgLine.length)
  const inline = eof || firstSignificant(keyRest, 0) !== null
  const scanFrom = resolveScanFrom(lineStarts, lines, cursor, inline, keyLine, bracketIdx)
  const sig = firstSignificant(text, scanFrom)
  const hasContent = sig !== null && sig.char !== ']'
  const elemIndent = sig !== null && !inline ? trailingWsBefore(text, lineStarts, sig.index) : ''
  const unit = unitOf(cfgIndent, inline ? '' : elemIndent)
  const indent = hasContent && elemIndent ? elemIndent : cfgIndent + unit
  if (inline) {
    return {
      line: keyLine + 1,
      column: bracketIdx + 2,
      indent,
      unit,
      needComma: hasContent,
      inline: true,
      cfgIndent,
    }
  }
  return {
    line: keyLine + 2,
    column: 1,
    indent,
    unit,
    needComma: hasContent,
    inline: false,
    cfgIndent,
  }
}

/**
 * 构造插入文本（body 按目标 unit 重排缩进；多行数组首行带 indent、尾随逗号换行；
 * 单行数组首尾补换行并回填 cfgIndent，让原 `] 落到对齐列）。
 * @author ddj 2026年09月22号
 * @param pos 插入定位
 * @param bodyText 片段主体 JSON 文本（host 已 nls 解析，2 空格缩进）
 * @returns 插入到 (line, column) 的完整文本
 */
export function buildInsertText(pos: ConfigInsertPos, bodyText: string): string {
  const body = reindentBody(bodyText, pos.unit)
  const indented = body.split('\n').map((line) => pos.indent + line).join('\n')
  const head = pos.inline ? '\n' : ''
  const tail = (pos.needComma ? ',' : '') + '\n' + (pos.inline ? pos.cfgIndent : '')
  return head + indented + tail
}

/** 首个有效字符（跳过空白与 // /* 注释；null = 到扫描尾）。 */
interface SigChar {
  /** 字符在全文（或扫描段）中的偏移。 */
  index: number
  /** 字符本身。 */
  char: string
}

function firstSignificant(text: string, from: number): SigChar | null {
  let i = Math.max(0, from)
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i + 1 < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i = Math.min(i + 2, n)
      continue
    }
    return { index: i, char: ch }
  }
  return null
}

/** 解析结构扫描起点：有光标（且未越界）从光标起——键入的过滤词在光标前被越过；否则从插入点起。 */
function resolveScanFrom(
  lineStarts: number[],
  lines: string[],
  cursor: CursorPos | undefined,
  inline: boolean,
  keyLine: number,
  bracketIdx: number,
): number {
  const defaultFrom = inline
    ? lineStarts[keyLine] + bracketIdx + 1
    : lineStarts[keyLine + 1] ?? textLen(lineStarts, lines)
  if (!cursor) return defaultFrom
  const lineIdx = cursor.lineNumber - 1
  if (!Number.isInteger(lineIdx) || lineIdx < 0 || lineIdx >= lines.length) return defaultFrom
  const column = Number.isFinite(cursor.column) && cursor.column >= 1 ? Math.floor(cursor.column) : 1
  return lineStarts[lineIdx] + column - 1
}

/** 全文长度（末行起始 + 末行长度；越界兜底 0）。 */
function textLen(lineStarts: number[], lines: string[]): number {
  const last = lines.length - 1
  return last >= 0 ? (lineStarts[last] ?? 0) + lines[last].length : 0
}

/** 每行起始偏移（含第 0 行 = 0）。 */
function lineStartOffsets(lines: string[]): number[] {
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  return starts
}

/** 偏移 → 行下标（二分；越界取末行）。 */
function lineIndexOf(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 目标偏移前、其所在行内的末尾空白串（= 该处真实缩进；"Em    {" 取 "    " 排除过滤词）。 */
function trailingWsBefore(text: string, lineStarts: number[], offset: number): string {
  const lineStart = lineStarts[lineIndexOf(lineStarts, offset)] ?? 0
  const prefix = text.slice(lineStart, Math.max(lineStart, offset))
  return /[\t ]*$/.exec(prefix)?.[0] ?? ''
}

/**
 * 探测缩进单元：元素行相对 configurations 行的增量优先，回退 configurations 行自身宽度。
 * @author ddj 2026年09月22号
 * @param cfgIndent configurations 行缩进
 * @param elemIndent 首个元素前的真实缩进（无元素线索传空串）
 * @returns 缩进单元字符串（缺省 2 空格）
 */
function unitOf(cfgIndent: string, elemIndent: string): string {
  if (elemIndent && elemIndent.startsWith(cfgIndent)) {
    const unit = elemIndent.slice(cfgIndent.length)
    if (unit && unit.length <= 8 && /^[\t ]+$/.test(unit)) return unit
  }
  if (cfgIndent.includes('\t')) return '\t'
  if (cfgIndent && /^ +$/.test(cfgIndent) && cfgIndent.length <= 8) return cfgIndent
  return '  '
}

/**
 * body 文本按目标 unit 重排缩进（2 空格基准 → 目标单元）。
 * @author ddj 2026年09月22号
 * @param bodyText JSON.stringify 产物（2 空格缩进）
 * @param unit 目标缩进单元
 * @returns 重排后文本
 */
function reindentBody(bodyText: string, unit: string): string {
  if (unit === '  ') return bodyText
  return bodyText
    .split('\n')
    .map((line) => {
      const spaces = /^[ ]*/.exec(line)?.[0].length ?? 0
      const depth = Math.floor(spaces / 2)
      return unit.repeat(depth) + line.slice(spaces)
    })
    .join('\n')
}
