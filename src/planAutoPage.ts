/**
 * dsh-vscode-mode host — HTML 计划模式的计划页渲染。
 *
 * 模型不写作者页（或写失败）时，用提交给 `exit_html_plan_mode` 的计划 Markdown 生成一页
 * htmlplan 风格的标准计划页：标题 → 为什么 → 主张树（doc-claim）→ 待拍板决策（doc-ask）→ 不改什么。
 * 解析容错优先：小节标题按关键词识别（为什么 / 决策 / 不改什么），识别不到就退回文档式渲染。
 *
 * 这样「计划页长什么样」由插件决定，不依赖模型写自定义 HTML——弱模型（含 GPT 系列）只交
 * Markdown 也能得到同样的版式；样式与脚本仍内联技能自带的运行时，页面不读工作区文件。
 * @author ddj 2026年11月25号（初版：文档式兜底页）
 * @author ddj 2026年11月26号（改为结构化计划页：主张树 + 决策 + 不改什么）
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { skillsDirOf } from './paths.js'

//region 结构面

/** 计划运行时资产。 */
export interface PlanRuntimeAssets {
  /** htmlplan.css 原文。 */
  css: string
  /** htmlplan.js 原文。 */
  js: string
}

/** 计划正文块种类。 */
export type PlanBlockKind = 'paragraph' | 'list' | 'code' | 'quote' | 'table' | 'rule'

/** 计划列表项（可嵌套）。 */
export interface PlanItem {
  /** 该项文本。 */
  text: string
  /** 子项。 */
  children: PlanItem[]
}

/** 计划正文块。 */
export interface PlanBlock {
  kind: PlanBlockKind
  /** 段落 / 引用 / 代码正文。 */
  text: string
  /** 代码语言。 */
  lang: string
  /** 列表是否有序。 */
  ordered: boolean
  /** 列表项。 */
  items: PlanItem[]
  /** 表格表头。 */
  head: string[]
  /** 表格数据行。 */
  rows: string[][]
}

/** 小节类别。 */
export type PlanSectionKind = 'why' | 'decision' | 'scope' | 'claim'

/** 小节：h2 给主体，h3 及其后作子主张。 */
export interface PlanSection {
  kind: PlanSectionKind
  /** 规范化后的标题。 */
  title: string
  /** 本节正文块。 */
  blocks: PlanBlock[]
  /** 子小节（按主张处理）。 */
  subs: PlanSection[]
}

/** 待拍板的决策。 */
export interface PlanChoice {
  /** 决策问题。 */
  question: string
  /** 选项（≥2 才画单选框；否则留自由填写框）。 */
  options: string[]
}

/** 解析后的计划正文。 */
export interface PlanDoc {
  title: string
  intro: PlanBlock[]
  why: string[]
  claims: PlanSection[]
  choices: PlanChoice[]
  choicesTitle: string
  scope: PlanSection | null
}

/** 解析用的草稿小节（还没解析正文块）。 */
interface DraftSection {
  title: string
  lines: string[]
  subs: Array<{ title: string; lines: string[] }>
}

//endregion

//region 常量

/** 计划正文上限：超过直接报错，避免把超大文本塞进 iframe。 */
export const AUTO_PAGE_MARKDOWN_CAP = 256 * 1024

/** 技能名（随包目录）。 */
const SKILL_DIR = 'dsh-vscodemode-html-plan'

/** 计划页标记行（作者页声明），自动页里必须剥掉。 */
const PAGE_MARK_LINE = /^[ \t]*HTML[ \t]*计划页[ \t]*[:：].*$/gim

/**
 * 小节分类关键词：只认标题开头，避免「文字按效果图选择 TMP 样式」被当成决策小节。
 */
const SCOPE_HEAD = /^(?:不改|不做|范围外|非目标|不动|out of scope|not doing|non-goal|unchanged)/i
const WHY_HEAD = /^(?:为什么|为啥|背景|诉求|动机|目标|痛点|why|context|goals?|motivation|background|problem)/i
const DECIDE_HEAD = /^(?:待)?(?:决策|拍板|定夺|确认|选择项|开放问题|待定|需要你|需要我|请你|open question|decision|choice)/i

