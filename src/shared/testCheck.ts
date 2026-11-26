/**
 * dsh-vscode-mode shared — 测试验收模式（`/test-check`）的跨平面契约。
 *
 * 宿主注册模式、工具与 RPC，客户端投影与页签都要认同一套名字、ID 规则与派生口径，
 * 所以常量、纯函数与视图类型全部放这里，避免两侧各写一份后悄悄漂移。
 *
 * 本模块是纯函数、零 IO、不 import node 内置模块（客户端也要打包它）：
 * 文件读取、watch 与 sha256 都在 host 的 `testCheckStore.ts` 里做。
 * @author ddj 2026年11月25号
 */

//region 常量

/** 会话投影 key（`sessionProjections.register` 的 key，也是客户端 `useProjection` 的入参）。 */
export const TEST_CHECK_MODE_KEY = 'test-check'

/** 进入/离开模式的命令名（官方命令语法：小写字母开头）。 */
export const TEST_CHECK_COMMAND = 'test-check'

/** 离开模式的完整命令行（chip 与提示文案共用）。 */
export const TEST_CHECK_OFF_LINE = '/test-check off'

/** AI 上报一条结果（必须带证据）的工具名。 */
export const TEST_CHECK_REPORT_TOOL = 'test_check_report'

/** 收尾并导出快照的工具名。 */
export const TEST_CHECK_FINISH_TOOL = 'test_check_finish'

/** 数据根目录（相对项目根，不进版本库）。 */
export const TEST_CHECK_BASE_DIR = '.dsh/test-check'

/** 覆盖数据根目录的环境变量（值即 `<id>/` 的父目录）。 */
export const TEST_CHECK_ENV = 'DSH_TEST_CHECK_DIR'

/** 定义文件名。 */
export const TEST_CHECK_ITEMS = 'items.json'

/** 结果目录名（每个结果一个 JSON 文件）。 */
export const TEST_CHECK_EVENTS = 'events'

/** 上报片段文件（插件生成，可重生成）。 */
export const TEST_CHECK_SNIPPETS = 'snippets.md'

/** 交付快照目录（相对项目根，进版本库）。 */
export const TEST_CHECK_DOCS = 'docs'

/** 页签轮询间隔（毫秒）：验收标准要求写事件后 1 秒内反映。 */
export const TEST_CHECK_POLL_MS = 1000

/** 底部栏 chip 的轮询间隔（毫秒）：只要计数，慢一点省开销。 */
export const TEST_CHECK_CHIP_MS = 2500

/** 一次最多读多少个事件文件（按文件名倒序取最近的）。 */
export const TEST_CHECK_MAX_EVENTS = 2000

/** 没有任务文本时用的固定单子 id。 */
export const TEST_CHECK_DEFAULT_ID = 'check'

/** 结果状态（可落盘的四个）。 */
export type TestCheckStatus = 'pass' | 'fail' | 'blocked' | 'skip'

/** 全部合法结果状态。 */
export const TEST_CHECK_STATUSES: readonly TestCheckStatus[] = ['pass', 'fail', 'blocked', 'skip']

/** 派生状态（含未验、声明无证据与需复验）。 */
export type TestCheckVerdict = 'todo' | 'pass' | 'claimed' | 'fail' | 'blocked' | 'skip' | 'stale'

/** 派生状态的中文标签（页签与快照共用）。 */
export const TEST_CHECK_LABELS: Readonly<Record<TestCheckVerdict, string>> = {
  todo: '未验',
  pass: '通过',
  claimed: '无证据',
  fail: '失败',
  blocked: '阻塞',
  skip: '跳过',
  stale: '需复验',
}

//endregion

//region 单子 ID

/** 单子 id 允许的字符：小写字母/数字开头，允许连字符。 */
const SHEET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 派生 id 时忽略的常见词（避免把 a/the 拼进目录名）。 */
const ID_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'use', 'using'])

