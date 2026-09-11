/**
 * dsh-vscode-mode host — 插件自带技能组（随包 skills/ 分发的 SKILL.md）。
 * - 存储：<包根>/skills/<技能名>/SKILL.md（目录式）或 <包根>/skills/<技能名>.md（扁平式），随包发布。
 * - 命名：技能名必须 kebab-case（DSH 硬约束，下划线会被 registry 拒绝）且以 dsh-vscodemode- 开头。
 * - 生效：注册自研 skill provider 到 ctx.skills（ctx.inject 惰性获取，服务缺失时插件仍完整可用）；
 *   文件变更经 fs.watch → control.invalidate() 即时可见。
 * 为什么自研 provider 而不用 @deepseek-ai/dsh-skill-filesystem：见 README「插件技能组」小节。
 * --region 划分：常量 / 类型 / frontmatter 解析（纯）/ 目录扫描（只读）/ provider / 挂载与状态
 * 作者 ddj 2026年09月11号
 */
import { existsSync, watch } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { skillsDirOf } from './paths.js'
import { log } from './log.js'
import type { Ctx } from './store.js'

// --region 常量
/** provider 名（注册进 ctx.skills；不得与 'filesystem' / 'openviking' 及保留名 'runtime' 冲突）。 */
export const SKILL_PROVIDER_NAME = 'dsh-vscodemode'
/** 技能组前缀白名单：名字不在其中的技能文件被跳过并告警。 */
export const SKILL_PREFIXES = ['dsh-vscodemode-'] as const
/** 候选 rank：对齐 dsh-skill-filesystem 的 CUSTOM_RANK（rank 仅在同一层内决定同名胜负）。 */
export const SKILL_RANK = 300
/** 单目录最多扫描的条目数（护栏，镜像 rules.ts 的 RULE_DIR_CAP）。 */
export const SKILL_DIR_CAP = 200
/** 技能发现来源标签（skill-explorer 归入 "System bundled" 组）。 */
const SKILL_SOURCE = 'bundled'
/** 目录式技能的文件名。 */
const SKILL_FILE = 'SKILL.md'
/** DSH 技能名语法（与 @deepseek-ai/dsh-skill 的 SKILL_NAME 一致：下划线非法）。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 不受支持的遗留字段 → 规范字段（官方同样拒绝，避免写错键位却静默无效果）。 */
const LEGACY_SKILL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
]
// --endregion

// --region 类型（镜像 @deepseek-ai/dsh-skill 的 provider 契约；本地无 dsh 类型声明）
/** 技能可见性策略：模型侧目录/加载器与人工命令各自独立。 */
export interface SkillInvocationPolicy {
  /** 是否进入模型可见目录并可由 skill 工具加载。 */
  readonly modelInvocable: boolean
  /** 是否可由用户的显式技能调用加载。 */
  readonly userInvocable: boolean
}

/** 一条技能解析成功的结果。 */
export interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  /** frontmatter 之后的正文（已 trim）。 */
  body: string
}

/** 一条技能被拒绝的原因（frontmatter 缺失/非法、名字不合规等）。 */
export interface SkillParseFailure {
  error: string
}

/** 解析结果：成功或失败（用 isParsedSkill 区分）。 */
export type SkillParse = ParsedSkill | SkillParseFailure

/** provider 返回的候选（registry 据此排序与加载）。 */
export interface SkillCandidate {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  source: string
  provider: string
  rank: number
  /** provider 私有句柄，原样回传给 get()。 */
  locator: unknown
  path?: string
  resourceBase?: { kind: 'directory'; path: string }
}

/** 完整技能定义（含正文）。 */
export interface SkillDefinition extends SkillCandidate {
  content: string
}

/** 注册生命周期与失效通知（registry 借给 provider 的控制面）。 */
export interface SkillControl {
  /** 精确注册被释放时 abort。 */
  readonly signal: AbortSignal
  /** 通知 registry 重收集目录（编辑 SKILL.md 后即时可见）。 */
  readonly invalidate: () => void
}

/** 本模块实现的 skill provider 面。 */
export interface SkillProvider {
  readonly name: string
  readonly list: () => Promise<SkillCandidate[]>
  readonly get: (candidate: SkillCandidate) => Promise<SkillDefinition | undefined>
}

