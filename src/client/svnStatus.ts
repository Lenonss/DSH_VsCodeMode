/**
 * dsh-vscode-mode client — SVN 能力状态层与动作执行。
 *
 * 数据源（status/changes）统一经 svnStore 工厂创建：scope 缓存 + 在途去重 + 事件广播 +
 * 「失败不写缓存」语义由工厂单点保证，本模块只负责各自的 select 与消费侧投影。
 * 状态：ensureSvnStatus → `edrv:svn-status`（命令/菜单显隐数据源）。
 * 变更（P2）：ensureSvnChanges → `edrv:svn-changes`（面板列表 + 文件树徽标查表）。
 * 动作：svnUpdate / svnTortoise / svnRevert / svnAdd / svnDiffBase 统一执行与反馈文案。
 * 作者 ddj 2026年09月16号
 */
import type { SvnAction, SvnChangeEntry, SvnItemStatus, SvnStatusPayload, SvnUpdateEntry } from '../shared/svn.js'
import { SVN_TORTOISE_LABELS, SVN_UPDATE_LABEL } from '../shared/svn.js'
import { svnActionOn, svnActionsFor } from '../shared/svnActions.js'
import type { SvnActionContext } from '../shared/svnActions.js'
import { createSvnStore } from './svnStore.js'
import { rpc } from './rpc.js'

/** SVN 能力状态数据源（未加载 = null，菜单/命令随之隐藏）。 */
const statusStore = createSvnStore<'svn.status', SvnStatusPayload>({
  method: 'svn.status',
  event: 'edrv:svn-status',
  select: (res) => ({ value: res as unknown as SvnStatusPayload }),
})

/** 工作副本变更数据源（未加载 = null；已加载无变更 = 空数组）。 */
const changesStore = createSvnStore<'svn.changes', SvnChangeEntry[]>({
  method: 'svn.changes',
  event: 'edrv:svn-changes',
  select: (res) => ({
    value: Array.isArray(res.entries) ? (res.entries as SvnChangeEntry[]) : [],
    meta: { truncated: res.truncated === true, wcRoot: res.wcRoot },
  }),
})

/**
 * 拉取（或命中缓存的）SVN 状态：成功后写缓存并广播。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id（缺省时 host 按唯一活跃会话解析）
 * @param scope 状态作用域（工作区优先；无 scope 不拉取）
 * @param force 跳过客户端与 host 缓存强制重测
 */
export function ensureSvnStatus(sessionId: string | undefined, scope: string | null | undefined, force = false): void {
  statusStore.ensure(sessionId, scope, force)
}

/** 读取指定 scope 的状态（未加载返回 null）。 */
export function getSvnStatus(scope: string | null | undefined): SvnStatusPayload | null {
  return statusStore.get(scope)
}

/** 命令面板可用性：最近一次加载判定「受管理且 svn CLI 可用」。 */
export function svnFeatureReady(): boolean {
  const latest = statusStore.latest()
  return Boolean(latest?.managed && latest.svnCli)
}

/** 最近一次加载的 SVN 能力状态（动作目录求值用；未加载返回 null）。 */
export function svnCurrentStatus(): SvnStatusPayload | null {
  return statusStore.latest()
}

/** 命令面板可用性：最近一次加载判定「受管理且 TortoiseProc 可用」。 */
export function tortoiseUsable(): boolean {
  const latest = statusStore.latest()
  return Boolean(latest?.managed && latest.tortoise)
}

/**
 * 强制重测（工作区「刷新」按钮/设置变更后）：清缓存并 force 拉取。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id
 * @param scope 状态作用域
 */
export function refreshSvnStatus(sessionId: string | undefined, scope: string | null | undefined): void {
  statusStore.refresh(sessionId, scope)
}

/**
 * 拉取（或命中缓存的）工作副本变更：成功后写缓存并广播 `edrv:svn-changes`。
 * 未受管理/CLI 不可用时保持「未加载」语义（不写空数组，避免把「未知」当「无变更」）。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id
 * @param scope 状态作用域
 * @param force 跳过 host 端 TTL 强制重查
 */
export function ensureSvnChanges(sessionId: string | undefined, scope: string | null | undefined, force = false): void {
  changesStore.ensure(sessionId, scope, force)
}

