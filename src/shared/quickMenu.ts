/**
 * dsh-vscode-mode 快捷菜单共享契约与纯逻辑。
 *
 * host 与 client 共用：只放类型与纯函数，禁 node/react 导入（与 shared/rules.ts 同约束）。
 * 覆盖四块：文档归一（含损坏/越界兜底）、树层级与工作区可见性、绑定校验、消息合成、几何布局。
 * 作者 ddj 2026年10月30号
 */
import type { RuleInfo, RuleProject, RuleScope } from './rules.js'

//#region 类型

/** 快捷菜单项类型：组（可含子项）或按钮（可发送）。 */
export type QuickItemType = 'group' | 'button'

/** 规则注入方式：引用（只给名字与路径）或内联（把正文嵌进消息）。 */
export type RuleInjectMode = 'reference' | 'inline'

/** 点击按钮后的动作：直接发送或只填入输入框。 */
export type ClickAction = 'send' | 'fill'

/** 一条绑定到按钮的规则引用（与 rules.* RPC 的作用域/文件契约对齐）。 */
export interface RuleBinding {
  /** 用户规则或项目规则。 */
  scope: RuleScope
  /** 项目规则所属工作区绝对路径（用户规则不设置）。 */
  workspacePath?: string
  /** 用户规则来源（当前 DSH_HOME 或旧版 ~/.dsh），用于同名文件消歧。 */
  origin?: 'current' | 'legacy'
  /** 规则文件名（含 .mdc 后缀）。 */
  file: string
}

/** 组与按钮共有的字段。 */
export interface QuickItemBase {
  /** 稳定 id（host 首次保存时生成；跨改名/移动不变）。 */
  id: string
  /** 项类型。 */
  type: QuickItemType
  /** 显示名（≤40 字）。 */
  name: string
  /** 同级显示优先级（升序，0..999）。 */
  order: number
  /** 归属组 id；null 表示顶层（不可感知的 root 组）。 */
  parentId: string | null
  /** 限定工作区绝对路径列表；null 表示全部工作区显示。 */
  workspaces: string[] | null
}

/** 组：只做容器，不含发送内容。 */
export interface QuickGroup extends QuickItemBase {
  type: 'group'
}

/** 按钮：带预填提示词与绑定。 */
export interface QuickButton extends QuickItemBase {
  type: 'button'
  /** 预填提示词（≤8KB，支持 {{workspace}} {{selection}} {{date}} {{rules}} {{skills}}）。 */
  prompt: string
  /** 绑定技能名（kebab-case，作为 /name 文本 token 发进消息）。 */
  skills: string[]
  /** 绑定规则列表。 */
  rules: RuleBinding[]
  /** 规则注入方式。 */
  ruleMode: RuleInjectMode
  /** 点击动作覆盖（缺省继承文档级 clickAction）。 */
  clickAction?: ClickAction
}

/** 菜单项（判别联合）。 */
export type QuickMenuItem = QuickGroup | QuickButton

/** 持久化文档（host 侧 quick-menu.json 的载荷）。 */
export interface QuickMenuDoc {
  /** 结构版本，用于迁移。 */
  version: number
  /** 乐观并发版本号（每次成功写入 +1）。 */
  revision: number
  /** 最后写入时间（ISO 字符串）。 */
  updatedAt: string
  /** 悬浮按钮总开关。 */
  enabled: boolean
  /** 文档级点击动作。 */
  clickAction: ClickAction
  /** 最大嵌套层数（1..5，默认 3；root 列的直接子项为第 1 层）。 */
  maxDepth: number
  /** 悬浮按钮位置（null 表示沿用输入框左上角锚点）。 */
  launcher: { x: number | null; y: number | null }
  /** 全部菜单项（扁平存储，父子关系由 parentId 表达）。 */
  items: QuickMenuItem[]
}

/** 矩形（浮层内坐标，left/top 为相对定位点）。 */
export interface QuickRect {
  left: number
  top: number
  width: number
  height: number
}

/** 尺寸。 */
export interface QuickSize {
  width: number
  height: number
}

/** 绑定状态：ok 就绪 / warn 可发送但会跳过或需注意 / error 失效 / unknown 未校验。 */
export interface BindingStatus {
  state: 'ok' | 'warn' | 'error' | 'unknown'
  /** 面向用户的原因文案（ok 时省略）。 */
  reason?: string
}

/** 规则列表快照（rules.list 的响应子集）。 */
export interface RuleListSnapshot {
  user: RuleInfo[]
  projects: RuleProject[]
}

/** 校验上下文：缺字段表示「尚未加载」，一律按未校验处理而非报错。 */
export interface ValidateContext {
  /** 当前会话工作区路径（项目规则匹配与可见性判断用）。 */
  cwd?: string
  rules?: RuleListSnapshot
  /** 当前会话可见技能名；null 表示无法枚举（无活跃会话）。 */
  skillNames?: string[] | null
}