/** 技能组装配状态（供兼容性页与日志读取）。 */
export interface SkillGroupState {
  /** 是否已调度 ctx.inject（services 就绪回调可能尚未执行）。 */
  dispatched: boolean
  /** provider 是否已注册成功。 */
  mounted: boolean
  /** 已发现的技能数（挂载后异步回填）。 */
  count: number
  /** 技能组根目录。 */
  dir: string
  /** 人类可读的状态说明（含降级原因）。 */
  note: string
}
// --endregion

// --region frontmatter 解析（纯函数）
/**
 * 去除标量值两侧成对引号。
 * 与 rules.ts 的同名私有工具语义一致；两处解析器面向不同格式（.mdc 规则 / SKILL.md），
 * 各自保持模块自治，避免为一处 4 行字符串处理引入跨模块耦合。
 * @author ddj 2026年09月11号
 * @param raw 原始标量文本
 * @returns 去引号后的文本
 */
function stripQuotes(raw: string): string {
  const value = raw.trim()
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  return quoted ? value.slice(1, -1) : value
}

/**
 * 解析 YAML 布尔标量（true/false/yes/no/on/off/1/0，大小写不敏感）。
 * @author ddj 2026年09月11号
 * @param raw 原始标量文本
 * @returns 布尔值；非布尔字面量返回 undefined
 */
function parseBool(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase()
  if (value === 'true' || value === 'yes' || value === 'on' || value === '1') return true
  if (value === 'false' || value === 'no' || value === 'off' || value === '0') return false
  return undefined
}

/**
 * 切出 frontmatter 与正文：首行必须是独立的 `---`，其后需有独立的闭合 `---`。
 * 容忍 BOM 与 CRLF；不满足即视为无 frontmatter（调用方按"忽略该文件"处理）。
 * @author ddj 2026年09月11号
 * @param text SKILL.md 全文
 * @returns frontmatter 行与正文；无合法 frontmatter 返回 null
 */
function splitFrontmatter(text: string): { fields: string[]; body: string } | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0] !== '---') return null
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i
      break
    }
  }
  if (close < 0) return null
  return { fields: lines.slice(1, close), body: lines.slice(close + 1).join('\n').trim() }
}

/**
 * 读取块标量（`|` / `>` 及其 chomping/缩进指示符后接的缩进行），返回文本与下一个待扫描位置。
 * 折叠式（`>`）行间以空格连接，字面式（`|`）以换行连接；两者末尾均 trim。
 * @author ddj 2026年09月11号
 * @param fields frontmatter 行
 * @param start 起始下标
 * @param folded 是否为折叠式（`>`）
 * @returns 块文本与下一扫描位置
 */
function readBlock(fields: string[], start: number, folded: boolean): { value: string; next: number } {
  const parts: string[] = []
  let i = start
  while (i < fields.length && (fields[i].trim() === '' || /^[ \t]/.test(fields[i]))) {
    const line = fields[i].trim()
    if (line !== '') parts.push(line)
    i += 1
  }
  return { value: parts.join(folded ? ' ' : '\n').trim(), next: i }
}

/**
 * 把 frontmatter 行解析为键值映射（仅支持本插件用到的标量形式：内联标量与 `|`/`>` 块标量）。
 * @author ddj 2026年09月11号
 * @param fields frontmatter 行
 * @returns 键值映射（无法识别的行跳过）
 */
function collectFields(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < fields.length; i++) {
    const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]?(.*)$/.exec(fields[i])
    if (!match) continue
    const key = match[1]
    const inline = match[2]
    // YAML 块标量指示符：| 或 >，可带 chomping（+/-）与显式缩进数字
    const block = /^([|>])[+-]?\d*$/.exec(inline.trim())
    if (block === null) {
      out[key] = stripQuotes(inline)
      continue
    }
    const read = readBlock(fields, i + 1, block[1] === '>')
    out[key] = read.value
    i = read.next - 1
  }
  return out
}

/**
 * 由 frontmatter 推导可见性策略（缺省两者皆 true；值为非布尔字面量时报错）。
 * @author ddj 2026年09月11号
 * @param data frontmatter 键值映射
 * @returns 策略与可选错误文案
 */
