/**
 * dsh-vscode-mode host — 规则管理（Codebuddy/Cursor 式 .mdc 规则）。
 * - 存储：用户规则 ~/.dsh/rules/*.mdc；项目规则 <工作区>/.dsh/rules/*.mdc（随仓库共享）。
 * - 格式：frontmatter（description / alwaysApply / globs / enabled）+ markdown 正文；
 *   类型映射 总是=always / 自动=auto(globs) / 手动=manual(仅索引)；enabled 为本插件扩展字段，缺省 true。
 * - 生效：host 注册 systemPrompt.section（order 400），每次装配同步读取（mtime 缓存），
 *   项目规则按 AssembleContext.agent.id → 会话 cwd 注入；旧版 DSH 缺服务时优雅降级。
 * --region 划分：常量 / frontmatter 解析（纯）/ 文件名与开关（纯）/ 注入渲染（纯）/ IO / systemPrompt 装配
 * 作者 ddj 2026年09月03号
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { dshHome } from './paths.js'
import type { RuleInfo, RuleProject, RuleRefInput, RuleScope, RuleSaveInput } from './shared/rules.js'
import type { Ctx } from './store.js'

// --region 常量与目录定位
/** 规则文件名白名单：字母数字开头，仅字母数字点横下划线，.mdc 后缀（天然拒绝路径分隔符）。 */
export const RULE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mdc$/
/** Windows 保留设备名（防意外创建系统设备文件）。 */
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
/** 单目录最多加载的规则文件数（防失控目录拖垮装配）。 */
const RULE_DIR_CAP = 200
/** 注入时单条规则正文字节上限（超出截断）。 */
const RULE_SINGLE_CAP = 16 * 1024
/** 注入时单个作用域（用户/项目）总字节预算。 */
const RULE_SCOPE_CAP = 64 * 1024
/** systemPrompt section 名（同层唯一）。 */
const SECTION_NAME = 'dsh-vscode-mode:rules'
/** section 顺序：persona(0) 与 PLAN_POLICY(500) 之间，规则先于计划策略被读到。 */
const SECTION_ORDER = 400

/**
 * 用户规则目录（~/.dsh/rules）。
 * @author ddj 2026年09月03号
 * @param home DSH home（缺省自动解析）
 * @returns 绝对路径
 */
export function userRulesDir(home = dshHome()): string {
  return join(home, 'rules')
}

/**
 * 项目规则目录（<工作区>/.dsh/rules）。
 * @author ddj 2026年09月03号
 * @param workspacePath 工作区绝对路径
 * @returns 绝对路径
 */
export function projectRulesDir(workspacePath: string): string {
  return join(workspacePath, '.dsh', 'rules')
}
// --endregion

// --region frontmatter 解析（纯函数）
/** parseRuleMdc 的产出：frontmatter 字段 + 正文 + 可选解析错误。 */
export interface ParsedRule {
  description: string
  alwaysApply: boolean
  globs: string[]
  enabled: boolean
  body: string
  error?: string
}

/**
 * 去除值两侧成对引号。
 * @author ddj 2026年09月03号
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

/**
 * 解析 globs 值：内联逗号分隔串，或空值后接 YAML 短横列表。
 * @author ddj 2026年09月03号
 * @param value 内联值（可为空）
 * @param listLines 后续短横列表行内容（去掉 `- ` 前缀）
 * @returns glob 数组
 */
function parseGlobs(value: string, listLines: string[]): string[] {
  const inline = stripQuotes(value)
  const items = inline ? inline.split(',') : listLines
  return items.map((item) => stripQuotes(item)).filter(Boolean)
}

/**
 * 容错解析一条 .mdc 规则：首行 `---` 且 100 行内有闭合 `---` 才视为 frontmatter，
 * 否则整个文本当正文（类型 manual、enabled=true）。解析永不抛错。
 * @author ddj 2026年09月03号
 * @param text 文件全文
 * @returns 解析结果
 */
