/**
 * dsh-vscode-mode host — SVN 日志解析（`svn log --xml -v`）。
 *
 * 实测要点（svn 1.14.5）：
 * - **默认范围是 `BASE:1`**：工作副本落后时几乎拿不到日志，调用方必须显式 `-r HEAD:1`。
 * - path 节点给的是**仓库绝对路径**（`/trunk/sub/x.txt`），不是工作副本相对路径；
 *   要落成工作区相对路径必须结合 `svn info --xml` 的 `<relative-url>`（如 `^/trunk`）剥前缀，
 *   不在前缀内的（分支/外部路径）标为 null，由 UI 显示为「仓库外路径」而不是硬拼。
 * - `<path>` 带 `action` / `kind` / `copyfrom-path` / `copyfrom-rev` / `prop-mods` / `text-mods`。
 * - `<msg>` 是多行文本节点（不是属性），需保留换行。
 * 作者 ddj 2026年09月16号
 */
import type { SvnLogEntry, SvnLogPath } from './shared/svn.js'
import { attrOf, numAttrOf, textOf, unescapeXml } from './svnXml.js'

/** 日志条目上限（防超大仓库撑爆载荷）。 */
export const LOG_CAP = 500

/**
 * Show All（P1-7）专用条目上限：比默认 `LOG_CAP` 高一个量级，仍留护栏。
 *
 * 取舍依据（蓝图 §5 P1-7）：真全量（省略 `-l`）在超大仓库会拉取上百 MB XML，
 * 且 DSH 输出收集器超限**保留尾部**（见 `svn.ts` `LOG_OUTPUT_CAP` 教训）→ 宁可有界。
 * 实测（2026-09-18，IslandSplash_BugFix `Assets`，svn 1.14.5）：`-l 5000` → 5000 条 /
 * 18.86MB / 30.1s；根路径 `-g` 300 条全历史 > 600s 未返回（真全量 + `-g` 不可行）。
 */
export const SVN_LOG_SHOW_ALL_CAP = 5000

/** 默认拉取条数（对齐 TortoiseSVN 默认 100 条）。 */
export const LOG_DEFAULT_LIMIT = 100

/** 合法日志动作字母。 */
const LOG_ACTIONS: ReadonlySet<string> = new Set(['A', 'D', 'R', 'M'])

/**
 * merged 条目的最大解析深度（P1-5）：实测最深 1 层，更深递归未观察到，
 * 故按「可能更深」实现递归但有界，防病态输入无限下钻。
 */
const LOG_MERGE_DEPTH = 8

/**
 * 把仓库绝对路径映射为工作区相对路径。
 *
 * `relativeUrl` 形如 `^/trunk`（来自 `svn info --xml`）；仓库路径 `/trunk/sub/x.txt`
 * 剥前缀后得 `sub/x.txt`。注意 relative-url 是 **URL 编码形态**（实测：空格 = `%20`、
 * 中文 = `%E9..`），而 log --xml 的 path 是明文，比对前必须先解码。
 * 前缀不完全匹配（跨分支/外部定义）返回 null——宁可在 UI 标注「仓库外」也不要硬拼出
 * 错误路径导致打开失败。
 *
 * @author ddj 2026年09月16号 / 2026年09月17号
 * @param repoPath 仓库绝对路径（`/trunk/...`）
 * @param relativeUrl 工作副本根的 relative-url（`^/trunk`，URL 编码形态）
 * @returns 工作区相对路径；不在根下返回 null
 */
export function mapRepoPath(repoPath: string, relativeUrl: string): string | null {
  const repo = String(repoPath ?? '').replace(/\/+$/, '')
  const encoded = String(relativeUrl ?? '').replace(/^\^/, '').replace(/\/+$/, '')
  let prefix = encoded
  try {
    prefix = decodeURIComponent(encoded)
  } catch (e) { /* 含非法 % 序列：回落编码原值比对 */ }
  if (!repo) return null
  // 无 relative-url（未探测到）时不做映射，交由调用方标注
  if (!prefix) return null
  if (repo === prefix) return ''
  if (!repo.startsWith(prefix + '/')) return null
  return repo.slice(prefix.length + 1)
}

/**
 * 解析 `svn log --xml -v` 输出为日志条目列表。
 *
 * 实现：顺序扫描（非按块切分）——`parseLogEntry` 会连**嵌套内容**一起消费，
 * 并返回本条结束位置，故顶层循环天然只收顶层条目，嵌套归各自的父条目。
 * 每条内取 author/date/msg 与 `<paths>` 段；`<path attrs>文本</path>` 的属性在标签上、
 * 路径在标签之间。闭标签不得当作新条目（P2 在 status 解析上踩过同一个坑）。
 *
 * P1-5（`-g`）：被合并的修订是**嵌套 `<logentry>`**（位于父条目 `</msg>` 之后，可并列多个），
 * 收进父条目的 `merged`；`cap` 只约束顶层条目（实测 `-l` 亦只约束顶层，总条数可超 `-l`）。
 *
 * @author ddj 2026年09月16号 / 2026年09月18号
 * @param xml log --xml 的 stdout
 * @param relativeUrl 工作副本根的 relative-url（用于路径映射；缺省则不映射）
 * @param cap 顶层条目上限
 * @returns 日志条目与是否截断
 */
