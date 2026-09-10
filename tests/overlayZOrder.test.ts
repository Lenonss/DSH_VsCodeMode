/**
 * 浮层层级（z-index 阶梯）回归测试。
 *
 * 事故回顾：`.edrv-snip-mask` 曾为 z-index 192、`.edrv-palette` 为 191，
 * 于是片段浮窗打开时命令栏被遮罩整体盖住；又因 openCommandPalette 对「已打开」
 * 直接 return，按 Ctrl+Shift+P 毫无反应（用户报「调不出来」）。
 *
 * 本文件守两件事：
 * ① 静态层级契约：命令栏必须高于片段浮窗；片段二级弹窗高于一级且都低于命令栏；
 * ② 唤起语义：已打开时重复唤起**不是**空操作（必须有可观测通知 / 序号推进）。
 * 作者 ddj 2026-09-10
 */
import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  closeCommandPalette, isPaletteOpen, openCommandPalette, paletteOpenSeq, subscribePalette,
} from '../src/client/commandPaletteStore.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CSS = readFileSync(ROOT + 'src/client/styles/editor.css', 'utf8')

/**
 * 取某个类选择器在样式表里声明的 z-index（取该规则行内首个匹配；支持带短横线的类名）。
 * @author ddj 2026年09月10号
 * @param cls 类名（不含点）
 * @returns z-index 数值；未声明返回 null
 */
function zIndexOf(cls: string): number | null {
  const re = new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '\\s*\\{[^}]*?z-index:\\s*(\\d+)')
  const m = re.exec(CSS)
  return m ? Number(m[1]) : null
}

describe('浮层 z-index 阶梯（静态契约）', () => {
  it('各浮层都声明了 z-index（防正则失效导致空断言）', () => {
    for (const cls of ['edrv-palette', 'edrv-palette-mask', 'edrv-snip-mask', 'edrv-snip-mask-top']) {
      expect(zIndexOf(cls), cls).not.toBeNull()
    }
  })

  it('命令栏必须高于片段浮窗遮罩（事故根因，禁止回退）', () => {
    const palette = zIndexOf('edrv-palette')!
    const snipMask = zIndexOf('edrv-snip-mask')!
    expect(palette, '命令栏 ' + palette + ' 必须 > 片段遮罩 ' + snipMask).toBeGreaterThan(snipMask)
  })

  it('命令栏高于片段二级弹窗（二级也不得盖住命令栏）', () => {
    expect(zIndexOf('edrv-palette')!).toBeGreaterThan(zIndexOf('edrv-snip-mask-top')!)
  })

  it('片段二级弹窗高于一级浮窗，且一级高于命令栏遮罩', () => {
    expect(zIndexOf('edrv-snip-mask-top')!).toBeGreaterThan(zIndexOf('edrv-snip-mask')!)
    expect(zIndexOf('edrv-snip-mask')!).toBeGreaterThan(zIndexOf('edrv-palette-mask')!)
  })

  it('命令栏高于其遮罩（同族内部顺序）', () => {
    expect(zIndexOf('edrv-palette')!).toBeGreaterThan(zIndexOf('edrv-palette-mask')!)
  })
})

describe('命令栏唤起语义（不允许静默无操作）', () => {
  afterEach(() => closeCommandPalette())

  it('重复唤起会通知订阅者并推进序号（快捷键始终有可观测响应）', () => {
    closeCommandPalette()
    let notified = 0
    const unsubscribe = subscribePalette(() => { notified += 1 })

    openCommandPalette('test')
    const seq1 = paletteOpenSeq()
    expect(isPaletteOpen()).toBe(true)
    const after1 = notified
    expect(after1).toBeGreaterThan(0)

    // 已打开时再次唤起：旧实现直接 return（0 次通知）→ 表现为"快捷键失效"
    openCommandPalette('keybinding-again')
    expect(notified, '重复唤起必须通知').toBeGreaterThan(after1)
    expect(paletteOpenSeq(), '重复唤起应推进序号').toBeGreaterThan(seq1)
    expect(isPaletteOpen()).toBe(true)

    unsubscribe()
  })

  it('关闭后再唤起恢复正常', () => {
    closeCommandPalette()
    expect(isPaletteOpen()).toBe(false)
    const before = paletteOpenSeq()
    openCommandPalette('reopen')
    expect(isPaletteOpen()).toBe(true)
    expect(paletteOpenSeq()).toBeGreaterThan(before)
  })

  it('关闭是空操作安全（重复关闭不抛错、不扣减序号）', () => {
    openCommandPalette('t')
    const seq = paletteOpenSeq()
    closeCommandPalette()
    closeCommandPalette()
    expect(isPaletteOpen()).toBe(false)
    expect(paletteOpenSeq()).toBe(seq)
  })
})

describe('装配层接线（打开片段浮窗前先关命令栏）', () => {
  const source = readFileSync(ROOT + 'src/client/ui/EditorView.ts', 'utf8')

  it('片段命令在打开浮窗前调用 closeCommandPalette', () => {
    // 两条片段命令都必须先关命令栏，避免残留"已打开但被遮住"的命令栏
    const configure = source.match(/edrv\.command\.configureSnippets[^\]]*closeCommandPalette/)
    const insert = source.match(/edrv\.command\.insertSnippet[^\]]*closeCommandPalette/)
    expect(configure, 'configureSnippets 未先关命令栏').not.toBeNull()
    expect(insert, 'insertSnippet 未先关命令栏').not.toBeNull()
  })

  it('命令栏组件订阅唤起序号以在重复唤起时重新聚焦', () => {
    const palette = readFileSync(ROOT + 'src/client/ui/CommandPalette.ts', 'utf8')
    expect(palette).toContain('paletteOpenSeq')
    expect(palette).toMatch(/openSeq/)
  })
})
