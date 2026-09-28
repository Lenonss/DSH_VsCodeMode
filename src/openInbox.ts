import { spawn } from 'node:child_process'
import { lstat, mkdir, chmod, open, rename, readdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { findProfileDir } from './devForm.js'
import { childEnv } from './childEnv.js'
import { handoffOpen, pendingState, clearPending, cancelPending } from './externalHandoff.js'
import { OPEN_ID, OPEN_MAX_BYTES, OPEN_TTL_MS, parseInboxOpen } from './shared/externalOpen.js'
import type { InboxAck, InboxOpen } from './shared/externalOpen.js'
import type { Ctx } from './store.js'

/** @public @author ddj 2026年09月28号
 * Resolve the profile-owned open-only directory.
 * @param profile Absolute active profile directory.
 * @returns Private inbox root.
 */
export function inboxDir(profile: string): string { return join(profile, 'dsh-vscode-mode', 'open-inbox') }

/** @public @author ddj 2026年09月28号
 * Reject symlink and reparse ancestors before filesystem transport operations.
 * @param path Existing path to validate.
 * @throws When any ancestor is a symlink.
 */
export async function checkOpenPath(path: string): Promise<void> {
  let current = resolve(path)
  for (;;) {
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error('外部打开目录不允许符号链接：' + current)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** @private @author ddj 2026年09月28号
 * Apply a fresh protected ACL granting only the current Windows identity.
 * @param path Directory being secured.
 * @returns Completion after PowerShell confirms the ACL.
 */
async function lockWindows(path: string): Promise<void> {
  const literal = "'" + path.replace(/'/g, "''") + "'"
  const script = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    '$p=' + literal,
    '$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$a=New-Object Security.AccessControl.DirectorySecurity',
    '$a.SetAccessRuleProtection($true,$false)',
    "$r=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
    '$a.AddAccessRule($r)',
    '[IO.Directory]::SetAccessControl($p,$a)',
  ].join(';')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  await new Promise<void>((done, fail) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true, env: childEnv(), timeout: 10_000 })
    child.once('error', fail)
    child.once('close', (code) => code === 0 ? done() : fail(new Error('无法保护外部打开目录 ACL')))
  })
}

/** @public @author ddj 2026年09月28号
 * Protect an existing transport directory for the current user only.
 * @param dir Existing directory, with no symlink or reparse ancestors.
 */
export async function secureOpenDir(dir: string): Promise<void> {
  await checkOpenPath(dir)
  if (process.platform === 'win32') await lockWindows(dir)
  else await chmod(dir, 0o700)
}

/** @public @author ddj 2026年09月28号
 * Create and protect an inbox and both transport subdirectories.
 * @param profile Active profile directory.
 * @returns Secured inbox root; throws on unsafe paths or ACL failures.
 */
export async function ensureOpenInbox(profile: string): Promise<string> {
  await checkOpenPath(profile)
  const root = inboxDir(profile)
  for (const dir of [dirname(root), root, join(root, 'requests'), join(root, 'acks')]) {
    try { await lstat(dir); await checkOpenPath(dir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(dir, { mode: 0o700 })
    }
    await secureOpenDir(dir)
  }
  return root
}

/** @private @author ddj 2026年09月28号
 * Read a bounded regular single-link JSON file without accepting inode replacement.
 * @param path Transport file.
 * @returns Parsed untrusted JSON.
 */
async function readOpenFile(path: string): Promise<unknown> {
  await checkOpenPath(path)
  const before = await lstat(path)
  if (!before.isFile() || before.nlink !== 1 || before.size > OPEN_MAX_BYTES) throw new Error('无效的外部打开文件')
  if (process.platform !== 'win32' && ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.())) throw new Error('外部打开文件权限不安全')
  const handle = await open(path, 'r')
  try {
    const after = await handle.stat()
    if (after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1 || after.size > OPEN_MAX_BYTES) throw new Error('外部打开文件已替换')
    const buffer = Buffer.alloc(OPEN_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > OPEN_MAX_BYTES) throw new Error('外部打开文件过大')
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally { await handle.close() }
}

/** @private @author ddj 2026年09月28号
 * Atomically publish a bounded terminal receipt inside the private ACK directory.
 * @param root Inbox root.
 * @param request Original validated request.
 * @param success Whether the editor confirmed success.
 * @param error Optional terminal diagnostic.
 */
async function writeOpenAck(root: string, requestId: string, profile: string, success: boolean, error?: string): Promise<void> {
  const dir = join(root, 'acks')
  await checkOpenPath(dir)
  const ack: InboxAck = { version: 1, requestId, profile, createdAt: Date.now(), success, error }
  const temp = join(dir, requestId + '.' + randomUUID() + '.tmp')
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(ack), 'utf8') } finally { await handle.close() }
  try { await rename(temp, join(dir, requestId + '.json')) } finally { await unlink(temp).catch(() => {}) }
}

