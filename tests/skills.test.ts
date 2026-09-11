/**
 * host skills.ts 测试：frontmatter 解析（纯）/ 前缀过滤（纯）/ 路径解析 /
 * 目录扫描与加载（tmpdir）/ 随包技能自检（拦 tarball 漏发 skills/）/ 挂载降级路径。
 * 作者 ddj 2026年09月11号
 */
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SKILL_PROVIDER_NAME,
  SKILL_PREFIXES,
  SKILL_DIR_CAP,
  hasGroupPrefix,
  installSkillGroup,
  isParsedSkill,
  listSkills,
  newSkillProvider,
  parseSkillMd,
  resetSkillGroup,
  skillGroupState,
} from '../src/skills.js'
import { skillsDirOf } from '../src/paths.js'

/** 归一化路径分隔符（CI 在 ubuntu 跑，禁止硬编码 Windows 反斜杠）。 */
const norm = (value: string): string => value.replace(/\\/g, '/')

/** 造一个临时技能组目录，返回 根目录 与 清理函数。 */
async function makeGroup(files: Record<string, string>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skills-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** 合法技能正文模板。 */
const skill = (name: string, extra = '', body = '正文内容\n'): string =>
  `---\nname: ${name}\ndescription: 描述 ${name}\n${extra}---\n\n${body}`

const created: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const cleanup of created) await cleanup()
})

