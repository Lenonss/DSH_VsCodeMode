/**
 * dsh-vscode-mode RPC contract — method names, per-method request/ok payloads,
 * and the typed handler map shared by the host dispatcher and the client
 * fetch wrapper. 载荷形状与历史实现一字不差，仅把隐式约定类型化。
 *
 * Purity rule: no node/react imports (same as types.ts).
 * 作者 ddj 2026-08-20
 */
import type {
  ArchiveBatch,
  ArchiveEntry,
  RecordView,
  StaleHunk,
} from './types.js'
import type { MpcConfig, MpcProject, MpcProjectSaveInput, MpcServer } from './mcp.js'
import type { CompatReport, DevFormInfo } from './compat.js'

/** webServer 精确路由。 */
export const RPC_PATH = '/edrv/rpc'

/** 决策作用域：call=整条记录，hunk=单个差异块。 */
export type RpcScope = 'call' | 'hunk'

/** 目录树单项（edrv.listDir 返回；path 相对工作区根，'/' 分隔）。 */
export interface TreeEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

/** 内容搜索单条命中（edrv.searchContent 返回；path 相对工作区根，列为 1-based UTF-16）。 */
export interface SearchContentMatch {
  path: string
  line: number
  startColumn: number
  endColumn: number
  text: string
}

/** 一条批量决策项（decideBatch 的 items 元素，与 accept/reject 单条参数同构）。 */
export interface DecideItem {
  callId: string
  scope?: RpcScope
  hunkIndex?: number
  decision: 'accepted' | 'rejected'
}

/** 批量决策逐项结果。 */
export interface DecideResult {
  callId: string
  ok: boolean
  error?: string
  record?: RecordView
}

/** 每个方法的请求参数（sessionId 为公共可选字段）。 */
export interface RpcRequestMap {
  'edrv.list': { sessionId?: string; callIds?: string[]; skipStale?: boolean }
  'edrv.accept': { sessionId?: string; callId: string; scope?: RpcScope; hunkIndex?: number }
  'edrv.reject': { sessionId?: string; callId: string; scope?: RpcScope; hunkIndex?: number }
  'edrv.decideBatch': { sessionId?: string; items: DecideItem[] }
  'edrv.read': { sessionId?: string; path: string }
  'edrv.original': { sessionId?: string; path: string }
  'edrv.save': { sessionId?: string; path: string; content: string }
  'edrv.archiveList': { sessionId?: string }
  'edrv.archiveRead': { sessionId?: string; path?: string }
  'edrv.rollback': { sessionId?: string; path: string; batch?: number }
  'edrv.debug': { sessionId?: string; text: string }
  'edrv.searchFiles': { sessionId?: string; query: string }
  'edrv.searchContent': { sessionId?: string; query: string; matchCase?: boolean; wholeWord?: boolean; regex?: boolean; maxResults?: number; include?: string[]; exclude?: string[] }
  'edrv.listDir': { sessionId?: string; path: string }
  'edrv.revealInExplorer': { sessionId?: string; path: string }
  'mcp.list': {}
  'mcp.save': { config: MpcConfig }
  'mcp.remove': { id: string }
  'mcp.toggle': { id: string; enabled: boolean }
  'mcp.refresh': { id: string }
  'mcp.projects': {}
  'mcp.projectSave': MpcProjectSaveInput
  'mcp.projectRemove': { workspacePath: string; serverName: string }
  'mcp.projectToggle': { workspacePath: string; serverName: string; enabled: boolean }
  'mcp.projectRefresh': { workspacePath: string; serverName: string }
  'vscode.fileOpenSettingsGet': {}
  'vscode.fileOpenSettingsUpdate': { fileOpenTool: string; expectedRevision?: number }
  'vscode.devFormGet': {}
  'vscode.devFormSet': { enabled: boolean; path?: string }
  'compat': {}
}

export type RpcMethod = keyof RpcRequestMap

/** 每个方法成功（ok:true）时的附加载荷。 */
export interface RpcOkMap {
  'edrv.list': { records: RecordView[] }
  'edrv.accept': { record: RecordView }
  'edrv.reject': { record: RecordView }
  'edrv.decideBatch': { results: DecideResult[] }
  'edrv.read': { content: string; size: number }
  'edrv.original': { content: string; size: number; stale: StaleHunk[]; fallback: boolean }
  'edrv.save': object
  'edrv.archiveList': { entries: ArchiveEntry[] }
  'edrv.archiveRead': { batches: ArchiveBatch[] }
  'edrv.rollback': { path: string; batch: number | null }
  'edrv.debug': object
  'edrv.searchFiles': { files: string[]; truncated: boolean }
  'edrv.searchContent': { matches: SearchContentMatch[]; truncated: boolean }
  'edrv.listDir': { root: string; path: string; entries: TreeEntry[] }
  'edrv.revealInExplorer': { revealed: string }
  'mcp.list': { servers: MpcServer[] }
  'mcp.save': { server: MpcServer }
  'mcp.remove': object
  'mcp.toggle': { server: MpcServer }
  'mcp.refresh': { server: MpcServer }
  'mcp.projects': { projects: MpcProject[] }
  'mcp.projectSave': { project: MpcProject }
  'mcp.projectRemove': { project: MpcProject }
  'mcp.projectToggle': { project: MpcProject }
  'mcp.projectRefresh': { project: MpcProject }
  'vscode.fileOpenSettingsGet': { fileOpenTool: string; revision?: number }
  'vscode.fileOpenSettingsUpdate': { fileOpenTool: string; revision?: number }
  'vscode.devFormGet': { devForm: DevFormInfo }
  'vscode.devFormSet': { devForm: DevFormInfo; restart: boolean }
  'compat': { report: CompatReport }
}

/** 统一响应：{ok:true, ...payload} 或 {ok:false, error}。 */
export type RpcResult<M extends RpcMethod> =
  | ({ ok: true } & RpcOkMap[M])
  | { ok: false; error: string }

/** 每个方法的 handler 签名（host 分发表与 client 类型检查共用）。 */
export type RpcHandler<M extends RpcMethod> = (
  args: RpcRequestMap[M],
) => Promise<RpcResult<M>>

/** host RPC 分发表：method → handler。 */
export type RpcHandlerMap = {
  [M in RpcMethod]: RpcHandler<M>
}
