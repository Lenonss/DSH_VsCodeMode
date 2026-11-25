/**
 * dsh-vscode-mode host — HTML 计划模式的「兜底页」渲染。
 *
 * 模型不写作者页（或写失败）时，用提交给 `exit_html_plan_mode` 的计划 Markdown 生成一页
 * htmlplan 风格的独立 HTML：内联技能运行时样式与脚本，支持标题/段落/列表/代码/引用/表格。
 * 只求「有页可读」，不产出主张树与决策控件。
 *
 * 运行时资产（`htmlplan.css` / `htmlplan.js`）从随包技能目录读取并缓存；本模块不写盘。
 * @author ddj 2026年11月25号
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

//endregion

//region 常量

/** 计划正文上限：超过直接报错，避免把超大文本塞进 iframe。 */
export const AUTO_PAGE_MARKDOWN_CAP = 256 * 1024

/** 技能名（随包目录）。 */
const SKILL_DIR = 'dsh-vscodemode-html-plan'

/** 计划页标记行（作者页声明），自动页里必须剥掉。 */
const PAGE_MARK_LINE = /^[ \t]*HTML[ \t]*计划页[ \t]*[:：].*$/gim

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

//region Markdown 子集渲染

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
 * 取一行里的纯文本（去行内标记），用于标题。
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
 * 把计划 Markdown 渲染成页面主体 HTML（不含外壳）。
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

    // 围栏代码块
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

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      const level = heading[1].length
      const text = heading[2].trim()
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

    // 分隔线
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push('<hr>')
      index += 1
      continue
    }

    // 引用
    if (trimmed.startsWith('>')) {
      const quote: string[] = []
      while (index < lines.length && (lines[index] ?? '').trim().startsWith('>')) {
        quote.push((lines[index] ?? '').trim().replace(/^>\s?/, ''))
        index += 1
      }
      out.push('<blockquote>' + renderInline(quote.join(' ')) + '</blockquote>')
      continue
    }

    // 表格
    const next = (lines[index + 1] ?? '').trim()
    if (trimmed.includes('|') && isTableDivider(next)) {
      const header = tableCells(trimmed)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? '').trim().includes('|')) {
        rows.push(tableCells(lines[index] ?? ''))
        index += 1
      }
      out.push('<table><thead><tr>' + header.map((cell) => '<th>' + renderInline(cell) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + renderInline(cell) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>')
      continue
    }

    // 列表（有序/无序，单层）
    const listMatch = /^([-*+]|\d+[.)])\s+(.*)$/.exec(trimmed)
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1])
      const items: string[] = []
      while (index < lines.length) {
        const item = /^([-*+]|\d+[.)])\s+(.*)$/.exec((lines[index] ?? '').trim())
        if (!item || /^\d/.test(item[1]) !== ordered) break
        items.push(item[2])
        index += 1
        // 续行（缩进的非列表行）并入当前项。
        while (index < lines.length) {
          const cont = lines[index] ?? ''
          if (!cont.trim() || /^([-*+]|\d+[.)])\s+/.test(cont.trim()) || /^#{1,6}\s/.test(cont.trim())) break
          items[items.length - 1] += ' ' + cont.trim()
          index += 1
        }
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push('<' + tag + '>' + items.map((item) => '<li>' + renderInline(item) + '</li>').join('') + '</' + tag + '>')
      continue
    }

    // 段落：收集到空行或下一个块级记号
    const paragraph: string[] = [trimmed]
    index += 1
    while (index < lines.length) {
      const raw = (lines[index] ?? '').trim()
      if (!raw) break
      if (/^```/.test(raw) || /^#{1,6}\s/.test(raw) || /^(?:-{3,}|\*{3,}|_{3,})$/.test(raw) || /^>/.test(raw)) break
      if (/^([-*+]|\d+[.)])\s+/.test(raw)) break
      if (raw.includes('|') && isTableDivider((lines[index + 1] ?? '').trim())) break
      paragraph.push(raw)
      index += 1
    }
    out.push('<p>' + renderInline(paragraph.join(' ')) + '</p>')
  }

  return { title: title || '计划', body: out.join('\n') }
}

//endregion

//region 页面组装

/**
 * 生成一页独立的 HTML 计划页（运行时内联，可直接塞进 sandbox iframe）。
 *
 * `data-feedback="off"` 关掉运行时自带的 Respond 条：页面没有决策控件，回复走计划签的官方按钮。
 * @author ddj 2026年11月25号
 * @param markdown 计划正文
 * @param assets 运行时样式与脚本
 * @returns 完整 HTML 文本
 */
export function renderAutoPlanPage(markdown: string, assets: PlanRuntimeAssets): string {
  const text = String(markdown ?? '')
  if (text.length > AUTO_PAGE_MARKDOWN_CAP) {
    throw new Error('计划正文过大（上限 ' + String(AUTO_PAGE_MARKDOWN_CAP) + ' 字符）')
  }
  const { title, body } = renderPlanMarkdown(text)
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
    '<body data-feedback="off">',
    '<header><h1>' + renderInline(title) + '</h1></header>',
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