function toInvocation(data: Record<string, string>): { policy: SkillInvocationPolicy; error?: string } {
  const defaults: SkillInvocationPolicy = { modelInvocable: true, userInvocable: true }
  const disabled = parseBool(data['disable-model-invocation'] ?? '')
  if (disabled === undefined && data['disable-model-invocation'] !== undefined) {
    return { policy: defaults, error: 'frontmatter 字段 "disable-model-invocation" 必须是布尔值' }
  }
  const user = parseBool(data['user-invocable'] ?? '')
  if (user === undefined && data['user-invocable'] !== undefined) {
    return { policy: defaults, error: 'frontmatter 字段 "user-invocable" 必须是布尔值' }
  }
  return { policy: { modelInvocable: disabled !== true, userInvocable: user !== false } }
}

/**
 * 判断解析结果是否为成功形态。
 * @author ddj 2026年09月11号
 * @param value 解析结果
 * @returns 是否为 ParsedSkill
 */
export function isParsedSkill(value: SkillParse): value is ParsedSkill {
  return !('error' in value)
}

/**
 * 解析一条 SKILL.md（纯函数，永不抛错）。
 * @author ddj 2026年09月11号
 * @param text SKILL.md 全文
 * @returns 解析结果（成功含正文与元数据；失败含拒绝原因）
 */
export function parseSkillMd(text: string): SkillParse {
  const parts = splitFrontmatter(text)
  if (parts === null) return { error: '缺少合法 frontmatter（首行须为 --- 且存在闭合 ---）' }
  const data = collectFields(parts.fields)
  const legacy = LEGACY_SKILL_KEYS.find(([key]) => data[key] !== undefined)
  if (legacy !== undefined) {
    return { error: 'frontmatter 字段 "' + legacy[0] + '" 不受支持，请改用 "' + legacy[1] + '"' }
  }
  const name = (data.name ?? '').trim()
  if (!SKILL_NAME_RE.test(name)) {
    return { error: '非法技能名 "' + name + '"（须 kebab-case：小写字母/数字，段间连字符；下划线非法）' }
  }
  const description = (data.description ?? '').trim()
  if (!description) return { error: '技能 "' + name + '" 缺少 description' }
  const invocation = toInvocation(data)
  if (invocation.error !== undefined) return { error: invocation.error }
  const whenToUse = (data.whenToUse ?? '').trim()
  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    invocation: invocation.policy,
    body: parts.body,
  }
}
// --endregion

// --region 目录扫描（只读，失败不抛）
/**
 * 判断技能名是否落在技能组前缀白名单内。
 * @author ddj 2026年09月11号
 * @param name 技能名
 * @returns 是否命中前缀
 */
export function hasGroupPrefix(name: string): boolean {
  return SKILL_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * 目录条目 → 候选文件路径（目录式取 <名>/SKILL.md；扁平式取 <名>.md；其余跳过）。
 * @author ddj 2026年09月11号
 * @param dir 技能组根目录
 * @param entry 目录条目
 * @returns 候选文件绝对路径；不构成技能时返回 undefined
 */
function skillFileOf(dir: string, entry: { name: string; isDirectory(): boolean; isFile(): boolean }): string | undefined {
  if (entry.isDirectory()) return join(dir, entry.name, SKILL_FILE)
  if (entry.isFile() && entry.name.endsWith('.md')) return join(dir, entry.name)
  return undefined
}

/**
 * 由已解析的技能构造候选（provider 名/rank/source/resourceBase 按 registry 契约填充）。
 * @author ddj 2026年09月11号
 * @param parsed 解析成功的技能
 * @param file SKILL.md 绝对路径
 * @returns registry 候选
 */
function candidateFrom(parsed: ParsedSkill, file: string): SkillCandidate {
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    invocation: parsed.invocation,
    source: SKILL_SOURCE,
    provider: SKILL_PROVIDER_NAME,
    rank: SKILL_RANK,
    locator: { path: file },
    path: file,
    resourceBase: { kind: 'directory', path: dirname(file) },
  }
}

/**
 * 读盘并校验单个技能文件（缺失/读失败/解析失败/非本组前缀 → undefined + 告警）。
 * @author ddj 2026年09月11号
 * @param file SKILL.md 绝对路径
 * @returns registry 候选；不可用时 undefined
 */
