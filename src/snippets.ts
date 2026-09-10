/**
 * dsh-vscode-mode host — 代码片段管理（VS Code 兼容 .code-snippets 文件）。
 * - 存储：全局片段 ~/.dsh/snippets/*.code-snippets；项目片段 <工作区>/.dsh/snippets/*.code-snippets
 *   （随仓库共享）。文件名约定与 VS Code 一致：`<language>.code-snippets`（`global.code-snippets`
 *   表示全语言生效）。
 * - 格式：顶层对象 { "<片段名>": { prefix, body, description?, scope? } }；body 支持字符串或
 *   字符串数组（数组按行拼接）。解析容错：单文件 JSON 损坏只影响该文件（error 字段提示）。
 * - 生效：client 侧 Monaco completion provider 按 model 语言拉取 snippetsEntries 后过滤展开；
 *   与 rules.ts 同一套 IO 通道（user 走 node fs；project 走 ctx fs + danger-full-access）。
 * --region 划分：常量与目录定位 / JSON 解析（纯）/ 条目展开（纯）/ 文件名与模板（纯）/ IO
 * 作者 ddj 2026年09月10号
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { dshHome } from './paths.js'
import type {
  SnippetEntry,
  SnippetInfo,
  SnippetProject,
  SnippetRefInput,
  SnippetSaveInput,
  SnippetScope,
} from './shared/snippets.js'
import type { Ctx } from './store.js'

/** 文件名与模板的纯函数定义在 shared（host 与 client 共用，避免两处漂移），此处透传便于 host 调用方单点导入。 */
export { normalizeSnippetFileName, snippetFileTemplate } from './shared/snippets.js'

// --region 常量与目录定位
/** 片段文件名白名单：字母数字开头，仅字母数字点横下划线，.code-snippets 后缀（天然拒绝路径分隔符）。 */
export const SNIPPET_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.code-snippets$/
/** Windows 保留设备名（防意外创建系统设备文件）。 */
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
/** 单目录最多加载的片段文件数（防失控目录拖垮装配）。 */
const SNIPPET_DIR_CAP = 200
/** 单条片段正文字节上限（超出截断，防超长片段撑爆补全载荷）。 */
const SNIPPET_SINGLE_CAP = 16 * 1024

/**
 * 全局片段目录（~/.dsh/snippets）。
 * @author ddj 2026年09月10号
 * @param home DSH home（缺省自动解析）
 * @returns 绝对路径
 */
export function userSnippetsDir(home = dshHome()): string {
  return join(home, 'snippets')
}

/**
 * 项目片段目录（<工作区>/.dsh/snippets）。
 * @author ddj 2026年09月10号
 * @param workspacePath 工作区绝对路径
 * @returns 绝对路径
 */
export function projectSnippetsDir(workspacePath: string): string {
  return join(workspacePath, '.dsh', 'snippets')
}

/**
 * 判定绝对路径是否落在全局片段目录内（edrv.read / edrv.save 的片段分支依据）。
 * 归一化分隔符后按前缀比较；不在目录内返回 false。
 * @author ddj 2026年09月10号
 * @param path 待判定路径
 * @param home DSH home（缺省自动解析）
 * @returns 是否为全局片段文件
 */
export function isSnippetFilePath(path: string, home = dshHome()): boolean {
  const raw = String(path ?? '')
  if (!raw) return false
  return resolveSnippetPath(raw, userSnippetsDir(home)) !== null
}

/**
 * 归一化并校验「路径是否位于 dir 直下」（拒绝 `..` 穿越与子目录）。
 * @author ddj 2026年09月10号
 * @param path 待判定路径
 * @param dir 目标目录
 * @returns 命中时返回归一化后的绝对路径（`/` 分隔）；否则 null
 */
function resolveSnippetPath(path: string, dir: string): string | null {
  const norm = (text: string): string => String(text).replace(/\\/g, '/').replace(/\/+$/, '')
  const target = norm(path)
  const base = norm(dir)
  if (!target.startsWith(base + '/')) return null
  const rest = target.slice(base.length + 1)
  // 仅允许目录直下的单层文件名（防子目录与穿越）
  if (!rest || rest.includes('/')) return null
  return SNIPPET_FILE_RE.test(rest) ? target : null
}
// --endregion

// --region JSON 解析（纯函数）
/** 一条片段的原始 JSON 声明（宽容：字段可能缺失或类型不符）。 */
interface RawSnippet {
  prefix?: unknown
  body?: unknown
  description?: unknown
  scope?: unknown
}