/**
 * FNV-1a 32 位哈希：只要稳定、两端一致，不需要密码学强度。
 * @author ddj 2026年11月25号
 * @param text 输入文本
 * @returns 8 位十六进制
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 由任务文本派生单子 id（kebab-case，确定性：宿主与客户端算出来必须一致）。
 *
 * 先取前三个 ASCII 词；中文任务没有可用词时退回 `check-<8 位哈希>`；
 * 完全没有任务时用固定 `check`，保证 `/test-check` 与 `/test-check off` 可配对。
 * @author ddj 2026年11月25号
 * @param task 任务文本
 * @returns 单子 id
 */
export function testCheckIdOf(task: unknown): string {
  const text = String(task ?? '').trim()
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const meaningful = words.filter((word) => word.length > 1 && !ID_STOP.has(word)).slice(0, 3)
  const slug = meaningful.join('-').slice(0, 32).replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (slug.length >= 3) return slug
  if (!text) return TEST_CHECK_DEFAULT_ID
  return 'check-' + fnv1a(text)
}

/**
 * 单子 id 是否合法（也用于校验 `items.json` 里的 id 字段）。
 * @author ddj 2026年11月25号
 * @param value 待校验值
 * @returns 合法为 true
 */
export function isSheetId(value: unknown): boolean {
  return typeof value === 'string' && SHEET_ID.test(value)
}

//endregion

//region 测试点 ID

/** 测试点 id：`<scope>.<area>.<3 位序号>`，段前缀必须是小写字母。 */
const ITEM_ID = /^([a-z][a-z0-9-]{0,31})\.([a-z][a-z0-9-]{0,31})\.([0-9]{3})$/

/** 单个段内不允许首尾连字符（`a-`、`-a` 视为错字）。 */
const ITEM_SEGMENT = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * 测试点 id 是否合法。
 * @author ddj 2026年11月25号
 * @param value 待校验值
 * @returns 合法为 true
 */
export function isItemId(value: unknown): boolean {
  const match = ITEM_ID.exec(typeof value === 'string' ? value : '')
  return match !== null && ITEM_SEGMENT.test(match[1]) && ITEM_SEGMENT.test(match[2])
}

/**
 * 取测试点 id 的非法原因（用于逐条列错，报告能指到具体段）。
 * @author ddj 2026年11月25号
 * @param value 待校验值
 * @returns 原因文案；合法时 null
 */
export function idProblemOf(value: unknown): string | null {
  const text = typeof value === 'string' ? value : ''
  if (!text) return 'ID 为空'
  const parts = text.split('.')
  if (parts.length !== 3) return 'ID 要三段：<scope>.<area>.<3 位序号>'
  if (!ITEM_SEGMENT.test(parts[0]) || !ITEM_SEGMENT.test(parts[1])) return '前两段要小写字母开头、不超过 32 字符、首尾不许连字符'
  if (!/^[0-9]{3}$/.test(parts[2])) return '序号要 3 位数字（001…999）'
  return null
}

//endregion

//region 输入解析

/** `/test-check` 的输入解析结果。 */
export interface TestCheckInput {
  /** off = 离开模式；enter = 进入模式（可带任务）。 */
  action: 'off' | 'enter'
  /** 剥离开关后的任务文本。 */
  task: string
}

/**
 * 解析 `/test-check` 的输入：`off` 离开，其余文本原样作为任务。
 * @author ddj 2026年11月25号
 * @param rawInput 官方命令的 rawInput
 * @returns 动作与任务文本
 */
export function parseCheckInput(rawInput: unknown): TestCheckInput {
  const text = String(rawInput ?? '').trim()
  if (/^off$/i.test(text)) return { action: 'off', task: '' }
  return { action: 'enter', task: text }
}

//endregion

//region 数据形状

