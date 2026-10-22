import { describe, expect, it } from 'vitest'
import { createTextPages } from '../src/textPages.js'
import type { TextPageSource } from '../src/textPages.js'
import { TEXT_PAGE_BYTES } from '../src/shared/textPages.js'
import { handleRpc } from '../src/rpc.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @private @author ddj 2026年10月22号 @param denied Resolve denial. @returns Host mock with exact-session lookup and evidence that no byte capability runs. */
function rpcFixture(denied = false) {
  const evidence = { resolves: 0, reads: 0 }
  const session = { id: 's', header: { cwd: '/workspace' } }
  const fs = {
    async resolve() { evidence.resolves++; if (denied) throw new Error('FS_PERMISSION_DENIED'); return '/workspace/f' },
    async readText() { evidence.reads++; throw new Error('unexpected full read') },
    async readBytes() { evidence.reads++; throw new Error('unexpected full read') },
  }
  const ctx = { get(name: string) {
    if (name === 'sessions') return { get: (id: string) => id === 's' ? session : undefined, list: () => [session] }
    if (name === 'fs') return fs
    return undefined
  } }
  return { ctx, evidence }
}

/** @private @author ddj 2026年10月22号 @returns Official-shaped provider with bounded range evidence and mutable workspace/version. */
function rangeFixture() {
  const bytes = new TextEncoder().encode('a'.repeat(TEXT_PAGE_BYTES - 1) + '中\r\nend')
  const target = { targetKey: 'opaque-target', displayPath: 'f' }
  const session = { id: 's', header: { cwd: '/workspace' } }
  const evidence = { resolves: 0, ranges: [] as { offset: number; length: number }[] }
  let version = 'v1'
  const fs = {
    async resolve() { evidence.resolves++; return target },
    async stat() { return { version, size: bytes.length, type: 'file' } },
    async readByteRange(actual: unknown, range: { offset: number; length: number }) {
      expect(actual).toBe(target)
      evidence.ranges.push(range)
      return bytes.slice(range.offset, range.offset + range.length)
    },
    async readText() { throw new Error('unexpected whole read') },
    async readBytes() { throw new Error('unexpected whole read') },
  }
  const ctx = { get(name: string) {
    if (name === 'sessions') return { get: (id: string) => id === 's' ? session : undefined, list: () => [session] }
    if (name === 'fs') return fs
    return undefined
  } }
  return { ctx, fs, evidence, session, mutate() { version = 'v2' } }
}

describe('official range adapter RPC', () => {
  it('reauthorizes each page and keeps reads bounded with opaque targets', async () => {
    const sample = rangeFixture()
    const first = await handleRpc(sample.ctx, new Map(), 'edrv.textPage', { sessionId: 's', path: 'f' })
    expect(first).toMatchObject({ ok: true, text: 'a'.repeat(TEXT_PAGE_BYTES - 1), eof: false })
    const second = await handleRpc(sample.ctx, new Map(), 'edrv.textPage', { sessionId: 's', path: 'f', cursor: first.nextCursor })
    expect(second).toMatchObject({ ok: true, text: '中\r\nend', eof: true })
    expect(sample.evidence.resolves).toBe(2)
    expect(sample.evidence.ranges.every((range) => range.length <= TEXT_PAGE_BYTES)).toBe(true)
  })
  it('rejects workspace rebound and changed versions before reading another page', async () => {
    const sample = rangeFixture()
    const first = await handleRpc(sample.ctx, new Map(), 'edrv.textPage', { sessionId: 's', path: 'f' })
    sample.session.header.cwd = '/other'
    expect(await handleRpc(sample.ctx, new Map(), 'edrv.textPage', { sessionId: 's', path: 'f', cursor: first.nextCursor }))
      .toMatchObject({ ok: false, reason: 'invalid-cursor' })
    sample.session.header.cwd = '/workspace'
    sample.mutate()
    expect(await handleRpc(sample.ctx, new Map(), 'edrv.textPage', { sessionId: 's', path: 'f', cursor: first.nextCursor }))
      .toMatchObject({ ok: false, reason: 'stale' })
    expect(sample.evidence.ranges).toHaveLength(1)
  })
  it('preserves official provider denial without whole-file fallback', async () => {
    const sample = rangeFixture()
    sample.fs.readByteRange = async () => { throw new Error('FS_PERMISSION_DENIED') }
    expect(await handleRpc(sample.ctx, new Map(), 'edrv.textPage', { sessionId: 's', path: 'f' }))
      .toMatchObject({ ok: false, reason: 'read-failed', error: expect.stringContaining('FS_PERMISSION_DENIED') })
  })
})