/** parseSnippetsJson 的产出：条目映射 + 可选解析错误。 */
export interface ParsedSnippets {
  entries: Record<string, ParsedEntry>
  error?: string
}

/** 已解析的单条片段（正文已归一为字符串）。 */
export interface ParsedEntry {
  prefix: string
  body: string
  description: string
  scope: string[]
}

/**
 * 归一化片段正文：字符串原样；字符串数组按行拼接（VS Code 语义）。
 * @author ddj 2026年09月10号
 * @param raw body 原始值
 * @returns 正文文本；非法类型返回空串
 */
export function normalizeBody(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw.filter((line) => typeof line === 'string').join('\n')
  return ''
}

/**
 * 归一化片段前缀：字符串去空白；字符串数组取首项；其余为空串。
 * @author ddj 2026年09月10号
 * @param raw prefix 原始值
 * @returns 前缀文本
 */
export function normalizePrefix(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw)) {
    const first = raw.find((item) => typeof item === 'string')
    return typeof first === 'string' ? first.trim() : ''
  }
  return ''
}

/**
 * 归一化 scope：字符串或字符串数组，去空白并小写；其余为空数组（= 全语言）。
 * @author ddj 2026年09月10号
 * @param raw scope 原始值
 * @returns 语言 id 数组
 */
export function normalizeScope(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return list
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 容错解析一个 .code-snippets 文件：顶层须为对象，逐条归一化；单条非法即跳过。
 * 解析永不抛错（失败以 error 文案返回）。
 * @author ddj 2026年09月10号
 * @param text 文件全文
 * @returns 解析结果（entries 为片段名 → 已解析条目）
 */
export function parseSnippetsJson(text: string): ParsedSnippets {
  const trimmed = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (!trimmed) return { entries: {} }
  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch (error) {
    return { entries: {}, error: 'JSON 解析失败：' + String(error) }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { entries: {}, error: '顶层必须是对象（{ "片段名": { prefix, body } }）' }
  }
  const entries: Record<string, ParsedEntry> = {}
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const raw = value as RawSnippet
    const body = normalizeBody(raw.body)
    if (!body) continue // body 缺失/非法：该条静默跳过（不污染整体）
    entries[key] = {
      prefix: normalizePrefix(raw.prefix),
      body: body.length > SNIPPET_SINGLE_CAP ? body.slice(0, SNIPPET_SINGLE_CAP) : body,
      description: typeof raw.description === 'string' ? raw.description : '',
      scope: normalizeScope(raw.scope),
    }
  }
  return { entries }
}
// --endregion

// --region 条目展开（纯函数）
/**
 * 由文件名推导语言 id：`<language>.code-snippets` → language；`global`/无法识别返回空串。
 * @author ddj 2026年09月10号
 * @param file 片段文件名（含后缀）
 * @returns 语言 id（空串 = 全语言）
 */
export function languageOfSnippetFile(file: string): string {
  const base = String(file ?? '').replace(/\.code-snippets$/i, '')
  if (!base || base.toLowerCase() === 'global') return ''
  return base.toLowerCase()
}

/**
 * 把「一个文件的解析结果」展开为补全条目：文件语言与条目 scope 取交集。
 * 条目 scope 为空 → 跟随文件语言；文件语言为空（global）→ 该条目对全语言生效。
 * @author ddj 2026年09月10号
 * @param info 文件元信息
 * @param parsed 解析结果
 * @returns 条目数组（含来源信息）
 */
export function entriesOfFile(info: SnippetInfo, parsed: ParsedSnippets): SnippetEntry[] {
  const fileLanguage = info.language
  const out: SnippetEntry[] = []
  for (const [key, entry] of Object.entries(parsed.entries)) {
    // 条目 scope 覆盖文件语言：有 scope 时按 scope，无 scope 时继承文件语言（空=全语言）
    const languages = entry.scope.length ? entry.scope : [fileLanguage]
    for (const language of languages) {
      out.push({
        key,
        prefix: entry.prefix,
        body: entry.body,
        description: entry.description,
        scope: info.scope,
        file: info.file,
        language,
      })
    }
  }
  return out
}

/**
 * 展开全部文件的条目（补全 provider 载荷）。
 * @author ddj 2026年09月10号
 * @param loaded 已加载的文件（元信息 + 解析结果）
 * @returns 条目数组（项目文件靠后，同 key 时项目覆盖全局）
 */