/** 消息合成上下文（在校验上下文之上补充占位符与内联正文）。 */
export interface ComposeContext extends ValidateContext {
  /** 规则内联正文，键为 bindingKey()。 */
  inlineContents?: Record<string, string>
  /** 用户框选文本（{{selection}}）。 */
  selection?: string
  /** 日期文本（{{date}}），缺省由调用方传入。 */
  date?: string
}

/** 单项状态聚合（失效原因汇总给菜单行/弹窗展示）。 */
export interface ItemStatus {
  errors: string[]
  warnings: string[]
}

//#endregion

//#region 常量

/** 文档结构版本。 */
export const QUICK_MENU_VERSION = 1
/** 菜单项数量上限。 */
export const QUICK_MENU_MAX_ITEMS = 200
/** 嵌套层数上限。 */
export const QUICK_MENU_MAX_DEPTH = 5
/** 嵌套层数下限。 */
export const QUICK_MENU_MIN_DEPTH = 1
/** 默认嵌套层数。 */
export const QUICK_MENU_DEFAULT_DEPTH = 3
/** 名称长度上限。 */
export const QUICK_MENU_NAME_CAP = 40
/** 提示词长度上限。 */
export const QUICK_MENU_PROMPT_CAP = 8192
/** 单条规则内联正文上限。 */
export const QUICK_MENU_RULE_CAP = 8192
/** 文档大小上限（字节）。 */
export const QUICK_MENU_BYTES_CAP = 256 * 1024
/** 优先级上限。 */
export const QUICK_MENU_ORDER_CAP = 999
/** 单项可绑定技能数上限。 */
export const QUICK_MENU_SKILL_CAP = 24
/** 单项可绑定规则数上限。 */
export const QUICK_MENU_RULE_LIMIT = 24
/** 技能名合法形态。 */
export const QUICK_MENU_SKILL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 未命名项兜底名。 */
const FALLBACK_NAME = '未命名'

//#endregion

//#region 基础工具

/**
 * 数值夹取（NaN/非有限回落到 fallback）。
 * @author ddj 2026年10月30号
 * @param value 原始值
 * @param min 下限
 * @param max 上限
 * @param fallback 非法值兜底
 * @returns 夹取后的数值
 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  if (number < min) return min
  if (number > max) return max
  return number
}

/**
 * 取对象形态（非对象/数组返回 null）。
 * @author ddj 2026年10月30号
 * @param value 原始值
 * @returns 普通对象或 null
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * 取字符串（非字符串回落空串）。
 * @author ddj 2026年10月30号
 * @param value 原始值
 * @returns 字符串
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 文本截断（超长补省略号）。
 * @author ddj 2026年10月30号
 * @param text 原文
 * @param cap 上限字符数
 * @returns 截断后文本
 */
function cutText(text: string, cap: number): string {
  if (text.length <= cap) return text
  return text.slice(0, Math.max(0, cap - 1)) + '…'
}

//#endregion

//#region 路径与工作区

/**
 * 归一化工作区路径（统一分隔符、去尾分隔符、win32 转小写），用于比较而非展示。
 * @author ddj 2026年10月30号
 * @param path 原始路径
 * @returns 归一化路径
 */
export function normalizePath(path: string): string {
  const unified = path.trim().replace(/\//g, '\\').replace(/\\+$/, '')
  if (unified === '') return ''
  // Windows 工作区路径大小写不敏感：统一小写，避免同一目录两种写法不匹配
  return unified.toLowerCase()
}

/**
 * 判断一条限定工作区列表是否覆盖当前工作区（含子目录，按路径边界匹配）。
 * @author ddj 2026年10月30号
 * @param paths 限定列表；null 表示全部工作区
 * @param cwd 当前工作区路径；空串表示未知（视为可见）
 * @returns 是否可见
 */
export function matchWorkspace(paths: string[] | null, cwd?: string): boolean {
  if (paths === null || paths === undefined) return true
  if (paths.length === 0) return true
  const normalizedCwd = normalizePath(cwd ?? '')
  if (normalizedCwd === '') return true
  return paths.some((path) => {
    const normalized = normalizePath(path)
    if (normalized === '') return false
    // 目录边界匹配：C:\a 不应命中 C:\ab
    return normalizedCwd === normalized || normalizedCwd.startsWith(normalized + '\\')
  })
}

//#endregion

//#region 文档构造与归一

/**
 * 默认文档（首次打开菜单时的初始状态）。
 * @author ddj 2026年10月30号
 * @returns 默认文档
 */
export function defaultDoc(): QuickMenuDoc {
  return {
    version: QUICK_MENU_VERSION,
    revision: 0,
    updatedAt: '',
    enabled: true,
    clickAction: 'send',
    maxDepth: QUICK_MENU_DEFAULT_DEPTH,
    launcher: { x: null, y: null },
    items: [],
  }
}

/**
 * 生成新菜单项 id（类型前缀 + 时间 + 随机，跨会话不重复）。
 * @author ddj 2026年10月30号
 * @param type 项类型
 * @returns 新 id
 */
export function newQuickId(type: QuickItemType): string {
  const prefix = type === 'group' ? 'g' : 'b'
  const random = Math.random().toString(36).slice(2, 8)
  return prefix + '_' + Date.now().toString(36) + random
}

/**
 * 归一化限定工作区列表（去空、去重、归一化；空结果回落到 null=全部）。
 * @author ddj 2026年10月30号
 * @param raw 原始值
 * @returns 限定列表或 null
 */
function normalizeWorkspaces(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const normalized = normalizePath(entry)
    if (normalized === '') continue
    if (out.includes(normalized)) continue
    out.push(normalized)
  }
  // 传空数组时视为「未限定」，避免误配导致整组消失
  return out.length > 0 ? out : null
}

