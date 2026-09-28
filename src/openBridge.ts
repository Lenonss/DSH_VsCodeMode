import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assetsDirOf, PLUGIN_ID } from './paths.js'
import { findProfileDir } from './devForm.js'
import { checkOpenPath, ensureOpenInbox, secureOpenDir } from './openInbox.js'
import { INTEGRATION_BASE_DEFAULT } from './shared/integration.js'
import type { Ctx } from './store.js'

/** @public @author ddj 2026年09月28号
 * Serialize only public launcher metadata, rejecting INI line injection.
 * @param baseUrl Selected public Web URL.
 * @param metadata Profile and local producer metadata.
 * @returns Complete INI document.
 */
export function openIni(baseUrl: string, metadata: Record<string, string> = {}): string {
  for (const value of [baseUrl, ...Object.values(metadata)]) if (/[\r\n\0]/.test(value)) throw new Error('无效的 launcher 配置')
  const extra = Object.entries(metadata).map(([key, value]) => key + '=' + value + '\n').join('')
  return '[dsh]\nbase=' + (baseUrl.trim() || INTEGRATION_BASE_DEFAULT) + '\n' + extra
}

/** @public @author ddj 2026年09月28号
 * Write transport metadata and helper without touching OS registration.
 * @param ctx Active host context.
 * @param dir Existing launcher or profile bridge directory.
 * @param baseUrl Configured public Web URL.
 * @param securedInbox Optional inbox already protected by this caller.
 */
export async function writeOpenConfig(ctx: Ctx, dir: string, baseUrl: string, securedInbox?: string): Promise<void> {
  const profile = findProfileDir(ctx)
  if (!profile) throw new Error('无法识别当前 DSH profile')
  const inbox = securedInbox ?? await ensureOpenInbox(profile)
  const helper = join(dir, 'dsh-open.mjs')
  await checkOpenPath(dir)
  await replaceOpen(helper, await readFile(join(assetsDirOf(import.meta.url), 'shell', 'dsh-open.mjs')))
  const info = ctx.get('profileContext') as { name?: string } | undefined
  const mode = info?.name === 'desktop' && process.versions.electron ? 'desktop' : 'web'
  const metadata = { mode, profile, inbox, helper, node: process.execPath, nodeMode: process.versions.electron ? 'electron' : 'node' }
  await replaceOpen(join(dir, 'dsh-open.ini'), openIni(baseUrl, metadata))
}

/** @public @author ddj 2026年09月28号
 * Provision an independent per-profile producer for Unity without a shell-menu marker.
 * @param ctx Current profile context.
 * @param baseUrl Selected public Web URL.
 * @returns Absolute profile bridge INI path.
 */
export async function ensureOpenBridge(ctx: Ctx, baseUrl: string): Promise<string> {
  const profile = findProfileDir(ctx)
  if (!profile) throw new Error('无法识别当前 DSH profile')
  const inbox = await ensureOpenInbox(profile)
  const dir = join(profile, PLUGIN_ID, 'bridge')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await secureOpenDir(dir)
  await writeOpenConfig(ctx, dir, baseUrl, inbox)
  return join(dir, 'dsh-open.ini')
}

/** @private @author ddj 2026年09月28号
 * Replace a bridge file atomically without following a preexisting file link.
 * @param path Destination in the validated bridge directory.
 * @param content Trusted bundled helper or generated metadata.
 */
async function replaceOpen(path: string, content: string | Buffer): Promise<void> {
  await checkOpenPath(dirname(path))
  const temporary = path + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
  try { await rename(temporary, path) } finally { await unlink(temporary).catch(() => {}) }
}