export function flattenSnippetEntries(loaded: Array<{ info: SnippetInfo; parsed: ParsedSnippets }>): SnippetEntry[] {
  const out: SnippetEntry[] = []
  for (const item of loaded) out.push(...entriesOfFile(item.info, item.parsed))
  return out
}
// --endregion

// --region 文件名与模板（纯函数）
/**
 * 校验片段文件名（白名单 + Windows 保留名拒绝）。
 * @author ddj 2026年09月10号
 * @param name 文件名（含后缀）
 * @returns 错误文案；null=合法
 */
export function validateSnippetFile(name: string): string | null {
  if (!SNIPPET_FILE_RE.test(name)) return '文件名不合法：仅允许字母数字开头，含字母/数字/点/横线/下划线，.code-snippets 后缀'
  if (RESERVED_NAME_RE.test(name)) return '文件名是 Windows 保留设备名，不允许'
  return null
}
// --endregion

// --region IO（列表 / 读 / 存 / 删 / 条目）
/**
 * 组装片段文件元信息视图（列表与补全载荷共用）。
 * @author ddj 2026年09月10号
 * @param scope 作用域
 * @param file 文件名
 * @param absPath 绝对路径
 * @param parsed 解析结果
 * @param size 字节数
 * @param mtime 修改时间毫秒
 * @returns 片段文件元信息
 */
function toSnippetInfo(scope: SnippetScope, file: string, absPath: string, parsed: ParsedSnippets, size: number, mtime: number): SnippetInfo {
  return {
    scope,
    file,
    absPath,
    relHint: scope === 'project' ? '.dsh/snippets/' : 'snippets/',
    language: languageOfSnippetFile(file),
    count: Object.keys(parsed.entries).length,
    size,
    mtime,
    error: parsed.error,
  }
}

/** 单目录片段文件列表（仅 *.code-snippets，最多 SNIPPET_DIR_CAP 个；目录缺失返回空）。 */
async function listSnippetsDir(dir: string, scope: SnippetScope): Promise<SnippetInfo[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const files = names.filter((name) => /\.code-snippets$/i.test(name)).sort().slice(0, SNIPPET_DIR_CAP)
  const out: SnippetInfo[] = []
  for (const file of files) {
    const absPath = join(dir, file)
    const info = await stat(absPath).catch(() => null)
    if (!info || !info.isFile()) continue
    const parsed = parseSnippetsJson(await readFile(absPath, 'utf8').catch(() => ''))
    out.push(toSnippetInfo(scope, file, absPath, parsed, info.size, info.mtimeMs))
  }
  return out
}

/** 已注册 workspace 列表（项目页与写入校验共用）。 */
function workspaceList(ctx: Ctx): Array<{ path: string; title?: string }> {
  const list = ctx.get('workspaceRegistry')?.list?.() ?? []
  return (list as Array<{ path?: string; title?: string }>).filter(
    (item): item is { path: string; title?: string } => Boolean(item) && typeof item.path === 'string' && item.path !== '',
  )
}

/** 用户显式 GUI 写操作的策略：danger-full-access（照抄 rules.fullPolicy）。 */
function fullPolicy(ctx: Ctx): unknown {
  const svc = ctx.get('sandboxPolicy')
  if (!svc || typeof svc.resolve !== 'function') return undefined
  return svc.resolve({ mode: 'danger-full-access' })
}

/**
 * 校验项目作用域的 workspacePath 已注册为 DSH workspace（防 RPC 写任意目录）。
 * @author ddj 2026年09月10号
 * @param ctx DSH 上下文
 * @param workspacePath 目标项目路径
 * @returns 命中的工作区项
 */
function requireWorkspace(ctx: Ctx, workspacePath: string | undefined): { path: string; title?: string } {
  const workspace = workspaceList(ctx).find((item) => item.path === workspacePath)
  if (!workspace) throw new Error('项目未注册为 DSH workspace，不能管理项目片段')
  return workspace as { path: string; title?: string }
}

/** 按作用域解析片段目录（project 先过 requireWorkspace）。 */
function dirOf(ctx: Ctx, scope: SnippetScope, workspacePath?: string): string {
  if (scope === 'project') return projectSnippetsDir(requireWorkspace(ctx, workspacePath).path)
  return userSnippetsDir()
}

