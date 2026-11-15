/**
 * 语言映射与 Monaco 语言表审计。
 *
 * 为什么需要机器审计：`langOf` 把扩展名映射成 Monaco 语言 id，而 id 必须真实存在于随包的
 * Monaco 构建里；写错的 id 不会报错，只会在打开文件时静默回落 plaintext（表现为「有些文件
 * 没分色」）。同时升级 Monaco 后新的语言/扩展名需要人工过一遍映射，否则同样静默丢色。
 *
 * 本文件覆盖：点文件/复合后缀/模板扩展名的解析结果，以及「映射值必须真实存在于
 * assets/vendor/monaco/vs/editor/editor.main.js 的语言表」这条硬约束。
 *
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMPOUND_EXT, DOTFILE_LANG, DOTFILE_PREFIX_LANG, LANG_BY_EXT, langOf } from '../src/client/monaco/loader.js'
import { TEMPLATE_LANGUAGE_IDS } from '../src/client/monaco/templateLanguages.js'

/** Monaco 语言表文件（AMD 构建，语言贡献表内联在 editor.main.js 里）。 */
const EDITOR_MAIN = join(process.cwd(), 'assets/vendor/monaco/vs/editor/editor.main.js')

/** 非 Monaco basic-languages 提供、但编辑器始终可用的语言 id。 */
const ALWAYS_AVAILABLE = new Set(['plaintext'])

/**
 * 我们**有意**把某个 Monaco 也认识的扩展名指到别的语言 id 时，必须在此登记。
 * 目前没有此类情况（我们的映射要么与 Monaco 一致，要么是 Monaco 未覆盖的扩展名）；
 * 留此常量是为了未来升级时不出现「悄悄覆盖官方映射」。
 */
const INTENTIONAL_OVERRIDES: Record<string, string> = {}

/** 关键语言覆盖：这些扩展名一旦解析错就是可见缺陷，逐项断言。 */
const COVERAGE: Array<[string, string]> = [
  ['*.ts', 'typescript'], ['*.tsx', 'typescript'], ['*.jsx', 'javascript'], ['*.mjs', 'javascript'],
  ['*.py', 'python'], ['*.ps1', 'powershell'], ['*.lua', 'lua'], ['*.cs', 'csharp'],
  ['*.kt', 'kotlin'], ['*.dart', 'dart'], ['*.rs', 'rust'], ['*.rb', 'ruby'],
  ['*.php', 'php'], ['*.sql', 'sql'], ['*.proto', 'plaintext'], ['*.vue', 'html'],
  ['*.toml', 'ini'], ['*.dockerfile', 'dockerfile'], ['*.csproj', 'xml'], ['*.plist', 'xml'],
]

/**
 * 解析 Monaco 原生语言贡献表。
 * @author ddj 2026年11月15号
 * @returns 语言 id 集合与「扩展名 → 语言 id」表（同名扩展名取首次出现）
 */
function monacoLanguageTable(): { ids: Set<string>; byExtension: Map<string, string> } {
  const source = readFileSync(EDITOR_MAIN, 'utf8')
  const pattern = /\{id:"([a-z0-9-]+)",extensions:\[([^\]]*)\]/g
  const ids = new Set<string>()
  const byExtension = new Map<string, string>()
  let match: RegExpExecArray | null = pattern.exec(source)
  while (match !== null) {
    const id = match[1]
    ids.add(id)
    for (const quoted of match[2].match(/"[^"]*"/g) ?? []) {
      const extension = quoted.slice(1, -1).replace(/^\./, '').toLowerCase()
      if (extension && !byExtension.has(extension)) byExtension.set(extension, id)
    }
    match = pattern.exec(source)
  }
  return { ids, byExtension }
}

const table = monacoLanguageTable()