/** 定义文件里的一条验收点。 */
export interface TestCheckItemDef {
  /** `<scope>.<area>.<3 位序号>`，全局唯一、只增不改。 */
  id: string
  /** 一句话说明这一条验什么。 */
  title: string
  /** 分组名（缺省「未分组」）。 */
  group?: string
  /** 被验文件（相对项目根，用于需复验判定）。 */
  files?: string[]
  /** 已删除的条目：保留编号但不计分。 */
  retired?: boolean
}

/** 定义文件（`items.json`）。 */
export interface TestCheckDefinition {
  /** 单子 id（建议与目录名一致）。 */
  id?: string
  /** 单子标题。 */
  title?: string
  /** 格式版本，当前只有 1。 */
  version?: number
  /** 验收点清单。 */
  items: TestCheckItemDef[]
}

/** 证据（全部可选；至少一项非空才算有证据）。 */
export interface TestCheckEvidence {
  /** test / command / file / log / manual。 */
  kind?: string
  /** 一句话证据（测试名、命令、文件）。 */
  summary?: string
  /** 跑过的命令。 */
  command?: string
  /** 命令退出码。 */
  exitCode?: number
  /** 证据文件路径（相对项目根或绝对）。 */
  path?: string
}

/** 结果事件里的被验对象（用于需复验判定）。 */
export interface TestCheckSubject {
  /** `sha256:<hex>`，算法见 `subjectHashOf` 的注释。 */
  hash?: string
}

/** 一条结果事件（一个事件文件的内容）。 */
export interface TestCheckEvent {
  /** 测试点 id（必填）。 */
  item: string
  /** 结果状态（必填）。 */
  status: TestCheckStatus
  /** ISO 时间；缺省用文件 mtime。 */
  at?: string
  /** 证据（缺省表示「没证据」）。 */
  evidence?: TestCheckEvidence
  /** 被验对象指纹。 */
  subject?: TestCheckSubject
}

/** 从磁盘读到的一条事件（带文件名与时间戳）。 */
export interface TestCheckEventFile {
  /** 事件文件名。 */
  file: string
  /** 排序用毫秒时间戳（`at` 解析失败时取文件 mtime）。 */
  at: number
  /** 解析后的事件。 */
  event: TestCheckEvent
}

/** 被忽略的事件文件（坏 JSON / 未知条目 / 非法状态）。 */
export interface TestCheckIgnored {
  /** 文件名（不含目录）。 */
  file: string
  /** 忽略原因。 */
  reason: string
}

/** 一条验收点在页签里的样子。 */
export interface TestCheckItemView {
  /** 测试点 id。 */
  id: string
  /** 说明。 */
  title: string
  /** 分组名。 */
  group: string
  /** 是否已退役。 */
  retired: boolean
  /** 最近一次落盘状态（没有事件时为 todo）。 */
  status: TestCheckStatus | 'todo'
  /** 派生状态。 */
  verdict: TestCheckVerdict
  /** 中文标签。 */
  label: string
  /** 事件时间（ISO）；没有事件时不带。 */
  at?: string
  /** 证据；没有时不带。 */
  evidence?: TestCheckEvidence
  /** 是否计入通过数（无证据的 pass 不计）。 */
  counted: boolean
  /** 是否需复验。 */
  stale: boolean
}

/** 一个分组。 */
export interface TestCheckGroupView {
  /** 分组名。 */
  name: string
  /** 该组的验收点（按定义顺序）。 */
  items: TestCheckItemView[]
}

/** 汇总计数（固定五格）。 */
export interface TestCheckCounts {
  /** 有效验收点总数（不含退役）。 */
  total: number
  /** 有证据且未失效的通过数。 */
  pass: number
  /** 失败数。 */
  fail: number
  /** 阻塞数。 */
  blocked: number
  /** 未验数（含跳过与「声明通过无证据」）。 */
  todo: number
  /** 需复验数。 */
  stale: number
}