/**
 * 绑定规则的稳定键（校验、去重、内联正文映射共用）。
 * @author ddj 2026年10月30号
 * @param binding 规则绑定
 * @returns 键
 */
export function bindingKey(binding: RuleBinding): string {
  const workspace = normalizePath(binding.workspacePath ?? '')
  return binding.scope + '|' + workspace + '|' + binding.file
}

/**
 * 归一化单条规则绑定（scope/file 必填，项目规则必须带工作区）。
 * @author ddj 2026年10月30号
 * @param raw 原始值
 * @returns 绑定或 null
 */
function normalizeRule(raw: unknown): RuleBinding | null {
  const record = asRecord(raw)
  if (!record) return null
  const file = asString(record.file).trim()
  if (file === '') return null
  const scope: RuleScope = record.scope === 'project' ? 'project' : 'user'
  const binding: RuleBinding = { scope, file }
  if (scope === 'project') {
    const workspacePath = asString(record.workspacePath).trim()
    if (workspacePath === '') return null
    binding.workspacePath = workspacePath
  }
  if (record.origin === 'current' || record.origin === 'legacy') binding.origin = record.origin
  return binding
}

/**
 * 归一化规则绑定列表（去重 + 上限）。
 * @author ddj 2026年10月30号
 * @param raw 原始值
 * @returns 绑定列表
 */
function normalizeRules(raw: unknown): RuleBinding[] {
  if (!Array.isArray(raw)) return []
  const out: RuleBinding[] = []
  for (const entry of raw) {
    const binding = normalizeRule(entry)
    if (!binding) continue
    if (out.some((existing) => bindingKey(existing) === bindingKey(binding))) continue
    out.push(binding)
  }
  return out.slice(0, QUICK_MENU_RULE_LIMIT)
}

/**
 * 归一化技能名列表（只保留 kebab-case，去重 + 上限）。
 * @author ddj 2026年10月30号
 * @param raw 原始值
 * @returns 技能名列表
 */
function normalizeSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (name === '' || !QUICK_MENU_SKILL_RE.test(name)) continue
    if (out.includes(name)) continue
    out.push(name)
  }
  return out.slice(0, QUICK_MENU_SKILL_CAP)
}

/**
 * 归一化单个菜单项（非法类型/缺 id 返回 null）。
 * @author ddj 2026年10月30号
 * @param raw 原始值
 * @returns 菜单项或 null
 */
function normalizeItem(raw: unknown): QuickMenuItem | null {
  const record = asRecord(raw)
  if (!record) return null
  const type: QuickItemType = record.type === 'group' ? 'group' : 'button'
  const id = asString(record.id).trim()
  if (id === '') return null
  const name = cutText(asString(record.name).trim() || FALLBACK_NAME, QUICK_MENU_NAME_CAP)
  const order = clampNumber(record.order, 0, QUICK_MENU_ORDER_CAP, 100)
  const rawParent = record.parentId
  const parentId = typeof rawParent === 'string' && rawParent.trim() !== '' ? rawParent.trim() : null
  const base: QuickItemBase = { id, type, name, order, parentId, workspaces: normalizeWorkspaces(record.workspaces) }
  if (type === 'group') return { ...base, type: 'group' }
  const button: QuickButton = {
    ...base,
    type: 'button',
    prompt: cutText(asString(record.prompt), QUICK_MENU_PROMPT_CAP),
    skills: normalizeSkills(record.skills),
    rules: normalizeRules(record.rules),
    ruleMode: record.ruleMode === 'inline' ? 'inline' : 'reference',
  }
  if (record.clickAction === 'send' || record.clickAction === 'fill') button.clickAction = record.clickAction
  return button
}

