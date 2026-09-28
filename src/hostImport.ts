/** Host-anchored optional package imports. @author ddj 2026年09月28号 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * Resolve against the running DSH entry before the plugin's development dependencies.
 * Import failures after successful resolution are preserved, not hidden by an older copy.
 * @author ddj 2026年09月28号
 * @param specifier Host package name.
 * @returns The evaluated host module namespace.
 */
export async function loadHostModule(specifier: string): Promise<unknown> {
  const anchor = process.argv[1]
  let resolved: string | undefined
  if (anchor) {
    try { resolved = createRequire(anchor).resolve(specifier) } catch { /* Source-only tests may have no Host tree. */ }
  }
  return import(resolved ? pathToFileURL(resolved).href : specifier)
}
