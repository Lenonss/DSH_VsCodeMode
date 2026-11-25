/**
 * dsh-vscode-mode 待审投影（pending review）的共享契约：按文件累计的净差异视图。
 * 官方快照表是不可变事实来源，本类型只是可由事实重建的投影，任何决定都不等于磁盘版本。
 * @author ddj 2026年10月29号
 */
import type { OfficialDiff } from './review.js'
import type { ReviewBlockState } from './reviewRegions.js'

/** 基线形态：`file` 写回内容，`none` 说明基线没有该路径（Revert 语义是删除文件）。 */
export type PendingEarlier = 'file' | 'none'

/**
 * 采集通道：谁把这次变化变成了一条记录。
 * `tool` 是旧记录与未知写工具的默认值；`remote_ssh_write` 目前只走旧链路，为桥接保留。
 */
export type PendingSource = 'edit' | 'write' | 'remote_ssh_write' | 'tool' | 'watch' | 'scan' | 'vcs'

/** 归属：谁动的文件。撤销白名单只看它。 */
export type PendingOrigin = 'agent' | 'editor' | 'vcs' | 'external'

/**
 * 修改前内容的可信度：known 已知内容，absent 当时不存在，vcs 版本库基线，
 * normalized 由工具回执文本补出的基线（行尾已归一，写回前必须确认），unknown 拿不到。
 */
export type PendingBaseKind = 'known' | 'absent' | 'vcs' | 'normalized' | 'unknown'

/**
 * 采集证据强度：authoritative 工具回执自带前后全文；receipt 回执只带哈希；
 * snapshot 只有自己的前后快照；none 没有可用证据。
 */
export type PendingEvidence = 'authoritative' | 'receipt' | 'snapshot' | 'none'

/** 一次写入调用的结局：只有 changed 会进待审列表。 */
export type PendingVerdict = 'changed' | 'noop' | 'failed' | 'unverified'

/**
 * 差异追踪窗口状态：`open` 表示 AI 动过、用户还没处理完，期间所有改动都折进同一条差异；
 * `closed` 表示已处理完，之后的改动不再生成记录。
 */
export type PendingTracking = 'open' | 'closed'

/** 会话血缘，用于子代理/派生会话归属到同一待审视图。 */
export interface PendingLineage {
  parentSessionId?: string
  origin?: string
  delegationDepth?: number
  cwd?: string
}

/** 待审条目的展示投影。 */
export interface PendingItem {
  /** 稳定身份键（后端 + 目标键），客户端按它发送动作。 */
  id: string
  /** 展示路径。 */
  path: string
  earlierVersion: PendingEarlier
  added: number
  deleted: number
  /** oldText 与 newText 严格相等：已解决但仍留在列表。 */
  settled: boolean
  /** 读者还没看过的最新变化。 */
  unseen: boolean
  /** 文件已不存在（Revert 可恢复）。 */
  missing: boolean
  /** 当前文件内容已被外部改动替换过。 */
  diverged: boolean
  /** 文本超出存储/展示上限，差异与决定能力受限。 */
  oversized: boolean
  revision: number
  updatedAt: number
  sessionId: string
  sessionIds: string[]
  lineage?: PendingLineage
  /** 采集通道；旧条目没有该字段，按 `tool` 处理。 */
  source?: PendingSource
  /** 归属；旧条目没有该字段，按 `agent` 处理。 */
  origin?: PendingOrigin
  /** 修改前内容的可信度；旧条目没有该字段，按 `known` 处理。 */
  baseKind?: PendingBaseKind
  /** 这次差异靠什么证据立起来；旧条目没有该字段，按 `snapshot` 处理。 */
  evidence?: PendingEvidence
  /** 这次调用的结局；旧条目没有该字段，按 `changed` 处理。 */
  verdict?: PendingVerdict
  /** 差异追踪窗口状态；缺省按 `open` 解释。 */
  tracking?: PendingTracking
  /** 开窗时刻（毫秒时间戳）；0 表示旧条目或未知。 */
  openedAt?: number
  /** 只读编辑说明（模型声明，仅展示，不参与判定）；没有时不出现。 */
  note?: string
}

/** 一页待审条目。 */
export interface PendingPage {
  items: PendingItem[]
  pending: number
  nextCursor: number | null
  /** 采集/重建过程中的缺口说明，绝不静默吞掉。 */
  gaps: string[]
  /**
   * 已被待审窗口接管过的路径（含已关窗条目，路径与身份两种写法）：
   * 用来压住同路径的官方旧行与旧工具记录，避免关窗后它们复活。
   */
  coveredPaths?: string[]
}

/** 单条待审详情。 */
export interface PendingDetail {
  item: PendingItem
  diff: OfficialDiff
  blocks: ReviewBlockState[]
  capability: { keep: boolean; revert: boolean; reason: string; confirmRevert?: boolean }
}

/** 全部请求都带会话作用域，工作区由 host 解析，永不采信客户端 cwd。 */
export interface PendingRequest {
  sessionId: string
}

/** 决定粒度。 */
export interface PendingScope {
  scope: 'file' | 'block' | 'range' | 'all'
  blockId?: string
  startLine?: number
  endLine?: number
}

/** Keep/Revert 请求；operationId 提供幂等，revision 提供并发校验。 */
export interface PendingDecide extends PendingRequest, PendingScope {
  id: string
  revision: number
  operationId: string
  decision: 'accepted' | 'rejected'
}

/** 从列表移除已解决条目（不触碰磁盘）。 */
export interface PendingRemove extends PendingRequest {
  id: string
  revision: number
  operationId: string
}

/** 撤销/重做一次决定。 */
export interface PendingHistoryMove extends PendingRequest {
  direction: 'undo' | 'redo'
  operationId: string
}

/** 待审条目在面板列表里的 id 前缀；客户端与 Host 共用这一份口径。 */
export const PENDING_PREFIX = 'pending:'
