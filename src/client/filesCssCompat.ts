/** Known official FilesBody selectors only; no installed package files are changed. */
const STYLE_NEW = 'style[data-plugin="@deepseek-ai/dsh-client-ui-sidebar-files"][data-path="src/client/FilesBody.module.css"]'
const STYLE_OLD = 'style[data-plugin-css="@deepseek-ai/dsh-client-ui-sidebar-files/FilesBody.module.css"]'
const PEER = 'data-edrv-files-peer'
/** 旧版（<=0.2.1）：官方用 :has 直接命中兄弟节点，类名哈希 k-1LKG。 */
const LEGACY_NAV = '.k-1LKG_navigator'
const RULES_OLD = [
  ':has(>.k-1LKG_navigator.k-1LKG_fill)>:not(.k-1LKG_navigator){visibility:hidden}',
  ':has(>.k-1LKG_navigator:not(.k-1LKG_wholePage))>:not(.k-1LKG_navigator){visibility:hidden}',
]
/** 0.2.3：可见性规则改挂行标记并读 CSS 变量，类名哈希仍是 k-1LKG。 */
const RULES_NEW = [
  '[data-files-navigator-row]>:not(.k-1LKG_navigator){visibility:var(--files-navigator-covered,inherit)}',
]
/** 任一哈希的 0.2.3 可见性规则（类名格式再变也不失效）。 */
const NEW_VISIBILITY = /(\[data-files-navigator-row\]\s*>\s*):not\(\.([A-Za-z0-9_-]+_navigator)\)(\s*\{\s*visibility)/g
/** 从样式文本里取官方导航器类名（取不到用旧常量）。 */
const NAV_CLASS = /\.([A-Za-z0-9_-]+_navigator)\b/

interface SheetPatch { original: string; patched: string }

/**
 * Restrict the wildcard sibling target to elements this plugin marked, keeping specificity.
 * @public @author ddj 2026年11月09号 / 2026年11月23号
 * @param rule Matched official rule text.
 * @returns Rule text with a :where() peer guard, or null when the rule is unknown.
 */
function restrictRule(rule: string): string | null {
  if (!rule.includes('>:not(')) return null
  return rule.replace('>:not(', `>:where([${PEER}]):not(`)
}

/**
 * Patch one known official stylesheet revision.
 * @public @author ddj 2026年11月09号 / 2026年11月23号
 * @param css Official inline stylesheet text.
 * @returns Patched text, or null for an unknown/ambiguous stylesheet version.
 */
export function patchFilesCss(css: string): string | null {
  const legacy = RULES_OLD.every(rule => css.split(rule).length === 2)
  if (legacy) return patchRules(css, RULES_OLD)
  const current = RULES_NEW.every(rule => css.split(rule).length === 2)
  if (current) return patchRules(css, RULES_NEW)
  // 类名哈希变化时按正则重定向，仍只认行标记这一条可见性规则
  const matches = [...css.matchAll(NEW_VISIBILITY)]
  if (matches.length !== 1) return null
  return css.replace(NEW_VISIBILITY, `$1:where([${PEER}]):not(.$2)$3`)
}

/**
 * Apply every rule replacement once.
 * @private @author ddj 2026年11月23号
 * @param css Official stylesheet text.
 * @param rules Matched rule list.
 * @returns Patched text.
 */
function patchRules(css: string, rules: string[]): string {
  let patched = css
  for (const rule of rules) {
    const restricted = restrictRule(rule)
    if (restricted) patched = patched.replace(rule, restricted)
  }
  return patched
}

/**
 * Read the official navigator class name from a stylesheet revision.
 * @public @author ddj 2026年11月23号
 * @param css Official stylesheet text.
 * @returns Class selector, or the legacy constant when unknown.
 */
export function navSelectorOf(css: string): string {
  const match = NAV_CLASS.exec(css)
  return match ? '.' + match[1] : LEGACY_NAV
}

/** @private @author ddj 2026年11月09号 @description Own stylesheet and sibling markers for one client lifecycle. */
class FilesCssCompat {
  private readonly sheets = new Map<HTMLStyleElement, SheetPatch>()
  private readonly parents = new Set<Element>()
  private readonly marked = new Set<Element>()
  private tracking = false
  private nav = LEGACY_NAV
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
    for (const sheet of Array.from(this.doc.querySelectorAll<HTMLStyleElement>(STYLE_NEW + ',' + STYLE_OLD))) {
      if (this.sheets.has(sheet)) continue
      const original = sheet.textContent ?? ''
      const patched = patchFilesCss(original)
      if (patched === null) continue
      this.nav = navSelectorOf(original)
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
    if (root.matches(this.nav) && root.parentElement) this.parents.add(root.parentElement)
    for (const navigator of Array.from(root.querySelectorAll(this.nav))) {
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

  /** @private @author ddj 2026年11月09号 @description Mark only actual direct siblings; the official rule still controls visibility. */
  private syncPeers(): void {
    const peers = new Set<Element>()
    for (const parent of this.parents) {
      const children = Array.from(parent.children)
      if (!parent.isConnected || !children.some(child => child.matches(this.nav))) {
        this.parents.delete(parent)
        continue
      }
      for (const child of children) {
        if (!child.matches(this.nav)) peers.add(child)
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
 * Install the reversible compatibility layer as a ctx.effect callback.
 * @public @author ddj 2026年11月09号
 * @returns Cleanup for plugin unload/HMR; missing DOM support is a no-op.
 */
export function installFilesCss(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  return new FilesCssCompat(document).dispose
}
