/** launch.json「添加配置」片段提取测试（临时扩展布局 + nls 解析 + 可用性标注，不读真实机器）。作者 ddj 2026年09月22号 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { annotateSnippets, clearSnippetCache, dapConfigSnippets } from '../src/dap/configSnippets.js'
import type { DapAdapterDecl, DapConfigSnippet } from '../src/shared/dap.js'

const homes: string[] = []

afterEach(() => {
  delete process.env.DSH_LSP_EXT_DIRS
  clearSnippetCache()
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
})

/** 建临时扩展根并覆盖扫描列表（隔离真实机器，沿用 dapDiscovery 惯例）。 */
function makeExtRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dap-snip-'))
  homes.push(home)
  const extRoot = join(home, 'extensions')
  mkdirSync(extRoot, { recursive: true })
  process.env.DSH_LSP_EXT_DIRS = extRoot
  return extRoot
}

/** 写伪扩展（清单 + 可选 nls 文件）。 */
function installExt(
  extRoot: string,
  dirName: string,
  debuggers: unknown[],
  nls?: { base?: Record<string, string>; zh?: Record<string, string> },
): string {
  const extDir = join(extRoot, dirName)
  mkdirSync(extDir, { recursive: true })
  writeFileSync(
    join(extDir, 'package.json'),
    JSON.stringify({ publisher: 'x', name: dirName, version: '1.0.0', contributes: { debuggers } }),
  )
  if (nls?.base) writeFileSync(join(extRoot, dirName, 'package.nls.json'), JSON.stringify(nls.base))
  if (nls?.zh) writeFileSync(join(extRoot, dirName, 'package.nls.zh-cn.json'), JSON.stringify(nls.zh))
  return extDir
}

describe('dapConfigSnippets', () => {
  it('configurationSnippets 提取：nls zh 覆盖 base，body 内占位符深度解析', () => {
    const extRoot = makeExtRoot()
    installExt(extRoot, 'tangzx.emmylua-0.9.41', [
      {
        type: 'emmylua_attach',
        label: 'EmmyLua Attach Debug',
        configurationSnippets: [
          {
            label: '%debug.attach.label%',
            description: '%debug.attach.desc%',
            body: { type: 'emmylua_attach', request: 'attach', name: '%debug.attach.name%', pid: 0 },
          },
        ],
      },
    ], {
      base: {
        'debug.attach.label': 'EmmyLua: Attach by process id',
        'debug.attach.desc': 'Attach process debugger',
        'debug.attach.name': 'Attach by process id',
      },
      zh: { 'debug.attach.label': 'EmmyLua: 通过进程ID附加' },
    })
    const list = dapConfigSnippets(true, extRoot)
    expect(list).toHaveLength(1)
    expect(list[0].label).toBe('EmmyLua: 通过进程ID附加')
    expect(list[0].description).toBe('Attach process debugger')
    const body = JSON.parse(list[0].bodyText)
    expect(body.name).toBe('Attach by process id')
    expect(body.type).toBe('emmylua_attach')
  })

  it('nls 未命中的占位符剥 %…% 外壳（不裸露上屏）', () => {
    const extRoot = makeExtRoot()
    installExt(extRoot, 'x.snip-1.0.0', [
      {
        type: 'coreclr',
        configurationSnippets: [{ label: '%unknown.key%', body: { type: 'coreclr', name: 'n' } }],
      },
    ])
    const list = dapConfigSnippets(true, extRoot)
    expect(list[0].label).toBe('unknown.key')
    expect(list[0].label).not.toContain('%')
  })

  it('initialConfigurations 兜底：单对象与数组均接受，label 取 body.name', () => {
    const extRoot = makeExtRoot()
    installExt(extRoot, 'x.single-1.0.0', [
      { type: 'coreclr', label: '.NET Core Debugger', initialConfigurations: { name: 'Launch .NET', request: 'launch' } },
    ])
    installExt(extRoot, 'x.array-1.0.0', [
      { type: 'vstuc', initialConfigurations: [{ name: 'Attach to Unity', request: 'attach' }] },
    ])
    const list = dapConfigSnippets(true, extRoot)
    expect(list.map((s) => s.label).sort()).toEqual(['Attach to Unity', 'Launch .NET'])
    // body 缺 type → 清单条目补齐（parseLaunchConfigs 要求 type+name）
    const net = list.find((s) => s.label === 'Launch .NET')!
    expect(net.type).toBe('coreclr')
    expect(JSON.parse(net.bodyText).type).toBe('coreclr')
  })

  it('兜底 label 链：body.name 缺失 → debugger.label → type', () => {
    const extRoot = makeExtRoot()
    installExt(extRoot, 'x.noname-1.0.0', [
      { type: 'java', label: 'Java Debug', initialConfigurations: { request: 'launch' } },
    ])
    installExt(extRoot, 'x.nolabel-1.0.0', [
      { type: 'python', initialConfigurations: { request: 'launch' } },
    ])
    const list = dapConfigSnippets(true, extRoot)
    expect(list.find((s) => s.type === 'java')!.label).toBe('Java Debug')
    expect(list.find((s) => s.type === 'python')!.label).toBe('python')
    // name 缺失 → 用 label 补齐（否则插入后 parseLaunchConfigs 丢弃该条目）
    expect(JSON.parse(list.find((s) => s.type === 'python')!.bodyText).name).toBe('python')
  })

  it('同 type+label 跨扩展版本去重，输出按 label 字典序', () => {
    const extRoot = makeExtRoot()
    const snippet = { configurationSnippets: [{ label: 'EmmyLua: 附加', body: { type: 'emmylua_attach', name: 'n' } }] }
    installExt(extRoot, 'tangzx.emmylua-0.9.40', [{ type: 'emmylua_attach', ...snippet }])
    installExt(extRoot, 'tangzx.emmylua-0.9.41', [{ type: 'emmylua_attach', ...snippet }])
    installExt(extRoot, 'x.a-1.0.0', [
      { type: 'z-type', configurationSnippets: [{ label: 'B配置', body: { type: 'z-type', name: 'b' } }] },
    ])
    installExt(extRoot, 'x.b-1.0.0', [
      { type: 'a-type', configurationSnippets: [{ label: 'A配置', body: { type: 'a-type', name: 'a' } }] },
    ])
    const list = dapConfigSnippets(true, extRoot)
    expect(list.map((s) => s.label)).toEqual(['A配置', 'B配置', 'EmmyLua: 附加'])
  })

  it('configurationSnippets 存在时忽略 initialConfigurations；无片段扩展不产出', () => {
    const extRoot = makeExtRoot()
    installExt(extRoot, 'x.mix-1.0.0', [
      {
        type: 't1',
        configurationSnippets: [{ label: '片段', body: { type: 't1', name: 's' } }],
        initialConfigurations: [{ name: '不该出现' }],
      },
    ])
    installExt(extRoot, 'x.plain-1.0.0', [{ type: 't2', label: 'Plain', program: './a.js' }])
    const list = dapConfigSnippets(true, extRoot)
    expect(list.map((s) => s.label)).toEqual(['片段'])
  })

  it('缓存：同 home 二次调用不重扫，clearSnippetCache 后重扫', () => {
    const extRoot = makeExtRoot()
    installExt(extRoot, 'x.c-1.0.0', [
      { type: 't', configurationSnippets: [{ label: 'L', body: { type: 't', name: 'n' } }] },
    ])
    expect(dapConfigSnippets(false, extRoot)).toHaveLength(1)
    // 清掉扩展目录后缓存仍在（同 home 不重扫）
    rmSync(join(extRoot, 'x.c-1.0.0'), { recursive: true, force: true })
    expect(dapConfigSnippets(false, extRoot)).toHaveLength(1)
    clearSnippetCache()
    expect(dapConfigSnippets(false, extRoot)).toHaveLength(0)
  })

  it('无扩展根 / 无 debuggers → 空表', () => {
    const extRoot = makeExtRoot()
    expect(dapConfigSnippets(true, extRoot)).toEqual([])
  })
})

