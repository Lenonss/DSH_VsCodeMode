/**
 * 编辑器模型探测（hasEditorView / hasEditorModel）回归测试。
 *
 * 事故回顾（用户报「Ctrl+U 没有效果」）：
 * 旧实现判定 `.monaco-editor textarea.inputarea`，而 Monaco 在支持 EditContext API 的
 * 浏览器（Chrome/Edge）里**默认**用它取代 textarea（只创建 div.native-edit-context，
 * 源码 `editContext: se(44,"editContext",!0)`）。于是「编辑器开着文件」仍被判为无模型：
 *   · 13 条 needsModel 命令被静默隐藏（含 Ctrl+U 加引用、命令栏里的保存/转到定义/查找引用…）
 *   · 桥接键位因可用性判定失败而**主动放行**按键（不吞键）→ 表现为「快捷键完全没效果」
 * 实测证据：编辑器开启时 textarea.inputarea=0、div.native-edit-context=1、hasEditorModel()=false。
 *
 * 本文件钉住：判据与输入实现无关、空态为 false、不误命中官方预览的 Monaco。
 * 作者 ddj 2026-09-10
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EDITOR_MODEL_SELECTOR, EDITOR_ROOT_SELECTOR, hasEditorModel, hasEditorView,
} from '../src/client/editorModelState.js'

/** 极简 DOM 节点（只承载类名与子节点，足够验证类名选择器语义）。 */
interface FakeEl {
  classes: string[]
  children: FakeEl[]
}

/**
 * 创建假节点。
 * @param classes 空格分隔的类名
 * @param children 子节点
 * @returns 假节点
 */
function el(classes: string, children: FakeEl[] = []): FakeEl {
  return { classes: classes.split(/\s+/).filter(Boolean), children }
}

/** 节点是否匹配单段类名选择器（`.a.b`）。 */
function matchesSimple(node: FakeEl, selector: string): boolean {
  const names = selector.split('.').filter(Boolean)
  return names.every((name) => node.classes.includes(name))
}

/** 遍历后代（不含自身）。 */
function walkDescendants(node: FakeEl, visit: (n: FakeEl) => void): void {
  for (const child of node.children) {
    visit(child)
    walkDescendants(child, visit)
  }
}

/**
 * 实现后代选择器查询（支持 `.a .b` 组合；本文件只用类名选择器）。
 * @param root 根节点（模拟 document）
 * @param selector 选择器
 * @returns 首个命中节点或 null
 */
function querySelector(root: FakeEl, selector: string): FakeEl | null {
  const parts = selector.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  let candidates: FakeEl[] = []
  walkDescendants(root, (n) => { if (matchesSimple(n, parts[0])) candidates.push(n) })
  for (let i = 1; i < parts.length; i += 1) {
    const next: FakeEl[] = []
    for (const candidate of candidates) {
      walkDescendants(candidate, (n) => { if (matchesSimple(n, parts[i])) next.push(n) })
    }
    candidates = next
  }
  return candidates.length ? candidates[0] : null
}

/** 把假 DOM 挂到 globalThis.document（无 jsdom，故手工注入）。 */
function mount(documentRoot: FakeEl): void {
  ;(globalThis as unknown as { document: unknown }).document = {
    querySelector: (selector: string) => querySelector(documentRoot, selector),
  }
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document
})

/** EditContext 输入实现下的编辑器行（无 textarea.inputarea）—— 本 bug 的现场。 */
function editContextEditorRow(): FakeEl {
  return el('edrv-editor-row', [
    el('overflow-guard', [
      el('native-edit-context', [el('ime-text-area')]),
    ]),
    el('monaco-editor'),
  ])
}

describe('hasEditorModel（判据须与 Monaco 输入实现无关）', () => {
  it('EditContext 实现下仍判定为有模型（回归：曾因 textarea.inputarea 恒 false）', () => {
    mount(el('root', [el('edrv-view-side', [editContextEditorRow()])]))
    // 现场事实：没有 textarea.inputarea，只有 native-edit-context
    expect(querySelector(el('x', [editContextEditorRow()]), '.monaco-editor textarea.inputarea')).toBeNull()
    expect(hasEditorModel(), '有 Monaco 实例即应有模型，与输入实现无关').toBe(true)
  })

  it('textarea 实现下同样判定为有模型（防反方向回归）', () => {
    mount(el('root', [
      el('edrv-view-side', [el('edrv-editor-row', [
        el('monaco-editor', [el('textarea inputarea')]),
      ])]),
    ]))
    expect(hasEditorModel()).toBe(true)
  })

  it('空态（编辑器行在、无文件）判定为无模型 —— 与旧语义一致', () => {
    // 实测：关掉最后一个页签后 .monaco-editor 不存在、.edrv-editor-row 仍在
    mount(el('root', [el('edrv-view-side', [el('edrv-editor-row', [el('edrv-editor-empty')])])]))
    expect(hasEditorModel()).toBe(false)
  })

  it('仅官方预览的 Monaco（在插件编辑器行之外）不得判定为有模型', () => {
    // 若判据只用 .monaco-editor，官方预览/文档预览会误命中 → 无编辑器时 Ctrl+U 会吞键
    mount(el('root', [
      el('sidebar-right', [el('monaco-editor')]),
      el('edrv-editor-row', [el('edrv-editor-empty')]),
    ]))
    expect(hasEditorModel()).toBe(false)
  })

  it('无 document 的运行环境（纯 Node）返回 false 且不抛错', () => {
    expect(hasEditorModel()).toBe(false)
  })
})

describe('hasEditorView', () => {
  it('编辑器行存在 → true', () => {
    mount(el('root', [el('edrv-editor-row')]))
    expect(hasEditorView()).toBe(true)
  })

  it('仅有浮层 portal（data-edrv-view 但不含编辑器行）→ false（旧判据会误判为有编辑器）', () => {
    mount(el('root', [el('edrv-palette-mask', [el('edrv-palette')])]))
    expect(hasEditorView()).toBe(false)
  })

  it('无 document 时返回 false 且不抛错', () => {
    expect(hasEditorView()).toBe(false)
  })
})

describe('判据选择器源码契约', () => {
  const raw = fs.readFileSync(
    path.join(process.cwd(), 'src', 'client', 'editorModelState.ts'),
    'utf8',
  )
  // 只看可执行代码：注释里会（正当地）解释本次事故而提到 textarea/inputarea
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('禁止依赖 Monaco 的 textarea 输入实现（曾被 EditContext 取代而静默失效）', () => {
    expect(code.includes('textarea'), '探测不得绑定 textarea（EditContext 浏览器无此节点）').toBe(false)
    expect(code.includes('inputarea')).toBe(false)
  })

  it('选择器限定在插件编辑器行内（避免误命中官方预览的 Monaco）', () => {
    expect(EDITOR_ROOT_SELECTOR).toBe('.edrv-editor-row')
    expect(EDITOR_MODEL_SELECTOR).toBe('.edrv-editor-row .monaco-editor')
  })
})
