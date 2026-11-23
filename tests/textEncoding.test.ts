import { describe, expect, it } from 'vitest'
import {
  backupPathOf,
  classifyEncoding,
  decodePreview,
  isEncodingError,
  kindLabelOf,
  repairBytes,
} from '../src/textEncoding.js'

/** @private @author ddj 2026年11月21号 @returns GBK 编码的「文件：」字节 */
function gbkSample(): Uint8Array {
  return Uint8Array.from([0xce, 0xc4, 0xbc, 0xfe, 0xa3, 0xba])
}

/** @private @author ddj 2026年11月21号 @returns 第 4/5/6 行各带一处 EF BC 3F 的混合字节 */
function mixedSample(): Uint8Array {
  const lines = ['-- a', '-- b', '-- c', '-- 邮箱', '-- 日期', '-- 功能']
  const parts: number[] = []
  lines.forEach((line, index) => {
    parts.push(...new TextEncoder().encode(index < 3 ? line + '\n' : line))
    if (index >= 3) parts.push(0xef, 0xbc, 0x3f, 0x0a)
  })
  return Uint8Array.from(parts)
}

describe('classifyEncoding', () => {
  it('accepts strict UTF-8 and records a BOM', () => {
    const bytes = new TextEncoder().encode('文件：ok\r\n')
    expect(classifyEncoding(bytes)).toMatchObject({ kind: 'utf-8', badBytes: 0, lines: [], bom: false })
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes])
    expect(classifyEncoding(withBom).bom).toBe(true)
  })

  it('detects whole-file GB18030', () => {
    const verdict = classifyEncoding(gbkSample())
    expect(verdict.kind).toBe('gb18030')
    expect(verdict.badBytes).toBe(0)
  })

  it('reports mixed corruption with line numbers', () => {
    const verdict = classifyEncoding(mixedSample())
    expect(verdict.kind).toBe('mixed')
    expect(verdict.badBytes).toBe(3)
    expect(verdict.lines).toEqual([4, 5, 6])
    expect(verdict.samples[0]).toMatchObject({ line: 4, bytes: 'efbc' })
    expect(verdict.samples[0]!.context).toContain('邮箱')
  })

  it('treats NUL bytes as binary', () => {
    expect(classifyEncoding(Uint8Array.from([0x61, 0x00, 0x62])).kind).toBe('binary')
  })
})

describe('preview and repair', () => {
  it('decodes GB18030 preview without writing', () => {
    const bytes = gbkSample()
    const preview = decodePreview(bytes, classifyEncoding(bytes))
    expect(preview.text).toBe('文件：')
    expect(preview.truncated).toBe(false)
  })

  it('keeps U+FFFD placeholders in a mixed preview', () => {
    const preview = decodePreview(mixedSample(), classifyEncoding(mixedSample()))
    expect(preview.text).toContain('邮箱')
    expect(preview.text).toContain('\uFFFD')
  })

  it('converts GB18030 to UTF-8 and preserves CRLF', () => {
    const gbk = Uint8Array.from([...gbkSample(), 0x0d, 0x0a, 0x61])
    const verdict = classifyEncoding(gbk)
    const repaired = repairBytes(gbk, verdict)
    expect(verdict.kind).toBe('gb18030')
    expect(repaired).toEqual({ ok: true, text: '文件：\r\na' })
    const encoded = new TextEncoder().encode((repaired as { text: string }).text)
    expect(new TextDecoder('utf-8', { fatal: true }).decode(encoded)).toBe('文件：\r\na')
  })

  it('refuses to write mixed and binary files', () => {
    const mixed = mixedSample()
    expect(repairBytes(mixed, classifyEncoding(mixed))).toMatchObject({ ok: false })
    const binary = Uint8Array.from([0x00, 0x01])
    expect(repairBytes(binary, classifyEncoding(binary))).toMatchObject({ ok: false })
  })

  it('names the backup path and the kind label', () => {
    expect(backupPathOf('a/b.lua')).toBe('a/b.lua.utf8bak')
    expect(kindLabelOf('mixed')).toBe('局部非法字节')
  })

  it('recognizes host encoding failures only', () => {
    expect(isEncodingError('FsError: cannot read "x.lua"; invalid UTF-8 text')).toBe(true)
    expect(isEncodingError('文件不存在')).toBe(false)
  })
})