describe('annotateSnippets（与工具条同源的可用性标注）', () => {
  /** 最小片段工厂。 */
  const snip = (label: string, type: string): DapConfigSnippet => ({ label, type, bodyText: '{}' })
  /** 最小适配器声明工厂（仅裁决消费的字段）。 */
  const decl = (type: string, available: boolean, reason?: string): DapAdapterDecl =>
    ({ type, available, reason }) as DapAdapterDecl

  it('type 命中可用适配器 → available=true 透传', () => {
    const out = annotateSnippets([snip('EmmyLua: 附加', 'emmylua_attach')], [decl('emmylua_attach', true)])
    expect(out).toHaveLength(1)
    expect(out[0].available).toBe(true)
    expect(out[0].reason).toBeUndefined()
  })

  it('type 命中不可用适配器 → available=false 带原因（如 coreclr 入口未下载）', () => {
    const out = annotateSnippets(
      [snip('.NET Core Debugger (attach)', 'coreclr')],
      [decl('coreclr', false, '适配器入口不存在（扩展可能需按需下载）：clrdbg.exe')],
    )
    expect(out[0].available).toBe(false)
    expect(out[0].reason).toContain('适配器入口不存在')
  })

  it('type 无 decl（清单未发现该类型）→ available=false +「未发现该类型适配器」', () => {
    const out = annotateSnippets([snip('Unity Debugger', 'unity')], [decl('emmylua_attach', true)])
    expect(out[0].available).toBe(false)
    expect(out[0].reason).toBe('未发现该类型适配器')
  })

  it('不改入参数组（返回新数组），字段齐全的混合场景逐条独立标注', () => {
    const input = [snip('A', 't-ok'), snip('B', 't-bad'), snip('C', 't-miss')]
    const frozen = input.map((s) => ({ ...s }))
    const out = annotateSnippets(input, [decl('t-ok', true), decl('t-bad', false, '原因x')])
    expect(input).toEqual(frozen)
    expect(out.map((s) => [s.label, s.available])).toEqual([['A', true], ['B', false], ['C', false]])
    expect(out[2].reason).toBe('未发现该类型适配器')
  })
})
