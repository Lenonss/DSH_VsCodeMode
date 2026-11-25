/**
 * 采集来源与归属：把「谁把这次变化变成记录」和「谁动的文件」拆成两个正交字段，
 * 并维护两类时间窗（编辑器保存 / 插件自写），供窗口跟随器判定归属。
 *
 * 设计取舍：
 * - 窗口跟随器只跟随已开窗的文件；归属只用确定性窗口判定，不猜 stdout、不看 mtime。
 *   `edrv.save` 前后 2s 内命中同一路径记为编辑器窗口，插件自己写回的路径为自写窗口。
 * - 去重键是「路径 + 内容哈希」：内容逐字节相等就视为同一次变化，绝不按时间戳猜。
 * - 标记表有上限，长跑实例不会无界增长。
 * 作者 ddj 2026-11-24
 */
import { createHash } from 'node:crypto'
import type { PendingBaseKind, PendingEvidence, PendingOrigin, PendingSource } from '../shared/pendingReview.js'
import { pathKeyFor } from '../shared/pathKey.js'

// --region 常量

/** 编辑器保存的归属窗口。 */
export const EDITOR_WINDOW_MS = 2000
/** 插件自写（撤销写回、远端镜像写穿）的窗口：写入后 watch 会立刻收到事件。 */
export const SELF_WINDOW_MS = 5000
/** 路径标记表上限：超出按写入序逐出最旧。 */
export const MARK_MAX = 2000

/** 写工具 → 采集通道。未列出的写工具按 `tool` 处理。 */
const SOURCE_OF_TOOL: Record<string, PendingSource> = {
  edit: 'edit',
  str_replace_editor: 'edit',
  apply_patch: 'edit',
  'ops_edit_file': 'edit',
  write: 'write',
  'ops_write_file': 'write',
  'ops_remove': 'write',
  'ops_copy': 'write',
  'ops_move': 'write',
  'ops_replace': 'edit',
  remote_ssh_write: 'remote_ssh_write',
  // 外部采集直接把通道名当工具名传进来，原样保留，不能被归一成 tool
  watch: 'watch',
  scan: 'scan',
  vcs: 'vcs',
}

/** 通道强度：合并同一路径的两次采集时，强通道保留其来源标签。 */
const SOURCE_RANK: Record<PendingSource, number> = {
  edit: 6, write: 6, remote_ssh_write: 5, tool: 4, watch: 3, scan: 2, vcs: 1,
}

/** 证据强度：回执说过的话比自己的快照可信，快照又胜过没有任何依据。 */
const EVIDENCE_RANK: Record<PendingEvidence, number> = {
  authoritative: 4, receipt: 3, snapshot: 2, none: 1,
}

// --endregion

// --region 纯函数

/**
 * @author ddj 2026-11-24
 * @description: Host 侧的路径比较键：盘符恒折叠大小写，其余按运行平台折叠。
 * @param path 路径
 * @returns 比较键
 */
export function pathKeyOf(path: string): string {
  return pathKeyFor(path, process.platform === 'win32')
}

/**
 * @author ddj 2026-11-24
 * @description: 写工具名 → 采集通道；未知工具统一按 `tool`。
 * @param tool 工具名
 * @returns 采集通道
 */
export function sourceOfTool(tool: unknown): PendingSource {
  const name = typeof tool === 'string' ? tool : ''
  return SOURCE_OF_TOOL[name] ?? 'tool'
}

/**
 * @author ddj 2026-11-24
 * @description: 合并同一路径的两次采集来源：强通道优先，同级保留首次值。
 * @param earlier 已落库通道（可为空）
 * @param later 本次通道
 * @returns 应当落库的通道
 */
export function strongerSource(earlier: PendingSource | undefined, later: PendingSource | undefined): PendingSource {
  const left = earlier ?? 'tool'
  const right = later ?? 'tool'
  return (SOURCE_RANK[left] >= SOURCE_RANK[right] ? left : right)
}

/**
 * @author ddj 2026年11月25号
 * @description: 合并证据强度：回执胜过快照，同级保留首次值。
 * @param earlier 已落库证据（可为空）
 * @param later 本次证据
 * @returns 应当落库的证据强度
 */
export function strongerEvidence(earlier: PendingEvidence | undefined, later: PendingEvidence | undefined): PendingEvidence {
  const left = earlier ?? 'snapshot'
  const right = later ?? 'snapshot'
  return (EVIDENCE_RANK[left] >= EVIDENCE_RANK[right] ? left : right)
}

/**
 * @author ddj 2026年11月25号
 * @description: 证据徽标文案；旧条目没有该字段时按快照处理。
 * @param evidence 证据强度
 * @returns 展示文案
 */
export function evidenceLabelOf(evidence?: PendingEvidence): string {
  if (evidence === 'authoritative') return '回执已核'
  if (evidence === 'receipt') return '回执对账'
  if (evidence === 'none') return '无回执'
  return '快照推断'
}

