import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { patchLauncher, readQuickMenu, resetMenuCache, saveQuickMenu } from '../src/quickMenu.js'
import { quickMenuFile } from '../src/paths.js'
import { defaultDoc, normalizeDoc } from '../src/shared/quickMenu.js'
import type { QuickButton, QuickMenuDoc } from '../src/shared/quickMenu.js'

let home = ''

/** 造一份带一个按钮的最小文档。 */
function docWithButton(prompt = '检查提交'): QuickMenuDoc {
  return normalizeDoc({
    items: [{ id: 'b1', type: 'button', name: '检查', order: 10, prompt }],
  })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'edrv-quickmenu-'))
  resetMenuCache()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  resetMenuCache()
})

describe('quickMenu host storage', () => {
  it('returns defaults when the file is missing', async () => {
    const state = await readQuickMenu(home)
    expect(state.doc.items).toEqual([])
    expect(state.doc.enabled).toBe(true)
    expect(state.warning).toBeUndefined()
  })

  it('creates the file on first save and bumps revision', async () => {
    const result = await saveQuickMenu(docWithButton(), 0, home)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doc.revision).toBe(1)
    const reread = await readQuickMenu(home)
    expect(reread.doc.revision).toBe(1)
    expect((reread.doc.items[0] as QuickButton).prompt).toBe('检查提交')
    const raw = JSON.parse(readFileSync(quickMenuFile(home), 'utf8'))
    expect(raw.items.length).toBe(1)
  })

  it('rejects a stale baseRevision without touching the file', async () => {
    const first = await saveQuickMenu(docWithButton('第一版'), 0, home)
    expect(first.ok).toBe(true)
    const stale = await saveQuickMenu(docWithButton('第二版'), 0, home)
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.error).toContain('其他窗口')
    const reread = await readQuickMenu(home)
    expect((reread.doc.items[0] as QuickButton).prompt).toBe('第一版')
  })

  it('backs up a corrupt file, resets it and reports a warning', async () => {
    const file = quickMenuFile(home)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(home, 'dsh-vscode-mode', 'data'), { recursive: true })
    writeFileSync(file, '{ broken json', 'utf8')
    const state = await readQuickMenu(home)
    expect(state.warning).toContain('解析失败')
    expect(state.doc.items).toEqual([])
    // 坏文件已另存，且主文件被重写成合法 JSON
    const backups = readdirSync(join(home, 'dsh-vscode-mode', 'data')).filter((name) => name.includes('.bad-'))
    expect(backups.length).toBeGreaterThan(0)
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow()
  })

  it('patches the launcher without bumping revision or losing items', async () => {
    const first = await saveQuickMenu(docWithButton(), 0, home)
    expect(first.ok).toBe(true)
    const patched = await patchLauncher({ x: 120, y: 340 }, home)
    expect(patched.ok).toBe(true)
    if (!patched.ok) return
    expect(patched.doc.revision).toBe(1)
    expect(patched.doc.launcher).toEqual({ x: 120, y: 340 })
    expect(patched.doc.items.length).toBe(1)
  })

  it('rejects documents above the item and byte caps', async () => {
    // 直接绕过 normalize 提交未裁剪文档：host 必须拒绝而不是静默截断用户数据
    const rawItems = Array.from({ length: 201 }, (_, index) => ({ id: 'b' + index, type: 'button', name: 'n' + index, prompt: 'p' }))
    const tooMany = await saveQuickMenu({ ...defaultDoc(), items: rawItems } as unknown as QuickMenuDoc, 0, home)
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.error).toContain('上限')
    const huge = normalizeDoc({
      items: Array.from({ length: 120 }, (_, index) => ({ id: 'c' + index, type: 'button', name: 'c' + index, prompt: 'x'.repeat(8000) })),
    })
    const tooBig = await saveQuickMenu(huge, 0, home)
    expect(tooBig.ok).toBe(false)
    if (tooBig.ok) return
    expect(tooBig.error).toContain('容量上限')
  })

  it('keeps the on-disk launcher when saving the document', async () => {
    // 拖拽/重置位置与表单保存并发时，表单里的旧坐标不能把磁盘坐标顶回去。
    const first = await saveQuickMenu(docWithButton(), 0, home)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const moved = await patchLauncher({ x: 40, y: 50 }, home)
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    const submitted = { ...first.doc, launcher: { x: 999, y: 999 } }
    const saved = await saveQuickMenu(submitted, first.doc.revision, home)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.doc.launcher).toEqual({ x: 40, y: 50 })
  })

  it('serves repeated reads from cache until the file changes', async () => {
    await saveQuickMenu(docWithButton(), 0, home)
    const first = await readQuickMenu(home)
    const second = await readQuickMenu(home)
    expect(second).toBe(first)
    writeFileSync(quickMenuFile(home), JSON.stringify(defaultDoc()), 'utf8')
    const third = await readQuickMenu(home)
    expect(third.doc.revision).toBe(0)
  })
})