export function parseRuleMdc(text: string): ParsedRule {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { description: '', alwaysApply: false, globs: [], enabled: true, body: text }
  let close = -1
  for (let i = 1; i < lines.length && i <= 101; i++) {
    if (lines[i].trim() === '---') { close = i; break }
  }
  if (close < 0) return { description: '', alwaysApply: false, globs: [], enabled: true, body: text }
  const result: ParsedRule = { description: '', alwaysApply: false, globs: [], enabled: true, body: lines.slice(close + 1).join('\n') }
  for (let i = 1; i < close; i++) {
    const match = /^([A-Za-z_-]+)[ \t]*:[ \t]?(.*)$/.exec(lines[i])
    if (!match) continue
    const [, key, raw] = match
    if (key === 'description') result.description = stripQuotes(raw)
    else if (key === 'alwaysApply') result.alwaysApply = stripQuotes(raw).toLowerCase() === 'true'
    else if (key === 'enabled') result.enabled = stripQuotes(raw).toLowerCase() !== 'false'
    else if (key === 'globs') {
      const listLines: string[] = []
      for (let j = i + 1; j < close; j++) {
        const item = /^[ \t]*-[ \t]*(.+)$/.exec(lines[j])
        if (!item) break
        listLines.push(item[1])
      }
      result.globs = parseGlobs(raw, listLines)
    }
  }
  return result
}

/**
 * 由 frontmatter 推导规则类型：总是 / 自动（有 globs）/ 手动。
 * @author ddj 2026年09月03号
 * @param parsed 解析结果
 * @returns 规则类型
 */
export function ruleTypeOf(parsed: ParsedRule): 'always' | 'auto' | 'manual' {
  if (parsed.alwaysApply) return 'always'
  if (parsed.globs.length) return 'auto'
  return 'manual'
}
// --endregion

// --region 文件名与开关改写（纯函数）
/**
 * 校验规则文件名（白名单 + Windows 保留名拒绝）。
 * @author ddj 2026年09月03号
 * @param name 文件名（含后缀）
 * @returns 错误文案；null=合法
 */
export function validateRuleFile(name: string): string | null {
  if (!RULE_FILE_RE.test(name)) return '文件名不合法：仅允许字母数字开头，含字母/数字/点/横线/下划线，.mdc 后缀'
  if (RESERVED_NAME_RE.test(name)) return '文件名是 Windows 保留设备名，不允许'
  return null
}

/**
 * 只改写 frontmatter 的 enabled 行（保留 BOM、CRLF 与其余内容不动）；无规则 frontmatter 返回 null。
 * @author ddj 2026年09月03号
 * @param text 文件全文
 * @param enabled 目标开关状态
 * @returns 改写后的全文；null=无法安全改写
 */
export function toggleEnabledLine(text: string, enabled: boolean): string | null {
  const hasBom = text.startsWith('\uFEFF')
  const rest = hasBom ? text.slice(1) : text
  const eol = rest.includes('\r\n') ? '\r\n' : '\n'
  const lines = rest.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  let close = -1
  for (let i = 1; i < lines.length && i <= 101; i++) {
    if (lines[i].trim() === '---') { close = i; break }
  }
  if (close < 0) return null
  const line = 'enabled: ' + (enabled ? 'true' : 'false')
  let replaced = false
  for (let i = 1; i < close; i++) {
    if (/^[ \t]*enabled[ \t]*:/.test(lines[i])) { lines[i] = line; replaced = true; break }
  }
  if (!replaced) lines.splice(1, 0, line)
  return (hasBom ? '\uFEFF' : '') + lines.join(eol)
}
// --endregion

// --region 注入渲染（纯函数）
/** 一条已加载规则：元信息 + 正文（注入渲染输入）。 */
export interface LoadedRule {
  info: RuleInfo
  body: string
}

/**
 * 渲染单条规则块：标题 + 描述 + 截断后的正文；auto 类型追加 glob 条件说明。
 * @author ddj 2026年09月03号
 * @param rule 已加载规则
 * @returns 文本块（含尾空行）
 */
function ruleBlock(rule: LoadedRule): string {
  let body = rule.body
  if (body.length > RULE_SINGLE_CAP) body = body.slice(0, RULE_SINGLE_CAP) + '\n…（规则正文超长已截断）'
  const condition = rule.info.type === 'auto' && rule.info.globs.length
    ? '（当处理匹配 ' + rule.info.globs.join(', ') + ' 的文件时应用）'
    : ''
  const desc = rule.info.description ? '\n' + rule.info.description : ''
  return '#### ' + rule.info.file + condition + desc + '\n' + body + '\n'
}

/**
 * 渲染一个作用域（用户/项目）的注入段：总是全文 / 自动带条件 / 手动仅索引行。
 * @author ddj 2026年09月03号
 * @param title 段标题
 * @param rules 已加载规则
 * @returns 段文本；无启用规则时返回空串
 */
