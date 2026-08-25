/** 大纲模块测试：parseOutline 兜底解析器 / resolveOutline 优先级 / 源注册表。作者 ddj 2026年08月27号 */
import { describe, expect, it, vi } from 'vitest'
import { parseOutline, SK } from '../src/client/outline/parse.js'
import {
  createOutlineSourceRegistry,
  resolveOutline,
  OUTLINE_MONACO_LANGS,
  OUTLINE_FALLBACK_LANGS,
} from '../src/client/outline/sources.js'

describe('parseOutline: markdown', () => {
  it('按 # 级数嵌套标题并补齐区间', () => {
    const out = parseOutline('markdown', [
      '# Title',
      'intro',
      '## Sub',
      'text',
      '### Deep',
      '## Sub2',
      '# Title2',
    ].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['Title', 'Title2'])
    expect(out[0].children?.map((s) => s.name)).toEqual(['Sub', 'Sub2'])
    expect(out[0].children?.[0].children?.map((s) => s.name)).toEqual(['Deep'])
    expect(out[0].children?.[0].kind).toBe(SK.Namespace)
    expect(out[0].endLine).toBe(6) // Title 到 Title2 前一行为止
    expect(out[0].children?.[0].endLine).toBe(5)
    expect(out[0].children?.[1].endLine).toBe(6)
    expect(out[1].endLine).toBe(7)
    expect(out[0].selectLine).toBe(1)
  })
})

describe('parseOutline: python', () => {
  it('class/def 按缩进嵌套', () => {
    const out = parseOutline('python', [
      'import os',
      'class Foo:',
      '    def __init__(self):',
      '        pass',
      '    def bar(self):',
      '        return 1',
      'def top():',
      '    pass',
    ].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['Foo', 'top'])
    expect(out[0].kind).toBe(SK.Class)
    expect(out[0].children?.map((s) => s.name)).toEqual(['__init__', 'bar'])
    expect(out[0].children?.[0].kind).toBe(SK.Function)
    expect(out[0].children?.[0].endLine).toBe(4)
    expect(out[0].endLine).toBe(6)
    expect(out[1].endLine).toBe(8)
  })
})

describe('parseOutline: shell / powershell / lua / go / rust', () => {
  it('shell 函数', () => {
    const out = parseOutline('shell', ['#!/bin/bash', 'foo() {', '  echo hi', '}', 'bar () {', '  echo x', '}'].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['foo', 'bar'])
    expect(out[0].selectLine).toBe(2)
    expect(out[0].endLine).toBe(4)
  })

  it('powershell function', () => {
    const out = parseOutline('powershell', ['function Get-Item2 {', '  Write-Output 1', '}'].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['Get-Item2'])
    expect(out[0].kind).toBe(SK.Function)
  })

  it('lua function 与点号赋值', () => {
    const out = parseOutline('lua', [
      'local M = {}',
      'function M.foo(x)',
      'end',
      'M.bar = function() end',
      'local function helper() end',
    ].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['M.foo', 'M.bar', 'helper'])
    expect(out[0].kind).toBe(SK.Function)
  })

  it('go func/type', () => {
    const out = parseOutline('go', [
      'package main',
      'import "fmt"',
      'func main() {',
      '\tfmt.Println("hi")',
      '}',
      'type Point struct {',
      '\tX int',
      '}',
    ].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['main', 'Point'])
    expect(out[0].kind).toBe(SK.Function)
    expect(out[1].kind).toBe(SK.Struct)
  })

  it('rust 各项声明', () => {
    const out = parseOutline('rust', [
      'pub struct Foo {',
      '    pub fn bar(&self) {}',
      '}',
      'fn main() {}',
      'impl Foo {',
      '    fn baz(&self) {}',
      '}',
    ].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['Foo', 'bar', 'main', 'Foo', 'baz'])
    expect(out[0].kind).toBe(SK.Struct)
  })
})

