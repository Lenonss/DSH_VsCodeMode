/**
 * lsp/providers.ts 原生导航委托测试。
 *
 * 背景：插件曾自研 Ctrl+点击（onMouseDown → 查引用 → 0 条时硬跳 defs[0]），
 * 在「有多个定义但 0 条其它引用」时直接跳走、不给用户选择余地；换用完整 Monaco 后
 * 原生 Ctrl+点击（gotoDefinitionAtPosition）也同时激活，两套路径互相竞争。
 * 现统一委托原生：多结果弹 Peek 让用户选，无定义时按 alternativeDefinitionCommand 降级。
 * 本文件锁定：①自研鼠标路径确已移除；②F12/Shift+F12 走原生命令通道。
 * 作者 ddj 2026-09-11
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as providers from '../src/client/monaco/lsp/providers.js'

const SRC = readFileSync(join(process.cwd(), 'src', 'client', 'monaco', 'lsp', 'providers.ts'), 'utf8')

/** 捕获的状态栏文案（setStatus 经 window 事件派发，node 环境需桩）。 */
const statusTexts: string[] = []

beforeEach(() => {
  statusTexts.length = 0
  // setStatus 通过 window.dispatchEvent('edrv:status') 上报，node 环境无 window → 补最小桩
  ;(globalThis as Record<string, unknown>).window = {
    dispatchEvent: (event: { detail?: { text?: string } }) => {
      if (event?.detail?.text) statusTexts.push(String(event.detail.text))
      return true
    },
  }
  ;(globalThis as Record<string, unknown>).CustomEvent = class {
    detail: unknown
    constructor(_type: string, init?: { detail?: unknown }) { this.detail = init?.detail }
  }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).CustomEvent
})

/** 假 Monaco 编辑器：记录 trigger 调用，并按需提供 referencesController contribution。 */
function fakeEditor(options: { peek?: boolean } = {}) {
  const triggers: Array<{ source: string; id: string }> = []
  return {
    triggers,
    trigger(source: string, id: string) { triggers.push({ source, id }) },
    getContribution(id: string) {
      if (id === 'editor.contrib.referencesController') return options.peek === false ? null : { id }
      return null
    },
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    setPosition() {},
    getModel: () => null,
  }
}

describe('原生导航委托：自研鼠标路径已移除', () => {
  it('不再导出 bindLspEditor（自研 Ctrl+点击入口）', () => {
    expect('bindLspEditor' in providers).toBe(false)
  })

  it('源码不再注册 onMouseDown / preventDefault 拦截（竞争源已消除）', () => {
    expect(SRC.includes('onMouseDown')).toBe(false)
    expect(SRC.includes('__edrvLspClick')).toBe(false)
  })

  it('不再有「0 条引用时硬跳首个定义」的自研降级分支', () => {
    // 该分支的判定特征：查引用 → 查定义 → jumpToLocation(defs[0])
    expect(SRC.includes('gotoRefsAt')).toBe(false)
    expect(SRC.includes('filterOtherRefs')).toBe(false)
  })
})