describe('actual official local provider', () => {
  it.skipIf(!process.env.EDRV_FS_LOCAL)('reads two pages through official IO and detects file replacement', async () => {
    const moduleUrl = pathToFileURL(resolve(process.env.EDRV_FS_LOCAL!)).href
    const { LocalFileSystem } = await import(/* @vite-ignore */ moduleUrl)
    // Use the exported production methods on a provider-shaped receiver; no Cordis service registration or Host mutation.
    const fs = Object.create(LocalFileSystem.prototype)
    const directory = await mkdtemp(join(tmpdir(), 'edrv-range-'))
    try {
      const path = join(directory, 'sample.txt')
      const text = 'a'.repeat(TEXT_PAGE_BYTES - 1) + '中\r\nend'
      await writeFile(path, text, 'utf8')
      const session = { id: 's', header: { cwd: directory } }
      const ctx = { get(name: string) {
        if (name === 'sessions') return { get: (id: string) => id === 's' ? session : undefined, list: () => [session] }
        if (name === 'fs') return fs
        return undefined
      } }
      const first = await handleRpc(ctx, new Map(), 'edrv.textPage', { sessionId: 's', path })
      expect(first).toMatchObject({ ok: true, eof: false })
      const second = await handleRpc(ctx, new Map(), 'edrv.textPage', { sessionId: 's', path, cursor: first.nextCursor })
      expect(second).toMatchObject({ ok: true, eof: true })
      expect(first.text + second.text).toBe(text)
      await writeFile(path, 'replaced', 'utf8')
      expect(await handleRpc(ctx, new Map(), 'edrv.textPage', { sessionId: 's', path, cursor: first.nextCursor }))
        .toMatchObject({ ok: false, reason: 'stale' })
    } finally {
      // directory is the exact absolute mkdtemp result created by this test, never a user-provided target.
      expect(directory.startsWith(join(tmpdir(), 'edrv-range-'))).toBe(true)
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('actual textPage RPC fail-closed wiring', () => {
  it('returns unsupported without attempting a whole-file read', async () => {
    const { ctx, evidence } = rpcFixture()
    expect(await handleRpc(ctx, new Map(), 'edrv.textPage', { sessionId: 's', path: 'f' }))
      .toMatchObject({ ok: false, reason: 'unsupported' })
    expect(evidence).toEqual({ resolves: 1, reads: 0 })
  })
  it('rejects missing sessions before resolving or reading a path', async () => {
    const { ctx, evidence } = rpcFixture()
    expect(await handleRpc(ctx, new Map(), 'edrv.textPage', { sessionId: 'other', path: 'f' }))
      .toMatchObject({ ok: false, reason: 'read-failed' })
    expect(evidence).toEqual({ resolves: 0, reads: 0 })
  })
  it('propagates path resolution denial without reading bytes', async () => {
    const { ctx, evidence } = rpcFixture(true)
    expect(await handleRpc(ctx, new Map(), 'edrv.textPage', { sessionId: 's', path: 'f' }))
      .toMatchObject({ ok: false, reason: 'read-failed', error: expect.stringContaining('FS_PERMISSION_DENIED') })
    expect(evidence).toEqual({ resolves: 1, reads: 0 })
  })
})

/** @private @author ddj 2026年10月22号 @param text Fixture text. @returns Authorized in-memory capability with read evidence. */
function fixture(text: string) {
  const bytes = new TextEncoder().encode(text)
  const reads: number[] = []
  let version = 'v1'
  const source: TextPageSource = {
    identity: 'authorized-file',
    async stat() { return { version, size: bytes.length, type: 'file' } },
    async readRange(offset, length) { reads.push(length); return bytes.slice(offset, offset + length) },
  }
  return { source, reads, mutate: () => { version = 'v2' } }
}

/** @private @author ddj 2026年10月22号 @param source Authorized fixture. @returns Entire preview by bounded independent pages. */
async function collect(source: TextPageSource): Promise<string> {
  const read = createTextPages()
  let cursor: string | undefined
  let result = ''
  do {
    const page = await read(source, { path: 'file', sessionId: 's', cursor })
    expect(page.ok).toBe(true)
    if (!page.ok) throw new Error(page.error)
    result += page.text
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return result
}

describe('authorized text pages', () => {
  it('fails closed when Host range reads are unavailable', async () => {
    expect(await createTextPages()(undefined, { path: 'file' })).toMatchObject({ ok: false, reason: 'unsupported' })
  })
  it('preserves split UTF-8, strips only the leading BOM and bounds huge lines', async () => {
    const text = '\uFEFF' + 'a'.repeat(TEXT_PAGE_BYTES - 4) + '😀中\uFEFF' + 'b'.repeat(TEXT_PAGE_BYTES)
    const sample = fixture(text)
    expect(await collect(sample.source)).toBe(text.slice(1))
    expect(Math.max(...sample.reads)).toBeLessThanOrEqual(TEXT_PAGE_BYTES)
  })
  it('handles every UTF-8 split position without dropping internal BOMs', async () => {
    for (const character of ['中', '😀']) {
      const width = new TextEncoder().encode(character).length
      for (let split = 1; split < width; split++) {
        const text = 'a'.repeat(TEXT_PAGE_BYTES - split) + character + '\uFEFFend'
        expect(await collect(fixture(text).source)).toBe(text)
      }
    }
  })
  it('rejects a malformed UTF-8 sequence spanning two ranges', async () => {
    const bytes = new Uint8Array(TEXT_PAGE_BYTES + 1).fill(0x61)
    bytes[TEXT_PAGE_BYTES - 1] = 0xe2
    const source: TextPageSource = { identity: 'bad',
      async stat() { return { version: 'v', size: bytes.length, type: 'file' } },
      async readRange(offset, length) { return bytes.slice(offset, offset + length) } }
    const read = createTextPages()
    const first = await read(source, { path: 'f' })
    if (!first.ok || !first.nextCursor) throw new Error('expected continuation')
    expect(await read(source, { path: 'f', cursor: first.nextCursor })).toMatchObject({ ok: false, reason: 'not-text' })
  })
  it('preserves a CRLF split across ranges and a final CR', async () => {
    const text = 'a'.repeat(TEXT_PAGE_BYTES - 1) + '\r\nb\rc\nend\r'
    expect(await collect(fixture(text).source)).toBe(text)
  })
  it('rejects invalid UTF-8 and binary NUL without replacement decoding', async () => {
    for (const bytes of [new Uint8Array([0xc0, 0x80]), new Uint8Array([0xe2, 0x82]), new Uint8Array([0])]) {
      const source: TextPageSource = { identity: 'x', async stat() { return { version: 'v', size: bytes.length, type: 'file' } },
        async readRange() { return bytes } }
      expect(await createTextPages()(source, { path: 'f' })).toMatchObject({ ok: false, reason: 'not-text' })
    }
  })
  it('binds cursors to session/path/identity/version and authenticates tampering', async () => {
    const sample = fixture('x'.repeat(TEXT_PAGE_BYTES + 10))
    const read = createTextPages()
    const first = await read(sample.source, { path: 'f', sessionId: 's' })
    if (!first.ok || !first.nextCursor) throw new Error('expected continuation')
    const args = { path: 'f', sessionId: 's', cursor: first.nextCursor }
    for (const changed of [{ ...args, path: 'other' }, { ...args, sessionId: 'other' }, { ...args, cursor: args.cursor + 'x' }]) {
      expect(await read(sample.source, changed)).toMatchObject({ ok: false, reason: 'invalid-cursor' })
    }
    expect(await read({ ...sample.source, identity: 'other' }, args)).toMatchObject({ ok: false, reason: 'invalid-cursor' })
    sample.mutate()
    expect(await read(sample.source, args)).toMatchObject({ ok: false, reason: 'stale' })
  })
  it('does not touch bytes when a new authorization denies metadata access', async () => {
    const sample = fixture('x'.repeat(TEXT_PAGE_BYTES + 10))
    const read = createTextPages()
    const first = await read(sample.source, { path: 'f', sessionId: 's' })
    if (!first.ok || !first.nextCursor) throw new Error('expected continuation')
    const previousReads = sample.reads.length
    const denied: TextPageSource = { ...sample.source, async stat() { throw new Error('FS_PERMISSION_DENIED') } }
    expect(await read(denied, { path: 'f', sessionId: 's', cursor: first.nextCursor }))
      .toMatchObject({ ok: false, reason: 'read-failed', error: 'Error: FS_PERMISSION_DENIED' })
    expect(sample.reads).toHaveLength(previousReads)
  })
  it('rejects workspace-rebound cursor before invoking either capability', async () => {
    const sample = fixture('x'.repeat(TEXT_PAGE_BYTES + 10))
    const read = createTextPages()
    const first = await read(sample.source, { path: 'f' })
    if (!first.ok || !first.nextCursor) throw new Error('expected continuation')
    let accessed = false
    const otherWorkspace: TextPageSource = { identity: 'workspace2:authorized-file',
      async stat() { accessed = true; return undefined }, async readRange() { accessed = true; return new Uint8Array() } }
    expect(await read(otherWorkspace, { path: 'f', cursor: first.nextCursor }))
      .toMatchObject({ ok: false, reason: 'invalid-cursor' })
    expect(accessed).toBe(false)
  })
  it('discards data changed during IO, rejects short and oversized reads', async () => {
    const sample = fixture('hello')
    const source = { ...sample.source, async readRange() { sample.mutate(); return new TextEncoder().encode('hello') } }
    expect(await createTextPages()(source, { path: 'f' })).toMatchObject({ ok: false, reason: 'stale' })
    for (const size of [1, 9]) {
      expect(await createTextPages()({ ...sample.source, async readRange() { return new Uint8Array(size) } }, { path: 'f' }))
        .toMatchObject({ ok: false, reason: 'read-failed' })
    }
  })
  it('supports empty files and never swallows authorized capability denial', async () => {
    expect(await collect(fixture('').source)).toBe('')
    const sample = fixture('hello')
    expect(await createTextPages()({ ...sample.source, async readRange() { throw new Error('FS_SANDBOX_DENIED') } }, { path: 'f' }))
      .toMatchObject({ ok: false, reason: 'read-failed', error: 'Error: FS_SANDBOX_DENIED' })
  })
})
