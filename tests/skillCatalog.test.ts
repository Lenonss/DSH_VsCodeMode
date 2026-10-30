/**
 * host skillCatalog.ts + shared/skillCatalog.ts 测试：技能候选枚举与来源分组。
 *
 * 覆盖三条容易回归的语义：
 * - 只认 DSH 的两类技能根（$DSH_HOME/skills 与 <projectRoot>/.dsh/skills），
 *   目录式 <名>/SKILL.md 与扁平式 <名>.md 都要能读；
 * - frontmatter 非法（下划线名、空描述）必须被跳过，而不是带病出现在下拉里；
 * - 分组顺序固定为「全局技能」在前、「当前工作区技能」在后，空组不出现。
 * 作者 ddj 2026年10月30号
 */
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { groupSkills, SKILL_SOURCE_LABEL } from '../src/shared/skillCatalog.js'
import { listSkillCatalog, projectRootOf, skillRootsOf } from '../src/skillCatalog.js'
import type { SkillInfo } from '../src/shared/skillCatalog.js'

/** 归一化路径分隔符（CI 在 ubuntu 跑，禁止硬编码 Windows 反斜杠）。 */
const norm = (value: string): string => value.replace(/\\/g, '/')

/** 合法技能正文模板（frontmatter 必须含 kebab-case name 与非空 description）。 */
const skill = (name: string): string => `---\nname: ${name}\ndescription: 描述 ${name}\n---\n\n正文\n`

const created: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const cleanup of created) await cleanup()
})

/**
 * 造临时目录并写入文件（键为相对路径）。
 * @author ddj 2026年10月30号
 * @param files 相对路径到内容的映射
 * @returns 根目录与清理函数
 */
async function makeTree(files: Record<string, string>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skillcat-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  const cleanup = () => rm(dir, { recursive: true, force: true })
  created.push(cleanup)
  return { dir, cleanup }
}

/**
 * 造一条技能元信息（只覆盖断言需要的字段）。
 * @author ddj 2026年10月30号
 * @param name 技能名
 * @param source 来源
 * @returns 技能元信息
 */
function info(name: string, source: 'user' | 'project'): SkillInfo {
  return { name, description: '描述 ' + name, path: '/x/' + name, source }
}

describe('groupSkills', () => {
  it('快照缺失或全空时不返回任何分组', () => {
    expect(groupSkills(null)).toEqual([])
    expect(groupSkills(undefined)).toEqual([])
    expect(groupSkills({ user: [], project: [] })).toEqual([])
  })

  it('只有工作区技能时只出现该组', () => {
    const groups = groupSkills({ user: [], project: [info('gamma', 'project')] })
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('project')
    expect(groups[0].label).toBe(SKILL_SOURCE_LABEL.project)
  })

  it('两类都有时全局技能在前', () => {
    const groups = groupSkills({ user: [info('alpha', 'user')], project: [info('gamma', 'project')] })
    expect(groups.map((group) => group.key)).toEqual(['user', 'project'])
    expect(groups.map((group) => group.label)).toEqual(['全局技能', '当前工作区技能'])
  })
})

describe('projectRootOf', () => {
  it('从子目录向上找到含 .git 的祖先', async () => {
    const tree = await makeTree({ '.git/HEAD': 'ref: refs/heads/main\n', 'pkg/src/keep.txt': 'x' })
    const nested = join(tree.dir, 'pkg', 'src')
    expect(norm(projectRootOf(nested) ?? '')).toBe(norm(tree.dir))
  })

  it('找不到 .git 时回落起点目录（不抛、不返回 undefined）', async () => {
    const tree = await makeTree({ 'keep.txt': 'x' })
    const found = projectRootOf(tree.dir)
    expect(found).toBeDefined()
    // 兜底值必须是 cwd 自身或它的祖先，绝不能跳到无关目录
    expect(norm(tree.dir).startsWith(norm(found ?? ''))).toBe(true)
  })

  it('cwd 缺失时返回 undefined', () => {
    expect(projectRootOf(undefined)).toBeUndefined()
    expect(projectRootOf('')).toBeUndefined()
  })
})

describe('skillRootsOf', () => {
  it('全局根固定为 $DSH_HOME/skills，工作区根为 <projectRoot>/.dsh/skills', async () => {
    const home = await makeTree({ 'keep.txt': 'x' })
    const tree = await makeTree({ '.git/HEAD': 'ref: refs/heads/main\n' })
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home.dir
    try {
      const roots = skillRootsOf(join(tree.dir, 'pkg'))
      expect(norm(roots.user)).toBe(norm(join(home.dir, 'skills')))
      expect(norm(roots.project)).toBe(norm(join(tree.dir, '.dsh', 'skills')))
      expect(norm(roots.projectRoot ?? '')).toBe(norm(tree.dir))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('listSkillCatalog', () => {
  it('枚举两类技能根，跳过非法 frontmatter，并区分目录式与扁平式', async () => {
    const home = await makeTree({
      'skills/alpha/SKILL.md': skill('alpha'),
      'skills/beta.md': skill('beta'),
      'skills/bad_name.md': skill('bad_name'),
    })
    const tree = await makeTree({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.dsh/skills/gamma/SKILL.md': skill('gamma'),
    })
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home.dir
    try {
      const catalog = await listSkillCatalog(join(tree.dir, 'pkg'))
      expect(catalog.user.map((entry) => entry.name)).toEqual(['alpha', 'beta'])
      expect(catalog.project.map((entry) => entry.name)).toEqual(['gamma'])
      expect(catalog.user.every((entry) => entry.source === 'user')).toBe(true)
      expect(catalog.project.every((entry) => entry.source === 'project')).toBe(true)
      expect(norm(catalog.projectRoot ?? '')).toBe(norm(tree.dir))

      const flat = catalog.user.find((entry) => entry.name === 'beta')
      expect(norm(flat?.path ?? '')).toMatch(/skills\/beta\.md$/)
      const nested = catalog.user.find((entry) => entry.name === 'alpha')
      expect(norm(nested?.path ?? '')).toMatch(/skills\/alpha\/SKILL\.md$/)
      expect(nested?.description).toBe('描述 alpha')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('目录都不存在时返回两个空数组（非错误），cwd 缺失时不给 projectRoot', async () => {
    const home = await makeTree({ 'keep.txt': 'x' })
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home.dir
    try {
      const catalog = await listSkillCatalog(undefined)
      expect(catalog.user).toEqual([])
      expect(catalog.project).toEqual([])
      expect('projectRoot' in catalog).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
