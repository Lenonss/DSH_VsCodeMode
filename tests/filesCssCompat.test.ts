import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFilesCss, patchFilesCss } from '../src/client/filesCssCompat.js'

const desktop = ':has(>.k-1LKG_navigator.k-1LKG_fill)>:not(.k-1LKG_navigator){visibility:hidden}'
const mobile = ':has(>.k-1LKG_navigator:not(.k-1LKG_wholePage))>:not(.k-1LKG_navigator){visibility:hidden}'
const original = `.before{color:red}${desktop}@media(width<768px){${mobile}}`
const marker = 'data-edrv-files-peer'

/** @private @author ddj 2026年11月09号 @description Minimal DOM with real parent/reparent semantics for compatibility ownership tests. */
class FakeElement {
  nodeType = 1
  isConnected = true
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  attrs = new Map<string, string>()
  textContent = ''
  /** @public @author ddj 2026年11月09号 @param nav Whether the element is an official navigator. */
  constructor(public nav = false) {}
  /** @public @author ddj 2026年11月09号 @param child Direct child to attach. */
  append(child: FakeElement): void { child.parentElement = this; this.children.push(child) }
  /** @public @author ddj 2026年11月09号 @returns Whether this is an official navigator. */
  matches(): boolean { return this.nav }
  /** @public @author ddj 2026年11月09号 @returns Descendant navigators only. */
  querySelectorAll(): FakeElement[] { return this.children.flatMap(child => [...(child.nav ? [child] : []), ...child.querySelectorAll()]) }
  /** @public @author ddj 2026年11月09号 @param key Attribute name. @returns Attribute presence. */
  hasAttribute(key: string): boolean { return this.attrs.has(key) }
  /** @public @author ddj 2026年11月09号 @param key Attribute name. @param text Attribute content. */
  setAttribute(key: string, text: string): void { this.attrs.set(key, text) }
  /** @public @author ddj 2026年11月09号 @param key Attribute name to remove. */
  removeAttribute(key: string): void { this.attrs.delete(key) }
}

/** @private @author ddj 2026年11月09号 @description Set up a bounded fake document and explicit mutation delivery. @returns Fixture controls. */
function fixture(css = original) {
  const body = new FakeElement()
  const head = new FakeElement()
  const sheet = new FakeElement()
  sheet.textContent = css
  const observers: { callback: (records: unknown[]) => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('MutationObserver', class {
    observe = vi.fn()
    disconnect = vi.fn()
    constructor(public callback: (records: unknown[]) => void) { observers.push(this) }
  })
  vi.stubGlobal('document', { body, head, querySelectorAll: () => sheet.isConnected ? [sheet] : [] })
  return { body, sheet, observers }
}

afterEach(() => vi.unstubAllGlobals())

describe('official FilesBody CSS compatibility', () => {
  it('restricts both rightmost targets, retaining media queries and specificity', () => {
    const patched = patchFilesCss(original)!
    expect(patched).toContain(':has(>.k-1LKG_navigator.k-1LKG_fill)>:where([data-edrv-files-peer]):not(')
    expect(patched).toContain(`@media(width<768px){${mobile.replace('>:not(', '>:where([data-edrv-files-peer]):not(')}}`)
    expect(patched.startsWith('.before{color:red}')).toBe(true)
    expect(patchFilesCss(patched)).toBeNull()
  })

  it.each([desktop, original + desktop, original.replace('visibility:hidden', 'visibility:collapse')])('skips unknown or ambiguous versions', css => {
    expect(patchFilesCss(css)).toBeNull()
  })

  it('marks arbitrary direct siblings, not descendants or unrelated nodes, and restores on unload', () => {
    const { body, sheet, observers } = fixture()
    const parent = new FakeElement()
    const nav = new FakeElement(true)
    const peer = new FakeElement()
    const nested = new FakeElement()
    peer.append(nested)
    parent.append(nav); parent.append(peer); body.append(parent)
    const dispose = installFilesCss()
    expect(peer.hasAttribute(marker)).toBe(true)
    expect(nav.hasAttribute(marker)).toBe(false)
    expect(nested.hasAttribute(marker)).toBe(false)
    expect(sheet.textContent).toBe(patchFilesCss(original))
    expect(observers[0].observe).toHaveBeenCalledWith(body, { childList: true, subtree: true })
    dispose()
    expect(peer.hasAttribute(marker)).toBe(false)
    expect(sheet.textContent).toBe(original)
    expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true)
  })

  it('handles late navigator insertion, sibling replacement, removal and remount', () => {
    const { body, observers } = fixture()
    const dispose = installFilesCss()
    const parent = new FakeElement()
    const nav = new FakeElement(true)
    const peer = new FakeElement()
    parent.append(nav); parent.append(peer); body.append(parent)
    observers[0].callback([{ addedNodes: [parent] }])
    expect(peer.hasAttribute(marker)).toBe(true)
    const replacement = new FakeElement()
    parent.children = [nav]; parent.append(replacement)
    observers[0].callback([{ addedNodes: [replacement] }])
    expect(peer.hasAttribute(marker)).toBe(false)
    expect(replacement.hasAttribute(marker)).toBe(true)
    parent.children = [replacement]
    observers[0].callback([{ addedNodes: [] }])
    expect(replacement.hasAttribute(marker)).toBe(false)
    parent.append(nav)
    observers[0].callback([{ addedNodes: [nav] }])
    expect(replacement.hasAttribute(marker)).toBe(true)
    dispose()
  })

  it('supports late known CSS and does not overwrite external stylesheet revisions on disposal', () => {
    const { sheet, observers } = fixture('unknown')
    const dispose = installFilesCss()
    expect(observers[0].observe).not.toHaveBeenCalled()
    sheet.textContent = original
    observers[1].callback([])
    expect(sheet.textContent).toBe(patchFilesCss(original))
    sheet.textContent = '.new-version{visibility:visible}'
    dispose()
    expect(sheet.textContent).toBe('.new-version{visibility:visible}')
  })

  it('does not rescan the body on unrelated head changes or overwrite preexisting markers', () => {
    const { body, observers } = fixture()
    const parent = new FakeElement()
    const peer = new FakeElement()
    peer.setAttribute(marker, 'foreign')
    parent.append(new FakeElement(true)); parent.append(peer); body.append(parent)
    const scan = vi.spyOn(body, 'querySelectorAll')
    const dispose = installFilesCss()
    scan.mockClear()
    observers[1].callback([])
    expect(scan).not.toHaveBeenCalled()
    dispose()
    expect(peer.attrs.get(marker)).toBe('foreign')
  })
})
