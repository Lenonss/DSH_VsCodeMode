/** Known official FilesBody selectors only; no installed package files are changed. */
const STYLE = 'style[data-plugin-css="@deepseek-ai/dsh-client-ui-sidebar-files/FilesBody.module.css"]'
const NAV = '.k-1LKG_navigator'
const PEER = 'data-edrv-files-peer'
const RULES = [
  ':has(>.k-1LKG_navigator.k-1LKG_fill)>:not(.k-1LKG_navigator){visibility:hidden}',
  ':has(>.k-1LKG_navigator:not(.k-1LKG_wholePage))>:not(.k-1LKG_navigator){visibility:hidden}',
]

interface SheetPatch { original: string; patched: string }

/**
 * @public @author ddj 2026年11月09号
 * @description Restrict known wildcard targets without increasing selector specificity.
 * @param css Official inline stylesheet text.
 * @returns Patched text, or null for an unknown/ambiguous stylesheet version.
 */
export function patchFilesCss(css: string): string | null {
  if (RULES.some(rule => css.split(rule).length !== 2)) return null
  let patched = css
  for (const rule of RULES) {
    patched = patched.replace(rule, rule.replace('>:not(', `>:where([${PEER}]):not(`))
  }
  return patched
}

/** @private @author ddj 2026年11月09号 @description Own stylesheet and sibling markers for one client lifecycle. */
class FilesCssCompat {
  private readonly sheets = new Map<HTMLStyleElement, SheetPatch>()
  private readonly parents = new Set<Element>()
  private readonly marked = new Set<Element>()
  private tracking = false
  private readonly tree: MutationObserver
  private readonly head: MutationObserver

  /** @public @author ddj 2026年11月09号 @param doc Client document; only its head/body are observed. */
  constructor(private readonly doc: Document) {
    this.tree = new MutationObserver(this.onTree)
    this.head = new MutationObserver(this.onHead)
    this.head.observe(doc.head, { childList: true, subtree: true, characterData: true })
    this.syncSheets()
  }

  /** @private @author ddj 2026年11月09号 @description Reconcile only the dedicated official stylesheet, including late injection. */
  private onHead = (): void => { this.syncSheets() }

  /** @private @author ddj 2026年11月09号 @description Patch known text and stop DOM tracking when no owned patch remains. */
  private syncSheets(): void {
    for (const [sheet, patch] of this.sheets) {
      if (!sheet.isConnected || sheet.textContent !== patch.patched) this.sheets.delete(sheet)
    }
    for (const sheet of Array.from(this.doc.querySelectorAll<HTMLStyleElement>(STYLE))) {
      if (this.sheets.has(sheet)) continue
      const original = sheet.textContent ?? ''
      const patched = patchFilesCss(original)
      if (patched === null) continue
      this.sheets.set(sheet, { original, patched })
      sheet.textContent = patched
    }
    if (!this.sheets.size) {
      this.tree.disconnect()
      this.tracking = false
      this.clearPeers()
      return
    }
    if (this.tracking) return

    this.tracking = true
    this.discover(this.doc.body)
    this.syncPeers()
    this.tree.observe(this.doc.body, { childList: true, subtree: true })
  }

  /** @private @author ddj 2026年11月09号 @param root Newly inserted subtree; never scan the document on scroll or attribute changes. */
  private discover(root: Element): void {
    if (root.matches(NAV) && root.parentElement) this.parents.add(root.parentElement)
    for (const navigator of Array.from(root.querySelectorAll(NAV))) {
      if (navigator.parentElement) this.parents.add(navigator.parentElement)
    }
  }

  /** @private @author ddj 2026年11月09号 @param records Child insertion/removal records, excluding text and attributes. */
  private onTree = (records: MutationRecord[]): void => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType === 1) this.discover(node as Element)
      }
    }
    this.syncPeers()
  }

  /** @private @author ddj 2026年11月09号 @description Mark only actual direct siblings; :has still controls desktop/mobile visibility. */
  private syncPeers(): void {
    const peers = new Set<Element>()
    for (const parent of this.parents) {
      const children = Array.from(parent.children)
      if (!parent.isConnected || !children.some(child => child.matches(NAV))) {
        this.parents.delete(parent)
        continue
      }
      for (const child of children) {
        if (!child.matches(NAV)) peers.add(child)
      }
    }
    for (const child of this.marked) {
      if (peers.has(child)) continue
      child.removeAttribute(PEER)
      this.marked.delete(child)
    }
    for (const child of peers) {
      if (child.hasAttribute(PEER)) continue
      child.setAttribute(PEER, '')
      this.marked.add(child)
    }
  }

  /** @private @author ddj 2026年11月09号 @description Remove only markers created by this owner. */
  private clearPeers(): void {
    for (const child of this.marked) child.removeAttribute(PEER)
    this.marked.clear()
    this.parents.clear()
  }

  /** @public @author ddj 2026年11月09号 @description Disconnect observers and restore unchanged owned stylesheet revisions. */
  dispose = (): void => {
    this.tree.disconnect()
    this.head.disconnect()
    for (const [sheet, patch] of this.sheets) {
      if (sheet.textContent === patch.patched) sheet.textContent = patch.original
    }
    this.sheets.clear()
    this.clearPeers()
  }
}

/**
 * @public @author ddj 2026年11月09号
 * @description Install the reversible compatibility layer as a ctx.effect callback.
 * @returns Cleanup for plugin unload/HMR; missing DOM support is a no-op.
 */
export function installFilesCss(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  return new FilesCssCompat(document).dispose
}