/** @private @author ddj 2026年09月28号
 * Check for an existing terminal receipt without following links.
 * @param root Inbox root.
 * @param name Request file name.
 * @returns Whether this request already has a receipt.
 */
async function ackExists(root: string, name: string): Promise<boolean> {
  try { await lstat(join(root, 'acks', name)); return true } catch { return false }
}

/** @private @author ddj 2026年09月28号
 * Consume validated request files once, retaining request identity until an actual ACK.
 * @param root Inbox root.
 * @param profile Expected profile.
 * @param active Accepted requests awaiting completion.
 * @param live Whether the owning lifecycle is still active.
 */
async function loadOpenFiles(root: string, profile: string, active: Map<string, InboxOpen>, live: () => boolean): Promise<void> {
  const dir = join(root, 'requests')
  await checkOpenPath(dir)
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort().slice(0, 128)
  for (const name of names) {
    if (!OPEN_ID.test(name.slice(0, -5))) continue
    const file = join(dir, name)
    try {
      const raw = await readOpenFile(file)
      const request = parseInboxOpen(raw, profile)
      if (request && request.requestId + '.json' === name && !active.has(request.requestId)) {
        if (!await ackExists(root, name)) {
          if (!live()) return
          handoffOpen(request, request.requestId, request.createdAt)
          active.set(request.requestId, request)
        }
      } else if (!request) {
        // A rejected request must not stay silent until its producer times out.
        const declared = (raw as { profile?: unknown })?.profile
        if (typeof declared === 'string' && !await ackExists(root, name)) {
          if (!live()) return
          await writeOpenAck(root, name.slice(0, -5), declared, false, '请求被拒绝：profile 与当前实例不匹配或字段不合法')
        }
      }
      if (!live()) return
      await unlink(file)
    } catch { /* Unsafe, malformed, or inaccessible files are not followed or executed. */ }
  }
}

/** @public @author ddj 2026年09月28号
 * Poll one private profile inbox; disposal stops all intervals and queued work.
 * @param ctx Host context exposing the active profile.
 * @returns Asynchronous setup of the lifecycle disposer.
 */
export async function startOpenInbox(ctx: Ctx): Promise<() => void> {
  const profile = findProfileDir(ctx)
  if (!profile) return () => {}
  const root = await ensureOpenInbox(profile)
  const active = new Map<string, InboxOpen>()
  let disposed = false
  let running = false
  /** @private @author ddj 2026年09月28号 Consume requests and publish only terminal results. */
  async function tick(): Promise<void> {
    if (disposed || running) return
    running = true
    try {
      await loadOpenFiles(root, profile!, active, () => !disposed)
      for (const [id, request] of active) {
        if (disposed) break
        const result = pendingState(id)
        const expired = Date.now() >= request.createdAt + OPEN_TTL_MS
        if (!result.completed && !expired) continue
        if (!result.delivered || expired) cancelPending(id, result.error)
        await writeOpenAck(root, request.requestId, request.profile, result.delivered && !expired, result.error ?? (expired ? '打开超时，请重试' : undefined))
        active.delete(id)
      }
    } finally { running = false }
  }
  const timer = setInterval(() => { void tick().catch(() => {}) }, 400)
  timer.unref?.()
  void tick().catch(() => {})
  return () => { disposed = true; clearInterval(timer); active.clear(); clearPending() }
}