/** 全部验收单列表里的一行（侧栏面板用；计数口径与页签同源）。 */
export interface TestCheckSheetSummary {
  /** 单子 id。 */
  id: string
  /** 单子标题（缺省为 id）。 */
  title: string
  /** 汇总计数（与 `edrv.testCheck.get` 的视图一致）。 */
  counts: TestCheckCounts
  /** 定义文件绝对路径。 */
  itemsPath: string
  /** 对应交付快照绝对路径（`docs/acceptance-<id>.html`）。 */
  snapshotPath: string
  /** 快照文件是否存在（不存在时面板给「移除」入口）。 */
  hasSnapshot: boolean
  /** 最近活动时间（毫秒；快照 mtime 优先，其次单子目录）。 */
  updatedAt: number
}

/** 验收单派生视图（RPC 载荷、页签与快照共用）。 */
export interface TestCheckView {
  /** 单子 id。 */
  id: string
  /** 单子标题。 */
  title: string
  /** 项目根（/ 分隔的绝对路径）。 */
  root: string
  /** 单子目录（/ 分隔的绝对路径）。 */
  dir: string
  /** ready = 定义读到了；missing = 还没建单；invalid = 定义有错。 */
  state: 'ready' | 'missing' | 'invalid'
  /** state 不为 ready 时的可读原因/逐条错误（多行）。 */
  error?: string
  /** 定义文件绝对路径。 */
  itemsPath: string
  /** 结果目录绝对路径。 */
  eventsDir: string
  /** 按分组排好的验收点。 */
  groups: TestCheckGroupView[]
  /** 汇总。 */
  counts: TestCheckCounts
  /** 被忽略的事件文件。 */
  ignored: TestCheckIgnored[]
  /** 数据指纹：变了才重绘 iframe。 */
  stamp: string
}

//endregion

//region 定义校验

/** 定义校验结果。 */
export interface DefinitionCheck {
  /** 校验通过的规范化定义；有错时不带。 */
  definition?: TestCheckDefinition
  /** 逐条错误文案（空数组表示通过）。 */
  errors: string[]
}

/**
 * 判断 `files` 项是否是安全的相对路径（不许绝对路径、不许 `..`）。
 * @author ddj 2026年11月25号
 * @param value 待校验值
 * @returns 安全为 true
 */
function isRelativeFile(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const text = value.trim().replace(/\\/g, '/')
  if (!text) return false
  if (/^(?:[a-z]:\/|\/)/i.test(text)) return false
  return !text.split('/').includes('..')
}

/**
 * 校验 `items.json`：JSON 已解析成对象，这里只查语义。
 *
 * 重复 ID、非法 ID、空标题都进 errors（不静默丢条目）；`retired` 条目同样要过校验，
 * 因为编号是永久占位的，写错号就等于丢失编号。
 * @author ddj 2026年11月25号
 * @param raw 解析后的 JSON
 * @param expectId 目录名（用作缺省 id，便于「目录与文件不一致」时仍能显示）
 * @returns 规范化定义或逐条错误
 */
