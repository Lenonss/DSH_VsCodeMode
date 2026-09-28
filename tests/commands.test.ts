/**
 * 指令系统装配测试：目录元数据 ↔ 官方键位表一致性、命令栏筛选、命令桥注册、
 * 命令栏 store 的开关与单实例宿主认领。全部为纯逻辑/DOM 无关断言（vitest node 环境）。
 * 键位派发归官方 shortcuts 机制的契约断言（探测/注册/迁移/弦表同步）在「装配层接线」组。
 * 作者 ddj 2026-09-10 / 2026年10月
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { BRIDGE_COMMANDS, EDITOR_COMMANDS, showCommandsDef } from '../src/client/ui/commandCatalog.js'
import type { CommandDef } from '../src/client/ui/commandCatalog.js'
import { filterCommands } from '../src/client/commandSearch.js'
import { createCommandBridge } from '../src/client/commandBridge.js'
import { COMMANDS } from '../src/client/keybindings.js'
import { bindingToChord, KEYBINDING_DEFAULTS, SHORTCUT_PROFILES, type ShortcutProfiles } from '../src/shared/keybindings.js'
import {
  closeCommandPalette, isPaletteOpen, openCommandPalette,
  registryRef, releasePaletteHost, runPaletteCommand, setPaletteRunner, subscribePalette,
} from '../src/client/commandPaletteStore.js'
import { REGISTRY_GLOBAL } from '../src/client/commandGlobals.js'

/** 目录全量（编辑器指令 + 桥接指令 + 命令栏自身）。 */
const CATALOG: readonly CommandDef[] = [...EDITOR_COMMANDS, ...BRIDGE_COMMANDS, showCommandsDef(() => {})]

/** 造一条筛选测试命令。 */
function cmd(id: string, label: string, category: string, order = 10): CommandDef {
  return { id, label, category, order, run: () => {} }
}

/** 按 SHORTCUT_PROFILES 派生官方目录弦表（等价 shortcutsOfficial.bindCatalogChords 的产物）。 */
function officialChordsOf(profiles: Record<string, ShortcutProfiles>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, profile] of Object.entries(profiles)) {
    for (const binding of Object.values(profile)) {
      if (!binding) continue
      const chord = bindingToChord(binding)
      if (chord !== null) {
        out[id] = chord
        break
      }
    }
  }
  return out
}

/** 事件目标替身：记录派发过的事件，供测试断言/回放。 */
class FakeTarget extends EventTarget {
  sent: Event[] = []

  override dispatchEvent(event: Event): boolean {
    this.sent.push(event)
    return super.dispatchEvent(event)
  }
}

/** 安装 window 替身（命令目录的 emit 走 window.dispatchEvent + CustomEvent，Node 自带二者）。 */
function installWindow(): FakeTarget {
  const fake = new FakeTarget()
  vi.stubGlobal('window', fake)
  return fake
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('指令目录与官方键位表一致性', () => {
  it('共享键位表的每条都有对应指令（无历史残留）', () => {
    const ids = new Set(CATALOG.map((command) => command.id))
    for (const id of Object.keys(KEYBINDING_DEFAULTS)) expect(ids.has(id), id).toBe(true)
  })

  it('SHORTCUT_PROFILES 无孤儿条目（每条都在目录内）', () => {
    const ids = new Set(CATALOG.map((command) => command.id))
    for (const id of Object.keys(SHORTCUT_PROFILES)) expect(ids.has(id), id).toBe(true)
  })

  it('共享键位表保留主候选 Ctrl+Shift+P（F1 候选为迁移基线，官方仅派生主候选）', () => {
    expect(KEYBINDING_DEFAULTS['edrv.showCommands']).toBe('Ctrl+Shift+P|F1')
    expect(officialChordsOf(SHORTCUT_PROFILES)['edrv.showCommands']).toBe('Ctrl+Shift+P')
  })

  it('指令 id 唯一且均带 edrv. 前缀', () => {
    const ids = CATALOG.map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.startsWith('edrv.')).toBe(true)
  })

  it('新增一条指令即自动进入快捷键设置页目录', () => {
    const ids = COMMANDS.map((entry) => entry.id)
    expect(ids.length).toBe(CATALOG.length)
    for (const command of CATALOG) expect(ids).toContain(command.id)
  })
})