describe('parseOutline: yaml / ini / 花括号语言', () => {
  it('yaml 仅顶层键', () => {
    const out = parseOutline('yaml', [
      'name: app',
      'services:',
      '  web:',
      '    image: nginx',
      'ports:',
      '  - 8080',
    ].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['name', 'services', 'ports'])
    expect(out[0].kind).toBe(SK.Key)
  })

  it('ini [section] 与键', () => {
    const out = parseOutline('ini', [
      '; comment',
      '[general]',
      'name = app',
      'version=1',
      '[server]',
      'host = localhost',
    ].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['general', 'name', 'version', 'server', 'host'])
    expect(out[0].kind).toBe(SK.Namespace)
    expect(out[1].kind).toBe(SK.Key)
  })

  it('花括号语言：类型声明 + 函数（跳过声明行与控制流）', () => {
    const out = parseOutline('cpp', [
      '#include <x>',
      'class Foo {',
      'public:',
      '    void bar();',
      '    int baz(int a) {',
      '        return a;',
      '    }',
      '};',
      'static int helper(int x) {',
      '    if (x > 0) { return 1; }',
      '    return 0;',
      '}',
    ].join('\n'))
    expect(out.map((s) => s.name)).toEqual(['Foo', 'baz', 'helper'])
    expect(out[0].kind).toBe(SK.Class)
    expect(out[1].kind).toBe(SK.Function)
    expect(out[2].kind).toBe(SK.Function)
  })

  it('plaintext 与未知语言返回空', () => {
    expect(parseOutline('plaintext', 'anything here\nfoo()')).toEqual([])
    expect(parseOutline('some-unknown', 'class A')).toEqual([])
  })
})

describe('createOutlineSourceRegistry', () => {
  const src = (id, priority) => ({ id, priority, provides: () => true, get: async () => [] })

  it('按优先级降序 list，且注册/注销通知订阅者', () => {
    const reg = createOutlineSourceRegistry()
    const listener = vi.fn()
    reg.subscribe(listener)
    const d1 = reg.register(src('a', 10))
    const d2 = reg.register(src('b', 80))
    const d3 = reg.register(src('c', 40))
    expect(reg.list().map((s) => s.id)).toEqual(['b', 'c', 'a'])
    expect(listener).toHaveBeenCalledTimes(3)
    d2()
    expect(reg.list().map((s) => s.id)).toEqual(['c', 'a'])
    d1(); d3()
    expect(reg.list()).toEqual([])
  })

  it('缺 id/get 抛 TypeError', () => {
    const reg = createOutlineSourceRegistry()
    expect(() => reg.register({ priority: 1, provides: () => true, get: async () => [] })).toThrow(TypeError)
  })
})

describe('resolveOutline', () => {
  const reg = createOutlineSourceRegistry()

  it('优先级降序、首个非空即停', async () => {
    const high = { id: 'high', priority: 80, provides: () => true, get: vi.fn(async () => [{ name: 'H', kind: 11, startLine: 1, endLine: 1, selectLine: 1 }]) }
    const low = { id: 'low', priority: 20, provides: () => true, get: vi.fn(async () => [{ name: 'L', kind: 11, startLine: 1, endLine: 1, selectLine: 1 }]) }
    reg.register(high); reg.register(low)
    const out = await resolveOutline(reg, { languageId: 'x', model: {} })
    expect(out[0].name).toBe('H')
    expect(low.get).not.toHaveBeenCalled()
  })

  it('高优先级源返回空时落入下一优先级', async () => {
    reg.register({ id: 'high', priority: 80, provides: () => true, get: vi.fn(async () => []) })
    const out = await resolveOutline(reg, { languageId: 'x', model: {} })
    expect(out[0].name).toBe('L')
  })

  it('出错源跳过、provides 抛错跳过', async () => {
    reg.register({ id: 'bad', priority: 90, provides: () => true, get: async () => { throw new Error('boom') } })
    reg.register({ id: 'noprov', priority: 85, provides: () => { throw new Error('no') }, get: async () => [{ name: 'X', kind: 0, startLine: 1, endLine: 1, selectLine: 1 }] })
    const out = await resolveOutline(reg, { languageId: 'x', model: {} })
    expect(out[0].name).toBe('L')
  })

  it('全部空 → []', async () => {
    const empty = createOutlineSourceRegistry()
    empty.register({ id: 'e', priority: 50, provides: () => true, get: async () => [] })
    expect(await resolveOutline(empty, { languageId: 'x', model: {} })).toEqual([])
  })
})

describe('内置语言清单', () => {
  it('原生与兜底语言集不相交且覆盖常见语言', () => {
    expect(OUTLINE_MONACO_LANGS.has('typescript')).toBe(true)
    expect(OUTLINE_FALLBACK_LANGS.has('python')).toBe(true)
    expect(OUTLINE_FALLBACK_LANGS.has('markdown')).toBe(true)
    expect(OUTLINE_FALLBACK_LANGS.has('lua')).toBe(true)
    for (const lang of OUTLINE_MONACO_LANGS) expect(OUTLINE_FALLBACK_LANGS.has(lang)).toBe(false)
  })
})