/**
 * 读取指定 scope 的变更清单（未加载返回 null；已加载但无变更返回空数组）。
 * @author ddj 2026年09月16号
 * @param scope 状态作用域
 * @returns 变更清单或 null
 */
export function getSvnChanges(scope: string | null | undefined): SvnChangeEntry[] | null {
  return changesStore.get(scope)
}

/**
 * 变更清单是否被条目上限截断（面板提示用）。
 * @author ddj 2026年09月16号
 * @param scope 状态作用域
 * @returns 是否截断
 */
export function svnChangesCapped(scope: string | null | undefined): boolean {
  return changesStore.meta(scope).truncated === true
}

/**
 * 路径 → 变更条目映射（文件树徽标 O(1) 查表；未加载返回空表）。
 * 同一路径出现多条时保留首条（svn status 对单路径只报一条）。
 * @author ddj 2026年09月16号
 * @param scope 状态作用域
 * @returns 相对路径（`/` 分隔）→ 条目
 */
export function svnChangeMapOf(scope: string | null | undefined): Record<string, SvnChangeEntry> {
  const entries = getSvnChanges(scope)
  if (!entries) return {}
  const map: Record<string, SvnChangeEntry> = {}
  for (const entry of entries) {
    if (!(entry.path in map)) map[entry.path] = entry
  }
  return map
}

/**
 * 强制刷新变更（面板 ⟳ / 提交后 / update 后）：清缓存并 force 重查。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id
 * @param scope 状态作用域
 */
export function refreshSvnChanges(sessionId: string | undefined, scope: string | null | undefined): void {
  changesStore.refresh(sessionId, scope)
}

/**
 * 丢弃变更缓存（工作副本被外部改动后强制下次重查）。
 * @author ddj 2026年09月16号
 * @param scope 状态作用域（缺省清空全部）
 */
export function clearSvnChanges(scope?: string | null): void {
  changesStore.clear(scope)
}

/** 命令面板可用性：最近一次加载判定「受管理且 svn CLI 可用且存在变更」。 */
export function svnChangesReady(): boolean {
  const latest = statusStore.latest()
  const entries = changesStore.latest()
  return Boolean(latest?.managed && latest.svnCli && entries && entries.length > 0)
}

/** 动作执行统一结果（message 已可直接落状态栏/notify）。 */
export interface SvnActionOutcome {
  ok: boolean
  message: string
  /** update 的条目级明细（仅 svnUpdate 填充）。 */
  entries?: SvnUpdateEntry[]
  /** update 的冲突路径清单（仅 svnUpdate 填充）。 */
  conflicts?: string[]
}

/**
 * 执行 svn update（CLI，全平台；path 工作区相对，'' = 工作区根）。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id
 * @param path 目标相对路径
 * @returns 执行结果与反馈文案
 */
export async function svnUpdate(sessionId: string | undefined, path: string): Promise<SvnActionOutcome> {
  try {
    const res = await rpc('svn.update', { sessionId, path })
    if (!res.ok) return { ok: false, message: 'SVN 更新失败：' + res.error }
    const conflicts = res.conflicts.length ? '；冲突：' + res.conflicts.join('、') : ''
    // P3：附带条目级明细，供编辑区结果条逐条展示（冲突高亮）
    return { ok: true, message: 'SVN 更新：' + res.summary + conflicts, entries: res.entries ?? [], conflicts: res.conflicts ?? [] }
  } catch (error) {
    return { ok: false, message: 'SVN 更新失败：' + String(error) }
  }
}

/**
 * 发射 TortoiseSVN 对话框（Windows 过渡增强）。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id
 * @param action Tortoise 动作
 * @param path 目标相对路径（文件/目录）
 * @returns 执行结果与反馈文案
 */
export async function svnTortoise(sessionId: string | undefined, action: SvnAction, path: string): Promise<SvnActionOutcome> {
  try {
    const res = await rpc('svn.tortoise', { sessionId, action, path })
    if (!res.ok) return { ok: false, message: 'TortoiseSVN 启动失败：' + res.error }
    return { ok: true, message: '已打开：' + SVN_TORTOISE_LABELS[action] }
  } catch (error) {
    return { ok: false, message: 'TortoiseSVN 启动失败：' + String(error) }
  }
}

/**
 * 基线差异结果（左侧 BASE 可为 null：added/未提交条目没有 pristine）。
 * reason 为 'no-pristine' 时属正常业务分支，调用方应提示而非报错。
 */