describe('装配层接线（client/index.ts 契约）', () => {
  const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

  it('装配指令桥并对外 provide 指令注册表', () => {
    expect(source).toContain('createCommandBridge()')
    expect(source).toContain('ctx.provide(REGISTRY_GLOBAL, bridge.registry)')
    expect(source).toContain('setupCommands(ctx)')
  })

  it('命令栏与指令桥同源装配（索引层不留命令列表硬编码）', () => {
    expect(source).toContain('createCommandBridge()')
    expect(source).toContain('setupCommands(ctx)')
  })

  it('键位派发归官方 shortcuts 机制（服务探测 + 官方注册 + 目录弦表同步 + 旧设置迁移）', () => {
    expect(source).toContain('awaitShortcutsService')
    expect(source).toContain('registerOfficialShortcuts')
    expect(source).toContain('bindCatalogChords')
    expect(source).toContain('migrateLegacyKeybindings')
  })

  it('注册表挂到 window 自身，且不得依赖不存在的 window.dsh（回归：曾导致命令栏恒空）', () => {
    // 剥注释后判断：注释里提到该命名空间是允许的（说明为何不能改回去）
    const bare = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(bare).not.toMatch(/\b(?:window|global)\.dsh\s*[\[=]/)
    expect(bare).toContain('host[REGISTRY_GLOBAL] = bridge.registry')
  })
})

describe('命令栏候选来源（回归：DSH 无 window.dsh 导致空表）', () => {
  it('装配后 registryRef() 暴露注册表，卸载后清空', () => {
    installWindow()
    const bridge = createCommandBridge()
    expect(registryRef()?.list().length).toBe(CATALOG.length)
    bridge.dispose()
    expect(registryRef()).toBeNull()
  })

  it('全局挂点名不是 dsh 命名空间，且指向注册表', () => {
    expect(REGISTRY_GLOBAL).not.toContain('.')
    const fake = new FakeTarget()
    vi.stubGlobal('window', fake)
    const bridge = createCommandBridge()
    const host = window as unknown as Record<string, unknown>
    host[REGISTRY_GLOBAL] = bridge.registry
    expect((host[REGISTRY_GLOBAL] as typeof bridge.registry).list().length).toBe(CATALOG.length)
    expect((window as unknown as { dsh?: unknown }).dsh).toBeUndefined()
    bridge.dispose()
  })
})

describe('EditorView 指令接线（事件名与目录一致）', () => {
  const source = readFileSync(new URL('../src/client/ui/EditorView.ts', import.meta.url), 'utf8')
  const wired = [...new Set([...source.matchAll(/'?(edrv\.command\.[A-Za-z]+)'/g)].map((hit) => hit[1]))].sort()
  // 桥接类指令（目录里声明、无原生监听）必须由 EditorView 的动作映射接住；
  // 其余内置指令由官方 shortcuts 派发（保存/侧栏/搜索等）或自有组件（快速打开在 QuickOpen）。
  const bridgeEvents = BRIDGE_COMMANDS.map((command) => 'edrv.command.' + command.id.replace('edrv.', '')).sort()
  const occurrences = (name: string): number => source.split("'" + name + "'").length - 1

  it('接线表被解析到（防正则失效导致空断言）', () => {
    expect(wired.length).toBeGreaterThanOrEqual(bridgeEvents.length)
    expect(wired).toContain('edrv.command.save')
  })

  it('桥接类指令全部被 EditorView 接住（接线表内各出现一次）', () => {
    for (const name of bridgeEvents) {
      expect(wired, name).toContain(name)
      // 接线表条目形如 ['edrv.command.x', ...]：该字面量至少出现一次（Monaco 右键入口会再引一次，故为 >=1）
      expect(occurrences(name), name).toBeGreaterThanOrEqual(1)
    }
  })

  it('EditorView 只接目录内的事件名（不出现僵尸接线）', () => {
    const known = new Set(CATALOG.map((command) => 'edrv.command.' + command.id.replace('edrv.', '')))
    known.add('edrv.command.quickOpen') // 目录内有、但由 QuickOpen 自己接（EditorView 不再重复实现）
    expect(wired.filter((name) => !known.has(name))).toEqual([])
  })

  it('整行移动动作单点实现（moveRow 只定义一次）', () => {
    expect(source.match(/const moveRow = /g)?.length).toBe(1)
  })
})

describe('filterCommands 命令栏筛选', () => {
  const list = [
    cmd('edrv.save', '保存文件', '文件', 10),
    cmd('edrv.goToDefinition', '转到定义', '语言智能', 10),
    cmd('edrv.searchInFiles', '在工作区中搜索', '视图', 20),
  ]

  it('空查询返回全部（按目录序稳定）', () => {
    expect(filterCommands(list, '').map((item) => item.id))
      .toEqual(['edrv.save', 'edrv.goToDefinition', 'edrv.searchInFiles'])
  })

  it('中文子串与大小写不敏感', () => {
    expect(filterCommands(list, '保存').map((item) => item.id)).toEqual(['edrv.save'])
    expect(filterCommands(list, 'GOTODEF').map((item) => item.id)).toEqual(['edrv.goToDefinition'])
    expect(filterCommands(list, 'edrv.save').map((item) => item.id)).toEqual(['edrv.save'])
  })

  it('分类名可命中（搜索「视图」）', () => {
    expect(filterCommands(list, '视图').map((item) => item.id)).toEqual(['edrv.searchInFiles'])
  })

  it('多 token 需全部命中（AND 语义）', () => {
    expect(filterCommands(list, '搜索 工作区').map((item) => item.id)).toEqual(['edrv.searchInFiles'])
    expect(filterCommands(list, '搜索 保存')).toEqual([])
  })

  it('label 命中优先于 id/category 命中', () => {
    const mixed = [
      cmd('x.alpha', '无关命令', '保存组', 1),
      cmd('x.beta', '保存文件', '无关组', 50),
    ]
    expect(filterCommands(mixed, '保存').map((item) => item.id)).toEqual(['x.beta', 'x.alpha'])
  })

  it('同权重按 order 再按注册序', () => {
    const same = [cmd('x.b', '同名', '组', 20), cmd('x.a', '同名', '组', 10)]
    expect(filterCommands(same, '同名').map((item) => item.id)).toEqual(['x.a', 'x.b'])
  })

  it('无匹配返回空数组', () => {
    expect(filterCommands(list, '不存在的命令')).toEqual([])
  })
})

describe('createCommandBridge 装配（键位派发归官方机制）', () => {
  it('注册全部内置指令（含命令栏自身）', () => {
    installWindow()
    const bridge = createCommandBridge()
    expect(bridge.registry.has('edrv.save')).toBe(true)
    expect(bridge.registry.has('edrv.showCommands')).toBe(true)
    expect(bridge.registry.has('edrv.nextEditorRow')).toBe(true)
    expect(bridge.registry.list().length).toBe(CATALOG.length)
    expect(bridge.registry.run('edrv.showCommands')).toBe(true)
    closeCommandPalette()
    bridge.dispose()
  })

  it('编辑器指令派发对应事件；编辑器态指令在无模型时被拒（桥不持有编辑器状态）', () => {
    const win = installWindow()
    const bridge = createCommandBridge()
    // 未挂载编辑器（无 document 探测命中）时编辑器态指令不可用
    expect(bridge.registry.run('edrv.save')).toBe(false)
    expect(bridge.registry.run('edrv.nextEditorRow')).toBe(false)
    // 始终可用的指令照常派发
    expect(bridge.registry.run('edrv.quickOpen')).toBe(true)
    expect(bridge.registry.run('edrv.toggleSidebar')).toBe(true)
    expect(bridge.registry.run('edrv.searchInFiles')).toBe(true)
    expect(win.sent.map((event) => event.type))
      .toEqual(['edrv.command.quickOpen', 'edrv.command.toggleSidebar', 'edrv.command.searchInFiles'])
    bridge.dispose()
  })
})

describe('commandPaletteStore 开关与宿主认领', () => {
  it('open/close 切换并通知订阅者（重复 open 也必须通知：快捷键不得静默失效）', () => {
    closeCommandPalette()
    const listener = vi.fn()
    const unsubscribe = subscribePalette(listener)
    expect(isPaletteOpen()).toBe(false)
    openCommandPalette('test')
    expect(isPaletteOpen()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    // 回归：已打开时的重复唤起曾直接 return（不通知）→ 命令栏被浮层遮住时按 Ctrl+Shift+P 毫无反应
    openCommandPalette('test-again')
    expect(listener).toHaveBeenCalledTimes(2)
    closeCommandPalette()
    expect(isPaletteOpen()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    openCommandPalette('after-unsubscribe')
    expect(listener).toHaveBeenCalledTimes(3)
    closeCommandPalette()
  })

  it('非持有者无法释放宿主认领（null/错误令牌均无副作用）', () => {
    expect(() => releasePaletteHost(null)).not.toThrow()
    expect(() => releasePaletteHost({})).not.toThrow()
  })

  it('runPaletteCommand 未注入执行器时返回 false，注入后转发', () => {
    setPaletteRunner(null)
    expect(runPaletteCommand('edrv.save')).toBe(false)
    const runner = vi.fn(() => true)
    setPaletteRunner(runner)
    expect(runPaletteCommand('edrv.save')).toBe(true)
    expect(runner).toHaveBeenCalledWith('edrv.save')
    setPaletteRunner(null)
  })
})