export function checkDefinition(raw: unknown, expectId = ''): DefinitionCheck {
  const errors: string[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['items.json 顶层必须是对象'] }
  }
  const row = raw as Record<string, unknown>
  if (row.version !== undefined && row.version !== 1) errors.push('version 只支持 1，当前是 ' + String(row.version))
  if (row.items !== undefined && !Array.isArray(row.items)) return { errors: [...errors, 'items 必须是数组'] }

  const list = Array.isArray(row.items) ? row.items : []
  const seen = new Set<string>()
  const items: TestCheckItemDef[] = []
  list.forEach((entry, index) => {
    const at = '第 ' + String(index + 1) + ' 条'
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(at + '：必须是对象')
      return
    }
    const item = entry as Record<string, unknown>
    const problem = idProblemOf(item.id)
    const itemId = typeof item.id === 'string' ? item.id.trim() : ''
    if (problem) errors.push(at + '：' + problem + (itemId ? '（' + itemId + '）' : ''))
    else if (seen.has(itemId)) errors.push(at + '：重复 ID ' + itemId)
    if (!problem) seen.add(itemId)

    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (!title) errors.push(at + '：title 不能为空')

    const retired = item.retired === true
    const group = typeof item.group === 'string' && item.group.trim() ? item.group.trim() : undefined
    let files: string[] | undefined
    if (item.files !== undefined) {
      if (!Array.isArray(item.files)) errors.push(at + '：files 必须是数组')
      else {
        files = []
        for (const file of item.files) {
          if (!isRelativeFile(file)) {
            errors.push(at + '：files 里 ' + JSON.stringify(file) + ' 不是相对项目根的路径')
            continue
          }
          files.push(String(file).trim().replace(/\\/g, '/'))
        }
      }
    }
    if (problem || !title) return
    const normalized: TestCheckItemDef = { id: itemId, title }
    if (group) normalized.group = group
    if (files && files.length) normalized.files = files
    if (retired) normalized.retired = true
    items.push(normalized)
  })

  if (errors.length) return { errors }
  const definition: TestCheckDefinition = { items }
  if (typeof row.id === 'string' && isSheetId(row.id)) definition.id = row.id
  else if (expectId && isSheetId(expectId)) definition.id = expectId
  if (typeof row.title === 'string' && row.title.trim()) definition.title = row.title.trim()
  definition.version = 1
  return { definition, errors }
}

//endregion

//region 派生

/**
 * 证据是否算「有」：任一摘要字段非空，或退出码是数字。
 * @author ddj 2026年11月25号
 * @param evidence 证据
 * @returns 有证据为 true
 */
export function hasEvidence(evidence: TestCheckEvidence | undefined): boolean {
  if (!evidence || typeof evidence !== 'object') return false
  if (typeof evidence.exitCode === 'number' && Number.isFinite(evidence.exitCode)) return true
  for (const key of ['summary', 'command', 'path'] as const) {
    const value = evidence[key]
    if (typeof value === 'string' && value.trim()) return true
  }
  return false
}

/**
 * 归一化状态：只认四个合法值，其余返回 null（调用方按非法事件处理）。
 * @author ddj 2026年11月25号
 * @param value 原始状态
 * @returns 合法状态或 null
 */
export function normalizeStatus(value: unknown): TestCheckStatus | null {
  return typeof value === 'string' && (TEST_CHECK_STATUSES as readonly string[]).includes(value)
    ? value as TestCheckStatus
    : null
}

/**
 * 把每条事件折成「每个测试点最新一条」。
 *
 * 排序口径：`at`（解析失败用文件 mtime）升序；同一时刻按文件名升序，保证结果稳定可测。
 * @author ddj 2026年11月25号
 * @param events 事件列表（顺序无关）
 * @returns 测试点 id → 最新事件
 */
export function latestPerItem(events: readonly TestCheckEventFile[]): Map<string, TestCheckEventFile> {
  const sorted = [...events].sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at
    return left.file < right.file ? -1 : left.file > right.file ? 1 : 0
  })
  const latest = new Map<string, TestCheckEventFile>()
  for (const entry of sorted) latest.set(entry.event.item, entry)
  return latest
}

/**
 * 拼出被验对象的待哈希文本（口径固定，片段与宿主都按它算）：
 * `files` 按路径排序，逐个拼 `path + '\n' + sha256(内容) + '\n'`。
 *
 * 这里只拼文本、不算 sha256——客户端也要用本模块，不能 import node:crypto；
 * 最终摘要由宿主（`testCheckStore.ts`）与各语言片段各自用真实的 sha256 算。
 * @author ddj 2026年11月25号
 * @param files 路径与内容 sha256（十六进制）
 * @returns 待哈希文本；没有文件时返回空串
 */
