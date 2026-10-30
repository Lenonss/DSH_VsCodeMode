/**
 * dsh-vscode-mode client — 快捷菜单与宿主能力的桥接契约。
 *
 * 菜单组件不直接依赖 ctx：规则/技能/工作区列表与「发送到对话」都由 client 入口注入，
 * 这样菜单可以在无会话、无远程服务时优雅降级（返回 null 或空列表）。
 * 作者 ddj 2026年10月30号
 */
import type { QuickMenuStore, QuickMenuScope } from './quickMenuStore.js'
import type { RuleBinding, RuleListSnapshot } from '../shared/quickMenu.js'
import type { SkillCatalog } from '../shared/skillCatalog.js'

/** 宿主提供的发送结果。 */
export interface QuickSendResult {
  ok: boolean
  /** 失败/跳过的说明（直接给用户看）。 */
  message?: string
}

/** 工作区精简视图（限定工作区选择用）。 */
export interface QuickWorkspace {
  path: string
  title: string
}

/** 菜单组件可用的宿主能力。 */
export interface QuickMenuHost {
  store: QuickMenuStore
  /** 当前会话与工作区（每次调用取最新值）。 */
  scope(): QuickMenuScope
  /** 发送文本到当前会话（内部负责新建会话兜底）。 */
  send(text: string): Promise<QuickSendResult>
  /** 只把文本填入当前输入框（不发送）。 */
  fill(text: string): Promise<QuickSendResult>
  /** 规则列表（rules.list）。 */
  rules(): Promise<RuleListSnapshot>
  /** 当前会话可见技能名；无会话返回 null（供 validateSkill 判定，与候选列表分开）。 */
  skills(): Promise<string[] | null>
  /** 技能候选（全局技能 + 当前工作区技能）；枚举失败返回 null。 */
  skillCatalog(cwd?: string): Promise<SkillCatalog | null>
  /** 读取一条规则的正文（内联注入用）。 */
  readRule(binding: RuleBinding): Promise<string>
  /** 已注册工作区列表。 */
  workspaces(): QuickWorkspace[]
  /** 轻提示。 */
  notify(text: string): void
}