function renderScope(title: string, rules: LoadedRule[]): string {
  const enabled = rules.filter((rule) => rule.info.enabled && !rule.info.error)
  const always = enabled.filter((rule) => rule.info.type === 'always')
  const auto = enabled.filter((rule) => rule.info.type === 'auto')
  const manual = enabled.filter((rule) => rule.info.type === 'manual')
  if (!always.length && !auto.length && !manual.length) return ''
  const out: string[] = ['## ' + title, '']
  let budget = RULE_SCOPE_CAP
  let omitted = false
  const push = (block: string): void => {
    if (block.length > budget) { omitted = true; return }
    budget -= block.length
    out.push(block)
  }
  if (always.length) {
    out.push('### 总是生效', '')
    for (const rule of always) push(ruleBlock(rule))
  }
  if (auto.length) {
    out.push('### 按文件匹配生效', '')
    for (const rule of auto) push(ruleBlock(rule))
  }
  if (manual.length) {
    out.push('### 可按需读取（未自动生效；需要时读取对应文件）', '')
    for (const rule of manual) {
      const desc = rule.info.description ? ' — ' + rule.info.description : ''
      push('- ' + rule.info.file + desc + '（路径: ' + rule.info.absPath + '）\n')
    }
  }
  if (omitted) out.push('', '（部分规则因总长度预算被省略，请精简规则文件）')
  return out.join('\n') + '\n'
}

/**
 * 渲染规则注入 section 全文：用户规则段 + 项目规则段；两者皆空返回空串（空 section 无害）。
 * @author ddj 2026年09月03号
 * @param user 用户规则
 * @param project 当前工作区项目规则
 * @param workspacePath 项目段标注的工作区路径（缺省跳过项目段）
 * @returns 注入文本
 */
export function renderRulesSection(user: LoadedRule[], project: LoadedRule[], workspacePath?: string): string {
  const userText = renderScope('用户规则（用户配置，必须遵守）', user)
  const projectText = workspacePath ? renderScope('项目规则（工作区 ' + workspacePath + '，必须遵守）', project) : ''
  return [userText, projectText].filter(Boolean).join('\n')
}
// --endregion

// --region IO（列表 / 读 / 存 / 删 / 开关）
/** 单目录规则元信息列表（仅 *.mdc，最多 RULE_DIR_CAP 个；目录缺失返回空）。 */
async function listRulesDir(dir: string, scope: RuleScope): Promise<RuleInfo[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const mdcs = names.filter((name) => name.endsWith('.mdc')).sort().slice(0, RULE_DIR_CAP)
  const out: RuleInfo[] = []
  for (const file of mdcs) {
    const absPath = join(dir, file)
    const info = await stat(absPath).catch(() => null)
    if (!info || !info.isFile()) continue
    const parsed = parseRuleMdc(await readFile(absPath, 'utf8').catch(() => ''))
    out.push(toRuleInfo(scope, file, absPath, parsed, info.size, info.mtimeMs))
  }
  return out
}

/** 已注册 workspace 列表（项目 Tab 与写入校验共用）。 */
function workspaceList(ctx: Ctx): Array<{ path: string; title?: string }> {
  const list = ctx.get('workspaceRegistry')?.list?.() ?? []
  return (list as Array<{ path?: string; title?: string }>).filter(
    (item): item is { path: string; title?: string } => Boolean(item) && typeof item.path === 'string' && item.path !== '',
  )
}

/** 用户显式 GUI 写操作的策略：danger-full-access（照抄 mcpProject.fullPolicy）。 */
function fullPolicy(ctx: Ctx): unknown {
  const svc = ctx.get('sandboxPolicy')
  if (!svc || typeof svc.resolve !== 'function') return undefined
  return svc.resolve({ mode: 'danger-full-access' })
}

/** 校验项目作用域的 workspacePath 已注册为 DSH workspace（防 RPC 写任意目录）。 */
function requireWorkspace(ctx: Ctx, workspacePath: string | undefined): { path: string; title?: string } {
  const workspace = workspaceList(ctx).find((item) => item.path === workspacePath)
  if (!workspace) throw new Error('项目未注册为 DSH workspace，不能管理项目规则')
  return workspace as { path: string; title?: string }
}

/** 按作用域解析规则目录（project 先过 requireWorkspace）。 */
function dirOf(ctx: Ctx, scope: RuleScope, workspacePath?: string): string {
  if (scope === 'project') return projectRulesDir(requireWorkspace(ctx, workspacePath).path)
  return userRulesDir()
}

/**
 * 规则总列表：用户规则 + 各已注册工作区的项目规则。
 * @author ddj 2026年09月03号
 * @param ctx DSH 上下文
 * @returns rules.list 载荷
 */
