/**
 * dsh-vscode-mode client — 大纲契约（归一化符号模型 + 数据源接口）。
 * 面板只消费 OutlineSymbol[]，与 Monaco 解耦；未来语言插件（LSP/VSIX 风格，
 * 如 EmmyLua/C#）注册高优先级 OutlineSource 即可接入，无需改动面板。
 * kind 取 monaco SymbolKind 数值（0–25，与 LSP SymbolKind 一致）。
 * 作者 ddj 2026-08-27
 */

/** 归一化大纲符号（面板唯一渲染契约）。 */
export interface OutlineSymbol {
  name: string
  /** monaco SymbolKind 数值：File0/Module1/Namespace2/Package3/Class4/Method5/Property6/Field7/Constructor8/Enum9/Interface10/Function11/Variable12/Constant13/String14/Number15/Boolean16/Array17/Object18/Key19/Null20/EnumMember21/Struct22/Event23/Operator24/TypeParameter25。 */
  kind: number
  detail?: string
  /** 符号整体起始行（1-based）。 */
  startLine: number
  /** 符号整体结束行（1-based）。 */
  endLine: number
  /** 跳转行（符号名所在行，1-based）。 */
  selectLine: number
  children?: OutlineSymbol[]
}

/** 大纲数据源输入（面板解析时注入当前快照；字段均为弱类型，源自行 duck-typing）。 */
export interface OutlineSourceInput {
  languageId: string
  /** Monaco 文本模型（源可用 model.getValue() 自行解析）。 */
  model?: unknown
  /** 当前 Monaco 编辑器实例（供 _commandService 等内部调用）。 */
  editor?: unknown
  /** 全局 monaco 对象。 */
  monaco?: unknown
}

/** 大纲数据源：按优先级降序解析，首个非空结果生效。 */
export interface OutlineSource {
  id: string
  /** 数值越大越优先（内置：monaco=50、fallback=30；第三方语言插件建议 60–90）。 */
  priority: number
  /** 是否可为该语言提供符号。 */
  provides(languageId: string): boolean
  get(input: OutlineSourceInput): Promise<OutlineSymbol[]>
}

/** 大纲源注册表（ctx.provide 为 edrvOutlineSources，供第三方注册）。 */
export interface OutlineSourceRegistry {
  register(source: OutlineSource): () => void
  list(): readonly OutlineSource[]
  subscribe(listener: () => void): () => void
  get(id: string): OutlineSource | undefined
}