/**
 * 判断从起点上溯的父链是否会回到目标项（环检测；超深链也按非法处理）。
 * @author ddj 2026年10月30号
 * @param byId id → 项
 * @param startId 起点父 id
 * @param targetId 目标项 id
 * @returns 是否成环
 */
function chainHas(byId: Map<string, QuickMenuItem>, startId: string | null, targetId: string): boolean {
  let current = startId
  let guard = 0
  while (current !== null) {
    if (current === targetId) return true
    if (guard > QUICK_MENU_MAX_DEPTH + 2) return true
    const parent = byId.get(current)
    if (!parent) return false
    current = parent.parentId
    guard += 1
  }
  return false
}

/**
 * 修补父链问题：父不存在/父是按钮/自指/形成环时把子项上抬到最近合法祖组或顶层。
 * @author ddj 2026年10月30号
 * @param items 归一化后的项
 * @returns 修补后的项
 */
function repairParents(items: QuickMenuItem[]): QuickMenuItem[] {
  const byId = new Map<string, QuickMenuItem>()
  for (const item of items) byId.set(item.id, item)
  for (const item of items) {
    // 先跳过按钮祖先，找到最近的合法组
    let resolved = item.parentId
    let guard = 0
    while (resolved !== null && guard <= QUICK_MENU_MAX_DEPTH + 2) {
      const parent = byId.get(resolved)
      if (!parent) { resolved = null; break }
      if (parent.type === 'group') break
      resolved = parent.parentId
      guard += 1
    }
    if (resolved !== null && chainHas(byId, resolved, item.id)) resolved = null
    item.parentId = resolved
  }
  return items
}

/**
 * 按父级分组重排优先级（order 归一为 10/20/30…，保证展示稳定且无并列）。
 * @author ddj 2026年10月30号
 * @param items 菜单项
 * @returns 同一数组（就地写入 order）
 */
function normalizeOrder(items: QuickMenuItem[]): QuickMenuItem[] {
  const groups = new Map<string, QuickMenuItem[]>()
  for (const item of items) {
    const key = item.parentId ?? ''
    const bucket = groups.get(key)
    if (bucket) bucket.push(item)
    else groups.set(key, [item])
  }
  for (const bucket of groups.values()) {
    bucket.sort((left, right) => {
      if (left.order !== right.order) return left.order - right.order
      if (left.name !== right.name) return left.name < right.name ? -1 : 1
      return left.id < right.id ? -1 : 1
    })
    bucket.forEach((item, index) => { item.order = (index + 1) * 10 })
  }
  return items
}

/**
 * 归一化整份文档（任何脏数据都收敛到可用形态，绝不抛错）。
 * @author ddj 2026年10月30号
 * @param raw 原始值（JSON.parse 结果或任意 unknown）
 * @returns 合法文档
 */
export function normalizeDoc(raw: unknown): QuickMenuDoc {
  const fallback = defaultDoc()
  const record = asRecord(raw)
  if (!record) return fallback
  const rawItems = Array.isArray(record.items) ? record.items : []
  const seen = new Set<string>()
  const items: QuickMenuItem[] = []
  for (const entry of rawItems) {
    const item = normalizeItem(entry)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
    if (items.length >= QUICK_MENU_MAX_ITEMS) break
  }
  const x = typeof record.launcher === 'object' && record.launcher !== null ? asRecord(record.launcher) : null
  const doc: QuickMenuDoc = {
    version: QUICK_MENU_VERSION,
    revision: Math.floor(clampNumber(record.revision, 0, Number.MAX_SAFE_INTEGER, 0)),
    updatedAt: cutText(asString(record.updatedAt), 40),
    enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
    clickAction: record.clickAction === 'fill' ? 'fill' : 'send',
    maxDepth: Math.round(clampNumber(record.maxDepth, QUICK_MENU_MIN_DEPTH, QUICK_MENU_MAX_DEPTH, QUICK_MENU_DEFAULT_DEPTH)),
    launcher: {
      x: x && typeof x.x === 'number' && Number.isFinite(x.x) ? x.x : null,
      y: x && typeof x.y === 'number' && Number.isFinite(x.y) ? x.y : null,
    },
    items: normalizeOrder(repairParents(items)),
  }
  return doc
}

/**
 * 结构迁移入口（当前只有 v1；后续版本在此收敛旧结构）。
 * @author ddj 2026年10月30号
 * @param raw 原始值
 * @returns 合法文档
 */
export function migrateDoc(raw: unknown): QuickMenuDoc {
  return normalizeDoc(raw)
}

/**
 * 序列化文档（host 落盘与导入导出共用）。
 * @author ddj 2026年10月30号
 * @param doc 文档
 * @returns JSON 文本
 */
export function serializeDoc(doc: QuickMenuDoc): string {
  return JSON.stringify(normalizeDoc(doc), null, 2)
}