async function candidateOf(file: string): Promise<SkillCandidate | undefined> {
  const info = await stat(file).catch(() => undefined)
  if (info === undefined || !info.isFile()) return undefined
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const parsed = parseSkillMd(text)
  if (!isParsedSkill(parsed)) {
    log.warn('技能已忽略（' + file + '）：' + parsed.error)
    return undefined
  }
  if (!hasGroupPrefix(parsed.name)) {
    log.warn('技能已忽略（' + file + '）：名字 "' + parsed.name + '" 不在技能组前缀 ' + SKILL_PREFIXES.join('/') + ' 内')
    return undefined
  }
  return candidateFrom(parsed, file)
}

/**
 * 扫描技能组目录（目录缺失/读取失败 → 空数组，不抛）。
 * @author ddj 2026年09月11号
 * @param dir 技能组根目录
 * @returns 通过校验的候选（按名字排序，受 SKILL_DIR_CAP 约束）
 */
export async function listSkills(dir: string): Promise<SkillCandidate[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const ordered = [...entries].sort((a, b) => a.name.localeCompare(b.name)).slice(0, SKILL_DIR_CAP)
  const found: SkillCandidate[] = []
  for (const entry of ordered) {
    const file = skillFileOf(dir, entry)
    if (file === undefined) continue
    const candidate = await candidateOf(file)
    if (candidate !== undefined) found.push(candidate)
  }
  return found
}

/**
 * 解析候选的落盘路径（locator 优先，回退 candidate.path）。
 * @author ddj 2026年09月11号
 * @param candidate registry 候选
 * @returns 绝对路径；不可解析时 undefined
 */
function locatorPath(candidate: SkillCandidate): string | undefined {
  const locator = candidate.locator as { path?: unknown } | undefined
  if (locator !== undefined && typeof locator.path === 'string') return locator.path
  return typeof candidate.path === 'string' ? candidate.path : undefined
}

/**
 * 加载候选的完整技能定义（重读盘；文件消失或名字变化 → undefined，让 registry 自行失效缓存）。
 * @author ddj 2026年09月11号
 * @param candidate registry 候选
 * @returns 完整定义；不可用时 undefined
 */
async function loadSkill(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
  const file = locatorPath(candidate)
  if (file === undefined) return undefined
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const parsed = parseSkillMd(text)
  if (!isParsedSkill(parsed) || parsed.name !== candidate.name) return undefined
  return { ...candidateFrom(parsed, file), content: parsed.body }
}
// --endregion

// --region provider 与监听
/**
 * 关闭 watcher（注册被释放时的收尾；失败不影响装配）。
 * @author ddj 2026年09月11号
 * @param watcher 文件监听器
 */
function closeWatcher(watcher: { close: () => unknown }): void {
  try {
    watcher.close()
  } catch (error) {
    /* 关闭失败不影响装配 */
  }
}

/**
 * 监听技能目录：变更 → control.invalidate()（registry 有收集缓存，必须失效才即时可见）。
 * 注册被释放时经 control.signal 关闭；监听不可用仅降级为"改动需重载插件"，不影响正确性。
 * @author ddj 2026年09月11号
 * @param dir 技能组根目录
 * @param control registry 借出的控制面
 */
function watchSkillDir(dir: string, control: SkillControl): void {
  if (!existsSync(dir)) return
  try {
    const watcher = watch(dir, { recursive: true, persistent: false }, () => control.invalidate())
    // EventEmitter 的 'error' 无监听者时会抛出未捕获异常，必须挂处理器
    watcher.on('error', (error) => log.warn('技能目录监听中断（改动需重载插件生效）：' + String(error)))
    control.signal.addEventListener('abort', () => closeWatcher(watcher), { once: true })
  } catch (error) {
    log.warn('技能目录监听不可用（改动需重载插件生效）：' + String(error))
  }
}

/**
 * 创建技能组 provider（注册进 ctx.skills）。
 * @author ddj 2026年09月11号
 * @param dir 技能组根目录
 * @param control registry 借出的控制面
 * @returns provider 实例
 */
