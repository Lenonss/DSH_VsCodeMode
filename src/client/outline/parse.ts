/**
 * dsh-vscode-mode client — 大纲兜底解析器（纯函数，无 DOM/Monaco 依赖，node 可测）。
 * 覆盖无内置 document symbol provider 的语言：markdown/mdx、python、shell、powershell、
 * lua、go、rust、yaml、ini(toml)、花括号语言（c/cpp/csharp/java/php/ruby/kotlin/swift/dart）。
 * TS/JS/JSON/CSS/HTML 有 Monaco 原生 provider，不走这里。
 * 作者 ddj 2026-08-27
 */
import type { OutlineSymbol } from './types.js'

/** monaco SymbolKind 数值常量（与 LSP SymbolKind 一致，面板渲染按此分组）。 */
export const SK = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
  Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
  Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
  Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
  Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
} as const

/** 花括号语言的泛型函数名排除集（避免误把控制流/关键字当符号）。 */
const BRACE_KW = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'foreach', 'using', 'with', 'when',
  'match', 'return', 'new', 'in', 'of', 'do', 'else', 'elif', 'then', 'yield',
  'await', 'typeof', 'instanceof', 'case', 'default', 'try', 'finally', 'throw',
])

/** 花括号语言的类型关键字 → SymbolKind。 */
const BRACE_TYPE_KIND: Record<string, number> = {
  class: SK.Class, struct: SK.Struct, interface: SK.Interface, enum: SK.Enum,
  namespace: SK.Namespace, module: SK.Module, trait: SK.Interface, record: SK.Class,
}

/** 按文档序（先序）补齐每个符号的 endLine：叶子取“下一个符号起行 - 1”，容器取末子 endLine。 */
function computeEnds(symbols: OutlineSymbol[], lastLine: number): void {
  const order: OutlineSymbol[] = []
  const collect = (list: OutlineSymbol[]): void => {
    for (const s of list) {
      order.push(s)
      if (s.children && s.children.length) collect(s.children)
    }
  }
  collect(symbols)
  for (let i = order.length - 1; i >= 0; i--) {
    const s = order[i]
    const kids = s.children ?? []
    if (kids.length) {
      s.endLine = Math.max(s.startLine, kids[kids.length - 1].endLine)
    } else {
      const next = order[i + 1]
      const end = next ? Math.max(s.startLine, next.startLine - 1) : lastLine
      s.endLine = Math.max(s.startLine, Math.min(end, lastLine))
    }
  }
}

/** 构造单行符号（起始行=跳转行=所在行；detail 为截断后的声明文本）。 */
function mk(lineIndex: number, name: string, kind: number, raw: string): OutlineSymbol {
  const detail = raw.trim().replace(/\s+/g, ' ').slice(0, 80)
  const line = lineIndex + 1
  const out: OutlineSymbol = { name, kind, startLine: line, endLine: line, selectLine: line }
  if (detail && detail !== name) out.detail = detail
  return out
}

/** Markdown/mdx：`#` 级标题，层级嵌套。 */
function parseMarkdown(text: string): OutlineSymbol[] {
  const roots: OutlineSymbol[] = []
  const stack: Array<{ level: number; item: OutlineSymbol }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i])
    if (!m) continue
    const item: OutlineSymbol = {
      name: m[2].trim(), kind: SK.Namespace,
      startLine: i + 1, endLine: i + 1, selectLine: i + 1, children: [],
    }
    while (stack.length && stack[stack.length - 1].level >= m[1].length) stack.pop()
    const parent = stack.length ? stack[stack.length - 1].item : null
    ;(parent ? parent.children : roots)!.push(item)
    stack.push({ level: m[1].length, item })
  }
  computeEnds(roots, lines.length)
  return roots
}

/** Python：def/class 按缩进栈嵌套。 */
function parsePython(text: string): OutlineSymbol[] {
  const roots: OutlineSymbol[] = []
  const stack: Array<{ indent: number; item: OutlineSymbol }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)(?:class|def)\s+([A-Za-z_]\w*)\s*[(:]/.exec(lines[i])
    if (!m) continue
    const indent = m[1].replace(/\t/g, '  ').length
    const isClass = /class\s/.test(lines[i])
    const item: OutlineSymbol = {
      name: m[2], kind: isClass ? SK.Class : SK.Function,
      startLine: i + 1, endLine: i + 1, selectLine: i + 1, children: [],
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack.length ? stack[stack.length - 1].item : null
    ;(parent ? parent.children : roots)!.push(item)
    stack.push({ indent, item })
  }
  computeEnds(roots, lines.length)
  return roots
}

/** Shell：`name() {` 函数。 */
function parseShell(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(\)[ \t]*\{/.exec(lines[i])
    if (m) out.push(mk(i, m[1], SK.Function, lines[i]))
  }
  computeEnds(out, lines.length)
  return out
}

/** PowerShell：`function Name {` / `filter Name {`。 */
function parsePwsh(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^[ \t]*(?:function|filter)[ \t]+([\w.-]+)/.exec(lines[i])
    if (m) out.push(mk(i, m[1], SK.Function, lines[i]))
  }
  computeEnds(out, lines.length)
  return out
}

