import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { checkOpenPath, inboxDir, startOpenInbox } from '../src/openInbox.js'
import { ackPending, pollPending } from '../src/externalHandoff.js'
import type { Ctx } from '../src/store.js'

let profile = ''
let dispose: (() => void) | undefined

beforeAll(async () => {
  profile = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.open-inbox-'))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-vscode-mode': '^0.13.0' } }))
  const ctx = { get: (name: string) => name === 'profileContext' ? { dir: profile } : undefined } as unknown as Ctx
  dispose = await startOpenInbox(ctx)
}, 30_000)
afterAll(async () => { dispose?.(); if (profile) await rm(profile, { recursive: true, force: true }) })

/** @private @author ddj 2026年09月28号
 * Poll one exact test predicate with a bounded deadline.
 * @param check Returns a useful result once ready.
 * @returns The first truthy result, or throws on timeout.
 */
async function until<T>(check: () => Promise<T> | T): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('Inbox test timed out')
}

describe('private inbox consumer', () => {
  it('does not create ACK on claim; writes success only after the matching editor receipt', async () => {
    const requestId = randomUUID()
    const root = inboxDir(profile)
    const request = { version: 1, requestId, profile, paths: [join(profile, '测试.cs')], line: 12, column: 3, createdAt: Date.now() }
    await writeFile(join(root, 'requests', requestId + '.json'), JSON.stringify(request), { mode: 0o600 })
    const claim = await until(() => pollPending({ clientId: 'inbox-client' }))
    expect(claim!.token).toBe(requestId)
    expect(claim!.line).toBe(12)
    const ackFile = join(root, 'acks', requestId + '.json')
    await expect(readFile(ackFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ackPending({ ...claim!, clientId: 'inbox-client', success: true })).toBe(true)
    const ack = await until(async () => {
      try { return JSON.parse(await readFile(ackFile, 'utf8')) } catch { return null }
    })
    expect(ack).toMatchObject({ version: 1, requestId, profile, success: true })
  })

  it('persists a failed editor receipt and never redelivers the failed request', async () => {
    const requestId = randomUUID()
    const root = inboxDir(profile)
    const request = { version: 1, requestId, profile, paths: [join(profile, 'a.cs')], createdAt: Date.now() }
    await writeFile(join(root, 'requests', requestId + '.json'), JSON.stringify(request), { mode: 0o600 })
    const claim = await until(() => pollPending({ clientId: 'failure-client' }))
    expect(ackPending({ ...claim!, clientId: 'failure-client', success: false, error: 'load failed' })).toBe(true)
    const ack = await until(async () => {
      try { return JSON.parse(await readFile(join(root, 'acks', requestId + '.json'), 'utf8')) } catch { return null }
    })
    expect(ack).toMatchObject({ success: false, error: 'load failed' })
    expect(pollPending({ clientId: 'another-client' })).toBeNull()
  })

  it('keeps the original deadline when an old request enters the physical inbox', async () => {
    const requestId = randomUUID()
    const root = inboxDir(profile)
    const createdAt = Date.now() - 50_000
    const request = { version: 1, requestId, profile, paths: [join(profile, 'old.cs')], createdAt }
    const requestFile = join(root, 'requests', requestId + '.json')
    const ackFile = join(root, 'acks', requestId + '.json')
    await writeFile(requestFile, JSON.stringify(request), { mode: 0o600 })
    const claim = await until(() => pollPending({ clientId: 'old-client' }))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(createdAt + 60_000)
    try {
      expect(ackPending({ ...claim!, clientId: 'old-client', success: true })).toBe(false)
      const ack = await until(async () => {
        try { return JSON.parse(await readFile(ackFile, 'utf8')) } catch { return null }
      })
      expect(ack.success).toBe(false)
      expect(pollPending({ clientId: 'late-client' })).toBeNull()
      await rm(ackFile)
      await writeFile(requestFile, JSON.stringify(request), { mode: 0o600 })
      await until(async () => {
        try { await readFile(requestFile); return false } catch { return true }
      })
      expect(pollPending({ clientId: 'replay-client' })).toBeNull()
    } finally { clock.mockRestore() }
  })

  it('rejects an ancestor directory junction or symlink without following it', async () => {
    const target = join(profile, 'target')
    const alias = join(profile, 'alias')
    await mkdir(target)
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(checkOpenPath(alias)).rejects.toThrow('符号链接')
  })
})
