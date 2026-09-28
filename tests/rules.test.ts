/**
 * host rules.ts 测试：frontmatter 解析（纯）/ 类型推导 / 文件名校验 / 开关改写（纯）/
 * 注入渲染（纯，含截断预算）/ IO（tmpdir：列表/读写/删/开关/注入 section 装配）。
 * 作者 ddj 2026年09月03号
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseRuleMdc, ruleTypeOf, validateRuleFile, toggleEnabledLine,
  renderRulesSection, rulesList, rulesRead, rulesSave, rulesRemove, rulesToggle,
  installRulesSection, projectRulesDir, userRulesDir, userRuleDirs, listUserRules, readUserRulesSync,
  type LoadedRule, type UserRulesDirs,
} from '../src/rules.js'

// --region 纯函数：解析与类型
describe('parseRuleMdc', () => {
  it('标准 frontmatter：description/alwaysApply/enabled 缺省 true', () => {
    const parsed = parseRuleMdc('---\ndescription: 码风规范\nalwaysApply: true\n---\n\n正文A\n')
    expect(parsed.description).toBe('码风规范')
    expect(parsed.alwaysApply).toBe(true)
    expect(parsed.enabled).toBe(true)
    expect(parsed.body).toBe('\n正文A\n')
    expect(parsed.error).toBeUndefined()
  })

  it('无 frontmatter → 全文正文 / enabled true / 手动', () => {
    const parsed = parseRuleMdc('# 只是 markdown\n')
    expect(parsed.body).toBe('# 只是 markdown\n')
    expect(parsed.alwaysApply).toBe(false)
    expect(parsed.enabled).toBe(true)
  })

  it('无闭合 --- → 整体当正文（不误吞）', () => {
    const text = '---\ndescription: 半截\n没有结束'
    const parsed = parseRuleMdc(text)
    expect(parsed.body).toBe(text)
    expect(parsed.description).toBe('')
  })

  it('globs 内联逗号串 + 引号去除', () => {
    const parsed = parseRuleMdc('---\ndescription: d\nglobs: "*.ts, *.tsx"\n---\nB')
    expect(parsed.globs).toEqual(['*.ts', '*.tsx'])
    expect(ruleTypeOf(parsed)).toBe('auto')
  })

  it('globs YAML 短横列表', () => {
    const parsed = parseRuleMdc('---\nglobs:\n  - "*.lua"\n  - "*.ts"\n---\nB')
    expect(parsed.globs).toEqual(['*.lua', '*.ts'])
  })

  it('enabled: false 显式停用；非 false 值视为启用', () => {
    expect(parseRuleMdc('---\nenabled: false\n---\nB').enabled).toBe(false)
    expect(parseRuleMdc('---\nenabled: true\n---\nB').enabled).toBe(true)
    expect(parseRuleMdc('---\nenabled: yes\n---\nB').enabled).toBe(true)
  })

  it('类型映射：always / auto(globs) / manual', () => {
    expect(ruleTypeOf(parseRuleMdc('---\nalwaysApply: true\n---\nB'))).toBe('always')
    expect(ruleTypeOf(parseRuleMdc('---\nglobs: "*.ts"\n---\nB'))).toBe('auto')
    expect(ruleTypeOf(parseRuleMdc('---\n---\nB'))).toBe('manual')
    expect(ruleTypeOf(parseRuleMdc('纯正文'))).toBe('manual')
  })
})

describe('validateRuleFile', () => {
  it('合法名通过（返回 null）', () => {
    expect(validateRuleFile('my-rule.mdc')).toBeNull()
    expect(validateRuleFile('Code_Style_v2.mdc')).toBeNull()
  })

  it('非法名拒绝：路径穿越 / 空扩展 / 其它后缀 / 保留设备名', () => {
    expect(validateRuleFile('../evil.mdc')).not.toBeNull()
    expect(validateRuleFile('a\\b.mdc')).not.toBeNull()
    expect(validateRuleFile('noext')).not.toBeNull()
    expect(validateRuleFile('x.txt')).not.toBeNull()
    expect(validateRuleFile('CON.mdc')).not.toBeNull()
  })
})

describe('toggleEnabledLine', () => {
  const base = '---\ndescription: d\nalwaysApply: true\n---\n正文'

  it('已有 enabled 行原位改写，其余内容零改动', () => {
    const text = '---\ndescription: d\nenabled: true\n---\n正文'
    const next = toggleEnabledLine(text, false)
    expect(next).toBe('---\ndescription: d\nenabled: false\n---\n正文')
  })

  it('无 enabled 行插入到 frontmatter 首行之后', () => {
    const next = toggleEnabledLine(base, false)
    expect(next?.startsWith('---\nenabled: false\ndescription: d')).toBe(true)
  })

  it('CRLF 保留（插入行同样使用 CRLF）', () => {
    const crlf = base.replace(/\n/g, '\r\n')
    const next = toggleEnabledLine(crlf, true)
    expect(next).toBe('---\r\nenabled: true\r\ndescription: d\r\nalwaysApply: true\r\n---\r\n正文')
  })

  it('无 frontmatter 返回 null', () => {
    expect(toggleEnabledLine('纯正文', true)).toBeNull()
    expect(toggleEnabledLine('---\n没闭合', true)).toBeNull()
  })
})
// --endregion

// --region 纯函数：注入渲染
/** 构造测试用已加载规则。 */
function loaded(file: string, type: LoadedRule['info']['type'], body: string, opts?: Partial<LoadedRule['info']>): LoadedRule {
  return {
    info: {
      scope: 'user', file, absPath: join('~/rules', file), relHint: 'rules/',
      description: '描述-' + file, type, globs: type === 'auto' ? ['*.ts'] : [], enabled: true,
      size: body.length, mtime: 0, ...opts,
    },
    body,
  }
}