//endregion

//region 运行时资产

let assetsCache: Promise<PlanRuntimeAssets> | null = null

/**
 * 读取技能自带的 htmlplan 运行时（进程内缓存；失败不缓存，便于重试）。
 * @author ddj 2026年11月25号
 * @returns 样式与脚本原文
 */
export function planRuntimeAssets(): Promise<PlanRuntimeAssets> {
  if (!assetsCache) {
    const dir = join(skillsDirOf(import.meta.url), SKILL_DIR, 'runtime')
    assetsCache = Promise.all([
      readFile(join(dir, 'htmlplan.css'), 'utf8'),
      readFile(join(dir, 'htmlplan.js'), 'utf8'),
    ]).then(([css, js]) => ({ css, js })).catch((error: unknown) => {
      assetsCache = null
      throw error
    })
  }
  return assetsCache
}

//endregion

//region 文本与行内

/** Markdown 子集里会用到的转义。 */
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

/**
 * HTML 转义。
 * @author ddj 2026年11月25号
 * @param text 原文本
 * @returns 可安全放进 HTML 的文本
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char)
}

/**
 * 把行内 Markdown（代码、粗体、斜体、链接）转成 HTML；其余文本先转义。
 * @author ddj 2026年11月25号
 * @param text 行内文本
 * @returns HTML 片段
 */
export function renderInline(text: string): string {
  const parts = String(text ?? '').split(/(`[^`]*`)/)
  return parts.map((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return '<code>' + escapeHtml(part.slice(1, -1)) + '</code>'
    }
    let html = escapeHtml(part)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer noopener">$1</a>')
    return html
  }).join('')
}

/**
 * 取一段行内文本的纯文本（去行内标记）。
 * @author ddj 2026年11月25号
 * @param text 行内文本
 * @returns 纯文本
 */
function plainTextOf(text: string): string {
  return String(text ?? '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .trim()
}

/**
 * 规范化小节标题：去井号、整行加粗、`计划：` 前缀与常见编号。
 * @author ddj 2026年11月26号
 * @param text 原始标题
 * @returns 干净标题
 */
function cleanHead(text: string): string {
  // 顺序有意义：先 trim/去井号，再剥编号，最后剥「计划：」前缀（弱模型常写成「1. 计划：…」）。
  let out = String(text ?? '').trim().replace(/^#{1,6}\s*/, '').replace(/^\*\*(.+)\*\*$/, '$1').trim()
  out = out
    .replace(/^\d+(?:\.\d+)+\s*[.、)）]?\s*/, '')
    .replace(/^\d+\s*[.、)）]\s*/, '')
    .replace(/^[（(]\s*\d+\s*[)）]\s*/, '')
    .replace(/^[一二三四五六七八九十]+\s*[、.]\s*/, '')
    .trim()
    .replace(/^(?:HTML\s*)?计划\s*[:：]\s*/, '')
    .trim()
  return out.replace(/[：:]\s*$/, '').trim()
}

/**
 * 行是否块级起点（段落收集到这里就该停）。
 * @author ddj 2026年11月26号
 * @param line 行文本
 * @param next 下一行文本
 * @returns 是否块级起点
 */
function isBlockStart(line: string, next: string): boolean {
  const text = line.trim()
  if (!text) return true
  if (/^```/.test(text) || /^>/.test(text)) return true
  if (/^#{1,6}\s+\S/.test(text)) return true
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) return true
  if (/^([-*+]|\d+[.)])\s+\S/.test(text)) return true
  return text.includes('|') && isTableDivider(next.trim())
}

//endregion

//region Markdown 解析

/**
 * 判断行是否表格分隔行（|---|---|）。
 * @author ddj 2026年11月25号
 * @param line 行文本
 * @returns 是否分隔行
 */
function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
}

/**
 * 把一行表格拆成单元格。
 * @author ddj 2026年11月25号
 * @param line 行文本
 * @returns 单元格文本
 */
