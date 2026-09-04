/**
 * dsh-vscode-mode 规则管理共享数据契约（.mdc 规则文件，参考 Codebuddy/Cursor 规则形态）。
 * 纯类型模块：禁 node/react 导入（与 shared/mcp.ts 同约束）。
 * 作者 ddj 2026年09月03号
 */

/** 规则作用域：用户规则（~/.dsh/rules）或项目规则（<工作区>/.dsh/rules）。 */
export type RuleScope = 'user' | 'project'

/** 规则生效类型（由 frontmatter 推导）：总是 / 自动（globs 命中时）/ 手动（仅索引）。 */
export type RuleType = 'always' | 'auto' | 'manual'

/** 一条 .mdc 规则的元信息（列表行展示 + 注入语义所需的最小集）。 */
export interface RuleInfo {
  scope: RuleScope
  /** 文件名（含 .mdc 后缀，不含路径）。 */
  file: string
  /** 绝对路径（host 解析，供展示与按需读取）。 */
  absPath: string
  /** 相对提示（用户层 rules/ 或项目层 .dsh/rules/）。 */
  relHint: string
  /** frontmatter description（缺失为空串）。 */
  description: string
  type: RuleType
  /** frontmatter globs 归一化列表（类型=auto 时非空）。 */
  globs: string[]
  /** frontmatter enabled（缺省 true；false 时列表仍显示但不注入）。 */
  enabled: boolean
  /** 文件字节数（列表排序/超大提示用）。 */
  size: number
  /** 修改时间毫秒。 */
  mtime: number
  /** frontmatter 解析失败文案（不注入，仅 UI 提示）。 */
  error?: string
}

/** 一个工作区的项目规则聚合（rules.list 的 projects 项）。 */
export interface RuleProject {
  workspacePath: string
  title: string
  rules: RuleInfo[]
  /** 工作区目录不存在或无规则目录时为 true（UI 显示空态而非报错）。 */
  missingDir?: boolean
}

/** 规则保存入参：content 为完整 .mdc 文本（frontmatter + 正文，host 原样写盘）。 */
export interface RuleSaveInput {
  scope: RuleScope
  /** project 必填：目标工作区绝对路径（须为 DSH 已注册 workspace）。 */
  workspacePath?: string
  file: string
  content: string
}

/** 规则读取/删除/开关入参公共字段。 */
export interface RuleRefInput {
  scope: RuleScope
  workspacePath?: string
  file: string
}