export function parseLogXml(
  xml: string,
  relativeUrl = '',
  cap: number = LOG_CAP,
): { entries: SvnLogEntry[]; truncated: boolean } {
  const entries: SvnLogEntry[] = []
  let truncated = false
  if (typeof xml !== 'string' || !xml) return { entries, truncated }
  let from = xml.indexOf('<logentry')
  while (from >= 0) {
    if (entries.length >= cap) { truncated = true; break }
    const scanned = parseLogEntry(xml, from, relativeUrl, 0)
    if (!scanned) break
    entries.push(scanned.entry)
    from = xml.indexOf('<logentry', scanned.end)
  }
  return { entries, truncated }
}

/**
 * 解析 `at` 处的一条 logentry（连嵌套内容一起消费；P1-5 递归 merged）。
 *
 * @author ddj 2026年09月18号
 * @param xml 日志 XML 全文
 * @param at `<logentry` 的起始下标
 * @param relativeUrl 工作副本根的 relative-url
 * @param depth 当前嵌套深度（顶层 0）
 * @returns 条目与「本条结束下标」；起始处不是 logentry 时返回 null
 */
function parseLogEntry(xml: string, at: number, relativeUrl: string, depth: number): { entry: SvnLogEntry; end: number } | null {
  const attrs = tagTailOf(xml, at, 'logentry')
  if (attrs === null) return null
  const revision = numAttrOf(attrs, 'revision')
  if (revision === undefined) return null
  const bodyFrom = at + '<logentry'.length + attrs.length + 1
  let end = entryEndOf(xml, bodyFrom, depth)
  const body = xml.slice(bodyFrom, end)
  const entry: SvnLogEntry = {
    revision,
    author: textOf(body, 'author'),
    date: textOf(body, 'date'),
    message: textOf(body, 'msg'),
    paths: parseLogPaths(body, relativeUrl),
  }
  // 顶层从不带 reverse-merge；嵌套条目按可能存在 true 处理（实测只采到 false）
  const reverse = attrOf(attrs, 'reverse-merge')
  if (reverse) entry.reverseMerge = reverse === 'true'
  if (depth < LOG_MERGE_DEPTH) {
    const nested = parseMergedOf(xml, bodyFrom, end, relativeUrl, depth)
    if (nested.list.length) entry.merged = nested.list
    end = nested.end
  }
  return { entry, end }
}

/**
 * 取 `at` 处标签的属性串（`<name` 之后到首个 `>` 之间）。
 * @author ddj 2026年09月18号
 * @param xml XML 全文
 * @param at `<name` 的起始下标
 * @param name 标签名
 * @returns 属性串（已 trim）；该处不是该标签的开标签时返回 null
 */
function tagTailOf(xml: string, at: number, name: string): string | null {
  if (!xml.startsWith('<' + name, at)) return null
  const gt = xml.indexOf('>', at)
  if (gt < 0) return null
  const tag = xml.slice(at + 1 + name.length, gt)
  return tag.trim().endsWith('/') ? null : tag
}

/**
 * 求条目结束下标：从正文起点扫描，跳过全部嵌套条目所用的闭标签。
 *
 * 实现按「先看下一个 `<logentry` 起点、再看当前深度的 `</logentry>`」取舍，
 * 因而支持更深层级（深层闭标签由深层那次递归消费，不会提前终止本层）。
 * @author ddj 2026年09月18号
 * @param xml XML 全文
 * @param from 正文起点（开标签 `>` 之后）
 * @param depth 本条目深度
 * @returns 本条 `</logentry>` 之后的绝对下标
 */
function entryEndOf(xml: string, from: number, depth: number): number {
  let scan = from
  let level = depth
  while (scan < xml.length) {
    const openAt = xml.indexOf('<logentry', scan)
    const closeAt = xml.indexOf('</logentry>', scan)
    if (closeAt < 0) return xml.length
    if (openAt >= 0 && openAt < closeAt) {
      const attrs = tagTailOf(xml, openAt, 'logentry')
      // 深层条目的结束下标：递归求得更深层的闭标签位置
      if (attrs === null) { scan = openAt + '<logentry'.length; continue }
      scan = entryEndOf(xml, openAt + '<logentry'.length + attrs.length + 1, level + 1)
      continue
    }
    if (level <= depth) return closeAt + '</logentry>'.length
    level -= 1
    scan = closeAt + '</logentry>'.length
  }
  return xml.length
}

/**
 * 解析块内全部并列嵌套 logentry（P1-5）；`end` 随之推进到本条目结束处。
 *
 * @author ddj 2026年09月18号
 * @param xml XML 全文
 * @param from 正文起点（开标签 `>` 之后）
 * @param end 本条目结束下标（深度扫描的结果）
 * @param relativeUrl 工作副本根的 relative-url
 * @param depth 父条目深度
 * @returns 嵌套条目列表与推进后的结束下标
 */
