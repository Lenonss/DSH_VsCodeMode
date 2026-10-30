/**
 * dsh-vscode-mode 快捷菜单共享契约 — 技能候选（全局技能 + 当前工作区技能）。
 *
 * 纯类型模块：禁 node/react 导入（与 shared/rules.ts、shared/quickMenu.ts 同约束）。
 * 为什么需要它：快捷菜单的「绑定技能」下拉要按来源分组展示候选，而会话可见技能名
 * （remote.skills）只给名字、不给来源，且无活跃会话时不可用；这里定义 host 扫描
 * 磁盘技能目录后的只读快照，供 UI 分组与摘要使用。
 *
 * 作者 ddj 2026年10月30号
 */

/** 技能来源：用户全局技能（DSH_HOME/skills）或当前工作区技能（<projectRoot>/.dsh/skills）。 */
export type SkillSource = 'user' | 'project'

/** 一条可绑定技能的元信息（下拉选项展示所需的最小集）。 */
export interface SkillInfo {
  /** kebab-case 技能名（与提示词里 /技能名 token 一致）。 */
  name: string
  /** frontmatter description（必填字段的最小摘要，缺失时为空串）。 */
  description: string
  /** SKILL.md 或 <名>.md 的绝对路径（排障与 title 提示用）。 */
  path: string
  source: SkillSource
}

/** 技能候选快照（skills.list 的返回，只读、不落缓存、不写盘）。 */
export interface SkillCatalog {
  user: SkillInfo[]
  /** 未识别到工作区根或工作区无技能目录时为空数组（非错误）。 */
  project: SkillInfo[]
  /** 解析出的工作区根目录（向上找到的含 .git 祖先）；缺失表示按 cwd 兜底。 */
  projectRoot?: string
}

/** 下拉面板的来源分组（按 key 顺序渲染）。 */
export interface SkillGroup {
  key: SkillSource
  label: string
  skills: SkillInfo[]
}

/** 来源分组标题文案。 */
export const SKILL_SOURCE_LABEL: Record<SkillSource, string> = {
  user: '全局技能',
  project: '当前工作区技能',
}

/**
 * 按来源分组（空组不出现；面板全空时由 UI 统一渲染空态）。
 * @author ddj 2026年10月30号
 * @param input 技能候选快照
 * @returns 非空分组（全局在前、工作区在后）
 */
export function groupSkills(input: SkillCatalog | null | undefined): SkillGroup[] {
  if (!input) return []
  const groups: SkillGroup[] = []
  if (input.user.length > 0) groups.push({ key: 'user', label: SKILL_SOURCE_LABEL.user, skills: input.user })
  if (input.project.length > 0) groups.push({ key: 'project', label: SKILL_SOURCE_LABEL.project, skills: input.project })
  return groups
}