/**
 * 片段文件总列表：全局片段 + 各已注册工作区的项目片段。
 * @author ddj 2026年09月10号
 * @param ctx DSH 上下文
 * @returns snippets.list 载荷
 */
export async function snippetsList(ctx: Ctx): Promise<{ user: SnippetInfo[]; projects: SnippetProject[] }> {
  const user = await listSnippetsDir(userSnippetsDir(), 'user')
  const projects: SnippetProject[] = []
  for (const workspace of workspaceList(ctx)) {
    const dir = projectSnippetsDir(workspace.path)
    const exists = existsSync(dir)
    const files = exists ? await listSnippetsDir(dir, 'project') : []
    projects.push({ workspacePath: workspace.path, title: workspace.title ?? '', files, missingDir: exists ? undefined : true })
  }
  return { user, projects }
}

/**
 * 读取一个片段文件全文（编辑界面打开用）。
 * @author ddj 2026年09月10号
 * @param ctx DSH 上下文
 * @param ref 作用域 + 文件名（+ 项目工作区）
 * @returns 文件全文
 */
export async function snippetsRead(ctx: Ctx, ref: SnippetRefInput): Promise<string> {
  const dir = dirOf(ctx, ref.scope, ref.workspacePath)
  return readFile(join(dir, ref.file), 'utf8')
}

/**
 * 保存（新建或覆盖）一个片段文件：project 作用域写盘走 ctx fs + danger-full-access（镜像 rules）。
 * @author ddj 2026年09月10号
 * @param ctx DSH 上下文
 * @param input 保存入参
 * @returns 保存后的片段文件元信息
 */
export async function snippetsSave(ctx: Ctx, input: SnippetSaveInput): Promise<SnippetInfo> {
  const invalid = validateSnippetFile(input.file)
  if (invalid) throw new Error(invalid)
  const dir = dirOf(ctx, input.scope, input.workspacePath)
  await mkdir(dir, { recursive: true })
  const absPath = join(dir, input.file)
  const content = String(input.content ?? '')
  if (input.scope === 'project') {
    const fs = ctx.get('fs')
    if (!fs) throw new Error('缺少 fs 服务')
    const target = await fs.resolve('.dsh/snippets/' + input.file, { cwd: requireWorkspace(ctx, input.workspacePath).path })
    await fs.writeText(target, content, void 0, void 0, fullPolicy(ctx))
  } else {
    await writeFile(absPath, content, 'utf8')
  }
  const info = await stat(absPath).catch(() => null)
  return toSnippetInfo(input.scope, input.file, absPath, parseSnippetsJson(content), info?.size ?? Buffer.byteLength(content), info?.mtimeMs ?? Date.now())
}

/**
 * 删除一个片段文件（project 作用域同样先过 workspace 注册校验）。
 * @author ddj 2026年09月10号
 * @param ctx DSH 上下文
 * @param ref 作用域 + 文件名（+ 项目工作区）
 */
export async function snippetsRemove(ctx: Ctx, ref: SnippetRefInput): Promise<void> {
  const dir = dirOf(ctx, ref.scope, ref.workspacePath)
  await rm(join(dir, ref.file), { force: true })
}

/**
 * 补全 provider 载荷：全局片段 + 指定工作区项目片段的全部条目。
 * 项目条目排在全局之后（同 key 时后出现的项目条目在 client 侧优先）。
 * @author ddj 2026年09月10号
 * @param ctx DSH 上下文
 * @param workspacePath 当前会话工作区（可选；未注册则仅全局片段）
 * @returns snippets.entries 载荷
 */
export async function snippetsEntries(ctx: Ctx, workspacePath?: string): Promise<{ entries: SnippetEntry[] }> {
  const loaded: Array<{ info: SnippetInfo; parsed: ParsedSnippets }> = []
  const load = async (dir: string, scope: SnippetScope): Promise<void> => {
    for (const info of await listSnippetsDir(dir, scope)) {
      const parsed = parseSnippetsJson(await readFile(info.absPath, 'utf8').catch(() => ''))
      if (parsed.error) continue // 损坏文件不影响其他片段
      loaded.push({ info, parsed })
    }
  }
  await load(userSnippetsDir(), 'user')
  const registered = workspaceList(ctx).some((item) => item.path === workspacePath)
  if (workspacePath && registered) await load(projectSnippetsDir(workspacePath), 'project')
  return { entries: flattenSnippetEntries(loaded) }
}
// --endregion