/**
 * @author ddj 2026-11-24
 * @description: 去重键：路径比较键 + 内容 sha256。只按内容判同一变化，不看时间。
 * @param pathKey 路径比较键
 * @param content 文件内容（缺失用空串）
 * @returns 去重键
 */
export function dedupeKey(pathKey: string, content: string | null): string {
  return pathKey + '\u0000' + createHash('sha256').update(content ?? '\u0000absent').digest('hex')
}

/**
 * @author ddj 2026-11-24 / 2026年11月25号
 * @description: 撤销白名单：只有 agent 来源且基线可信时才可以直接撤销；归一基线要确认。
 * @param origin 归属
 * @param baseKind 基线与可信度
 * @returns 可直接撤销 / 需确认 / 禁止
 */
export function revertPolicyOf(
  origin: PendingOrigin | undefined,
  baseKind: PendingBaseKind | undefined,
): 'direct' | 'confirm' | 'blocked' {
  const base = baseKind ?? 'known'
  if (base === 'unknown') return 'blocked'
  if (base === 'normalized') return 'confirm'
  return (origin ?? 'agent') === 'agent' ? 'direct' : 'confirm'
}

/**
 * @author ddj 2026-11-24 / 2026年11月25号
 * @description: 条目来源徽标文案；官方行没有徽标，待审条目在来源后附证据强度。
 * @param entry 待审条目的来源字段
 * @returns 展示文案
 */
export function sourceLabelOf(entry: { source?: PendingSource; origin?: PendingOrigin; evidence?: PendingEvidence }): string {
  const source = entry.source ?? 'tool'
  const origin = entry.origin ?? 'agent'
  const badge = ' · ' + evidenceLabelOf(entry.evidence)
  if (origin === 'agent') return source + ' · agent' + badge
  if (origin === 'editor') return '编辑器保存' + badge
  if (origin === 'vcs') return '版本库同步' + badge
  return source + ' · 外部' + badge
}

// --endregion

// --region 时间窗

/** 一条路径上的窗口标记。 */
interface Marks {
  selfAt?: number
  editorAt?: number
}

/** 进程内窗口状态：随插件装配创建，卸载清空。 */
interface WindowState {
  /** 路径标记表（插入序即淘汰序）。 */
  marks: Map<string, Marks>
}

/**
 * 创建窗口注册表（不依赖 Host，可单测）。
 * @author ddj 2026-11-24
 * @returns 注册表能力
 */
export function createWindows() {
  const state: WindowState = { marks: new Map() }

  /**
   * @description: 逐出超期标记，再压到上限内。
   * @param now 当前时间
   */
  function sweep(now: number): void {
    for (const [key, mark] of state.marks) {
      const self = mark.selfAt !== undefined && now - mark.selfAt <= SELF_WINDOW_MS
      const editor = mark.editorAt !== undefined && now - mark.editorAt <= EDITOR_WINDOW_MS
      if (!self && !editor) state.marks.delete(key)
    }
    while (state.marks.size > MARK_MAX) {
      const oldest = state.marks.keys().next().value
      if (oldest === undefined) break
      state.marks.delete(oldest)
    }
  }

  /**
   * @description: 取（或建）一条路径的标记。
   * @param key 路径比较键
   * @param now 当前时间
   * @returns 可变标记对象
   */
  function markOf(key: string, now: number): Marks {
    sweep(now)
    const existing = state.marks.get(key)
    if (existing) return existing
    const created: Marks = {}
    state.marks.set(key, created)
    return created
  }

  return {
    /** @param key 路径比较键 @param now 当前时间 @returns 打自写标记。 */
    markSelf(key: string, now = Date.now()): void {
      markOf(key, now).selfAt = now
    },
    /** @param key 路径比较键 @param now 当前时间 @returns 打编辑器保存标记。 */
    markEditor(key: string, now = Date.now()): void {
      markOf(key, now).editorAt = now
    },
    /**
     * @description: 取占用窗口的类别；自写优先于编辑器，两者都没有返回 null。
     * @param key 路径比较键
     * @param now 当前时间
     * @returns 窗口类别
     */
    windowOf(key: string, now = Date.now()): 'self' | 'editor' | null {
      const mark = state.marks.get(key)
      if (!mark) return null
      if (mark.selfAt !== undefined && now - mark.selfAt <= SELF_WINDOW_MS) return 'self'
      if (mark.editorAt !== undefined && now - mark.editorAt <= EDITOR_WINDOW_MS) return 'editor'
      return null
    },
    /** @returns 无。清空全部窗口（插件卸载）。 */
    dispose(): void {
      state.marks.clear()
    },
  }
}

/** 进程级窗口注册表：capture.ts / rpc.ts / externalCapture.ts 共用同一份。 */
export const windows = createWindows()

// --endregion
