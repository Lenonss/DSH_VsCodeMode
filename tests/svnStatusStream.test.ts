/** Regression for measured large-WC XML, pipe EOF and output loss. @author ddj 2026年10月09号 */
import { describe, expect, it, vi } from 'vitest'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable, PassThrough } from 'node:stream'
import { parseStatusXml } from '../src/svn.js'
import { EXPLORER_CAP, statusXmlValid } from '../src/svnExplorer.js'
import { SvnStatusReader, readStatusPipe } from '../src/svnStatusStream.js'
import { explorerIndexOf, explorerMarkOf } from '../src/shared/svnExplorer.js'

/** @private @author ddj 2026年10月09号 @param path Entry path. @returns Verbose XML entry with ignored commit detail. */
function entryXml(path: string): string {
  return '<entry path="' + path + '"><wc-status item="normal" props="none" revision="2"><commit revision="2"><author>'
    + 'user'.repeat(60) + '</author></commit></wc-status></entry>'
}
/** @private @author ddj 2026年10月09号 @param chunks Raw chunks. @param code Exit code. @returns Managed pipe test handle. */
function pipeOf(chunks: Iterable<Buffer | string>, code = 0) {
  return { stdout: Readable.from(chunks), done: Promise.resolve({ exitCode: code }), terminate: vi.fn(),
    collected: { stderr: { readFrom: () => ({ text: 'svn: E170013: failure' }) } } }
}

 describe('SVN status streaming', () => {
  it('handles tag and UTF-8 boundaries one byte at a time', async () => {
    const xml = Buffer.from('<status><target path=".">' + entryXml('中文/脚本.cs') + '</target></status>')
    const chunks = [...xml].map((byte) => Buffer.from([byte]))
    const result = await readStatusPipe(pipeOf(chunks), parseStatusXml, 10, 1000)
    expect(result.entries[0].path).toBe('中文/脚本.cs')
    expect(result.truncated).toBe(false)
  })
  it('retains semantics for properties/tree conflicts/changelists', async () => {
    const xml = '<status><changelist name="中文&amp;group"><entry path="dir/a"><wc-status item="normal" props="modified" tree-conflicted="true"/></entry></changelist></status>'
    const out = await readStatusPipe(pipeOf([xml]), parseStatusXml, 10, 1000)
    expect(out.entries).toEqual(parseStatusXml(xml).entries)
  })
  it('returns a bounded prefix but still validates the remainder of XML', async () => {
    const xml = '<status>' + entryXml('a') + entryXml('b') + '</status>'
    const out = await readStatusPipe(pipeOf([xml]), parseStatusXml, 1, 1000)
    expect(out.entries.map((e) => e.path)).toEqual(['a'])
    expect(out.truncated).toBe(true)
    await expect(readStatusPipe(pipeOf([xml.slice(0, -9)]), parseStatusXml, 1, 1000)).rejects.toThrow('不完整')
  })
  it('rejects empty, tail-only, malformed or truncated documents', async () => {
    for (const xml of ['', entryXml('a') + '</status>', '<status></target></status>', '<status>' + entryXml('a'), '<status/>', '<status></status>junk']) {
      await expect(readStatusPipe(pipeOf([xml]), parseStatusXml, 10, 1000)).rejects.toThrow('不完整')
    }
  })
  it('fails nonzero exit rather than publishing normal statuses', async () => {
    const handle = pipeOf(['<status>' + entryXml('a') + '</status>'], 1)
    await expect(readStatusPipe(handle, parseStatusXml, 10, 1000)).rejects.toThrow('E170013')
    expect(handle.terminate).toHaveBeenCalledOnce()
  })
  it('waits for pipe EOF even after process done settles', async () => {
    const stdout = new PassThrough()
    const pending = readStatusPipe({ stdout, done: Promise.resolve({ exitCode: 0 }) }, parseStatusXml, 10, 1000)
    stdout.write('<status>' + entryXml('a'))
    stdout.end('</status>')
    expect((await pending).entries).toHaveLength(1)
  })
  it('terminates on a hanging pipe and never falls back to inherit', async () => {
    const stdout = new PassThrough()
    const terminate = vi.fn(() => { stdout.destroy(); return undefined })
    await expect(readStatusPipe({ stdout, done: Promise.resolve({ exitCode: 0 }), terminate }, parseStatusXml, 10, 20)).rejects.toThrow('超时')
    expect(terminate).toHaveBeenCalledOnce()
  })
  it('rejects a missing raw pipe instead of reading a collected tail', async () => {
    await expect(readStatusPipe({ done: Promise.resolve({ exitCode: 0 }) }, parseStatusXml, 10, 1000)).rejects.toThrow('管道不可用')
  })
  it('handles 125415 entries above 32 MiB without keeping the XML document', async () => {
    let bytes = 0
    /** @private @author ddj 2026年10月09号 @returns Large XML chunks, allocated one entry at a time. */
    function* chunks() {
      yield '<status><target path=".">'
      for (let i = 0; i < 125415; i++) { const xml = entryXml('Scripts/f' + i + '.cs'); bytes += Buffer.byteLength(xml); yield xml }
      yield '</target></status>'
    }
    const out = await readStatusPipe(pipeOf(chunks()), parseStatusXml, EXPLORER_CAP, 10000)
    expect(bytes).toBeGreaterThan(32 * 1024 * 1024)
    expect(out.entries).toHaveLength(125415)
    expect(out.truncated).toBe(false)
    expect(explorerMarkOf(explorerIndexOf(out.entries), 'Scripts/f125414.cs', false)?.kind).toBe('clean')
  }, 15000)

  it.skipIf(!process.env.SVN_STATUS_XML)('parses actual captured workspace identically to the complete parser', async () => {
    const file = process.env.SVN_STATUS_XML!
    const full = await readFile(file, 'utf8')
    expect(Buffer.byteLength(full)).toBeGreaterThan(32 * 1024 * 1024)
    expect(statusXmlValid(full.slice(-32 * 1024 * 1024))).toBe(false)
    const reader = new SvnStatusReader(parseStatusXml, EXPLORER_CAP)
    for await (const chunk of createReadStream(file)) reader.push(chunk)
    const out = reader.finish()
    expect(out).toEqual(parseStatusXml(full, EXPLORER_CAP))
    expect(out.truncated).toBe(false)
    console.log('REAL_XML_BYTES=' + Buffer.byteLength(full) + '; RETAINED_ENTRIES=' + out.entries.length)
  }, 15000)
})