export function newSkillProvider(dir: string, control: SkillControl): SkillProvider {
  watchSkillDir(dir, control)
  return {
    name: SKILL_PROVIDER_NAME,
    list: () => listSkills(dir),
    get: (candidate) => loadSkill(candidate),
  }
}
// --endregion

// --region 挂载与状态
/** 最近一次装配状态（兼容性页与启动日志读取；模块级单例，热重载后由新装配覆写）。 */
let group: SkillGroupState = { dispatched: false, mounted: false, count: 0, dir: '', note: '未装配' }

/**
 * 读取技能组装配状态（副本，调用方不可改写内部状态）。
 * @author ddj 2026年09月11号
 * @returns 状态快照
 */
export function skillGroupState(): SkillGroupState {
  return { ...group }
}

/**
 * 复位装配状态（测试隔离用）。
 * @author ddj 2026年09月11号
 */
export function resetSkillGroup(): void {
  group = { dispatched: false, mounted: false, count: 0, dir: '', note: '未装配' }
}

/**
 * 记录状态片段。
 * @author ddj 2026年09月11号
 * @param patch 待覆写字段
 */
function recordGroup(patch: Partial<SkillGroupState>): void {
  group = { ...group, ...patch }
}

/**
 * 在 skills 就绪回调里注册 provider，并异步回填技能数。
 * @author ddj 2026年09月11号
 * @param sctx inject 回调给出的服务上下文
 * @param dir 技能组根目录
 */
function mountGroup(sctx: unknown, dir: string): void {
  const sc = sctx as { get?: (name: string) => unknown; skills?: unknown } | undefined
  const skills = (typeof sc?.get === 'function' ? sc.get('skills') : undefined) ?? sc?.skills
  const register = (skills as { registerProvider?: unknown } | undefined)?.registerProvider
  if (typeof register !== 'function') {
    recordGroup({ mounted: false, note: 'skills 服务不可用或版本不含 registerProvider' })
    log.warn('技能组未挂载：skills 服务不可用，插件其余功能不受影响')
    return
  }
  try {
    ;(register as (create: (control: SkillControl) => SkillProvider) => unknown).call(skills, (control) =>
      newSkillProvider(dir, control),
    )
    recordGroup({ mounted: true, dir, note: '已挂载（等待技能扫描）' })
  } catch (error) {
    recordGroup({ mounted: false, note: 'provider 注册失败：' + String(error) })
    log.warn('技能组未挂载：provider 注册失败（' + String(error) + '）')
    return
  }
  void listSkills(dir)
    .then((found) => {
      recordGroup({ count: found.length, note: '已挂载 ' + found.length + ' 个技能' })
      log.info('插件技能组已挂载：' + SKILL_PREFIXES[0] + '* 共 ' + found.length + ' 个技能（' + dir + '）')
    })
    .catch((error) => log.warn('技能组扫描失败：' + String(error)))
}

/**
 * 装配插件技能组（惰性获取 skills 服务；服务缺失/版本过旧时降级记录，不抛错）。
 * 返回值只表示"是否已调度"——inject 回调异步执行，实际结果见 skillGroupState()。
 * @author ddj 2026年09月11号
 * @param ctx DSH host 上下文
 * @param dir 技能组根目录（缺省 import.meta.url 派生；测试注入）
 * @returns 是否已调度挂载
 */
export function installSkillGroup(ctx: Ctx, dir: string = skillsDirOf(import.meta.url)): boolean {
  const inject = (ctx as { inject?: unknown } | undefined)?.inject
  if (typeof inject !== 'function') {
    recordGroup({ dispatched: false, mounted: false, dir, note: 'ctx.inject 不可用（DSH 版本过旧），技能组未挂载' })
    log.warn('技能组未挂载：DSH 未提供 ctx.inject')
    return false
  }
  recordGroup({ dispatched: true, mounted: false, dir, note: '已调度 skills 服务装配（等待 skills 就绪）' })
  try {
    ;(inject as (services: string[], callback: (sctx: unknown) => void) => unknown).call(ctx, ['skills'], (sctx) =>
      mountGroup(sctx, dir),
    )
  } catch (error) {
    recordGroup({ dispatched: false, mounted: false, note: '挂载调度失败：' + String(error) })
    log.warn('技能组挂载调度失败：' + String(error))
    return false
  }
  return true
}
// --endregion
