/** Browser application URL resolution shared by transport and asset loaders. @author ddj 2026年09月28号 */

/**
 * Resolve a product-local path under the current application's document base.
 * Supports HTTP reverse-proxy prefixes and the official Desktop dsh-app origin.
 * @author ddj 2026年09月28号
 * @param path Root-shaped internal endpoint or asset path; never an external URL.
 * @param base Explicit document base for tests; otherwise document.baseURI or location.href.
 * @returns Absolute application URL, or the original root path outside a browser.
 */
export function appUrl(path: string, base?: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Expected an application-local path')
  const source = base ?? (typeof document !== 'undefined' ? document.baseURI : undefined)
    ?? (typeof location !== 'undefined' ? location.href : undefined)
  if (!source) return path
  const root = new URL('.', source)
  if (!['http:', 'https:', 'dsh-app:'].includes(root.protocol)) throw new Error('Unsupported application origin')
  return new URL(path.slice(1), root).href
}