describe('renderRulesSection', () => {
  it('空列表输出空串', () => {
    expect(renderRulesSection([], [])).toBe('')
  })

  it('三类型分段：总是全文 / 自动带条件 / 手动仅索引行', () => {
    const user = [loaded('a.mdc', 'always', 'AAA'), loaded('b.mdc', 'auto', 'BBB'), loaded('c.mdc', 'manual', 'CCC')]
    const text = renderRulesSection(user, [])
    expect(text).toContain('## 用户规则')
    expect(text).toContain('### 总是生效')
    expect(text).toContain('AAA')
    expect(text).toContain('### 按文件匹配生效')
    expect(text).toContain('当处理匹配 *.ts 的文件时应用')
    expect(text).toContain('BBB')
    expect(text).toContain('### 可按需读取')
    expect(text).toContain('- c.mdc — 描述-c.mdc（路径: ')
    // 手动规则正文不注入
    expect(text).not.toContain('\nCCC')
  })

  it('enabled=false 与解析错误规则被排除', () => {
    const user = [loaded('off.mdc', 'always', 'OFF', { enabled: false }), loaded('bad.mdc', 'always', 'BAD', { error: '解析失败' })]
    const text = renderRulesSection(user, [])
    expect(text).toBe('')
  })

  it('项目段仅在带 workspacePath 时渲染', () => {
    const project = [loaded('p.mdc', 'always', 'PPP')]
    expect(renderRulesSection([], project)).toBe('')
    const text = renderRulesSection([], project, 'D:/ws')
    expect(text).toContain('项目规则（工作区 D:/ws')
    expect(text).toContain('PPP')
  })

  it('单条正文超 16KB 截断；总预算超限省略并留说明', () => {
    const big = loaded('big.mdc', 'always', 'X'.repeat(17 * 1024))
    const many = Array.from({ length: 6 }, (_, i) => loaded('m' + i + '.mdc', 'always', 'Y'.repeat(14 * 1024)))
    const text = renderRulesSection([big], [])
    expect(text).toContain('规则正文超长已截断')
    expect(text.length).toBeLessThan(17 * 1024 + 500)
    const text2 = renderRulesSection(many, [])
    expect(text2).toContain('部分规则因总长度预算被省略')
  })
})
// --endregion

// --region IO（tmpdir + mock ctx）
let home = ''
let projectA = ''
let testDirs: UserRulesDirs
/** 项目写盘捕获（ctx fs mock）。 */
const written = new Map<string, string>()

/** 构造最小 mock ctx（fs / sandboxPolicy / workspaceRegistry）。 */
function mockCtx(withWorkspace: boolean): any {
  return {
    get(name: string) {
      if (name === 'fs') {
        return {
          resolve: async (p: string, o: { cwd: string }) => join(o.cwd, p),
          // 模拟真实 provider：写盘落磁盘（捕获副本供断言），读盘直读磁盘
          writeText: async (t: string, c: string) => { written.set(t, c); await writeFile(t, c, 'utf8') },
          readText: async (t: string) => readFile(t, 'utf8'),
        }
      }
      if (name === 'sandboxPolicy') return { resolve: (r: { mode: string }) => ({ mode: r.mode }) }
      if (name === 'workspaceRegistry') return { list: () => (withWorkspace ? [{ path: projectA, title: '项目A' }] : []) }
      return undefined
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'edrv-rules-'))
  projectA = join(home, 'projA')
  testDirs = { current: join(home, 'rules'), legacy: join(home, 'isolated-legacy', 'rules') }
  process.env.DSH_HOME = home
  await mkdir(projectA, { recursive: true })
})

