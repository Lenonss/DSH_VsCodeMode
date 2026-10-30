/**
 * dsh-vscode-mode 待审投影（pending review）的共享契约：按文件累计的净差异视图。
 * 官方快照表是不可变事实来源，本类型只是可由事实重建的投影，任何决定都不等于磁盘版本。
 * @author ddj 2026年10月29号
 */
import type { OfficialDiff } from './review.js'
import type { ReviewBlockState } from './reviewRegions.js'

/** 基线形态：`file` 写回内容，`none` 说明基线没有该路径（Revert 语义是删除文件）。 */
export type PendingEarlier = 'file' | 'none'

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
}

/** 一页待审条目。 */
export interface PendingPage {
  items: PendingItem[]
  pending: number
  nextCursor: number | null
  /** 采集/重建过程中的缺口说明，绝不静默吞掉。 */
  gaps: string[]
}

/** 单条待审详情。 */
export interface PendingDetail {
  item: PendingItem
  diff: OfficialDiff
  blocks: ReviewBlockState[]
  capability: { keep: boolean; revert: boolean; reason: string }
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

/** 从版本控制导入本地改动。 */
export interface PendingImport extends PendingRequest {
  includeUntracked?: boolean
  /** 只刷新一个文件，便于大仓单文件重扫。 */
  path?: string
}

/** 待审条目在面板列表里的 id 前缀；客户端与 Host 共用这一份口径。 */
export const PENDING_PREFIX = 'pending:'
