/**
 * dsh-vscode-mode host — 技能候选枚举（全局技能 + 当前工作区技能）。
 *
 * 为什么要另起一条通道：本插件原有的 `skills.ts` 只管「随包分发的技能组」
 * （<包根>/skills，按 SKILL_PREFIXES 前缀白名单过滤）；而快捷菜单「绑定技能」需要的是
 * 用户能自由增删的两类技能目录，与 DSH 文件系统 skill provider 的两个根一致：
 * - 全局技能：`$DSH_HOME/skills`（provider rank 400 / user-dsh）
 * - 工作区技能：`<projectRoot>/.dsh/skills`（provider rank 100 / project-dsh）
 * 只读、不写盘、不缓存：每次打开配置弹窗重扫一遍（目录数量级很小）。
 *
 * 作者 ddj 2026年10月30号
 */
import { statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from './paths.js'
import { isParsedSkill, parseSkillMd } from './skills.js'
import type { SkillCatalog, SkillInfo, SkillSource } from './shared/skillCatalog.js'

/** 单个根目录最多枚举的技能数（防失控目录拖垮弹窗）。 */
const SKILL_CATALOG_CAP = 200
/** 向上找项目根的层数上限（防异常路径下的长链遍历）。 */
const ROOT_DEPTH_CAP = 8
/** 目录式技能的清单文件名。 */
const SKILL_FILE = 'SKILL.md'

/** 技能根目录集合（绝对路径）。 */
export interface SkillRoots {
  /** 全局技能根：<DSH_HOME>/skills。 */
  user: string
  /** 工作区技能根：<projectRoot>/.dsh/skills。 */
  project: string
  /** 解析出的工作区根（含 .git 的最近祖先；找不到时回落 cwd）。 */
  projectRoot?: string
}

/**
 * 从 cwd 向上找项目根（含 .git 的最近祖先；找不到回落 cwd）。
 * @author ddj 2026年10月30号
 * @param cwd 起始目录
 * @returns 项目根绝对路径；cwd 缺失时 undefined
 */
export function projectRootOf(cwd?: string): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  let current = cwd
  for (let depth = 0; depth < ROOT_DEPTH_CAP; depth += 1) {
    const parent = join(current, '..')
    // 用目录列举探测 .git：目录式与 worktree 的文件式 .git 都算命中
    const entry = join(current, '.git')
    if (entryExists(entry)) return current
    if (parent === current) break
    current = parent
  }
  return cwd
}

/**
 * 探测路径是否存在（同步存在性判断，避免为一次 up-walk 引入异步瀑布）。
 * @author ddj 2026年10月30号
 * @param path 绝对路径
 * @returns 存在为 true
 */
function entryExists(path: string): boolean {
  try {
    // 只做存在性探测：statSync 对文件/目录/符号链接（跟随）都成立
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * 技能根目录（全局 + 当前工作区）。
 * @author ddj 2026年10月30号
 * @param cwd 当前工作区
 * @returns 两个根的绝对路径
 */
export function skillRootsOf(cwd?: string): SkillRoots {
  const projectRoot = projectRootOf(cwd)
  const project = projectRoot === undefined ? '' : join(projectRoot, '.dsh', 'skills')
  return { user: join(dshHome(), 'skills'), project, projectRoot }
}

/**
 * 扫描单个技能根（深度 1：<root>/<名>/SKILL.md 或 <root>/<名>.md）。
 * 目录缺失/读失败/frontmatter 非法 → 跳过该条（不抛、不返回半成品）。
 * @author ddj 2026年10月30号
 * @param dir 技能根目录
 * @param source 来源标记
 * @returns 通过校验的技能（按名字排序，受 SKILL_CATALOG_CAP 约束）
 */
async function listRootSkills(dir: string, source: SkillSource): Promise<SkillInfo[]> {
  if (dir === '') return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name)).slice(0, SKILL_CATALOG_CAP)
  const found: SkillInfo[] = []
  const seen = new Set<string>()
  for (const entry of ordered) {
    // 扁平式（<名>.md，含符号链接）优先按后缀判定，其余一律当目录式技能
    const file = entry.name.endsWith('.md') ? join(dir, entry.name) : join(dir, entry.name, SKILL_FILE)
    const info = await readSkillInfo(file, source).catch(() => undefined)
    if (info === undefined || seen.has(info.name)) continue
    seen.add(info.name)
    found.push(info)
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * 读取并解析单个技能文件。
 * @author ddj 2026年10月30号
 * @param file 技能文件绝对路径
 * @param source 来源标记
 * @returns 技能元信息；文件缺失/不可读/frontmatter 非法时 undefined
 */
async function readSkillInfo(file: string, source: SkillSource): Promise<SkillInfo | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const parsed = parseSkillMd(text)
  if (!isParsedSkill(parsed)) return undefined
  return { name: parsed.name, description: parsed.description, path: file, source }
}

/**
 * 枚举技能候选（全局 + 当前工作区；只读，永不抛）。
 * @author ddj 2026年10月30号
 * @param cwd 当前工作区（缺失时只枚举全局根）
 * @returns 技能候选快照
 */
export async function listSkillCatalog(cwd?: string): Promise<SkillCatalog> {
  const roots = skillRootsOf(cwd)
  const user = await listRootSkills(roots.user, 'user')
  const project = await listRootSkills(roots.project, 'project')
  return roots.projectRoot === undefined
    ? { user, project }
    : { user, project, projectRoot: roots.projectRoot }
}