export interface SvnDiffBaseOutcome {
  ok: boolean
  /** 左侧（BASE 版本）内容；null = 无 pristine。 */
  base: string | null
  /** 右侧（工作区磁盘内容）。 */
  working: string
  /** 无 BASE 时的原因（'no-pristine' | 'cat-failed'）。 */
  reason?: string
  /** 失败提示文案（ok=false，或 ok=true 时的补充说明）。 */
  message: string
  /** W2-6 护栏：内容含 NUL（二进制）。 */
  binary?: boolean
  /** W2-6 护栏：内容可能非 UTF-8。 */
  encodingHint?: boolean
}

/**
 * 读取基线差异（BASE 左 / 工作区右）。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id
 * @param path 工作区相对路径
 * @returns 双侧内容或错误文案
 */
export async function svnDiffBase(sessionId: string | undefined, path: string): Promise<SvnDiffBaseOutcome> {
  try {
    const res = await rpc('svn.diffBase', { sessionId, path })
    if (!res.ok) return { ok: false, base: null, working: '', message: '读取基线失败：' + res.error }
    if (res.base === null) {
      const message = res.reason === 'no-pristine'
        ? '该文件尚无基线版本（未提交的新增文件）'
        : '读取基线失败' + (res.error ? '：' + res.error : '')
      return { ok: true, base: null, working: res.working, message, binary: res.binary === true, encodingHint: res.encodingHint === true }
    }
    return { ok: true, base: res.base, working: res.working, message: '已打开基线差异', binary: res.binary === true, encodingHint: res.encodingHint === true }
  } catch (error) {
    return { ok: false, base: null, working: '', message: '读取基线失败：' + String(error) }
  }
}

/**
 * 批量还原（`svn revert -R`，CLI 全平台；新增文件不会被删除）。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id
 * @param paths 工作区相对路径列表
 * @returns 执行结果与反馈文案
 */
export async function svnRevert(sessionId: string | undefined, paths: string[]): Promise<SvnActionOutcome> {
  try {
    const res = await rpc('svn.revert', { sessionId, paths })
    if (!res.ok) return { ok: false, message: 'SVN 还原失败：' + res.error }
    return { ok: true, message: 'SVN 还原：' + res.summary }
  } catch (error) {
    return { ok: false, message: 'SVN 还原失败：' + String(error) }
  }
}

/**
 * 批量加入版本控制（`svn add`）。
 * @author ddj 2026年09月16号
 * @param sessionId 会话 id
 * @param paths 工作区相对路径列表
 * @returns 执行结果与反馈文案
 */
export async function svnAdd(sessionId: string | undefined, paths: string[]): Promise<SvnActionOutcome> {
  try {
    const res = await rpc('svn.add', { sessionId, paths })
    if (!res.ok) return { ok: false, message: '加入版本控制失败：' + res.error }
    return { ok: true, message: '加入版本控制：' + res.summary }
  } catch (error) {
    return { ok: false, message: '加入版本控制失败：' + String(error) }
  }
}

// --region W2 差异管理补全（补丁/目录对比/远端检查/冲突/配对）

/**
 * 生成统一格式补丁文本（W2-1，只读不落盘）。
 * @author ddj 2026年09月20号
 * @param sessionId 会话 id
 * @param path 工作区相对路径（文件/目录）
 * @param opts 扩展选项（空白语义/EOL/上下文行数；缺省 = svn 默认）
 * @returns 补丁文本 + 截断/二进制标记，或错误文案
 */
export async function svnPatchText(
  sessionId: string | undefined,
  path: string,
  opts: { whitespace?: 'none' | 'b' | 'w'; ignoreEol?: boolean; unified?: number } = {},
): Promise<{ ok: boolean; text?: string; truncated?: boolean; binary?: boolean; message: string }> {
  try {
    const res = await rpc('svn.patchText', { sessionId, path, ...opts })
    if (!res.ok) return { ok: false, message: '生成补丁失败：' + res.error }
    return { ok: true, text: res.text, truncated: res.truncated, binary: res.binary, message: '已生成补丁' }
  } catch (error) {
    return { ok: false, message: '生成补丁失败：' + String(error) }
  }
}