function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

/**
 * 造一个空块（只填 kind，其余给默认值）。
 * @author ddj 2026年11月26号
 * @param kind 块种类
 * @returns 空块
 */
function blankBlock(kind: PlanBlockKind): PlanBlock {
  return { kind, text: '', lang: '', ordered: false, items: [], head: [], rows: [] }
}

/**
 * 解析列表（缩进决定层级），并吞掉后续缩进续行。
 * @author ddj 2026年11月26号
 * @param lines 全部行
 * @param start 起始下标
 * @returns 列表项与下一个下标
 */
function parseListItems(lines: string[], start: number): { items: PlanItem[]; next: number } {
  const items: PlanItem[] = []
  const stack: Array<{ indent: number; item: PlanItem }> = []
  let index = start

  while (index < lines.length) {
    const raw = lines[index] ?? ''
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(raw)
    if (!match) break

    const indent = (match[1] ?? '').replace(/\t/g, '  ').length
    const item: PlanItem = { text: (match[3] ?? '').trim(), children: [] }
    while (stack.length && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop()
    if (stack.length) stack[stack.length - 1]?.item.children.push(item)
    else items.push(item)
    stack.push({ indent, item })
    index += 1

    // 列表项的续行：缩进、非列表、非块级记号。
    while (index < lines.length) {
      const cont = lines[index] ?? ''
      const trimmed = cont.trim()
      if (!trimmed) break
      if (/^([-*+]|\d+[.)])\s+\S/.test(trimmed)) break
      if (isBlockStart(cont, lines[index + 1] ?? '')) break
      item.text += ' ' + trimmed
      index += 1
    }
  }

  return { items, next: index }
}

/**
 * 把行区间解析成块序列（段落 / 列表 / 代码 / 引用 / 表格 / 分隔线）。
 * @author ddj 2026年11月26号
 * @param lines 行数组
 * @param start 起始下标
 * @param end 结束下标（不含）
 * @returns 块序列
 */
function parseBlocks(lines: string[], start: number, end: number): PlanBlock[] {
  const blocks: PlanBlock[] = []
  let index = start

  while (index < end) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (!trimmed) {
      index += 1
      continue
    }

    const fence = /^```([\w-]*)\s*$/.exec(trimmed)
    if (fence) {
      const code: string[] = []
      index += 1
      while (index < end && !/^```\s*$/.test((lines[index] ?? '').trim())) {
        code.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push({ ...blankBlock('code'), text: code.join('\n'), lang: fence[1] ?? '' })
      continue
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = []
      while (index < end && (lines[index] ?? '').trim().startsWith('>')) {
        quote.push((lines[index] ?? '').trim().replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push({ ...blankBlock('quote'), text: quote.join(' ') })
      continue
    }

    if (trimmed.includes('|') && isTableDivider((lines[index + 1] ?? '').trim())) {
      const head = tableCells(trimmed)
      index += 2
      const rows: string[][] = []
      while (index < end && (lines[index] ?? '').trim().includes('|')) {
        rows.push(tableCells(lines[index] ?? ''))
        index += 1
      }
      blocks.push({ ...blankBlock('table'), head, rows })
      continue
    }

    const listMatch = /^([-*+]|\d+[.)])\s+\S/.exec(trimmed)
    if (listMatch) {
      const parsed = parseListItems(lines.slice(0, end), index)
      blocks.push({ ...blankBlock('list'), ordered: /^\d/.test(listMatch[1] ?? ''), items: parsed.items })
      index = parsed.next
      continue
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(blankBlock('rule'))
      index += 1
      continue
    }

    const paragraph: string[] = [trimmed]
    index += 1
    while (index < end) {
      const raw = lines[index] ?? ''
      if (isBlockStart(raw, lines[index + 1] ?? '')) break
      paragraph.push(raw.trim())
      index += 1
    }
    blocks.push({ ...blankBlock('paragraph'), text: paragraph.join(' ') })
  }

  return blocks
}