export async function rulesList(ctx: Ctx): Promise<{ user: RuleInfo[]; projects: RuleProject[] }> {
  const user = await listRulesDir(userRulesDir(), 'user')
  const projects: RuleProject[] = []
  for (const workspace of workspaceList(ctx)) {
    const dir = projectRulesDir(workspace.path)
    const exists = existsSync(dir)
    const rules = exists ? await listRulesDir(dir, 'project') : []
    projects.push({ workspacePath: workspace.path, title: workspace.title ?? '', rules, missingDir: exists ? undefined : true })
  }
  return { user, projects }
}

/**
 * 读取一条规则全文（编辑器回填用）。
 * @author ddj 2026年09月03号
 * @param ctx DSH 上下文
 * @param ref 作用域 + 文件名（+ 项目工作区）
 * @returns 文件全文
 */
export async function rulesRead(ctx: Ctx, ref: RuleRefInput): Promise<string> {
  const dir = dirOf(ctx, ref.scope, ref.workspacePath)
  return readFile(join(dir, ref.file), 'utf8')
}

/**
 * 组装规则元信息视图（rulesSave / rulesToggle / 注入缓存共用）。
 * @author ddj 2026年09月03号
 * @param scope 作用域
 * @param file 文件名
 * @param absPath 绝对路径
 * @param parsed 解析结果
 * @param size 字节数
 * @param mtime 修改时间毫秒
 * @returns 规则元信息
 */
function toRuleInfo(scope: RuleScope, file: string, absPath: string, parsed: ParsedRule, size: number, mtime: number): RuleInfo {
  return {
    scope, file, absPath,
    relHint: scope === 'project' ? '.dsh/rules/' : 'rules/',
    description: parsed.description, type: ruleTypeOf(parsed), globs: parsed.globs, enabled: parsed.enabled,
    size, mtime, error: parsed.error,
  }
}

/**
 * 保存（新建或覆盖）一条规则：project 作用域写盘走 ctx fs + danger-full-access（镜像 mcpProject）。
 * @author ddj 2026年09月03号
 * @param ctx DSH 上下文
 * @param input 保存入参
 * @returns 保存后的规则元信息
 */
export async function rulesSave(ctx: Ctx, input: RuleSaveInput): Promise<RuleInfo> {
  const invalid = validateRuleFile(input.file)
  if (invalid) throw new Error(invalid)
  const dir = dirOf(ctx, input.scope, input.workspacePath)
  await mkdir(dir, { recursive: true })
  const absPath = join(dir, input.file)
  const content = String(input.content ?? '')
  if (input.scope === 'project') {
    const fs = ctx.get('fs')
    if (!fs) throw new Error('缺少 fs 服务')
    const target = await fs.resolve('.dsh/rules/' + input.file, { cwd: requireWorkspace(ctx, input.workspacePath).path })
    await fs.writeText(target, content, void 0, void 0, fullPolicy(ctx))
  } else {
    await writeFile(absPath, content, 'utf8')
  }
  const info = await stat(absPath).catch(() => null)
  return toRuleInfo(input.scope, input.file, absPath, parseRuleMdc(content), info?.size ?? Buffer.byteLength(content), info?.mtimeMs ?? Date.now())
}

/**
 * 删除一条规则文件（project 作用域同样先过 workspace 注册校验）。
 * @author ddj 2026年09月03号
 * @param ref 作用域 + 文件名（+ 项目工作区）
 */
export async function rulesRemove(ctx: Ctx, ref: RuleRefInput): Promise<void> {
  const dir = dirOf(ctx, ref.scope, ref.workspacePath)
  await rm(join(dir, ref.file), { force: true })
}

/**
 * 切换规则启用开关：只改写 frontmatter enabled 行，其余内容零改动。
 * @author ddj 2026年09月03号
 * @param ref 作用域 + 文件名（+ 项目工作区）
 * @param enabled 目标状态
 * @returns 更新后的规则元信息
 */
export async function rulesToggle(ctx: Ctx, ref: RuleRefInput, enabled: boolean): Promise<RuleInfo> {
  const dir = dirOf(ctx, ref.scope, ref.workspacePath)
  const absPath = join(dir, ref.file)
  const text = await readRuleText(ctx, ref, absPath)
  if (text === null) throw new Error('规则文件不存在：' + ref.file)
  const next = toggleEnabledLine(text, enabled)
  if (next === null) throw new Error('规则缺少 frontmatter（首行需为 ---），无法记录开关状态')
  if (next !== text) await rulesSaveContent(ctx, ref, absPath, next)
  return await ruleInfoOf(ref, absPath, next)
}