/** Lua：`function Foo:bar` / `M.bar = class|function`。 */
function parseLua(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*--/.test(line)) continue
    const fm = /^[ \t]*(?:local[ \t]+)?function[ \t]+([A-Za-z_][\w.:]*)/.exec(line)
    if (fm) { out.push(mk(i, fm[1], SK.Function, line)); continue }
    const cm = /^[ \t]*([A-Za-z_][\w.]*)[ \t]*=[ \t]*(?:class|function)\b/.exec(line)
    if (cm) out.push(mk(i, cm[1], /class\b/.test(line) ? SK.Class : SK.Function, line))
  }
  computeEnds(out, lines.length)
  return out
}

/** Go：func（含 receiver）/ type。 */
function parseGo(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const fm = /^[ \t]*func[ \t]+(?:\([^)]*\)[ \t]*)?([A-Za-z_]\w*)/.exec(lines[i])
    if (fm) { out.push(mk(i, fm[1], SK.Function, lines[i])); continue }
    const tm = /^[ \t]*type[ \t]+([A-Za-z_]\w*)/.exec(lines[i])
    if (tm) out.push(mk(i, tm[1], SK.Struct, lines[i]))
  }
  computeEnds(out, lines.length)
  return out
}

/** Rust：fn/struct/enum/trait/impl/mod/type。 */
function parseRust(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const lines = text.split('\n')
  const kindOf: Record<string, number> = {
    fn: SK.Function, struct: SK.Struct, enum: SK.Enum, trait: SK.Interface,
    impl: SK.Module, mod: SK.Module, type: SK.TypeParameter,
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(fn|struct|enum|trait|impl|mod|type)[ \t]+([A-Za-z_]\w*)/.exec(lines[i])
    if (m && kindOf[m[1]]) out.push(mk(i, m[2], kindOf[m[1]], lines[i]))
  }
  computeEnds(out, lines.length)
  return out
}

/** YAML：仅顶层键。 */
function parseYaml(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s/.test(line) || /^\s*[#-]/.test(line)) continue
    const m = /^([A-Za-z0-9_.\-]+)\s*:/.exec(line)
    if (m) out.push(mk(i, m[1], SK.Key, line))
  }
  computeEnds(out, lines.length)
  return out
}

/** INI/TOML：`[section]` + `key=value`。 */
function parseIni(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*[;#]/.test(line)) continue
    const sm = /^\[([^\]]+)\]/.exec(line)
    if (sm) { out.push(mk(i, sm[1], SK.Namespace, line)); continue }
    const km = /^([A-Za-z0-9_.\-]+)\s*[=:]/.exec(line.trim())
    if (km) out.push(mk(i, km[1], SK.Key, line))
  }
  computeEnds(out, lines.length)
  return out
}

/** 花括号语言（C 族/JVM/.NET）：类型声明 + 泛型函数扫描（扁平，best-effort）。 */
function parseBrace(text: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = []
  const lines = text.split('\n')
  const typeRe = /^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|sealed|readonly|export|declare|async|open|extern|virtual|override|const|global|pub|local)\s+)*(class|struct|interface|enum|namespace|module|trait|record)\s+([A-Za-z_]\w*)/
  // 泛型函数：允许任意“字词型”返回类型/修饰符前缀（含 :: 限定名），名字后跟 ( 且不以 ; 结尾
  const funcRe = /^[ \t]*(?:[\w<>,*&\[\].:]+\s+)*([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (!t || /^\s*\*/.test(line)) continue
    const tm = typeRe.exec(line)
    if (tm) { out.push(mk(i, tm[2], BRACE_TYPE_KIND[tm[1]] ?? SK.Class, line)); continue }
    const fm = funcRe.exec(line)
    if (!fm) continue
    if (BRACE_KW.has(fm[1]) || /;\s*$/.test(t)) continue
    out.push(mk(i, fm[1], SK.Function, line))
  }
  computeEnds(out, lines.length)
  return out
}

/**
 * 按 Monaco languageId 解析大纲符号（纯函数）。
 * @author ddj 2026年08月27号
 * @param languageId Monaco 语言 id
 * @param text 文件全文
 * @returns 归一化大纲符号树
 */
export function parseOutline(languageId: string, text: string): OutlineSymbol[] {
  switch (languageId) {
    case 'markdown':
    case 'mdx':
      return parseMarkdown(text)
    case 'python':
      return parsePython(text)
    case 'shell':
      return parseShell(text)
    case 'powershell':
      return parsePwsh(text)
    case 'lua':
      return parseLua(text)
    case 'go':
      return parseGo(text)
    case 'rust':
      return parseRust(text)
    case 'yaml':
      return parseYaml(text)
    case 'ini':
      return parseIni(text)
    case 'c':
    case 'cpp':
    case 'csharp':
    case 'java':
    case 'php':
    case 'ruby':
    case 'kotlin':
    case 'swift':
    case 'dart':
      return parseBrace(text)
    default:
      return []
  }
}
