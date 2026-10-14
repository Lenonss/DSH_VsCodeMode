import { describe, expect, it, vi } from 'vitest'
import { revealTreeRow, treeRevealPath } from '../src/client/sidebar/panels/useExplorerReveal.js'

/** @private @author ddj 2026年10月14号 @param top Row top. @returns Minimal scroll host with an exact row. */
function hostOf(top = 350) {
  const row = { getBoundingClientRect: () => ({ top, bottom: top + 20, height: 20 }) }
  return { clientHeight: 200, clientTop: 2, scrollTop: 50,
    getBoundingClientRect: () => ({ top: 100 }), querySelector: vi.fn(() => row) }
}

describe('tree reveal geometry and paths', () => {
  it('normalizes relative paths and rejects external or traversal targets', () => {
    expect(treeRevealPath('./dir\\文件 name.ts')).toBe('dir/文件 name.ts')
    expect(treeRevealPath('a.ts')).toBe('a.ts')
    for (const path of [null, '', '/tmp/a', 'C:\\a', 'dir/../a']) expect(treeRevealPath(path)).toBeNull()
  })
  it('centers an offscreen row by moving only the host', () => {
    const host = hostOf()
    expect(revealTreeRow(host as any, 'dir/a')).toBe(true)
    expect(host.scrollTop).toBe(208)
  })
  it('does not scroll an already visible row', () => {
    const host = hostOf(150)
    expect(revealTreeRow(host as any, 'a.ts')).toBe(true)
    expect(host.scrollTop).toBe(50)
  })
  it('keeps hidden or missing rows pending', () => {
    const host = hostOf()
    host.clientHeight = 0
    expect(revealTreeRow(host as any, 'a')).toBe(false)
    host.clientHeight = 200
    host.querySelector.mockReturnValue(null as any)
    expect(revealTreeRow(host as any, 'a')).toBe(false)
    expect(revealTreeRow(null, 'a')).toBe(false)
    expect(host.scrollTop).toBe(50)
  })
  it('escapes quotes in exact attribute selectors', () => {
    const host = hostOf()
    revealTreeRow(host as any, 'dir/a" b.ts')
    expect(host.querySelector).toHaveBeenCalledWith('[data-edrv-path="dir/a\\" b.ts"]')
  })
})
