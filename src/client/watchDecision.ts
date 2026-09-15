/**
 * dsh-vscode-mode client — 外部磁盘改动的同步决策（纯逻辑，可单测）。
 *
 * 存在意义：编辑区内容只在打开/手动刷新时从磁盘读取，外部（其他编辑器、Unity、
 * 脚本、agent 工具）改了文件后缓冲与文件树长期陈旧，且陈旧缓冲的防抖自动保存会
 * 直接覆盖外部改动。本模块只承载判定与基线台账，IO 与 UI 由 useFileWatch /
 * EditorView 承担：
 * - 基线（baseline）：每个已打开路径记录「最后一次从磁盘读到的版本令牌」，
 *   版本令牌来自 host fs.stat（不透明串），客户端只做相等比较。
 * - 台账（syncState）：判定为需要用户介入（冲突/消失）的路径，供状态栏提示
 *   与「抑制自动保存」读取；冲突被处理或自愈后清除。
 *
 * 判定表（syncDecision）：
 *   无基线              → none（首次打开或未带版本，由调用方补记基线）
 *   文件缺失 + 缓冲干净  → deleted
 *   文件缺失 + 缓冲脏    → none（保留未保存编辑，交由保存失败路径提示）
 *   版本未变            → none
 *   版本变 + 缓冲干净    → sync-silent（先比内容：相同只补基线，不同才重载）
 *   版本变 + 缓冲脏 + 内容相同 → sync-silent（仅补记基线，不打断编辑）
 *   版本变 + 缓冲脏 + 内容不同 → conflict（绝不覆盖）
 *
 * 重要事实（实测，勿改回「只看版本」）：host 版本令牌 = host fs 的 stat 身份串，
 * 本地后端实现为 `dev:ino:size:mtimeNs:ctimeNs`，其中 ctime 在「同字节重写」时
 * 也会变（格式化工具/同步盘/编辑器保存策略常见）。因此版本变化只代表「动过」，
 * 是否真的需要重载必须由磁盘内容与缓冲内容的比对决定；读取结果按版本号缓存
 * （readVersion），同一版本只读一次，避免陈旧缓冲长期不处理时反复拉取大文件。
 *
 * 作者 ddj 2026-09-15
 */
import type { FileVersionItem } from '../shared/rpc.js'

// --region 类型

/** 一次同步判定的输入（全部为已观测事实，不含 IO）。 */
export interface SyncInput {
  /** 是否已有磁盘版本基线。 */
  hasBaseline: boolean
  /** 磁盘版本令牌是否与基线不同（无基线时为 false）。 */
  versionChanged: boolean
  /** 磁盘上是否已不存在该路径。 */
  missing: boolean
  /** 缓冲是否已置脏（有待保存的编辑）。 */
  clean: boolean
  /** 缓冲内容是否与磁盘内容相同（仅冲突分支需要，未取到磁盘内容时传 false）。 */
  contentEqual: boolean
}

/** 同步判定结果。 */
export type SyncAction = 'sync-silent' | 'conflict' | 'deleted' | 'none'

/** 需要用户介入的台账项（状态栏提示与自动保存抑制共用）。 */
export interface SyncFlag {
  path: string
  kind: 'conflict' | 'deleted'
  at: number
}

// --endregion

// --region 常量与状态

/** 台账上限：超出按写入序逐出最旧（防长时间运行无界增长）。 */
export const SYNC_STATE_CAP = 64
/** 单作用域基线上限：超出按写入序逐出最旧（已关闭页签的基线可丢）。 */
export const BASELINE_CAP = 128

/** 作用域键 → 路径 → 磁盘版本令牌。 */
const baselines = new Map<string, Map<string, string>>()
/** 作用域键 → 路径 → 已读取过内容的磁盘版本（同版本不重复读盘；含当时的比对结果）。 */
const readVersions = new Map<string, Map<string, { version: string; equal: boolean }>>()
/** 作用域键 → 路径 → 待处理同步标记。 */
const syncState = new Map<string, Map<string, SyncFlag>>()

// --endregion

// --region 纯函数

/**
 * 台账键：作用域 + 归一化路径（`/` 分隔，大小写敏感语义与 host 一致）。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 * @param path 文件路径（工作区相对或绝对）
 * @returns 台账键
 */
export function syncKey(scope: string, path: string): string {
  return String(scope ?? '') + '\u0000' + String(path ?? '').replace(/\\/g, '/')
}

/**
 * 判定一次观测的同步动作（纯函数，判定表见模块头注释）。
 * @author ddj 2026年09月15号
 * @param input 观测输入（基线有无/版本是否变化/是否缺失/缓冲是否脏/内容是否相同）
 * @returns 同步动作
 */
export function syncDecision(input: SyncInput): SyncAction {
  if (!input.hasBaseline) return 'none'
  if (input.missing) return input.clean ? 'deleted' : 'none'
  if (!input.versionChanged) return 'none'
  if (input.clean) return 'sync-silent'
  return input.contentEqual ? 'sync-silent' : 'conflict'
}