function parseMergedOf(xml: string, from: number, end: number, relativeUrl: string, depth: number): { list: SvnLogEntry[]; end: number } {
  const list: SvnLogEntry[] = []
  let scan = from
  while (scan < end) {
    const openAt = xml.indexOf('<logentry', scan)
    if (openAt < 0 || openAt >= end) break
    const nested = parseLogEntry(xml, openAt, relativeUrl, depth + 1)
    if (!nested) { scan = openAt + '<logentry'.length; continue }
    list.push(nested.entry)
    scan = nested.end
    end = Math.max(end, nested.end)
  }
  return { list, end }
}

/**
 * 解析单条日志的 `<paths>` 段为变更路径列表。
 * @author ddj 2026年09月16号
 * @param block 单条 logentry 原文
 * @param relativeUrl 工作副本根的 relative-url
 * @returns 变更路径列表
 */
function parseLogPaths(block: string, relativeUrl: string): SvnLogPath[] {
  const section = /<paths>([\s\S]*?)<\/paths>/.exec(block)
  if (!section) return []
  const out: SvnLogPath[] = []
  // 一次正则拿到「属性串 + 文本内容」两段（path 为文本节点而非属性）
  const re = /<path\b([^>]*?)\/?>([\s\S]*?)<\/path>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(section[1])) !== null) {
    const attrs = m[1]
    const rawPath = unescapeXml(m[2]).trim()
    if (!rawPath) continue
    const action = attrOf(attrs, 'action')
    out.push({
      path: rawPath,
      relPath: mapRepoPath(rawPath, relativeUrl),
      action: (LOG_ACTIONS.has(action) ? action : 'M') as SvnLogPath['action'],
      kind: attrOf(attrs, 'kind') || undefined,
      copyFrom: attrOf(attrs, 'copyfrom-path') || undefined,
      copyFromRev: numAttrOf(attrs, 'copyfrom-rev'),
      propMods: attrOf(attrs, 'prop-mods') === 'true',
      textMods: attrOf(attrs, 'text-mods') === 'true',
    })
  }
  return out
}

/**
 * 可排序键（P0-12）：版本号 / 作者 / 日期 / 信息首行。
 */
export type LogSortKey = 'revision' | 'author' | 'date' | 'message'

/** 排序方向。 */
export type LogSortDir = 'asc' | 'desc'

/**
 * 日志条目排序（P0-12/D31，纯函数；默认 revision desc = 后端原序语义）。
 * - author/message 用 localeCompare（中英混排稳定）；message 按首行排序，与显示一致
 * - date 按解析时间戳；解析失败的行恒定沉底（不随方向翻转，避免 NaN 污染）
 * @author ddj 2026年09月17号
 * @param entries 条目（只读）
 * @param key 排序键
 * @param dir 方向
 * @returns 新数组（不改动入参）
 */
export function orderLogEntries(entries: readonly SvnLogEntry[], key: LogSortKey = 'revision', dir: LogSortDir = 'desc'): SvnLogEntry[] {
  const out = entries.slice()
  if (key === 'revision') {
    out.sort((a, b) => (dir === 'asc' ? a.revision - b.revision : b.revision - a.revision))
    return out
  }
  const sign = dir === 'asc' ? 1 : -1
  out.sort((a, b) => {
    if (key === 'date') {
      const at = new Date(String(a.date ?? '')).getTime()
      const bt = new Date(String(b.date ?? '')).getTime()
      if (Number.isNaN(at) && Number.isNaN(bt)) return 0
      if (Number.isNaN(at)) return 1 // 解析失败恒沉底
      if (Number.isNaN(bt)) return -1
      return sign * (at - bt)
    }
    const av = sortTextOf(a, key)
    const bv = sortTextOf(b, key)
    return sign * av.localeCompare(bv)
  })
  return out
}

/**
 * 排序用的文本值（message 取首行，与列表显示一致）。
 * @author ddj 2026年09月17号
 * @param entry 条目
 * @param key 排序键（author/message）
 * @returns 文本
 */
function sortTextOf(entry: SvnLogEntry, key: LogSortKey): string {
  if (key === 'message') return String(entry.message ?? '').split(/\r?\n/)[0] ?? ''
  return String(entry.author ?? '')
}

/**
 * 从 `svn info --xml` 输出解析工作副本版号（P1-9；目录目标返回 null——版号加粗仅对文件目标）。
 * @author ddj 2026年09月17号
 * @param xml svn info --xml 输出
 * @returns 工作副本版号（无 commit 节点或目录 = null）
 */
export function parseSvnInfoRevision(xml: string): number | null {
  const text = String(xml ?? '')
  if (!text.includes('<entry')) return null
  const kind = /<entry[^>]*\bkind="([^"]*)"/.exec(text)?.[1] ?? ''
  if (kind === 'dir') return null
  const at = /<commit[^>]*\brevision="(\d+)"/.exec(text)
  return at ? Number(at[1]) : null
}