describe('langOf：点文件与复合后缀', () => {
  it('无扩展名的点文件按名字映射', () => {
    expect(langOf('.eslintrc')).toBe('json')
    expect(langOf('/repo/.babelrc')).toBe('json')
    expect(langOf('C:\\repo\\.gitconfig')).toBe('ini')
    expect(langOf('.editorconfig')).toBe('ini')
    expect(langOf('.rprofile')).toBe('r')
    expect(langOf('.zshrc')).toBe('shell')
  })

  it('点文件前缀派生的名字（.env / .env.local）走 ini', () => {
    expect(langOf('.env')).toBe('ini')
    expect(langOf('.env.local')).toBe('ini')
  })

  it('复合后缀优先于末段扩展名', () => {
    expect(langOf('welcome.blade.php')).toBe('blade')
    expect(langOf('types.d.ts')).toBe('typescript')
  })

  it('大小写与路径分隔符无关', () => {
    expect(langOf('SRC/Index.TSX')).toBe('typescript')
    expect(langOf('a\\b\\page.NJK')).toBe('nunjucks')
  })

  it('未知扩展名与无扩展名回落 plaintext', () => {
    expect(langOf('notes.unknownext')).toBe('plaintext')
    expect(langOf('Makefile')).toBe('plaintext')
    expect(langOf('')).toBe('plaintext')
  })
})

describe('langOf：HTML 模板语言', () => {
  const cases: Array<[string, string]> = [
    ['index.ejs', 'ejs'], ['page.eta', 'ejs'], ['view.erb', 'erb'],
    ['layout.njk', 'nunjucks'], ['layout.nunjucks', 'nunjucks'],
    ['base.jinja', 'jinja'], ['base.jinja2', 'jinja'], ['base.j2', 'jinja'],
    ['index.blade.php', 'blade'], ['index.haml', 'haml'], ['index.slim', 'slim'],
    ['index.pug', 'pug'], ['index.hbs', 'handlebars'], ['index.mustache', 'handlebars'],
    ['index.twig', 'twig'], ['index.liquid', 'liquid'], ['index.cshtml', 'razor'],
    ['mail.ftl', 'freemarker2'],
  ]

  for (const [file, language] of cases) {
    it(`${file} → ${language}`, () => expect(langOf(file)).toBe(language))
  }
})

describe('审计：映射值必须真实存在于随包 Monaco', () => {
  it('Monaco 语言表可解析（构建产物完整）', () => {
    expect(table.ids.size).toBeGreaterThan(60)
    expect(table.ids.has('typescript')).toBe(true)
  })

  it('LANG_BY_EXT 不指向不存在的语言 id', () => {
    const dead = Object.entries(LANG_BY_EXT)
      .filter(([, language]) => !table.ids.has(language) && !TEMPLATE_LANGUAGE_IDS.includes(language) && !ALWAYS_AVAILABLE.has(language))
      .map(([extension, language]) => `${extension} → ${language}`)
    expect(dead, '这些映射指向了随包 Monaco 没有的语言 id（打开文件会静默回落 plaintext）').toEqual([])
  })

  it('点文件与复合后缀映射同样有效', () => {
    const values = [...Object.values(DOTFILE_LANG), ...DOTFILE_PREFIX_LANG.map(([, language]) => language), ...Object.values(COMPOUND_EXT)]
    const dead = values.filter((language) => !table.ids.has(language) && !TEMPLATE_LANGUAGE_IDS.includes(language) && !ALWAYS_AVAILABLE.has(language))
    expect(dead).toEqual([])
  })

  it('自定义模板语言 id 不与 Monaco 内置 id 冲突', () => {
    expect(TEMPLATE_LANGUAGE_IDS.filter((id) => table.ids.has(id))).toEqual([])
  })

  it('覆盖官方映射时必须显式登记', () => {
    const undeclared = Object.entries(LANG_BY_EXT)
      .filter(([extension, language]) => {
        const official = table.byExtension.get(extension)
        return official !== undefined && official !== language && INTENTIONAL_OVERRIDES[extension] !== language
      })
      .map(([extension, language]) => `${extension} → ${language}（Monaco 官方为 ${table.byExtension.get(extension)}）`)
    expect(undeclared, '新增覆盖请在 INTENTIONAL_OVERRIDES 登记，避免升级 Monaco 后悄悄改变行为').toEqual([])
  })

  it('关键扩展名覆盖项解析正确', () => {
    const wrong = COVERAGE
      .map(([glob, language]) => ({ glob, language, actual: langOf(glob.replace('*', 'file')) }))
      .filter((item) => item.actual !== item.language)
      .map((item) => `${item.glob}: 期望 ${item.language}，实际 ${item.actual}`)
    expect(wrong).toEqual([])
  })
})