describe('Lua 表字段声明 Ctrl+点击', () => {
  /** 构造只提供字段检测所需 API 的 Lua 文档。@author ddj 2026年10月16号 */
  function luaModel(lines: string[]) {
    return {
      getLanguageId: () => 'lua',
      getLineContent: (line: number) => lines[line - 1],
      getWordAtPosition: ({ lineNumber, column }: { lineNumber: number; column: number }) => {
        const line = lines[lineNumber - 1]
        const match = /[A-Za-z_][A-Za-z0-9_]*/g
        let word: RegExpExecArray | null
        while ((word = match.exec(line))) {
          if (column > word.index && column <= word.index + word[0].length) {
            return { word: word[0], startColumn: word.index + 1, endColumn: word.index + word[0].length + 1 }
          }
        }
        return null
      },
    }
  }

  it('只识别 EventId 表内枚举键声明，不把使用点或普通赋值当声明', () => {
    const model = luaModel([
      'EventId.ISTaskSystem = {',
      '    TaskStateChange = 50000,',
      '    HideISTaskMainView = 50001,',
      '}',
      'EventId.ISTaskSystem.TaskStateChange = 42',
      'local TaskStateChange = 5',
    ])
    expect(providers.isLuaTableKey(model, { lineNumber: 2, column: 9 })).toBe(true)
    expect(providers.isLuaTableKey(model, { lineNumber: 3, column: 9 })).toBe(true)
    expect(providers.isLuaTableKey(model, { lineNumber: 5, column: 30 })).toBe(false)
    expect(providers.isLuaTableKey(model, { lineNumber: 6, column: 8 })).toBe(false)
  })

  it('字段 Ctrl+点击只打开一次引用 Peek；非字段点击不接管', () => {
    const listeners = new Map<string, (event: any) => void>()
    const ed = fakeEditor() as ReturnType<typeof fakeEditor> & Record<string, any>
    const model = luaModel(['EventId.ISTaskSystem = {', '    TaskStateChange = 50000,', '}'])
    const position = { lineNumber: 2, column: 9 }
    const setPositions: unknown[] = []
    ed.getDomNode = () => ({
      addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    })
    ed.getTargetAtClientPoint = () => ({ type: 6, position })
    ed.getModel = () => model
    ed.setPosition = (pos: unknown) => setPositions.push(pos)
    const unbind = providers.bindLuaKeyRefs(ed, { editor: { MouseTargetType: { CONTENT_TEXT: 6 } } })
    const intercepted: string[] = []
    const event = { button: 0, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
      clientX: 1, clientY: 1, preventDefault: () => intercepted.push('default'),
      stopPropagation: () => intercepted.push('propagation') }
    listeners.get('mousedown')?.(event)
    expect(intercepted).toEqual(['default', 'propagation'])
    expect(setPositions).toEqual([position])
    expect(ed.triggers).toEqual([{ source: 'edrv-lsp', id: 'editor.action.referenceSearch.trigger' }])
    listeners.get('mouseup')?.({ ...event, ctrlKey: false })
    expect(intercepted).toEqual(['default', 'propagation', 'default', 'propagation'])
    listeners.get('mousedown')?.({ ...event, ctrlKey: false })
    expect(ed.triggers).toHaveLength(1)
    unbind()
    expect(listeners.has('mousedown')).toBe(false)
    expect(listeners.has('mouseup')).toBe(false)
  })
})

describe('原生导航委托：命令通道', () => {
  it('runGoToDefinition 走原生 revealDefinition（多定义由原生弹 Peek）', async () => {
    const ed = fakeEditor()
    await providers.runGoToDefinition(ed)
    expect(ed.triggers).toEqual([{ source: 'edrv-lsp', id: 'editor.action.revealDefinition' }])
  })

  it('runGoToDefinition 对空编辑器安全返回', async () => {
    await expect(providers.runGoToDefinition(null)).resolves.toBeUndefined()
  })

  it('runFindReferences 走原生 referenceSearch.trigger', async () => {
    const ed = fakeEditor()
    await providers.runFindReferences(ed)
    expect(ed.triggers).toEqual([{ source: 'edrv-lsp', id: 'editor.action.referenceSearch.trigger' }])
  })

  it('runFindReferences 无光标位置时不触发（避免对空位置查询）', async () => {
    const ed = fakeEditor()
    ed.getPosition = () => null
    await providers.runFindReferences(ed)
    expect(ed.triggers).toEqual([])
  })

  it('缺少 referencesController 时给出可见提示而非静默失败', async () => {
    const ed = fakeEditor({ peek: false })
    const ok = await providers.triggerReferencePeek(ed)
    expect(ok).toBe(false)
    expect(ed.triggers).toEqual([])
    // 关键：不能静默 —— 必须上报可见原因
    expect(statusTexts.length).toBe(1)
    expect(statusTexts[0]).toContain('不支持引用预览')
  })
})