afterAll(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('rules IO（用户域）', () => {
  it('save → list → read → toggle → remove 全链路', async () => {
    const ctx = mockCtx(false)
    const content = '---\ndescription: 测试规则\nalwaysApply: true\n---\n规则正文'
    const saved = await rulesSave(ctx, { scope: 'user', file: 'alpha.mdc', content })
    expect(saved.type).toBe('always')
    expect(saved.enabled).toBe(true)
    expect(saved.absPath).toBe(join(userRulesDir(), 'alpha.mdc'))

    const list = await rulesList(ctx, testDirs)
    expect(list.user.map((r) => r.file)).toContain('alpha.mdc')
    expect(await rulesRead(ctx, { scope: 'user', file: 'alpha.mdc' })).toBe(content)

    const toggled = await rulesToggle(ctx, { scope: 'user', file: 'alpha.mdc' }, false)
    expect(toggled.enabled).toBe(false)
    expect(await readFile(join(home, 'rules', 'alpha.mdc'), 'utf8')).toContain('enabled: false')
    expect(await readFile(join(home, 'rules', 'alpha.mdc'), 'utf8')).toContain('alwaysApply: true')

    await rulesRemove(ctx, { scope: 'user', file: 'alpha.mdc' })
    expect(existsSync(join(home, 'rules', 'alpha.mdc'))).toBe(false)
  })

  it('save 非法文件名拒绝；toggle 无 frontmatter 拒绝', async () => {
    const ctx = mockCtx(false)
    await expect(rulesSave(ctx, { scope: 'user', file: '../evil.mdc', content: 'x' })).rejects.toThrow()
    const plain = join(home, 'rules', 'plain.mdc')
    await mkdir(join(home, 'rules'), { recursive: true })
    await writeFile(plain, '纯正文', 'utf8')
    await expect(rulesToggle(ctx, { scope: 'user', file: 'plain.mdc' }, false)).rejects.toThrow('frontmatter')
  })

  it('list 目录缺失返回空而非报错', async () => {
    const list = await rulesList(mockCtx(false), testDirs)
    expect(Array.isArray(list.user)).toBe(true)
    expect(Array.isArray(list.projects)).toBe(true)
  })
})

describe('双目录用户规则', () => {
  const ctx = mockCtx(false)
  const activeHome = join('dual', 'active')
  const systemHome = join('dual', 'system')
  const always = (body: string, enabled = true) => `---\nalwaysApply: true\nenabled: ${enabled}\n---\n${body}`
  const dirs = () => userRuleDirs(join(home, activeHome), join(home, systemHome))

  it('目录相同时不重复加载，只有旧目录存在时列表与注入均读取旧规则', async () => {
    expect(userRuleDirs(join(home, systemHome, '.dsh'), join(home, systemHome)).legacy).toBeUndefined()
    const paths = dirs()
    await mkdir(paths.legacy!, { recursive: true })
    await writeFile(join(paths.legacy!, 'old.mdc'), always('旧规则正文'), 'utf8')
    const list = await rulesList(ctx, paths)
    expect(list.user.map((rule) => [rule.file, rule.origin])).toEqual([['old.mdc', 'legacy']])
    expect(list.user[0].absPath).toBe(join(paths.legacy!, 'old.mdc'))
    expect(await rulesRead(ctx, { scope: 'user', origin: 'legacy', file: 'old.mdc' }, paths)).toContain('旧规则正文')
    expect(renderRulesSection(readUserRulesSync(paths), [])).toContain('旧规则正文')
    let provider: ((asm: unknown) => string) | undefined
    const spCtx = { ...ctx, get: (name: string) => name === 'systemPrompt'
      ? { section: (section: { text: typeof provider }) => { provider = section.text; return () => {} } }
      : undefined }
    expect(installRulesSection(spCtx, paths)).toBe(true)
    expect(provider!({})).toContain('旧规则正文')
  })

  it('当前目录同名优先，禁用当前版也遮蔽旧版；删除后旧版重新生效', async () => {
    const paths = dirs()
    await mkdir(paths.current, { recursive: true })
    await writeFile(join(paths.legacy!, 'same.mdc'), always('旧版正文'), 'utf8')
    await writeFile(join(paths.current, 'same.mdc'), always('当前正文', false), 'utf8')
    await writeFile(join(paths.current, 'new.mdc'), always('独有规则'), 'utf8')
    const list = await listUserRules(paths)
    expect(list.map((rule) => [rule.file, rule.origin])).toEqual([
      ['new.mdc', 'current'], ['old.mdc', 'legacy'], ['same.mdc', 'current'],
    ])
    const injected = renderRulesSection(readUserRulesSync(paths), [])
    expect(injected).toContain('旧规则正文')
    expect(injected).toContain('独有规则')
    expect(injected).not.toContain('旧版正文')
    expect(injected).not.toContain('当前正文')
    await rulesRemove(ctx, { scope: 'user', origin: 'current', file: 'same.mdc' }, paths)
    expect((await listUserRules(paths)).find((rule) => rule.file === 'same.mdc')?.origin).toBe('legacy')
    expect(renderRulesSection(readUserRulesSync(paths), [])).toContain('旧版正文')
  })

  it('文件名大小写的遮蔽语义与宿主平台一致', async () => {
    const paths = userRuleDirs(join(home, 'case', 'active'), join(home, 'case', 'system'))
    await mkdir(paths.current, { recursive: true })
    await mkdir(paths.legacy!, { recursive: true })
    await writeFile(join(paths.current, 'Case.mdc'), always('当前大小写规则'), 'utf8')
    await writeFile(join(paths.legacy!, 'case.mdc'), always('旧版大小写规则'), 'utf8')
    const listed = await listUserRules(paths)
    const injected = readUserRulesSync(paths)
    const expected = process.platform === 'win32' ? 1 : 2
    expect(listed).toHaveLength(expected)
    expect(injected).toHaveLength(expected)
    if (process.platform === 'win32') expect(injected[0].body).not.toContain('旧版大小写规则')
  })

  it('旧规则的保存、开关、删除只作用于旧目录，新规则默认写当前目录', async () => {
    const paths = dirs()
    const ref = { scope: 'user' as const, origin: 'legacy' as const, file: 'edit.mdc' }
    const saved = await rulesSave(ctx, { ...ref, content: always('旧目录编辑') }, paths)
    expect(saved.origin).toBe('legacy')
    expect(saved.absPath).toBe(join(paths.legacy!, ref.file))
    expect(await rulesRead(ctx, ref, paths)).toContain('旧目录编辑')
    expect(existsSync(join(paths.current, ref.file))).toBe(false)
    expect((await rulesToggle(ctx, ref, false, paths)).origin).toBe('legacy')
    expect(await readFile(saved.absPath, 'utf8')).toContain('enabled: false')
    await rulesSave(ctx, { scope: 'user', file: 'fresh.mdc', content: always('新规则') }, paths)
    expect(existsSync(join(paths.current, 'fresh.mdc'))).toBe(true)
    await rulesRemove(ctx, ref, paths)
    expect(existsSync(saved.absPath)).toBe(false)
    expect(existsSync(join(paths.current, 'fresh.mdc'))).toBe(true)
  })

  it('缺失目录为空；非法来源和文件名拒绝；非缺失目录错误不被吞掉', async () => {
    const paths = { current: join(home, 'absent-active'), legacy: join(home, 'absent-legacy') }
    expect(await listUserRules(paths)).toEqual([])
    expect(readUserRulesSync(paths)).toEqual([])
    const bad = { scope: 'user' as const, file: 'old.mdc', origin: 'arbitrary' as any }
    await expect(rulesRead(ctx, bad, paths)).rejects.toThrow('来源')
    await expect(rulesSave(ctx, { ...bad, content: 'x' }, paths)).rejects.toThrow('来源')
    await expect(rulesRemove(ctx, bad, paths)).rejects.toThrow('来源')
    await expect(rulesToggle(ctx, bad, false, paths)).rejects.toThrow('来源')
    await expect(rulesRemove(ctx, { scope: 'user', origin: 'legacy', file: '../x.mdc' }, paths)).rejects.toThrow('文件名')
    await expect(rulesRead(ctx, { scope: 'user', file: '../x.mdc' }, paths)).rejects.toThrow('文件名')
    await expect(rulesSave(ctx, { scope: 'project', origin: 'legacy', workspacePath: projectA, file: 'p.mdc', content: 'x' }, paths)).rejects.toThrow('项目规则不能指定')
    const invalidDir = join(home, 'not-a-directory')
    await writeFile(invalidDir, 'x', 'utf8')
    await expect(listUserRules({ current: invalidDir })).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(() => readUserRulesSync({ current: invalidDir })).toThrow()
  })
})

describe('rules IO（项目域）', () => {
  it('未注册 workspace 拒绝写入', async () => {
    await expect(rulesSave(mockCtx(false), { scope: 'project', workspacePath: projectA, file: 'p.mdc', content: 'x' })).rejects.toThrow('未注册')
  })

  it('已注册 workspace：mkdir + ctx fs 写盘（fullPolicy），list 可见', async () => {
    const ctx = mockCtx(true)
    const saved = await rulesSave(ctx, { scope: 'project', workspacePath: projectA, file: 'proj-rule.mdc', content: '---\ndescription: 项目规则\nalwaysApply: true\n---\nP' })
    expect(saved.scope).toBe('project')
    expect(saved.relHint).toBe('.dsh/rules/')
    const key = [...written.keys()].find((k) => k.endsWith('proj-rule.mdc'))
    expect(key).toBeDefined()
    expect(written.get(key!)).toContain('项目规则')
    expect(existsSync(projectRulesDir(projectA))).toBe(true)

    const list = await rulesList(ctx, testDirs)
    const proj = list.projects.find((p) => p.workspacePath === projectA)
    expect(proj?.title).toBe('项目A')
    expect(proj?.rules.map((r) => r.file)).toContain('proj-rule.mdc')

    const toggled = await rulesToggle(ctx, { scope: 'project', workspacePath: projectA, file: 'proj-rule.mdc' }, false)
    expect(toggled.enabled).toBe(false)
    const writtenAgain = [...written.entries()].find(([k]) => k.endsWith('proj-rule.mdc'))!
    expect(writtenAgain[1]).toContain('enabled: false')
  })

  it('无 .dsh/rules 的已注册工作区 → missingDir 标记', async () => {
    const list = await rulesList(mockCtx(true), testDirs)
    // projectA 在上一用例已建目录；另造一个无规则目录的注册项验证 missingDir
    const bare = join(home, 'projBare')
    await mkdir(bare, { recursive: true })
    const ctx = mockCtx(false)
    ctx.get = (name: string) => (name === 'workspaceRegistry' ? { list: () => [{ path: bare, title: 'Bare' }] } : undefined)
    const list2 = await rulesList(ctx, testDirs)
    expect(list2.projects[0]?.missingDir).toBe(true)
  })
})

describe('installRulesSection', () => {
  it('无 systemPrompt 服务 → false 不抛错', () => {
    expect(installRulesSection({ get: () => undefined, effect: () => () => {} })).toBe(false)
  })

  it('注册 section 且 provider 按会话 cwd 注入项目规则；provider 异常返回空串', async () => {
    const ctx = mockCtx(true)
    const ruleDir = projectRulesDir(projectA)
    await mkdir(ruleDir, { recursive: true })
    await writeFile(join(ruleDir, 'inj.mdc'), '---\ndescription: 注入测试\nalwaysApply: true\n---\n注入正文', 'utf8')
    let captured: { name: string; order: number; text: unknown } | null = null
    ctx.get = (name: string) => {
      if (name === 'systemPrompt') return { section: (s: typeof captured) => { captured = s; return () => {} } }
      if (name === 'sessions') return { get: (id: string) => (id === 's1' ? { header: { cwd: projectA } } : undefined) }
      if (name === 'workspaceRegistry') return { list: () => [{ path: projectA, title: 'A' }] }
      return undefined
    }
    expect(installRulesSection(ctx, testDirs)).toBe(true)
    expect(captured!.name).toBe('dsh-vscode-mode:rules')
    expect(captured!.order).toBe(400)
    const provider = captured!.text as (asm: unknown) => string
    const text = provider({ agent: { id: 's1' } })
    expect(text).toContain('inj.mdc')
    expect(text).toContain('项目规则（工作区 ' + projectA)
    expect(provider({})).not.toContain('项目规则（工作区')
    expect(provider({ agent: { id: 'missing' } })).not.toContain('inj.mdc')
  })
})
// --endregion
