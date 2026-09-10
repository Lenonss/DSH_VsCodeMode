/**
 * 代码片段选择器（SnippetsPicker）纯逻辑测试：
 * 文件行摘要文案（语言/条目数/相对路径），以及 host 侧同名 RPC 载荷的展示契约。
 * 组件渲染走 React DOM，node 环境不挂载；此处只覆盖可离线断言的纯函数部分。
 * 作者 ddj 2026-09-10
 */
import { describe, expect, it } from 'vitest'
import { fileMeta } from '../src/client/ui/SnippetsPicker.js'
import { snippetFileNameFor, snippetFileTemplate } from '../src/shared/snippets.js'

describe('fileMeta 列表行摘要', () => {
  it('有语言：语言 · 条目数 · [相对提示]', () => {
    expect(fileMeta({ language: 'lua', count: 3, relHint: 'snippets/', file: 'lua.code-snippets' }))
      .toBe('lua · 3 条 · [snippets/lua.code-snippets]')
  })

  it('无语言（global / 无法识别）：显示「全语言」', () => {
    expect(fileMeta({ language: '', count: 1, relHint: 'snippets/', file: 'global.code-snippets' }))
      .toBe('全语言 · 1 条 · [snippets/global.code-snippets]')
  })

  it('项目片段用 .dsh/snippets/ 相对提示（语言显示为友好名）', () => {
    expect(fileMeta({ language: 'csharp', count: 0, relHint: '.dsh/snippets/', file: 'csharp.code-snippets' }))
      .toBe('C# · 0 条 · [.dsh/snippets/csharp.code-snippets]')
  })
})

describe('新建流程的默认值', () => {
  it('当前编辑器语言决定默认文件名（无语言回退 global）', () => {
    expect(snippetFileNameFor('lua')).toBe('lua.code-snippets')
    expect(snippetFileNameFor('')).toBe('global.code-snippets')
  })

  it('模板内容可直接保存并被解析（与 host 同源实现）', () => {
    const parsed = JSON.parse(snippetFileTemplate('lua'))
    const keys = Object.keys(parsed)
    expect(keys).toHaveLength(1)
    expect(parsed[keys[0]].prefix).toBe('hello')
    expect(Array.isArray(parsed[keys[0]].body)).toBe(true)
  })
})