/**
 * 目录对比（W2-2，任意两修订的 summarize 变更列表）。
 * @author ddj 2026年09月20号
 * @param sessionId 会话 id
 * @param revA 起始修订（较早）
 * @param revB 结束修订（较晚）
 * @param path 目标相对路径（'' = 工作副本根）
 * @returns 变更条目或错误文案
 */
export async function svnDiffSum(
  sessionId: string | undefined,
  revA: number,
  revB: number,
  path = '',
): Promise<{ ok: boolean; entries?: Array<{ path: string; item: string; kind: string; props: string }>; message: string }> {
  try {
    const res = await rpc('svn.diffSum', { sessionId, path, revA, revB })
    if (!res.ok) return { ok: false, message: '目录对比失败：' + res.error }
    return { ok: true, entries: res.entries, message: '已读取 ' + res.entries.length + ' 条变更' }
  } catch (error) {
    return { ok: false, message: '目录对比失败：' + String(error) }
  }
}

/**
 * 远端更新检查（W2-3，`svn status -u`；host 侧 15s 短超时，离线/超时走本函数错误分支）。
 * @author ddj 2026年09月20号
 * @param sessionId 会话 id
 * @param path 目标相对路径（'' = 工作副本根）
 * @returns 落后条目 + against 修订，或错误文案
 */
export async function svnRemoteStatus(
  sessionId: string | undefined,
  path = '',
): Promise<{ ok: boolean; outdated?: Array<{ path: string; item: string }>; againstRev?: number | null; message: string }> {
  try {
    const res = await rpc('svn.remoteStatus', { sessionId, path })
    if (!res.ok) return { ok: false, message: '远端检查失败：' + res.error }
    return { ok: true, outdated: res.outdated, againstRev: res.againstRev, message: '远端检查完成' }
  } catch (error) {
    return { ok: false, message: '远端检查失败：' + String(error) }
  }
}

/**
 * 扫描冲突副本文件（W2-4，`.mine`/`.working`/`.rN`，纯本地只读）。
 * @author ddj 2026年09月20号
 * @param sessionId 会话 id
 * @param path 冲突文件的工作区相对路径
 * @returns 副本清单或错误文案
 */
export async function svnConflictArtifacts(
  sessionId: string | undefined,
  path: string,
): Promise<{ ok: boolean; artifacts?: Array<{ path: string; name: string; kind: 'mine' | 'working' | 'rev'; rev?: number }>; message: string }> {
  try {
    const res = await rpc('svn.conflictArtifacts', { sessionId, path })
    if (!res.ok) return { ok: false, message: '扫描冲突副本失败：' + res.error }
    return { ok: true, artifacts: res.artifacts, message: '发现 ' + res.artifacts.length + ' 个冲突副本' }
  } catch (error) {
    return { ok: false, message: '扫描冲突副本失败：' + String(error) }
  }
}

/**
 * 双侧本地文件差异（W2-4，冲突副本 `.rN` ↔ `.mine` 对比）。
 * @author ddj 2026年09月20号
 * @param sessionId 会话 id
 * @param left 左侧工作区相对路径
 * @param right 右侧工作区相对路径
 * @returns 双侧内容（含护栏标记）或错误文案
 */
export async function svnDiffLocalPair(
  sessionId: string | undefined,
  left: string,
  right: string,
): Promise<{ ok: boolean; leftText?: string | null; rightText?: string | null; binary?: boolean; encodingHint?: boolean; message: string }> {
  try {
    const res = await rpc('svn.diffLocalPair', { sessionId, left, right })
    if (!res.ok) return { ok: false, message: '读取冲突副本失败：' + res.error }
    return { ok: true, leftText: res.left, rightText: res.right, binary: res.binary === true, encodingHint: res.encodingHint === true, message: '已读取双侧内容' }
  } catch (error) {
    return { ok: false, message: '读取冲突副本失败：' + String(error) }
  }
}

/**
 * 批量取文件大小（W2-5，改名配对启发式用；未知/失败按 null）。
 * @author ddj 2026年09月20号
 * @param sessionId 会话 id
 * @param paths 工作区相对路径列表（host 上限 200）
 * @returns 路径 → 大小表
 */
export async function svnFileSizes(
  sessionId: string | undefined,
  paths: string[],
): Promise<Record<string, number | null>> {
  try {
    const res = await rpc('svn.fileSizes', { sessionId, paths })
    if (!res.ok) return {}
    const table: Record<string, number | null> = {}
    for (const item of res.sizes) table[item.path] = item.size
    return table
  } catch (error) {
    return {}
  }
}