/**
 * 解析文档文本（解析失败返回默认文档并给出告警文案）。
 * @author ddj 2026年10月30号
 * @param text 文件内容
 * @returns 文档 + 可选告警
 */
export function parseDoc(text: string): { doc: QuickMenuDoc; warning?: string } {
  try {
    return { doc: migrateDoc(JSON.parse(text)) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { doc: defaultDoc(), warning: '快捷菜单配置解析失败（' + reason + '），已回落默认配置' }
  }
}

//#endregion

//#region 层级与可见性

/**
 * 计算项所在层级（root 的直接子项为第 1 层；孤儿按第 1 层）。
 * @author ddj 2026年10月30号
 * @param doc 文档
 * @param id 项 id
 * @returns 层级（找不到返回 0）
 */
export function depthOf(doc: QuickMenuDoc, id: string): number {
  const byId = new Map<string, QuickMenuItem>()
  for (const item of doc.items) byId.set(item.id, item)
  let current = byId.get(id)
  if (!current) return 0
  let depth = 1
  let guard = 0
  while (current.parentId !== null && guard < QUICK_MENU_MAX_DEPTH + 1) {
    const parent = byId.get(current.parentId)
    if (!parent) break
    depth += 1
    current = parent
    guard += 1
  }
  return depth
}

/**
 * 判断能否在指定父级下新增子项（达到最大嵌套层数时禁止）。
 * @author ddj 2026年10月30号
 * @param doc 文档
 * @param parentId 父组 id（null 为顶层）
 * @returns 是否可新增
 */
export function canCreateAt(doc: QuickMenuDoc, parentId: string | null): boolean {
  if (parentId === null) return doc.maxDepth >= QUICK_MENU_MIN_DEPTH
  const depth = depthOf(doc, parentId)
  if (depth <= 0) return false
  return depth + 1 <= doc.maxDepth
}

/**
 * 取某组下可见的子项（按优先级排序；cwd 为空时不做工作区过滤）。
 * @author ddj 2026年10月30号
 * @param doc 文档
 * @param parentId 父组 id（null 为顶层）
 * @param cwd 当前工作区路径
 * @returns 可见子项
 */
export function childrenOf(doc: QuickMenuDoc, parentId: string | null, cwd?: string): QuickMenuItem[] {
  return doc.items
    .filter((item) => item.parentId === parentId)
    .filter((item) => itemVisibleIn(doc, item, cwd))
    .sort((left, right) => {
      if (left.order !== right.order) return left.order - right.order
      return left.name < right.name ? -1 : 1
    })
}

/**
 * 计算项的有效工作区限定（沿祖先链最近的显式限定生效）。
 * @author ddj 2026年10月30号
 * @param doc 文档
 * @param item 菜单项
 * @returns 限定列表或 null
 */
export function inheritWorkspaces(doc: QuickMenuDoc, item: QuickMenuItem): string[] | null {
  const byId = new Map<string, QuickMenuItem>()
  for (const entry of doc.items) byId.set(entry.id, entry)
  let current: QuickMenuItem | undefined = item
  let guard = 0
  while (current && guard < QUICK_MENU_MAX_DEPTH + 2) {
    if (current.workspaces !== null) return current.workspaces
    current = current.parentId === null ? undefined : byId.get(current.parentId)
    guard += 1
  }
  return null
}

/**
 * 判断项在当前工作区是否可见（继承父组限定）。
 * @author ddj 2026年10月30号
 * @param doc 文档
 * @param item 菜单项
 * @param cwd 当前工作区路径
 * @returns 是否可见
 */
export function itemVisibleIn(doc: QuickMenuDoc, item: QuickMenuItem, cwd?: string): boolean {
  return matchWorkspace(inheritWorkspaces(doc, item), cwd)
}

/**
 * 收集某组的所有后代 id（防止把组设为自己的子组）。
 * @author ddj 2026年10月30号
 * @param doc 文档
 * @param id 组 id
 * @returns 后代 id 列表（含自身）
 */
export function descendantIds(doc: QuickMenuDoc, id: string): string[] {
  const out: string[] = [id]
  let index = 0
  while (index < out.length) {
    const current = out[index]
    index += 1
    for (const item of doc.items) {
      if (item.parentId !== current) continue
      if (out.includes(item.id)) continue
      out.push(item.id)
    }
  }
  return out
}

//#endregion

//#region 绑定校验

/**
 * 在校验上下文里定位规则文件（用户规则按 origin 消歧、项目规则按工作区定位）。
 * @author ddj 2026年10月30号
 * @param binding 规则绑定
 * @param snapshot 规则列表快照
 * @returns 命中信息：规则元数据 / 工作区目录缺失 / 未找到
 */
function lookupRule(binding: RuleBinding, snapshot: RuleListSnapshot): { info?: RuleInfo; missingDir?: string } {
  if (binding.scope === 'user') {
    const hit = snapshot.user.find((rule) => {
      if (rule.file !== binding.file) return false
      if (binding.origin && rule.origin !== binding.origin) return false
      return true
    })
    return hit ? { info: hit } : {}
  }
  const wanted = normalizePath(binding.workspacePath ?? '')
  const project = snapshot.projects.find((entry) => normalizePath(entry.workspacePath) === wanted)
  if (!project) return {}
  if (project.missingDir) return { missingDir: project.workspacePath }
  const hit = project.rules.find((rule) => rule.file === binding.file)
  return hit ? { info: hit } : {}
}

/**
 * 校验一条规则绑定（文件缺失/停用/自身报错/跨工作区）。
 * @author ddj 2026年10月30号
 * @param binding 规则绑定
 * @param ctx 校验上下文
 * @returns 绑定状态
 */
export function validateRule(binding: RuleBinding, ctx: ValidateContext): BindingStatus {
  if (!ctx.rules) return { state: 'unknown', reason: '未校验（规则列表未加载）' }
  const found = lookupRule(binding, ctx.rules)
  if (found.missingDir) {
    return { state: 'error', reason: '工作区规则目录不存在：' + found.missingDir + '\\.dsh\\rules' }
  }
  if (!found.info) {
    return { state: 'error', reason: '规则文件不存在或已移除：' + binding.file }
  }
  if (found.info.error) return { state: 'error', reason: '规则解析失败：' + found.info.error }
  if (!found.info.enabled) return { state: 'warn', reason: '规则已停用，不会生效：' + binding.file }
  if (binding.scope === 'project') {
    const wanted = normalizePath(binding.workspacePath ?? '')
    const current = normalizePath(ctx.cwd ?? '')
    if (current !== '' && wanted !== current) {
      return { state: 'warn', reason: '规则来自其他工作区，发送时会跳过：' + binding.file }
    }
  }
  return { state: 'ok' }
}

/**
 * 校验一条技能绑定（技能按会话枚举，不可见不等同于已删除）。
 * @author ddj 2026年10月30号
 * @param name 技能名
 * @param ctx 校验上下文
 * @returns 绑定状态
 */
export function validateSkill(name: string, ctx: ValidateContext): BindingStatus {
  if (ctx.skillNames === undefined || ctx.skillNames === null) {
    return { state: 'unknown', reason: '未校验（当前没有活跃会话）' }
  }
  if (ctx.skillNames.includes(name)) return { state: 'ok' }
  return { state: 'warn', reason: '当前会话不可见（可能已移除或未被该会话加载）：' + name }
}

/**
 * 聚合单个菜单项的绑定状态（组无绑定，恒为空）。
 * @author ddj 2026年10月30号
 * @param item 菜单项
 * @param ctx 校验上下文
 * @returns 失效与告警原因
 */
export function itemStatus(item: QuickMenuItem, ctx: ValidateContext): ItemStatus {
  const status: ItemStatus = { errors: [], warnings: [] }
  if (item.type !== 'button') return status
  if (item.prompt.trim() === '') status.warnings.push('提示词为空，只发送绑定的技能与规则')
  for (const binding of item.rules) {
    const result = validateRule(binding, ctx)
    if (result.state === 'error') status.errors.push(result.reason ?? '规则失效')
    else if (result.state === 'warn') status.warnings.push(result.reason ?? '规则需注意')
  }
  for (const name of item.skills) {
    const result = validateSkill(name, ctx)
    if (result.state === 'error') status.errors.push(result.reason ?? '技能失效')
    else if (result.state === 'warn') status.warnings.push(result.reason ?? '技能需注意')
  }
  return status
}

/**
 * 校验编辑中的草稿（保存前拦截明显错误）。
 * @author ddj 2026年10月30号
 * @param draft 草稿
 * @param doc 当前文档（用于兄弟重名与父链判断）
 * @returns 错误与告警
 */
export function validateItem(draft: QuickMenuItem, doc: QuickMenuDoc): ItemStatus {
  const status: ItemStatus = { errors: [], warnings: [] }
  const name = draft.name.trim()
  if (name === '') status.errors.push('名称不能为空')
  if (name.length > QUICK_MENU_NAME_CAP) status.errors.push('名称过长（上限 ' + QUICK_MENU_NAME_CAP + ' 字）')
  if (draft.order < 0 || draft.order > QUICK_MENU_ORDER_CAP) status.errors.push('优先级需在 0 到 ' + QUICK_MENU_ORDER_CAP + ' 之间')
  if (draft.parentId !== null) {
    const parent = doc.items.find((item) => item.id === draft.parentId)
    if (!parent) status.errors.push('归属组不存在')
    else if (parent.type !== 'group') status.errors.push('只能归属到组')
    else if (descendantIds(doc, draft.id).includes(parent.id)) status.errors.push('不能把组归属到自己的子组')
    // 编辑既有项时按移动后的实际层级判断，避免把它自己的原位判成越限
    else if (depthOf(doc, parent.id) + 1 > doc.maxDepth) status.errors.push('已达最大嵌套层数（上限 ' + doc.maxDepth + '）')
  }
  const siblings = doc.items.filter((item) => item.parentId === draft.parentId && item.id !== draft.id)
  if (name !== '' && siblings.some((item) => item.name === name)) status.warnings.push('同级已有同名项')
  if (draft.type === 'button') {
    if (draft.prompt.length > QUICK_MENU_PROMPT_CAP) status.errors.push('提示词过长（上限 ' + QUICK_MENU_PROMPT_CAP + ' 字符）')
    if (draft.prompt.trim() === '' && draft.skills.length === 0 && draft.rules.length === 0) {
      status.errors.push('提示词与绑定都为空，点击后没有内容可发送')
    }
    for (const name of draft.skills) {
      if (!QUICK_MENU_SKILL_RE.test(name)) status.errors.push('技能名不合法：' + name)
    }
    for (const binding of draft.rules) {
      if (binding.scope === 'project' && !binding.workspacePath) status.errors.push('项目规则缺少工作区：' + binding.file)
    }
  }
  return status
}

//#endregion

//#region 消息合成

/**
 * 挑选可用技能（不可见技能不进消息，并留下告警）。
 * @author ddj 2026年10月30号
 * @param item 按钮
 * @param ctx 合成上下文
 * @param warnings 告警收集器
 * @returns 实际发送的技能名
 */
function pickSkills(item: QuickButton, ctx: ComposeContext, warnings: string[]): string[] {
  const out: string[] = []
  for (const name of item.skills) {
    const result = validateSkill(name, ctx)
    if (result.state === 'error' || result.state === 'warn') {
      warnings.push(result.reason ?? ('技能不可用：' + name))
      continue
    }
    out.push(name)
  }
  return out
}

/**
 * 挑选可用规则（失效/停用/跨工作区规则不注入，并留下告警）。
 * @author ddj 2026年10月30号
 * @param item 按钮
 * @param ctx 合成上下文
 * @param warnings 告警收集器
 * @returns 发送的规则绑定与元数据
 */
function pickRules(item: QuickButton, ctx: ComposeContext, warnings: string[]): Array<{ info: RuleInfo }> {
  const out: Array<{ info: RuleInfo }> = []
  for (const binding of item.rules) {
    const result = validateRule(binding, ctx)
    if (result.state !== 'ok') {
      warnings.push(result.reason ?? ('规则不可用：' + binding.file))
      continue
    }
    const found = ctx.rules ? lookupRule(binding, ctx.rules) : {}
    if (found.info) out.push({ info: found.info })
  }
  return out
}

/**
 * 生成规则引用段（只给名字与绝对路径，由模型按需读取）。
 * @author ddj 2026年10月30号
 * @param rules 规则元数据
 * @returns 引用段落（无规则返回空串）
 */
function buildRuleRefs(rules: Array<{ info: RuleInfo }>): string {
  if (rules.length === 0) return ''
  const lines = rules.map((rule) => '- ' + rule.info.file + '（绝对路径：' + rule.info.absPath + '）')
  return '---\n引用的规则：\n' + lines.join('\n') + '\n（需要时按需读取上述规则文件）'
}

/**
 * 生成规则内联段（缺正文或超长时截断并告警）。
 * @author ddj 2026年10月30号
 * @param item 按钮
 * @param rules 规则元数据
 * @param ctx 合成上下文
 * @param warnings 告警收集器
 * @returns 内联段落（无内容返回空串）
 */
function buildInline(item: QuickButton, rules: Array<{ info: RuleInfo }>, ctx: ComposeContext, warnings: string[]): string {
  if (rules.length === 0) return ''
  const contents = ctx.inlineContents ?? {}
  const blocks: string[] = []
  for (const rule of rules) {
    const key = bindingKey({ scope: rule.info.scope, file: rule.info.file, workspacePath: rule.info.scope === 'project' ? ctx.cwd : undefined })
    const raw = contents[key]
    if (typeof raw !== 'string' || raw.trim() === '') {
      warnings.push('未能读取规则正文，已跳过内联：' + rule.info.file)
      continue
    }
    blocks.push('### ' + rule.info.file + '\n' + cutText(raw, QUICK_MENU_RULE_CAP))
  }
  if (blocks.length === 0) return ''
  return '## 已绑定规则（节选）\n\n' + blocks.join('\n\n')
}

/**
 * 替换提示词占位符（未知占位符原样保留）。
 * @author ddj 2026年10月30号
 * @param prompt 原文
 * @param values 占位符取值
 * @returns 替换结果
 */
function fillPrompt(prompt: string, values: Record<string, string>): string {
  let out = prompt
  for (const [key, value] of Object.entries(values)) {
    out = out.split('{{' + key + '}}').join(value)
  }
  return out.trim()
}

/**
 * 合成发送文本：提示词 + 技能 token + 规则引用/内联（自动剔失效绑定）。
 * @author ddj 2026年10月30号
 * @param item 按钮
 * @param ctx 合成上下文
 * @returns 文本与告警
 */
export function composePrompt(item: QuickButton, ctx: ComposeContext): { text: string; warnings: string[] } {
  const warnings: string[] = []
  const skills = pickSkills(item, ctx, warnings)
  const rules = pickRules(item, ctx, warnings)
  const tokens = skills.map((name) => '/' + name).join(' ')
  const promptText = fillPrompt(item.prompt, {
    workspace: ctx.cwd ?? '',
    selection: ctx.selection ?? '',
    date: ctx.date ?? '',
    rules: rules.map((rule) => rule.info.file).join('、'),
    skills: tokens,
  })
  const blocks: string[] = []
  if (promptText !== '') blocks.push(promptText)
  // 技能 token 必须位于行首或空白之后才会被识别，故单独成行
  if (tokens !== '') blocks.push(tokens)
  if (item.ruleMode === 'reference') {
    const refs = buildRuleRefs(rules)
    if (refs !== '') blocks.push(refs)
  } else {
    const inline = buildInline(item, rules, ctx, warnings)
    if (inline !== '') blocks.push(inline)
  }
  return { text: blocks.join('\n\n').trim(), warnings }
}

//#endregion

//#region 几何布局

/**
 * 计算悬浮按钮默认位置（输入框左上角上方让出一个按钮高度）。
 * @author ddj 2026年10月30号
 * @param seat 输入框锚点矩形（浮层坐标系；缺失时回落左上角）
 * @param layer 浮层矩形
 * @param size 按钮尺寸
 * @param margin 边距
 * @returns 位置
 */
export function anchorLauncher(seat: QuickRect | null, layer: QuickRect, size: QuickSize, margin = 8): { left: number; top: number } {
  const maxLeft = Math.max(margin, layer.width - size.width - margin)
  const maxTop = Math.max(margin, layer.height - size.height - margin)
  if (!seat) return { left: clampNumber(margin, margin, maxLeft, margin), top: clampNumber(margin, margin, maxTop, margin) }
  const left = seat.left - layer.left
  const top = seat.top - layer.top - size.height - margin
  return { left: clampNumber(left, margin, maxLeft, margin), top: clampNumber(top, margin, maxTop, margin) }
}

/**
 * 计算级联子列位置（右侧放不下则翻到左侧，纵向夹取进视口）。
 * @author ddj 2026年10月30号
 * @param anchor 父列或父行矩形
 * @param size 子列尺寸
 * @param viewport 浮层尺寸
 * @param gap 列间距
 * @returns 子列矩形
 */
export function placeColumn(anchor: QuickRect, size: QuickSize, viewport: QuickSize, gap = 6): QuickRect {
  const margin = 8
  const maxLeft = Math.max(margin, viewport.width - size.width - margin)
  const maxTop = Math.max(margin, viewport.height - size.height - margin)
  const rightLeft = anchor.left + anchor.width + gap
  const flip = rightLeft + size.width > viewport.width - margin
  const left = flip ? anchor.left - size.width - gap : rightLeft
  const top = clampNumber(anchor.top, margin, maxTop, margin)
  return { left: clampNumber(left, margin, maxLeft, margin), top, width: size.width, height: size.height }
}

/**
 * 计算 SAO 风格居中突出缩放（离列中心越远越小越淡）。
 *
 * 幅度按「列内可用宽度」定：列 220px、左右内边距 7px + 1px 边框，行宽 204px，
 * 中心行放到 1.03（约 210px）刚好还在列内、不裁字；再大就会顶出滚动区。
 * 曲线用 smoothstep，让中间三四行连成一片「实」的区域，两端快速退淡，
 * 与 CSS 的上下虚化叠出「居中突出」的体积感。
 * @author ddj 2026年10月30号
 * @param index 行下标
 * @param count 行数
 * @returns 缩放与透明度
 */
export function centerScale(index: number, count: number): { scale: number; opacity: number } {
  if (count <= 1) return { scale: 1, opacity: 1 }
  const center = (count - 1) / 2
  const distance = Math.abs(index - center) / Math.max(center, 0.5)
  const ratio = Math.min(1, Math.max(0, distance))
  const eased = ratio * ratio * (3 - 2 * ratio)
  return { scale: 1.03 - 0.075 * eased, opacity: 1 - 0.35 * eased }
}

//#endregion