// --region 纯函数：frontmatter 解析
describe('parseSkillMd', () => {
  it('标准 frontmatter：name/description/正文，缺省可见性皆 true', () => {
    const parsed = parseSkillMd(skill('dsh-vscodemode-demo', '', '   正文\n'))
    expect(isParsedSkill(parsed)).toBe(true)
    if (!isParsedSkill(parsed)) return
    expect(parsed.name).toBe('dsh-vscodemode-demo')
    expect(parsed.description).toBe('描述 dsh-vscodemode-demo')
    expect(parsed.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    // 正文整体 trim（与官方 provider 的 content: parsed.body.trim() 一致）
    expect(parsed.body).toBe('正文')
  })

  it('缺 frontmatter / 未闭合 / 首行非 --- → 拒绝', () => {
    expect(isParsedSkill(parseSkillMd('# 只是 markdown\n'))).toBe(false)
    expect(isParsedSkill(parseSkillMd('---\nname: dsh-vscodemode-a\n'))).toBe(false)
    expect(isParsedSkill(parseSkillMd('前置说明\n---\nname: dsh-vscodemode-a\ndescription: d\n---\n'))).toBe(false)
  })

  it('下划线技能名被拒（DSH 硬约束），大写与空名同样被拒', () => {
    const underscore = parseSkillMd(skill('dsh_vscodemode_mcp'))
    expect(isParsedSkill(underscore)).toBe(false)
    if (!isParsedSkill(underscore)) expect(underscore.error).toContain('kebab-case')
    expect(isParsedSkill(parseSkillMd(skill('Dsh-Vscodemode-Mcp')))).toBe(false)
    expect(isParsedSkill(parseSkillMd(skill('')))).toBe(false)
  })

  it('空 description 被拒', () => {
    const bad = parseSkillMd('---\nname: dsh-vscodemode-a\ndescription: ""\n---\nB\n')
    expect(isParsedSkill(bad)).toBe(false)
    if (!isParsedSkill(bad)) expect(bad.error).toContain('description')
  })

  it('whenToUse 可选带上', () => {
    const parsed = parseSkillMd(skill('dsh-vscodemode-a', 'whenToUse: 用户提到 MCP 时\n'))
    if (!isParsedSkill(parsed)) throw new Error('应解析成功')
    expect(parsed.whenToUse).toBe('用户提到 MCP 时')
  })

  it('可见性布尔：disable-model-invocation / user-invocable 各轴独立', () => {
    const model = parseSkillMd(skill('dsh-vscodemode-a', 'disable-model-invocation: true\n'))
    if (!isParsedSkill(model)) throw new Error('应解析成功')
    expect(model.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    const user = parseSkillMd(skill('dsh-vscodemode-a', 'user-invocable: false\n'))
    if (!isParsedSkill(user)) throw new Error('应解析成功')
    expect(user.invocation).toEqual({ modelInvocable: true, userInvocable: false })
  })

  it('布尔字面量宽容（yes/no/on/off/1/0，大小写不敏感）', () => {
    const yes = parseSkillMd(skill('dsh-vscodemode-a', 'disable-model-invocation: YES\n'))
    if (!isParsedSkill(yes)) throw new Error('应解析成功')
    expect(yes.invocation.modelInvocable).toBe(false)
    const off = parseSkillMd(skill('dsh-vscodemode-a', 'user-invocable: off\n'))
    if (!isParsedSkill(off)) throw new Error('应解析成功')
    expect(off.invocation.userInvocable).toBe(false)
  })

  it('非布尔字面量报错，不静默当默认值', () => {
    const bad = parseSkillMd(skill('dsh-vscodemode-a', 'disable-model-invocation: maybe\n'))
    expect(isParsedSkill(bad)).toBe(false)
    if (!isParsedSkill(bad)) expect(bad.error).toContain('布尔')
  })

  it('遗留驼峰键被拒并指向规范键（对齐官方语义）', () => {
    const legacy = parseSkillMd(skill('dsh-vscodemode-a', 'disableModelInvocation: true\n'))
    expect(isParsedSkill(legacy)).toBe(false)
    if (!isParsedSkill(legacy)) {
      expect(legacy.error).toContain('disableModelInvocation')
      expect(legacy.error).toContain('disable-model-invocation')
    }
    expect(isParsedSkill(parseSkillMd(skill('dsh-vscodemode-a', 'userInvocable: true\n')))).toBe(false)
  })

  it('CRLF 与 BOM 容错', () => {
    const crlf = parseSkillMd('\uFEFF---\r\nname: dsh-vscodemode-a\r\ndescription: d\r\n---\r\n正文\r\n')
    expect(isParsedSkill(crlf)).toBe(true)
    if (isParsedSkill(crlf)) expect(crlf.name).toBe('dsh-vscodemode-a')
  })

  it('引号值与块标量（| 与 >）', () => {
    const quoted = parseSkillMd('---\nname: "dsh-vscodemode-a"\ndescription: \'带 空格\'\n---\nB\n')
    if (!isParsedSkill(quoted)) throw new Error('应解析成功')
    expect(quoted.name).toBe('dsh-vscodemode-a')
    expect(quoted.description).toBe('带 空格')
    const literal = parseSkillMd(skill('dsh-vscodemode-a', 'whenToUse: |\n  第一行\n  第二行\n'))
    if (!isParsedSkill(literal)) throw new Error('应解析成功')
    expect(literal.whenToUse).toBe('第一行\n第二行')
    const folded = parseSkillMd(skill('dsh-vscodemode-a', 'whenToUse: >\n  第一行\n  第二行\n'))
    if (!isParsedSkill(folded)) throw new Error('应解析成功')
    expect(folded.whenToUse).toBe('第一行 第二行')
  })
})
// --endregion

// --region 纯函数：前缀白名单
describe('hasGroupPrefix', () => {
  it('只认 dsh-vscodemode- 前缀', () => {
    expect(SKILL_PREFIXES[0]).toBe('dsh-vscodemode-')
    expect(hasGroupPrefix('dsh-vscodemode-mcp')).toBe(true)
    expect(hasGroupPrefix('dsh-vscode-mode-dev')).toBe(false)
    expect(hasGroupPrefix('modsearch')).toBe(false)
    expect(hasGroupPrefix('')).toBe(false)
  })
})
// --endregion

// --region 路径解析
describe('skillsDirOf', () => {
  it('由 lib/index.js 派生到包根 skills/', () => {
    const dir = skillsDirOf('file:///D:/pkg/lib/index.js')
    expect(norm(dir)).toBe('D:/pkg/skills')
  })

  it('随包 skills/ 目录与 provider 常量可用', () => {
    expect(SKILL_PROVIDER_NAME).toBe('dsh-vscodemode')
    // 常量护栏：provider 名不得撞官方 'filesystem' 与保留名 'runtime'
    expect(SKILL_PROVIDER_NAME).not.toBe('filesystem')
    expect(SKILL_PROVIDER_NAME).not.toBe('runtime')
    expect(SKILL_DIR_CAP).toBeGreaterThan(0)
  })
})
// --endregion

// --region 目录扫描与加载（tmpdir）
describe('listSkills / provider', () => {
  const noopControl = { signal: new AbortController().signal, invalidate: () => {} }

  it('目录式与扁平式都能发现；非前缀被跳过', async () => {
    const group = await makeGroup({
      'dsh-vscodemode-alpha/SKILL.md': skill('dsh-vscodemode-alpha'),
      'dsh-vscodemode-flat.md': skill('dsh-vscodemode-flat'),
      'other-b/SKILL.md': skill('other-b'),
    })
    created.push(group.cleanup)
    const found = await listSkills(group.dir)
    expect(found.map((item) => item.name).sort()).toEqual(['dsh-vscodemode-alpha', 'dsh-vscodemode-flat'])
  })

  it('候选契约满足 registry 校验：provider/rank/source/invocation/path', async () => {
    const group = await makeGroup({ 'dsh-vscodemode-a/SKILL.md': skill('dsh-vscodemode-a') })
    created.push(group.cleanup)
    const [candidate] = await listSkills(group.dir)
    expect(candidate.provider).toBe(SKILL_PROVIDER_NAME)
    expect(Number.isFinite(candidate.rank)).toBe(true)
    expect(candidate.source).toBe('bundled')
    expect(typeof candidate.invocation.modelInvocable).toBe('boolean')
    expect(typeof candidate.invocation.userInvocable).toBe('boolean')
    expect(norm(candidate.path ?? '')).toMatch(/dsh-vscodemode-a\/SKILL\.md$/)
    // 目录式技能的资源基址 = 技能目录（供正文相对路径解析）
    expect(candidate.resourceBase).toEqual({ kind: 'directory', path: join(group.dir, 'dsh-vscodemode-a') })
  })

  it('目录不存在 → 空数组，不抛', async () => {
    await expect(listSkills(join(tmpdir(), 'dsh-skills-absent-' + Date.now()))).resolves.toEqual([])
  })

  it('损坏/无 frontmatter 的文件被跳过，其余仍可用', async () => {
    const group = await makeGroup({
      'dsh-vscodemode-good/SKILL.md': skill('dsh-vscodemode-good'),
      'dsh-vscodemode-bad/SKILL.md': '# 没有 frontmatter\n',
      'dsh-vscodemode-under/SKILL.md': skill('dsh_vscodemode_under'),
    })
    created.push(group.cleanup)
    const found = await listSkills(group.dir)
    expect(found.map((item) => item.name)).toEqual(['dsh-vscodemode-good'])
  })

  it('根目录裸 .md（无 frontmatter）不会产出候选', async () => {
    const group = await makeGroup({
      'README.md': '# 说明文档\n',
      'dsh-vscodemode-a/SKILL.md': skill('dsh-vscodemode-a'),
    })
    created.push(group.cleanup)
    const found = await listSkills(group.dir)
    expect(found.map((item) => item.name)).toEqual(['dsh-vscodemode-a'])
  })

  it('provider.get 返回完整正文；文件消失 → undefined', async () => {
    const group = await makeGroup({ 'dsh-vscodemode-a/SKILL.md': skill('dsh-vscodemode-a', '', '正文 A\n') })
    created.push(group.cleanup)
    const provider = newSkillProvider(group.dir, noopControl)
    expect(provider.name).toBe(SKILL_PROVIDER_NAME)
    const [candidate] = await provider.list()
    const definition = await provider.get(candidate)
    expect(definition?.content).toBe('正文 A')
    await rm(join(group.dir, 'dsh-vscodemode-a', 'SKILL.md'), { force: true })
    await expect(provider.get(candidate)).resolves.toBeUndefined()
  })

  it('provider.get 在名字被改后返回 undefined（让 registry 失效缓存）', async () => {
    const group = await makeGroup({ 'dsh-vscodemode-a/SKILL.md': skill('dsh-vscodemode-a') })
    created.push(group.cleanup)
    const provider = newSkillProvider(group.dir, noopControl)
    const [candidate] = await provider.list()
    await writeFile(join(group.dir, 'dsh-vscodemode-a', 'SKILL.md'), skill('dsh-vscodemode-renamed'), 'utf8')
    await expect(provider.get(candidate)).resolves.toBeUndefined()
  })
})
// --endregion

// --region 随包技能自检（拦 tarball 漏发 skills/）
describe('随包技能组', () => {
  it('skills/ 下至少一个合法技能，且都能被 provider 发现', async () => {
    const dir = skillsDirOf(import.meta.url)
    const found = await listSkills(dir)
    expect(found.length).toBeGreaterThan(0)
    for (const candidate of found) {
      expect(hasGroupPrefix(candidate.name)).toBe(true)
      expect(candidate.description.length).toBeGreaterThan(0)
      expect(candidate.provider).toBe(SKILL_PROVIDER_NAME)
    }
  })

  it('dsh-vscodemode-mcp 存在且正文非空、覆盖 MCP 关键面', async () => {
    const dir = skillsDirOf(import.meta.url)
    const found = await listSkills(dir)
    const mcp = found.find((item) => item.name === 'dsh-vscodemode-mcp')
    expect(mcp, '缺少 skills/dsh-vscodemode-mcp/SKILL.md（或 package.json files 漏发 skills/）').toBeDefined()
    if (!mcp) return
    const control = { signal: new AbortController().signal, invalidate: () => {} }
    const definition = await newSkillProvider(dir, control).get(mcp)
    const content = definition?.content ?? ''
    expect(content.length).toBeGreaterThan(500)
    // 关键事实必须写在技能里（源码变更时这些断言先失败，提醒同步技能）
    for (const needle of ['mcp.list', 'mcp.projectSave', '.mcp.json', 'mcp__', 'streamable-http', 'serverName']) {
      expect(content, '技能正文缺少关键面：' + needle).toContain(needle)
    }
  })
})
// --endregion

// --region 装配与降级
describe('installSkillGroup', () => {
  it('无 ctx.inject（旧版 DSH）→ false 且不抛，状态记录原因', () => {
    resetSkillGroup()
    expect(installSkillGroup({} as never, 'X:/skills')).toBe(false)
    const state = skillGroupState()
    expect(state.dispatched).toBe(false)
    expect(state.mounted).toBe(false)
    expect(state.note).toContain('ctx.inject')
  })

  it('有 inject → 已调度，回调注册 provider 后状态为已挂载', () => {
    resetSkillGroup()
    let registered: unknown
    const ctx = {
      inject: (_services: string[], callback: (sctx: unknown) => void) => {
        callback({ get: (name: string) => (name === 'skills' ? { registerProvider: (create: unknown) => { registered = create } } : undefined) })
      },
    }
    expect(installSkillGroup(ctx as never, 'X:/skills')).toBe(true)
    expect(registered).toBeTypeOf('function')
    const state = skillGroupState()
    expect(state.dispatched).toBe(true)
    expect(state.mounted).toBe(true)
    expect(state.dir).toBe('X:/skills')
  })

  it('skills 服务缺失（回调给出空上下文）→ 降级未挂载，不抛', () => {
    resetSkillGroup()
    const ctx = { inject: (_services: string[], callback: (sctx: unknown) => void) => callback({}) }
    expect(installSkillGroup(ctx as never, 'X:/skills')).toBe(true)
    const state = skillGroupState()
    expect(state.dispatched).toBe(true)
    expect(state.mounted).toBe(false)
    expect(state.note).toContain('skills 服务不可用')
  })

  it('registerProvider 抛错（同层重名）→ 捕获为未挂载，不冒泡', () => {
    resetSkillGroup()
    const ctx = {
      inject: (_services: string[], callback: (sctx: unknown) => void) =>
        callback({ get: () => ({ registerProvider: () => { throw new Error('provider 已注册') } }) }),
    }
    expect(() => installSkillGroup(ctx as never, 'X:/skills')).not.toThrow()
    const state = skillGroupState()
    expect(state.mounted).toBe(false)
    expect(state.note).toContain('provider 注册失败')
  })

  it('inject 自身抛错 → 返回 false 且不抛', () => {
    resetSkillGroup()
    const ctx = { inject: () => { throw new Error('inject 不可用') } }
    expect(installSkillGroup(ctx as never, 'X:/skills')).toBe(false)
    expect(skillGroupState().note).toContain('挂载调度失败')
  })

  it('skillGroupState 返回副本（外部改写不影响内部）', () => {
    resetSkillGroup()
    const snapshot = skillGroupState()
    snapshot.mounted = true
    expect(skillGroupState().mounted).toBe(false)
  })
})
// --endregion