// --endregion

/**
 * Monaco 右键菜单 SVN 动作条目（编辑区动态注册用）。
 *
 * 与树/页签菜单同源：条目来自 shared 动作目录（surface='tab'），显隐规则经 svnActionOn
 * 求值（含「自研替换时间线」的能力覆盖判定），故不会再出现「编辑区右键只有 Tortoise 项」
 * 或「自研项漏挂某入口」的不一致。
 */
export interface SvnEditorAction {
  /** Monaco action id（稳定前缀 `edrv.svnEditor*`，与命令栏 id 不同通道）。 */
  id: string
  /** 菜单展示文案。 */
  label: string
  /** 动作类别：update = 工作区更新（全平台）、cli = 其他自研 CLI 动作、tortoise = 官方对话框。 */
  kind: 'update' | 'cli' | 'tortoise'
  /** 直接执行的自研动作 id（kind = cli/update 时）。 */
  actionId?: string
  /** kind = tortoise 时的 Tortoise 动作。 */
  tortoiseAction?: SvnAction
}

/** 动作 id → Monaco action id 后缀（保持历史 id 稳定：既有 id 不因重构而变）。 */
const EDITOR_ACTION_ID: Record<string, string> = {
  update: 'Update',
  'diff-base': 'Diff',
  add: 'Add',
  'revert-cli': 'Revert',
  log: 'Log',
  'tortoise-commit': 'Commit',
  'tortoise-log': 'TortoiseLog',
  'tortoise-diff': 'TortoiseDiff',
  'tortoise-blame': 'Blame',
  'tortoise-revert': 'TortoiseRevert',
}

/**
 * 按状态推导编辑区右键 SVN 动作表（纯函数；未检出/未受管理返回空 = 整组隐藏）。
 *
 * 复用 surface='tab' 的动作集合（页签与编辑区都针对「当前文件」这一语义），
 * 并注入活动文件的版本控制状态供状态门禁求值。被自研能力覆盖的 Tortoise 项
 * （差异/还原/日志）按时间线自动隐藏，留提交与追溯。
 *
 * @author ddj 2026年09月16号
 * @param status SVN 能力状态（未加载传 null）
 * @param target 活动文件的版本控制信息（缺省按「受版本控制、可比较」处理）
 * @returns 动作描述表
 */
export function svnEditorActions(
  status: SvnStatusPayload | null,
  target?: { versioned?: boolean; status?: SvnItemStatus; diffable?: boolean },
): SvnEditorAction[] {
  if (!status?.managed) return []
  const ctx: SvnActionContext = {
    managed: status.managed,
    svnCli: status.svnCli,
    tortoise: status.tortoise,
    svnFeatures: status.svnFeatures,
    // 编辑区展示的是**一个文件**，故按 target='file' 求值：这样「比较/加入/还原/日志」
    // 等面向文件的门禁（targets: file/directory）才会命中。若按 'editor' 求值，这些动作
    // 会因目标类型不匹配而整体消失——P1 动作矩阵里编辑区右键本应有更新/提交/日志/差异/追溯/还原。
    target: 'file',
    versioned: target?.versioned ?? true,
    status: target?.status,
    diffable: target?.diffable ?? true,
  }
  const actions: SvnEditorAction[] = []
  for (const def of svnActionsFor('tab')) {
    if (!svnActionOn(def, ctx)) continue
    const id = 'edrv.svnEditor' + (EDITOR_ACTION_ID[def.id] ?? def.id)
    if ((def.capability ?? 'cli') === 'tortoise') {
      actions.push({
        id,
        label: def.label,
        kind: 'tortoise',
        tortoiseAction: tortoiseActionOf(def.id),
      })
    } else {
      actions.push({ id, label: def.label, kind: def.id === 'update' ? 'update' : 'cli', actionId: def.id })
    }
  }
  return actions
}

/**
 * Tortoise 动作 id（`tortoise-<action>`）→ SvnAction。
 * @author ddj 2026年09月16号
 * @param id 动作 id
 * @returns Tortoise 动作名
 */
function tortoiseActionOf(id: string): SvnAction {
  return id.replace(/^tortoise-/, '') as SvnAction
}
