/**
 * 代码片段「按语言绑定」测试：
 * ① snippetLanguageOf：片段文件名 → 绑定语言（回归本次事故 —— 曾用 langOf 推导，
 *    因 .code-snippets 在 LANG_BY_EXT 里映射为 json，导致默认名错成 `json.code-snippets`）；
 * ② 片段文件仍按 JSON 高亮（langOf 行为不变，不能被本次修复带偏）；
 * ③ shared 的语言目录 / 展示名 / 下拉选项。
 * 作者 ddj 2026-09-10
 */
import { describe, expect, it } from 'vitest'
import { langOf, snippetLanguageOf } from '../src/client/monaco/loader.js'
import { languageOptions, fileMeta } from '../src/client/ui/SnippetsPicker.js'
import {
  SNIPPET_LANGUAGES, languageLabelOf, snippetFileNameFor, snippetFileTemplate,
} from '../src/shared/snippets.js'

describe('snippetLanguageOf（片段文件名 → 绑定语言）', () => {
  it('按 `<语言>.code-snippets` 命名约定推导', () => {
    expect(snippetLanguageOf('lua.code-snippets')).toBe('lua')
    expect(snippetLanguageOf('typescript.code-snippets')).toBe('typescript')
    expect(snippetLanguageOf('csharp.code-snippets')).toBe('csharp')
    expect(snippetLanguageOf('Lua.code-snippets')).toBe('lua') // 大小写不敏感
  })

  it('global / 空语言前缀 → 空串（全语言生效）', () => {
    expect(snippetLanguageOf('global.code-snippets')).toBe('')
    expect(snippetLanguageOf('GLOBAL.code-snippets')).toBe('')
    expect(snippetLanguageOf('.code-snippets')).toBe('')
  })

  it('带目录的路径只看 basename', () => {
    expect(snippetLanguageOf('C:/Users/x/.dsh/snippets/lua.code-snippets')).toBe('lua')
    expect(snippetLanguageOf('a\\b\\lua.code-snippets')).toBe('lua')
  })

  it('回归：不得把片段文件当成 json 源文件（曾致默认名 json.code-snippets）', () => {
    expect(snippetLanguageOf('global.code-snippets')).not.toBe('json')
    expect(snippetLanguageOf('lua.code-snippets')).not.toBe('json')
    // 反证：这正是当初误用 langOf 得到的错误结果
    expect(langOf('lua.code-snippets')).toBe('json')
    expect(snippetLanguageOf('lua.code-snippets')).not.toBe(langOf('lua.code-snippets'))
  })

  it('非片段文件回落到 langOf（普通源码不受影响）', () => {
    expect(snippetLanguageOf('a.lua')).toBe('lua')
    expect(snippetLanguageOf('src/foo.ts')).toBe('typescript')
    expect(snippetLanguageOf('x.json')).toBe('json')
    expect(snippetLanguageOf('README.md')).toBe('markdown')
  })

  it('片段文件仍按 JSON 高亮（langOf 行为未被本次修复改变）', () => {
    expect(langOf('global.code-snippets')).toBe('json')
    expect(langOf('lua.code-snippets')).toBe('json')
  })
})

describe('默认文件名与绑定语言一致', () => {
  it('语言决定默认文件名；全语言回退 global（不再是 json）', () => {
    expect(snippetFileNameFor('lua')).toBe('lua.code-snippets')
    expect(snippetFileNameFor('')).toBe('global.code-snippets')
    expect(snippetFileNameFor(undefined as unknown as string)).toBe('global.code-snippets')
    // 与推导函数互为逆运算：文件名 → 语言 → 文件名 应稳定
    for (const lang of ['lua', 'typescript', 'csharp', 'python']) {
      expect(snippetLanguageOf(snippetFileNameFor(lang))).toBe(lang)
    }
  })

  it('模板首行语言注释随绑定语言变化', () => {
    expect(snippetFileTemplate('lua')).toContain('lua 片段示例')
    expect(snippetFileTemplate('')).toContain('global 片段示例')
  })
})

describe('SNIPPET_LANGUAGES 与语言展示名', () => {
  it('目录非空、去重、均为小写（作为语言下拉来源）', () => {
    expect(SNIPPET_LANGUAGES.length).toBeGreaterThan(20)
    expect(new Set(SNIPPET_LANGUAGES).size).toBe(SNIPPET_LANGUAGES.length)
    for (const id of SNIPPET_LANGUAGES) expect(id).toBe(id.toLowerCase())
  })

  it('覆盖插件已支持的常见语言（与 LANG_BY_EXT 取值集合一致）', () => {
    // LANG_BY_EXT 的取值集合（插件实际会打开的文件语言）应被目录覆盖
    for (const id of ['lua', 'typescript', 'javascript', 'csharp', 'cpp', 'python', 'json', 'markdown', 'yaml']) {
      expect(SNIPPET_LANGUAGES, id).toContain(id)
    }
  })

  it('展示名映射：收录项用友好名，未收录项原样返回，空为全语言', () => {
    expect(languageLabelOf('csharp')).toBe('C#')
    expect(languageLabelOf('cpp')).toBe('C++')
    expect(languageLabelOf('javascript')).toBe('JavaScript')
    expect(languageLabelOf('lua')).toBe('lua')
    expect(languageLabelOf('')).toBe('全语言')
  })
})

describe('languageOptions（新建弹窗语言下拉）', () => {
  it('首项为全语言，其后为去重的小写语言项', () => {
    const options = languageOptions(['Lua', 'lua', 'cpp', ''])
    expect(options[0]).toEqual({ id: '', label: '全语言（所有文件生效）' })
    expect(options.map((item) => item.id)).toEqual(['', 'lua', 'cpp'])
    expect(options[1].label).toBe('lua')
    expect(options[2].label).toBe('C++')
  })

  it('目录缺失/为空时回落内置常量', () => {
    expect(languageOptions(undefined).length).toBe(SNIPPET_LANGUAGES.length + 1)
    expect(languageOptions([]).length).toBe(SNIPPET_LANGUAGES.length + 1)
  })
})

describe('fileMeta 列表行摘要（语言可读名）', () => {
  it('展示绑定语言的友好名而非原始 id', () => {
    expect(fileMeta({ language: 'lua', count: 2, relHint: 'snippets/', file: 'lua.code-snippets' }))
      .toBe('lua · 2 条 · [snippets/lua.code-snippets]')
    expect(fileMeta({ language: 'csharp', count: 1, relHint: 'snippets/', file: 'csharp.code-snippets' }))
      .toBe('C# · 1 条 · [snippets/csharp.code-snippets]')
  })

  it('全语言文件显示「全语言」', () => {
    expect(fileMeta({ language: '', count: 3, relHint: 'snippets/', file: 'global.code-snippets' }))
      .toBe('全语言 · 3 条 · [snippets/global.code-snippets]')
  })
})
