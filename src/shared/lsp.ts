/**
 * dsh-vscode-mode shared — 语言服务器 RPC 契约（双面，禁 node/react）。
 * LSP 请求/响应的 JSON 载荷形状 + 纯函数辅助（Monaco↔LSP 坐标换算等）。
 * 只描述"过 RPC 的载荷"，宿主与语言服务器之间的帧级交互在 host 侧 src/lsp/ 内。
 * 作者 ddj 2026-08-27
 */

/** LSP Position（0-based：line 行号从 0，character UTF-16 列从 0）。 */
export interface LspPosition {
  line: number
  character: number
}

/** LSP Range（start/end 均 0-based，包含 start、排除 end）。 */
export interface LspRange {
  start: LspPosition
  end: LspPosition
}

/** LSP Location：uri 为 file:// 绝对路径（与 Monaco Uri 对齐）。 */
export interface LspLocation {
  uri: string
  range: LspRange
}

/** 跳转结果（definition 常返回 LocationLink，归一化为 targetUri + targetRange + 可选 originSelectionRange）。 */
export interface LspLocationLink {
  targetUri: string
  targetRange: LspRange
  targetSelectionRange: LspRange
  originSelectionRange?: LspRange
}

/** 归一化后的符号（documentSymbol/workspaceSymbol 统一形状）。kind 为 LSP SymbolKind 数值。 */
export interface LspSymbol {
  name: string
  kind: number
  range: LspRange
  selectionRange: LspRange
  detail?: string
  containerName?: string
  children?: LspSymbol[]
}

/** hover 内容（markdown/纯文本行数组）。 */
export interface LspHover {
  contents: string[]
  range?: LspRange
}

/** LSP 服务器能力子集：本插件会用到的方法。 */
export interface LspServerCapabilities {
  definition: boolean
  references: boolean
  documentSymbol: boolean
  workspaceSymbol: boolean
  hover: boolean
}

/** 服务器进程/会话状态。 */
export type LspServerPhase =
  | 'idle'        // 未启动（惰性）
  | 'starting'    // 启动中（initialize 握手）
  | 'ready'       // 就绪
  | 'indexing'    // 工作区索引中
  | 'unavailable' // 连续失败，停止自动重启
  | 'stopped'     // 已停止（禁用/卸载/会话结束）

/** 单语言服务器状态（edrv.lsp.status 载荷元素）。 */
export interface LspServerStatus {
  languageId: string
  source: 'extension' | 'discover' | 'manual' | 'none'
  phase: LspServerPhase
  version?: string
  reason?: string   // unavailable/不可用原因（缺 dotnet、找不到服务器等）
  root?: string     // 绑定工作区根（相对显示）
}

/**
 * Monaco 位置（1-based lineNumber/column）→ LSP Position（0-based）。
 * @author ddj 2026年08月27号
 * @param lineNumber Monaco 行（≥1）
 * @param column Monaco 列（≥1）
 * @returns LSP 0-based position
 */
export function monoToLsp(lineNumber: number, column: number): LspPosition {
  return { line: Math.max(0, lineNumber - 1), character: Math.max(0, column - 1) }
}

/**
 * LSP Position（0-based）→ Monaco 位置（1-based）。
 * @author ddj 2026年08月27号
 * @param pos LSP position
 * @returns { lineNumber, column }（均 ≥1）
 */
export function lspToMono(pos: LspPosition): { lineNumber: number; column: number } {
  return { lineNumber: Math.max(1, pos.line + 1), column: Math.max(1, pos.character + 1) }
}

/** file:// URI → 路径（仅做规范化解码；Windows file:///C:/... 保留）。 */
export function fileUriToPath(uri: string): string {
  if (!uri) return ''
  const rest = uri.replace(/^file:\/\//, '')
  const decoded = decodeURIComponent(rest)
  return decoded.replace(/^\/([A-Za-z]:)/, '$1') // file:///C:/x → C:/x
}

/** 已装扩展信息（edrv.lsp.ext.list 载荷元素）。 */
export interface LspExtInfo {
  id: string        // publisher.name
  namespace: string
  name: string
  version: string
  displayName?: string
  description?: string
}

/** Open VSX 市场搜索结果项（edrv.lsp.ext.market 载荷元素）。 */
export interface LspMarketItem {
  namespace: string
  name: string
  id: string
  version: string
  displayName?: string
  description?: string
  download?: string
}

/** 有更新的已装扩展（edrv.lsp.ext.updates 载荷元素）。 */
export interface LspExtUpdate {
  id: string
  current: string
  latest: string
  displayName?: string
}
