/**
 * dsh-vscode-mode client — 规则 frontmatter 纯函数（解析 + 按类型改写）。
 * 与 host parseRuleMdc/ruleTypeOf 语义对齐的浏览器端实现：编辑器类型下拉与
 * 原始 .mdc 文本域双向同步共用；纯字符串运算，禁 node/react 导入。
 * 作者 ddj 2026年09月07号
 */

/** 规则生效类型（与 shared/rules.ts RuleType 一致，此处独立声明避免引入 host 依赖）。 */
export type RuleFmType = 'always' | 'auto' | 'manual'

/** 一条 .mdc 文本的解析结果（改写 frontmatter 所需的全部上下文）。 */
export interface RuleFmParsed {
  type: RuleFmType
  description: string
  alwaysApply: boolean
  globs: string[]
  enabled: boolean
  /** 是否存在规则 frontmatter（首行 --- 且有闭合）。 */
  hasFm: boolean
  /** 闭合 --- 之后的正文（按 \n 归一，与 host 解析一致）。 */
  body: string
  /** 已知键之外的 frontmatter 原行（如 updatedAt），改写时原样保留。 */
  fmExtra: string[]
  /** 原文是否带 BOM（改写后回填）。 */
  bom: boolean
  /** 原文 frontmatter 是否显式写了 enabled 行（改写时保持该行存在与否）。 */
  hasEnabledLine: boolean
}

/** 类型改写入参：下拉/描述/globs 控件的最新值。 */
export interface RuleMetaNext {
  type: RuleFmType
  description: string
  globs: string[]
}

/**
 * 去除值两侧成对引号（与 host stripQuotes 一致）。
 * @author ddj 2026年09月07号
 * @param raw 原始值
 * @returns 去引号后的值
 */
function stripQuotes(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

// --region 解析
/**
 * 解析 .mdc 全文：首行 --- 且 100 行内有闭合 --- 才视为 frontmatter；
 * 已知键 description/alwaysApply/globs/enabled，其余原行进 fmExtra；永不抛错。
 * @author ddj 2026年09月07号
 * @param text 文件全文
 * @returns 解析结果
 */
export function parseRuleFm(text: string): RuleFmParsed {
  const bom = text.startsWith('\uFEFF')
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const none: RuleFmParsed = { type: 'manual', description: '', alwaysApply: false, globs: [], enabled: true, hasFm: false, body: text.replace(/^\uFEFF/, ''), fmExtra: [], bom, hasEnabledLine: false }
  if (lines[0]?.trim() !== '---') return none
  let close = -1
  for (let i = 1; i < lines.length && i <= 101; i++) {
    if (lines[i].trim() === '---') { close = i; break }
  }
  if (close < 0) return none
  const parsed: RuleFmParsed = { type: 'manual', description: '', alwaysApply: false, globs: [], enabled: true, hasFm: true, body: lines.slice(close + 1).join('\n'), fmExtra: [], bom, hasEnabledLine: false }
  for (let i = 1; i < close; i++) {
    const match = /^([A-Za-z_-]+)[ \t]*:[ \t]?(.*)$/.exec(lines[i])
    if (!match) { parsed.fmExtra.push(lines[i]); continue }
    const [, key, raw] = match
    if (key === 'description') parsed.description = stripQuotes(raw)
    else if (key === 'alwaysApply') parsed.alwaysApply = stripQuotes(raw).toLowerCase() === 'true'
    else if (key === 'enabled') { parsed.enabled = stripQuotes(raw).toLowerCase() !== 'false'; parsed.hasEnabledLine = true }
    else if (key === 'globs') parsed.globs = parseGlobsValue(raw, lines, i, close)
    else parsed.fmExtra.push(lines[i])
  }
  parsed.type = fmTypeOf(parsed)
  return parsed
}

/**
 * 解析 globs 值：内联逗号分隔串，或空值后接 YAML 短横列表（与 host parseGlobs 一致）。
 * @author ddj 2026年09月07号
 * @param value 内联值
 * @param lines 全文行
 * @param start globs 行下标
 * @param close 闭合 --- 下标
 * @returns glob 数组
 */
function parseGlobsValue(value: string, lines: string[], start: number, close: number): string[] {
  const inline = stripQuotes(value)
  if (inline) return inline.split(',').map((item) => stripQuotes(item)).filter(Boolean)
  const list: string[] = []
  for (let j = start + 1; j < close; j++) {
    const item = /^[ \t]*-[ \t]*(.+)$/.exec(lines[j])
    if (!item) break
    list.push(stripQuotes(item[1]))
  }
  return list
}

/**
 * 由 frontmatter 推导类型：alwaysApply=true → 总是；有 globs → 自动；否则手动。
 * @author ddj 2026年09月07号
 * @param parsed 解析结果
 * @returns 规则类型
 */
function fmTypeOf(parsed: RuleFmParsed): RuleFmType {
  if (parsed.alwaysApply) return 'always'
  if (parsed.globs.length) return 'auto'
  return 'manual'
}
// --endregion

// --region 改写
/**
 * 按最新控件值重写 frontmatter：known 键固定顺序 + fmExtra + 闭合 --- + 原 body；
 * 无 frontmatter 且目标为手动时：有描述则新建仅含描述的 frontmatter，否则原文返回。
 * @author ddj 2026年09月07号
 * @param parsed parseRuleFm 的结果（必须来自同一文本）
 * @param next 控件最新值
 * @returns 重写后的全文
 */
export function applyRuleMeta(parsed: RuleFmParsed, next: RuleMetaNext): string {
  if (!parsed.hasFm && next.type === 'manual') {
    if (!next.description.trim()) return (parsed.bom ? '\uFEFF' : '') + parsed.body
    return (parsed.bom ? '\uFEFF' : '') + ['---', 'description: ' + next.description.trim(), '---'].join('\n') + '\n' + parsed.body
  }
  const lines: string[] = ['---']
  lines.push('description: ' + next.description.trim())
  if (next.type === 'always') lines.push('alwaysApply: true')
  if (next.type === 'auto') lines.push('globs: ' + next.globs.join(', '))
  if (parsed.hasEnabledLine) lines.push('enabled: ' + (parsed.enabled ? 'true' : 'false'))
  lines.push(...parsed.fmExtra)
  lines.push('---')
  return (parsed.bom ? '\uFEFF' : '') + lines.join('\n') + '\n' + parsed.body
}
// --endregion
