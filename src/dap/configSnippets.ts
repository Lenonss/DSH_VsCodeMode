/**
 * dsh-vscode-mode host — launch.json「添加配置」片段提取。
 * 扫描 VSCode 扩展清单 contributes.debuggers[]：
 * - configurationSnippets[]（label/description/body）优先；缺失时 initialConfigurations[] 兜底
 *   （条目本身就是配置体，label 取 body.name → debugger.label → type）；
 * - %key% 占位符按 package.nls.json → package.nls.zh-cn.json 合并表解析（zh 覆盖 base），
 *   解析失败剥 %…% 外壳（避免裸占位符上屏）；
 * - body 缺 type/name 时补齐（parseLaunchConfigs 要求两者，缺了插进去也不可见）。
 * 与 discovery 各自独立缓存（片段随扩展安装变化；force 重扫，测试隔离）。
 * 作者 ddj 2026年09月22号
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { vscodeExtensionsDirs } from '../lsp/providers.js'
import { dshHome } from '../paths.js'
import type { DapAdapterDecl, DapConfigSnippet } from '../shared/dap.js'

/** 清单 debuggers 条目（片段提取消费的子集）。 */
interface SnippetDebuggerEntry {
  type?: unknown
  label?: unknown
  configurationSnippets?: unknown
  initialConfigurations?: unknown
}

/** 归一后的片段原料（nls 解析前）。 */
interface RawSnippetItem {
  label?: string
  description?: string
  body: Record<string, unknown>
}

/** nls 键值表（package.nls*.json 扁平结构）。 */
type NlsTable = Record<string, string>

/** 发现缓存（null = 未加载；按 home 隔离，测试用 force/clear 复位）。 */
let cache: DapConfigSnippet[] | null = null
let cacheHome = ''

// --region 片段发现

/**
 * 全部可添加调试配置片段（按 label 字典序稳定输出，type+label 去重）。
 * @author ddj 2026年09月22号
 * @param force 强制重扫（扩展安装后 / 测试隔离用）
 * @param home DSH home（缺省真实；测试可注入）
 * @returns 片段列表
 */
export function dapConfigSnippets(force = false, home = dshHome()): DapConfigSnippet[] {
  if (!force && cache !== null && home === cacheHome) return cache
  cache = scanSnippets(home)
  cacheHome = home
  return cache
}

/** 清空片段缓存（扩展安装后 / 测试 afterEach 复位）。 */
export function clearSnippetCache(): void {
  cache = null
  cacheHome = ''
}

/**
 * 按适配器可用性标注片段（与调试工具条同源裁决 debuggerDecls）：
 * type 命中 decl → 透传 available/reason；未命中（清单无该 type 的可用适配器声明）
 * → available=false +「未发现该类型适配器」。下拉据此过滤「选得进、跑不了」的条目。
 * @author ddj 2026年09月22号
 * @param snippets 片段列表（dapConfigSnippets 产物）
 * @param decls 适配器声明表（debuggerDecls()）
 * @returns 带可用性标注的片段列表（新数组，不改入参）
 */
export function annotateSnippets(
  snippets: readonly DapConfigSnippet[],
  decls: readonly DapAdapterDecl[],
): DapConfigSnippet[] {
  const byType = new Map(decls.map((decl) => [decl.type, decl]))
  return snippets.map((snip) => {
    const decl = byType.get(snip.type)
    if (!decl) {
      return { ...snip, available: false, reason: '未发现该类型适配器' }
    }
    const annotated: DapConfigSnippet = { ...snip, available: decl.available }
    if (!decl.available && decl.reason) annotated.reason = decl.reason
    return annotated
  })
}

