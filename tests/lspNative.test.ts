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