/** 按作用域读规则全文：project 与写盘同通道走 ctx fs，user 走 node fs；缺失返回 null。 */
async function readRuleText(ctx: Ctx, ref: RuleRefInput, absPath: string): Promise<string | null> {
  if (ref.scope !== 'project') return readFile(absPath, 'utf8').catch(() => null)
  const fs = ctx.get('fs')
  if (!fs) throw new Error('缺少 fs 服务')
  const target = await fs.resolve('.dsh/rules/' + ref.file, { cwd: requireWorkspace(ctx, ref.workspacePath).path })
  try {
    return await fs.readText(target)
  } catch {
    return null
  }
}

/** rulesToggle 的写盘通道：与 rulesSave 相同（project 走 ctx fs + fullPolicy，user 走 node fs）。 */
async function rulesSaveContent(ctx: Ctx, ref: RuleRefInput, absPath: string, content: string): Promise<void> {
  if (ref.scope !== 'project') {
    await writeFile(absPath, content, 'utf8')
    return
  }
  const fs = ctx.get('fs')
  if (!fs) throw new Error('缺少 fs 服务')
  const target = await fs.resolve('.dsh/rules/' + ref.file, { cwd: requireWorkspace(ctx, ref.workspacePath).path })
  await fs.writeText(target, content, void 0, void 0, fullPolicy(ctx))
}

/** 重建单条规则元信息（toggle 后回传 UI；stat 失败时用内容长度 + 当前时间兜底）。 */
async function ruleInfoOf(ref: RuleRefInput, absPath: string, content: string): Promise<RuleInfo> {
  const info = await stat(absPath).catch(() => null)
  return toRuleInfo(ref.scope, ref.file, absPath, parseRuleMdc(content), info?.size ?? Buffer.byteLength(content), info?.mtimeMs ?? Date.now())
}
// --endregion

// --region systemPrompt 装配（注入生效通道）
/** 注入读取的 mtime 缓存项：mtimeMs+size 命中即复用解析结果，避免每次装配读盘解析。 */
interface InjCacheEntry {
  mtimeMs: number
  size: number
  parsed: ParsedRule
}
const injCache = new Map<string, InjCacheEntry>()

/**
 * 同步读取一个规则目录（装配 provider 内专用）：仅 *.mdc，mtime 缓存，异常静默为空。
 * @author ddj 2026年09月03号
 * @param dir 规则目录
 * @param scope 作用域
 * @param relHint 相对提示
 * @returns 已加载规则列表
 */
function readRulesSync(dir: string, scope: RuleScope): LoadedRule[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: LoadedRule[] = []
  for (const file of names.filter((name) => name.endsWith('.mdc')).sort().slice(0, RULE_DIR_CAP)) {
    const absPath = join(dir, file)
    let info: { mtimeMs: number; size: number; isFile(): boolean }
    try {
      info = statSync(absPath)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const cached = injCache.get(absPath)
    let parsed: ParsedRule
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      parsed = cached.parsed
    } else {
      try {
        parsed = parseRuleMdc(readFileSync(absPath, 'utf8'))
      } catch {
        continue
      }
      injCache.set(absPath, { mtimeMs: info.mtimeMs, size: info.size, parsed })
    }
    out.push({
      info: toRuleInfo(scope, file, absPath, parsed, info.size, info.mtimeMs),
      body: parsed.body,
    })
  }
  return out
}

/** 从装配上下文解析会话工作区 cwd（agent.id → sessions → header.cwd；缺链返回 null）。 */
function cwdFromAssemble(ctx: Ctx, asm: { agent?: { id?: unknown } } | undefined): string | null {
  const id = asm?.agent?.id
  if (typeof id !== 'string' || !id) return null
  const session = ctx.get('sessions')?.get?.(id)
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : null
}

/**
 * 安装规则注入 section（可选探测 systemPrompt 服务；失败/缺失返回 false，不致命）。
 * @author ddj 2026年09月03号
 * @param ctx DSH host 上下文
 * @returns 是否成功注册
 */
export function installRulesSection(ctx: Ctx): boolean {
  const sp = ctx.get('systemPrompt')
  if (!sp || typeof sp.section !== 'function') return false
  const provider = (asm: { agent?: { id?: unknown } }): string => {
    try {
      const user = readRulesSync(userRulesDir(), 'user')
      const cwd = cwdFromAssemble(ctx, asm)
      const project = cwd ? readRulesSync(projectRulesDir(cwd), 'project') : []
      return renderRulesSection(user, project, cwd ?? undefined)
    } catch {
      return ''
    }
  }
  ctx.effect(() => sp.section({ name: SECTION_NAME, order: SECTION_ORDER, text: provider }), 'vscode-mode: rules section')
  return true
}
// --endregion