export function subjectHashLines(files: ReadonlyArray<{ path: string; sha256: string }>): string {
  if (!files.length) return ''
  return [...files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((file) => file.path + '\n' + file.sha256 + '\n')
    .join('')
}

/**
 * 读一条证据的展示文案（快照与页签共用；没有摘要时退回命令）。
 * @author ddj 2026年11月25号
 * @param evidence 证据
 * @returns 一行文案；什么都没有时空串
 */
export function evidenceTextOf(evidence: TestCheckEvidence | undefined): string {
  if (!evidence) return ''
  const summary = typeof evidence.summary === 'string' ? evidence.summary.trim() : ''
  if (summary) return summary
  const command = typeof evidence.command === 'string' ? evidence.command.trim() : ''
  if (command) {
    const code = typeof evidence.exitCode === 'number' ? ' · 退出码 ' + String(evidence.exitCode) : ''
    return command + code
  }
  const path = typeof evidence.path === 'string' ? evidence.path.trim() : ''
  return path
}

/**
 * 把任意长度的文本混成 32 位十六进制（仅用于 stamp 与「没有 SHA 也要有个指纹」的场合）。
 * @author ddj 2026年11月25号
 * @param text 输入
 * @returns 32 位十六进制
 */
export function mixHex(text: string): string {
  return fnv1a(text) + fnv1a(text + '\u0001') + fnv1a(text + '\u0002') + fnv1a(text + '\u0003')
}

/**
 * 由事件、失效标记与状态推导展示状态。
 * @author ddj 2026年11月25号
 * @param event 最新事件（可能没有）
 * @param stale 是否需复验
 * @returns 派生状态
 */
export function verdictOf(event: TestCheckEventFile | undefined, stale: boolean): TestCheckVerdict {
  if (!event) return 'todo'
  const status = normalizeStatus(event.event.status)
  if (!status) return 'todo'
  if (stale) return 'stale'
  if (status === 'pass') return hasEvidence(event.event.evidence) ? 'pass' : 'claimed'
  if (status === 'fail') return 'fail'
  if (status === 'blocked') return 'blocked'
  return 'skip'
}

/** 派生视图的入参（宿主把磁盘事实读好后交给纯函数）。 */
export interface DeriveInput {
  /** 单子 id。 */
  id: string
  /** 单子标题（缺省用 id）。 */
  title?: string
  /** 项目根。 */
  root: string
  /** 单子目录。 */
  dir: string
  /** 定义文件路径。 */
  itemsPath: string
  /** 结果目录路径。 */
  eventsDir: string
  /** 已校验的定义。 */
  definition: TestCheckDefinition
  /** 读到的事件。 */
  events: readonly TestCheckEventFile[]
  /** 测试点 id → 当前文件指纹（空串/缺省表示不比对）。 */
  hashes?: Readonly<Record<string, string>>
  /** 被忽略的事件文件。 */
  ignored?: readonly TestCheckIgnored[]
}

/**
 * 由定义 + 事件 + 当前指纹派生验收单视图。
 *
 * 计数口径：退役条目不参与；`pass` 只有「有证据且未失效」才计入通过；
 * `skip` 与「声明通过无证据」都进「未验」；失效单独进「需复验」。
 * @author ddj 2026年11月25号
 * @param input 磁盘事实
 * @returns 派生视图（含数据指纹）
 */
export function deriveSheetView(input: DeriveInput): TestCheckView {
  const latest = latestPerItem(input.events)
  const hashes = input.hashes ?? {}
  const counts: TestCheckCounts = { total: 0, pass: 0, fail: 0, blocked: 0, todo: 0, stale: 0 }
  const groups = new Map<string, TestCheckItemView[]>()

  for (const item of input.definition.items) {
    if (item.retired) continue
    counts.total += 1
    const event = latest.get(item.id)
    const group = item.group ?? '未分组'
    const current = hashes[item.id] ?? ''
    const declared = event?.event.subject?.hash ?? ''
    const stale = Boolean(event) && Boolean(current) && Boolean(declared) && current !== declared
    const verdict = verdictOf(event, stale)
    if (verdict === 'pass') counts.pass += 1
    else if (verdict === 'fail') counts.fail += 1
    else if (verdict === 'blocked') counts.blocked += 1
    else if (verdict === 'stale') counts.stale += 1
    else counts.todo += 1

    const view: TestCheckItemView = {
      id: item.id,
      title: item.title,
      group,
      retired: false,
      status: event ? (normalizeStatus(event.event.status) ?? 'todo') : 'todo',
      verdict,
      label: TEST_CHECK_LABELS[verdict],
      counted: verdict === 'pass',
      stale,
    }
    if (event?.event.at) view.at = event.event.at
    if (event?.event.evidence) view.evidence = event.event.evidence
    const bucket = groups.get(group) ?? []
    bucket.push(view)
    groups.set(group, bucket)
  }

  const view: TestCheckView = {
    id: input.id,
    title: input.title ?? input.definition.title ?? input.id,
    root: input.root,
    dir: input.dir,
    state: 'ready',
    itemsPath: input.itemsPath,
    eventsDir: input.eventsDir,
    groups: [...groups.entries()].map(([name, items]) => ({ name, items })),
    counts,
    ignored: [...(input.ignored ?? [])],
    stamp: '',
  }
  view.stamp = stampOf(view)
  return view
}

/**
 * 数据指纹：状态、计数、每条的派生状态与时间都参与；数据没变就返回同一个串。
 * @author ddj 2026年11月25号
 * @param view 派生视图
 * @returns 指纹
 */
export function stampOf(view: TestCheckView): string {
  const parts = [
    view.state,
    String(view.counts.total),
    String(view.counts.pass),
    String(view.counts.fail),
    String(view.counts.blocked),
    String(view.counts.todo),
    String(view.counts.stale),
    String(view.ignored.length),
  ]
  for (const group of view.groups) {
    for (const item of group.items) parts.push(item.id + ':' + item.verdict + ':' + (item.at ?? ''))
  }
  return mixHex(parts.join('|'))
}

/**
 * 构造「还没建单」或「定义有错」的视图（没有条目，但结构完整，页签照常渲染）。
 * @author ddj 2026年11月25号
 * @param input 基本信息
 * @param state missing / invalid
 * @param error 可读原因（多行）
 * @param ignored 被忽略的事件
 * @returns 派生视图
 */
export function emptyView(
  input: { id: string; title?: string; root: string; dir: string; itemsPath: string; eventsDir: string },
  state: 'missing' | 'invalid',
  error?: string,
  ignored: readonly TestCheckIgnored[] = [],
): TestCheckView {
  const view: TestCheckView = {
    id: input.id,
    title: input.title ?? input.id,
    root: input.root,
    dir: input.dir,
    state,
    itemsPath: input.itemsPath,
    eventsDir: input.eventsDir,
    groups: [],
    counts: { total: 0, pass: 0, fail: 0, blocked: 0, todo: 0, stale: 0 },
    ignored: [...ignored],
    stamp: '',
  }
  if (error) view.error = error
  view.stamp = stampOf(view)
  return view
}

//endregion

//region 结果文件名

/**
 * 交付快照文件名（放在项目根 `docs/` 下）：`acceptance-<id>.html`。
 * @author ddj 2026年11月26号
 * @param id 单子 id
 * @returns 文件名
 */
export function snapshotNameOf(id: string): string {
  return 'acceptance-' + id + '.html'
}

/**
 * 生成事件文件名：`<时间戳>-<随机>.json`，并发写不会互相覆盖。
 * @author ddj 2026年11月25号
 * @param at 时间点（默认当下）
 * @param random 0~1 随机数来源（测试可注入固定值）
 * @returns 文件名
 */
export function eventFileNameOf(at: Date = new Date(), random: () => number = Math.random): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = String(at.getUTCFullYear())
    + pad(at.getUTCMonth() + 1) + pad(at.getUTCDate())
    + 'T' + pad(at.getUTCHours()) + pad(at.getUTCMinutes()) + pad(at.getUTCSeconds())
  const salt = Math.floor(Math.abs(random()) * 0xffff).toString(16).padStart(4, '0')
  return stamp + '-' + salt + '.json'
}

//endregion