/**
 * 按 h2 切小节、按 h3+ 切子小节；h1 之前的正文归 intro。
 * @author ddj 2026年11月26号
 * @param lines 全部行
 * @param titleAt 标题行下标（跳过）
 * @returns intro 行与小节草稿
 */
function splitSections(lines: string[], titleAt: number): { intro: string[]; sections: DraftSection[] } {
  const intro: string[] = []
  const sections: DraftSection[] = []
  let current: DraftSection | null = null
  let sub: { title: string; lines: string[] } | null = null

  lines.forEach((line, index) => {
    if (index === titleAt) return
    const head = /^(#{2,6})\s+(.+)$/.exec(line.trim())
    if (head && (head[1] ?? '').length === 2) {
      current = { title: cleanHead(head[2] ?? ''), lines: [], subs: [] }
      sections.push(current)
      sub = null
      return
    }
    if (head && !current) {
      // 第一个标题就比 h2 深（弱模型常用 `### 1.1 为什么` 打头）：当一个小节处理，别丢进引言。
      current = { title: cleanHead(head[2] ?? ''), lines: [], subs: [] }
      sections.push(current)
      sub = null
      return
    }
    if (head && current) {
      sub = { title: cleanHead(head[2] ?? ''), lines: [] }
      current.subs.push(sub)
      return
    }
    if (!current) intro.push(line)
    else if (sub) sub.lines.push(line)
    else current.lines.push(line)
  })

  return { intro, sections }
}

/**
 * 判断小节归哪一类。
 * @author ddj 2026年11月26号
 * @param title 小节标题
 * @returns 类别
 */
function classifySection(title: string): PlanSectionKind {
  if (SCOPE_HEAD.test(title)) return 'scope'
  if (DECIDE_HEAD.test(title)) return 'decision'
  if (WHY_HEAD.test(title)) return 'why'
  return 'claim'
}

/**
 * 取小节里的所有短句（段落、列表项、引用），用于「为什么」与决策清单。
 * @author ddj 2026年11月26号
 * @param section 小节
 * @returns 文本列表
 */
function textsOf(section: PlanSection): string[] {
  const out: string[] = []
  for (const block of section.blocks) {
    if (block.kind === 'list') out.push(...block.items.map((item) => item.text))
    else if (block.text) out.push(block.text)
  }
  for (const sub of section.subs) out.push(...textsOf(sub))
  return out.map((text) => text.trim()).filter(Boolean)
}

/**
 * 把一行决策文本拆成「问题 + 选项」：`问题 | 选项A | 选项B`。
 * @author ddj 2026年11月26号
 * @param text 决策项文本
 * @returns 决策；空文本返回 null
 */
function choiceOf(text: string): PlanChoice | null {
  const parts = String(text ?? '').split(/[|｜]/).map((part) => part.trim()).filter(Boolean)
  const question = parts[0] ?? ''
  if (!question) return null
  return { question, options: parts.length > 2 ? parts.slice(1, 6) : [] }
}

/**
 * 草稿小节 → 正式小节（解析正文块、递归子小节）。
 * @author ddj 2026年11月26号
 * @param draft 草稿小节
 * @returns 小节
 */
function toSection(draft: DraftSection): PlanSection {
  return {
    kind: classifySection(draft.title),
    title: draft.title,
    blocks: parseBlocks(draft.lines, 0, draft.lines.length),
    subs: draft.subs.map((sub) => ({
      kind: 'claim',
      title: sub.title,
      blocks: parseBlocks(sub.lines, 0, sub.lines.length),
      subs: [],
    })),
  }
}

/**
 * 找标题行：优先 h1；没有 h1 时，若第一个标题就是全文第一行，也当标题（弱模型常写 `## 计划：…`）。
 * @author ddj 2026年11月26号
 * @param lines 全部行
 * @returns 标题行下标；找不到返回 -1
 */
function findTitleLine(lines: string[]): number {
  const h1 = lines.findIndex((line) => /^#\s+\S/.test(line.trim()))
  if (h1 >= 0) return h1
  const firstHead = lines.findIndex((line) => /^#{1,6}\s+\S/.test(line.trim()))
  if (firstHead < 0) return -1
  const firstText = lines.findIndex((line) => line.trim() !== '')
  return firstHead === firstText ? firstHead : -1
}

/**
 * 把计划 Markdown 解析成结构（标题、引言、为什么、主张、决策、不改什么）。
 * @author ddj 2026年11月26号
 * @param markdown 计划正文
 * @returns 计划结构
 */
export function parsePlanDoc(markdown: string): PlanDoc {
  const lines = String(markdown ?? '').replace(PAGE_MARK_LINE, '').split('\n')
  const titleAt = findTitleLine(lines)
  const rawTitle = titleAt >= 0 ? cleanHead((lines[titleAt] ?? '').replace(/^#+/, '')) : ''
  const drafts = splitSections(lines, titleAt)
  const sections = drafts.sections.map(toSection)
  const decisionSections = sections.filter((section) => section.kind === 'decision')
  const scope = sections.find((section) => section.kind === 'scope') ?? null
  const why = sections.filter((section) => section.kind === 'why').flatMap(textsOf)

  return {
    title: rawTitle || '计划',
    intro: parseBlocks(drafts.intro, 0, drafts.intro.length),
    why,
    claims: sections.filter((section) => section.kind === 'claim'),
    choices: decisionSections.flatMap(textsOf).map(choiceOf).filter((choice): choice is PlanChoice => choice !== null),
    choicesTitle: decisionSections[0]?.title || '待拍板的决策',
    scope,
  }
}

//endregion

//region 块级渲染

/**
 * 渲染一张表。
 * @author ddj 2026年11月26号
 * @param head 表头
 * @param rows 数据行
 * @returns HTML
 */
function renderTableHtml(head: string[], rows: string[][]): string {
  const headHtml = head.length
    ? '<thead><tr>' + head.map((cell) => '<th>' + renderInline(cell) + '</th>').join('') + '</tr></thead>'
    : ''
  const bodyHtml = rows.length
    ? '<tbody>' + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + renderInline(cell) + '</td>').join('') + '</tr>').join('') + '</tbody>'
    : ''
  return '<table>' + headHtml + bodyHtml + '</table>'
}

/**
 * 渲染一个块。
 * @author ddj 2026年11月26号
 * @param block 块
 * @returns HTML
 */
function renderBlockHtml(block: PlanBlock): string {
  if (block.kind === 'paragraph') return '<p>' + renderInline(block.text) + '</p>'
  if (block.kind === 'quote') return '<blockquote>' + renderInline(block.text) + '</blockquote>'
  if (block.kind === 'table') return renderTableHtml(block.head, block.rows)
  if (block.kind === 'rule') return '<hr>'
  if (block.kind === 'list') return renderListHtml(block.items, block.ordered)
  // textarea 兜底：代码里可能出现 `</script`，塞进 script 会截断页面。
  const lang = block.lang ? ' lang="' + escapeHtml(block.lang) + '"' : ''
  return '<doc-code' + lang + '><textarea class="src" hidden>' + escapeHtml(block.text) + '</textarea></doc-code>'
}

/**
 * 渲染块序列。
 * @author ddj 2026年11月26号
 * @param blocks 块序列
 * @returns HTML
 */
function renderBlocksHtml(blocks: PlanBlock[]): string {
  return blocks.map(renderBlockHtml).join('\n')
}

/**
 * 渲染列表（按层级缩进成嵌套 ul/ol）。
 * @author ddj 2026年11月26号
 * @param items 列表项
 * @param ordered 是否有序
 * @returns HTML
 */
function renderListHtml(items: PlanItem[], ordered: boolean): string {
  if (!items.length) return ''
  const tag = ordered ? 'ol' : 'ul'
  const rows = items.map((item) => {
    const kids = item.children.length ? renderListHtml(item.children, ordered) : ''
    return '<li>' + renderInline(item.text) + kids + '</li>'
  })
  return '<' + tag + '>' + rows.join('') + '</' + tag + '>'
}

//endregion

//region 计划页组装

/**
 * 渲染一张决策卡（≥2 个选项给单选，否则给自由填写框）。
 * @author ddj 2026年11月26号
 * @param choice 决策
 * @param index 序号（从 0 起）
 * @returns HTML
 */
function renderChoiceHtml(choice: PlanChoice, index: number): string {
  const id = 'd' + String(index + 1)
  const question = '<p>' + renderInline(choice.question) + '</p>'
  if (choice.options.length < 2) {
    return '<doc-ask id="' + id + '" kind="decision">' + question
      + '<textarea name="' + id + '" placeholder="写下你的选择或补充…"></textarea></doc-ask>'
  }
  const options = choice.options.map((option, at) => '<label><input type="radio" name="' + id + '" value="'
    + escapeHtml(plainTextOf(option)) + '"' + (at === 0 ? ' checked' : '') + '> ' + renderInline(option) + '</label>').join('')
  return '<doc-ask id="' + id + '" kind="decision">' + question + '<div class="opts-row">' + options + '</div></doc-ask>'
}

/**
 * 渲染决策清单（一条待拍板主张，里面挂 N 张决策卡）。
 * @author ddj 2026年11月26号
 * @param doc 计划结构
 * @returns HTML；没有决策时为空串
 */
function renderChoicesHtml(doc: PlanDoc): string {
  if (!doc.choices.length) return ''
  const cards = doc.choices.map(renderChoiceHtml).join('\n')
  return '<doc-claim>\n<p>' + renderInline(doc.choicesTitle) + '</p>\n' + cards + '\n</doc-claim>'
}

/**
 * 渲染一条主张（标题作主张句，正文作证据，子小节作子主张）。
 *
 * 列表留在正文里画成 ul/ol：列表项本身没有证据，提成子主张后点开只会是空白块。
 * @author ddj 2026年11月26号
 * @param section 小节
 * @param aux 是否「不改什么」（aux="scope"，编号画成破折号）
 * @returns HTML
 */
function renderClaimHtml(section: PlanSection, aux: boolean): string {
  const open = aux ? '<doc-claim aux="scope">' : '<doc-claim>'
  const body: string[] = []
  for (const block of section.blocks) body.push(renderBlockHtml(block))
  for (const sub of section.subs) body.push(renderClaimHtml(sub, false))
  return [open, '<p>' + renderInline(section.title) + '</p>', ...body, '</doc-claim>'].filter(Boolean).join('\n')
}

/**
 * 渲染「为什么」折叠条（用户诉求的原始说法）。
 * @author ddj 2026年11月26号
 * @param why 诉求文本
 * @returns HTML；没有诉求时为空串
 */
function renderThreadHtml(why: string[]): string {
  if (!why.length) return ''
  const items = why.slice(0, 8).map((text) => '<p>' + renderInline(text) + '</p>').join('')
  return '<details class="thread"><summary>为什么 · ' + String(why.length) + ' 个诉求</summary>' + items + '</details>'
}

/**
 * 组装结构化计划页主体（引言 + 主张树 + 决策 + 不改什么）。
 * @author ddj 2026年11月26号
 * @param doc 计划结构
 * @returns main 内 HTML
 */
function renderPlanBody(doc: PlanDoc): string {
  const parts: string[] = [renderBlocksHtml(doc.intro), '<doc-plan>']
  for (const claim of doc.claims) parts.push(renderClaimHtml(claim, false))
  parts.push(renderChoicesHtml(doc))
  if (doc.scope) parts.push(renderClaimHtml(doc.scope, true))
  parts.push('</doc-plan>')
  return parts.filter(Boolean).join('\n')
}

/**
 * 把计划 Markdown 渲染成文档式页面主体（结构识别不到时的兜底）。
 * @author ddj 2026年11月25号
 * @param markdown 计划正文
 * @returns `{ title, body }`
 */
export function renderPlanMarkdown(markdown: string): { title: string; body: string } {
  const lines = String(markdown ?? '').replace(PAGE_MARK_LINE, '').split('\n')
  const out: string[] = []
  let title = ''
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    const fence = /^```([\w-]*)\s*$/.exec(trimmed)
    if (fence) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test((lines[index] ?? '').trim())) {
        code.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      const lang = fence[1] ? ' class="language-' + escapeHtml(fence[1]) + '"' : ''
      out.push('<pre><code' + lang + '>' + escapeHtml(code.join('\n')) + '</code></pre>')
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      const level = (heading[1] ?? '').length
      const text = (heading[2] ?? '').trim()
      if (!title) {
        title = plainTextOf(text)
        index += 1
        continue
      }
      const tag = level >= 4 ? 'h4' : level === 3 ? 'h3' : 'h2'
      out.push('<' + tag + '>' + renderInline(text) + '</' + tag + '>')
      index += 1
      continue
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push('<hr>')
      index += 1
      continue
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = []
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quote.push((lines[index] ?? '').trim().replace(/^>\s?/, ''))
        index += 1
      }
      out.push('<blockquote>' + renderInline(quote.join(' ')) + '</blockquote>')
      continue
    }

    if (trimmed.includes('|') && isTableDivider((lines[index + 1] ?? '').trim())) {
      const head = tableCells(trimmed)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').trim().includes('|')) {
        rows.push(tableCells(lines[index] ?? ''))
        index += 1
      }
      out.push(renderTableHtml(head, rows))
      continue
    }

    const listMatch = /^([-*+]|\d+[.)])\s+(.*)$/.exec(trimmed)
    if (listMatch) {
      const parsed = parseListItems(lines, index)
      out.push(renderListHtml(parsed.items, /^\d/.test(listMatch[1] ?? '')))
      index = parsed.next
      continue
    }

    const paragraph: string[] = [trimmed]
    index += 1
    while (index < lines.length) {
      if (isBlockStart(lines[index] ?? '', lines[index + 1] ?? '')) break
      paragraph.push((lines[index] ?? '').trim())
      index += 1
    }
    out.push('<p>' + renderInline(paragraph.join(' ')) + '</p>')
  }

  return { title: title || '计划', body: out.join('\n') }
}

/**
 * 生成一页独立的 HTML 计划页（运行时内联，可直接塞进 sandbox iframe）。
 *
 * 有计划结构（至少一条主张）时输出标准计划页；否则退回文档式渲染，保证「有页可读」。
 * 有决策时才打开页面自带的答复条（`data-feedback`），没有决策就不干扰阅读。
 * @author ddj 2026年11月25号
 * @author ddj 2026年11月26号（改为结构化计划页）
 * @param markdown 计划正文
 * @param assets 运行时样式与脚本
 * @returns 完整 HTML 文本
 */
export function renderAutoPlanPage(markdown: string, assets: PlanRuntimeAssets): string {
  const text = String(markdown ?? '')
  if (text.length > AUTO_PAGE_MARKDOWN_CAP) {
    throw new Error('计划正文过大（上限 ' + String(AUTO_PAGE_MARKDOWN_CAP) + ' 字符）')
  }

  const doc = parsePlanDoc(text)
  const structured = doc.claims.length > 0 || doc.choices.length > 0 || doc.scope !== null
  const fallback = structured ? null : renderPlanMarkdown(text)
  const body = structured ? renderPlanBody(doc) : (fallback?.body ?? '')
  const title = structured ? doc.title : (fallback?.title ?? '计划')
  const thread = structured ? renderThreadHtml(doc.why) : ''
  const script = String(assets?.js ?? '').replace(/<\/script/gi, '<\\/script')
  const style = String(assets?.css ?? '')

  return [
    '<!doctype html>',
    '<html lang="zh-CN" data-htmlplan-packed>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + escapeHtml(title) + '</title>',
    '<style data-htmlplan>',
    style,
    '</style>',
    '<body data-feedback="' + (doc.choices.length ? 'on' : 'off') + '">',
    '<header><h1>' + renderInline(title) + '</h1>',
    thread,
    '</header>',
    '<main>',
    body,
    '</main>',
    '<script data-htmlplan>',
    script,
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

//endregion