/** 扫描全部扩展根收集片段（先到先得去重，输出按 label 排序）。 */
function scanSnippets(home: string): DapConfigSnippet[] {
  const out: DapConfigSnippet[] = []
  const seen = new Set<string>()
  for (const root of vscodeExtensionsDirs(home)) {
    for (const extDir of subDirsOf(root)) {
      collectExt(extDir, out, seen)
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

/** 单扩展处理：有产出原料才读 nls（多数扩展无调试片段，不白读两个小文件）。 */
function collectExt(extDir: string, out: DapConfigSnippet[], seen: Set<string>): void {
  const entries = debuggersOf(extDir)
  const plans = entries
    .map((entry) => ({ entry, type: strOf(entry.type), items: rawItemsOf(entry) }))
    .filter((plan) => Boolean(plan.type) && plan.items.length > 0)
  if (!plans.length) return
  const nls = readNlsTable(extDir)
  for (const plan of plans) {
    for (const item of plan.items) {
      const snippet = projectSnippet(plan.entry, plan.type, item, nls)
      const key = plan.type + '\u0000' + snippet.label
      if (seen.has(key)) continue
      seen.add(key)
      out.push(snippet)
    }
  }
}

/** 清单条目 → 片段投影（nls 解析 + type/name 补齐）。 */
function projectSnippet(
  entry: SnippetDebuggerEntry,
  type: string,
  item: RawSnippetItem,
  nls: NlsTable,
): DapConfigSnippet {
  const body = resolveNlsDeep(item.body, nls) as Record<string, unknown>
  if (!strOf(body.type)) body.type = type
  const label = resolveNlsText(item.label ?? '', nls)
    || strOf(body.name)
    || resolveNlsText(strOf(entry.label), nls)
    || type
  if (!strOf(body.name)) body.name = label
  const snippet: DapConfigSnippet = {
    label,
    type: strOf(body.type) || type,
    bodyText: JSON.stringify(body, null, 2),
  }
  const description = resolveNlsText(item.description ?? '', nls)
  if (description) snippet.description = description
  return snippet
}

// --endregion

// --region 清单与原料归一

/** 读扩展根下的扩展子目录（根不存在返回空；与 discovery 同口径）。 */
function subDirsOf(root: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name))
}

/** 读某扩展的 contributes.debuggers（无清单/无声明/解析失败返回空）。 */
function debuggersOf(extDir: string): SnippetDebuggerEntry[] {
  try {
    const text = readFileSync(join(extDir, 'package.json'), 'utf8').replace(/^﻿/, '')
    const manifest = JSON.parse(text) as { contributes?: { debuggers?: unknown } }
    const list = manifest.contributes?.debuggers
    return Array.isArray(list) ? (list as SnippetDebuggerEntry[]) : []
  } catch {
    return []
  }
}

/** 条目 → 原料列表：configurationSnippets 优先，initialConfigurations 兜底（条目即配置体）。 */
function rawItemsOf(entry: SnippetDebuggerEntry): RawSnippetItem[] {
  const out: RawSnippetItem[] = []
  const snippets = asArray(entry.configurationSnippets)
  for (const raw of snippets) {
    const snippet = asRecord(raw)
    if (!snippet) continue
    const body = asRecord(snippet.body)
    if (!body) continue
    out.push({ label: strOf(snippet.label), description: strOf(snippet.description), body })
  }
  if (out.length) return out
  for (const raw of asArray(entry.initialConfigurations)) {
    const body = asRecord(raw)
    if (body) out.push({ body })
  }
  return out
}

// --endregion

// --region nls 占位符解析

/**
 * 读扩展 nls 表（base 先入，zh-cn 后入覆盖；文件缺失/解析失败按空跳过）。
 * @author ddj 2026年09月22号
 * @param extDir 扩展根目录
 * @returns %key% → 文本 表
 */
function readNlsTable(extDir: string): NlsTable {
  const table: NlsTable = {}
  for (const file of ['package.nls.json', 'package.nls.zh-cn.json']) {
    try {
      const path = join(extDir, file)
      if (!existsSync(path)) continue
      const data = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') table[key] = value
      }
    } catch {
      /* 单个 nls 文件损坏按无表处理，不阻断提取 */
    }
  }
  return table
}

/**
 * 解析单串 %key% 占位（最多 3 轮：nls 值可再含占位；未命中剥 %…% 外壳）。
 * @author ddj 2026年09月22号
 * @param value 原文
 * @param table nls 表
 * @returns 解析后文本（无占位原样返回）
 */
function resolveNlsText(value: string, table: NlsTable): string {
  if (!value.includes('%')) return value
  let out = value
  for (let round = 0; round < 3; round += 1) {
    const next = out.replace(/%([A-Za-z0-9_.-]+)%/g, (_match, key: string) => table[key] ?? key)
    if (next === out) break
    out = next
  }
  return out
}

/** 深度解析任意值内的 %key%（字符串逐个过 resolveNlsText，对象/数组递归）。 */
function resolveNlsDeep(value: unknown, table: NlsTable): unknown {
  if (typeof value === 'string') return resolveNlsText(value, table)
  if (Array.isArray(value)) return value.map((item) => resolveNlsDeep(item, table))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveNlsDeep(item, table)
    }
    return out
  }
  return value
}

// --endregion

// --region 小工具

/** unknown → 非空字符串（其余空串）。 */
function strOf(value: unknown): string {
  return typeof value === 'string' && value ? value : ''
}

/** unknown → 普通对象（数组/原始值返回 null）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** unknown → 数组（单对象包一层，兼容 initialConfigurations 单对象写法）。 */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value && typeof value === 'object' ? [value] : []
}

// --endregion