/**
 * 从 host 版本条目取可比较的版本令牌（缺失/空串 → null，表示该后端不提供版本）。
 * @author ddj 2026年09月15号
 * @param item 版本条目（可为 undefined）
 * @returns 版本令牌或 null
 */
export function versionOf(item: FileVersionItem | undefined | null): string | null {
  const version = item?.version
  return typeof version === 'string' && version ? version : null
}

// --endregion

// --region 基线台账

/**
 * 记入（或更新）某路径的磁盘版本基线；版本为空串时不记（后端不支持版本）。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 * @param path 文件路径
 * @param version 磁盘版本令牌
 */
export function recordBaseline(scope: string, path: string, version: string | undefined | null): void {
  if (!path || typeof version !== 'string' || !version) return
  let map = baselines.get(scope)
  if (!map) {
    map = new Map()
    baselines.set(scope, map)
  }
  const key = String(path).replace(/\\/g, '/')
  map.delete(key)
  map.set(key, version)
  while (map.size > BASELINE_CAP) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/**
 * 读取某路径的磁盘版本基线。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 * @param path 文件路径
 * @returns 版本令牌；无基线 → null
 */
export function baselineOf(scope: string, path: string): string | null {
  return baselines.get(scope)?.get(String(path).replace(/\\/g, '/')) ?? null
}

/**
 * 清除某路径的基线（页签关闭、会话销毁时调用）。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 * @param path 文件路径
 */
export function clearBaseline(scope: string, path: string): void {
  baselines.get(scope)?.delete(String(path).replace(/\\/g, '/'))
}

/**
 * 记入「已读取过内容的磁盘版本」与比结果（同版本不再重复读盘）。
 * 读盘成功、保存成功、覆盖成功、保留本地推进基线时都要记，避免下一轮白读一次。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 * @param path 文件路径
 * @param version 版本令牌（空值忽略）
 * @param equal 读到的磁盘内容是否与当时的缓冲内容相同
 */
export function markReadVersion(scope: string, path: string, version: string | undefined | null, equal = false): void {
  if (!path || typeof version !== 'string' || !version) return
  let map = readVersions.get(scope)
  if (!map) {
    map = new Map()
    readVersions.set(scope, map)
  }
  const key = String(path).replace(/\\/g, '/')
  map.delete(key)
  map.set(key, { version, equal: equal === true })
  while (map.size > BASELINE_CAP) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/**
 * 该磁盘版本是否已读过内容；是则同时给出当时的比对结果（轮询跳过读盘）。
 * 必须按版本号严格匹配：缓存里可能是更早版本的结果，版本不同一律视为未读。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 * @param path 文件路径
 * @param version 当前磁盘版本令牌
 * @returns 未读过该版本 → null；读过 → { equal: 内容是否与缓冲一致 }
 */
export function readVersionOf(scope: string, path: string, version: string | null): { equal: boolean } | null {
  if (!version) return null
  const memo = readVersions.get(scope)?.get(String(path).replace(/\\/g, '/'))
  if (!memo || memo.version !== version) return null
  return { equal: memo.equal }
}

/**
 * 清除某路径的已读版本（重载后必须清：下一轮需按新版本重新读盘比对）。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 * @param path 文件路径
 */
export function clearReadVersion(scope: string, path: string): void {
  readVersions.get(scope)?.delete(String(path).replace(/\\/g, '/'))
}

/**
 * 清空某作用域的全部基线（作用域切换时调用，防旧工作区基线串到新工作区）。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 */
export function clearScope(scope: string): void {
  baselines.delete(scope)
  readVersions.delete(scope)
  syncState.delete(scope)
}

// --endregion

// --region 同步标记

/**
 * 标记某路径需要用户介入（冲突/文件消失）。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 * @param path 文件路径
 * @param kind 标记类型
 */
export function markSync(scope: string, path: string, kind: SyncFlag['kind']): void {
  let map = syncState.get(scope)
  if (!map) {
    map = new Map()
    syncState.set(scope, map)
  }
  const key = String(path).replace(/\\/g, '/')
  map.delete(key)
  map.set(key, { path, kind, at: Date.now() })
  while (map.size > SYNC_STATE_CAP) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/**
 * 读取某路径的待处理同步标记。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 * @param path 文件路径
 * @returns 标记；无 → null
 */
export function readSync(scope: string, path: string): SyncFlag | null {
  return syncState.get(scope)?.get(String(path).replace(/\\/g, '/')) ?? null
}

/**
 * 清除某路径的同步标记（重新加载/保留本地/保存成功后调用）。
 * @author ddj 2026年09月15号
 * @param scope 工作区作用域键
 * @param path 文件路径
 */
export function clearSync(scope: string, path: string): void {
  syncState.get(scope)?.delete(String(path).replace(/\\/g, '/'))
}

// --endregion
