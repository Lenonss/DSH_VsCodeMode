/**
 * pdfPreview 纯函数单测：PDF 判定（isPdfPath）与 base64 编解码往返。
 * 断言全部使用字符串字面量，不依赖 path.join（CI ubuntu 平台陷阱，见 dsh-vscode-mode-dev 技能）。
 * @author ddj 2026年09月22号
 */
import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, isPdfPath, PDF_MIME } from '../src/client/pdfPreview.js'

describe('isPdfPath', () => {
  it('accepts pdf in any case and both separators', () => {
    expect(isPdfPath('docs/manual.pdf')).toBe(true)
    expect(isPdfPath('docs\\manual.PDF')).toBe(true)
    expect(isPdfPath('C:\\proj\\需求文档.Pdf')).toBe(true)
    expect(isPdfPath('spec.pdf')).toBe(true)
  })

  it('rejects non-pdf and extensionless paths', () => {
    expect(isPdfPath('src/main.ts')).toBe(false)
    expect(isPdfPath('README.md')).toBe(false)
    expect(isPdfPath('png')).toBe(false)
    expect(isPdfPath('.pdf')).toBe(false)
    expect(isPdfPath('')).toBe(false)
    expect(isPdfPath('archive.pdf.bak')).toBe(false)
  })

  it('does not confuse with image extensions', () => {
    expect(isPdfPath('a/logo.png')).toBe(false)
    expect(isPdfPath('a/photo.jpg')).toBe(false)
  })
})

describe('base64 round-trip', () => {
  it('decodes known vector', () => {
    expect(bytesToBase64(base64ToBytes('aGVsbG8='))).toBe('aGVsbG8=')
    expect(Array.from(base64ToBytes('AQI=')).join(',')).toBe('1,2')
  })

  it('round-trips binary-ish bytes across chunk boundaries', () => {
    const bytes = new Uint8Array(0x8000 + 7)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
    expect(bytesToBase64(bytes)).toBe(bytesToBase64(bytes))
    const encoded = bytesToBase64(bytes)
    const decoded = base64ToBytes(encoded)
    expect(decoded.length).toBe(bytes.length)
    for (let i = 0; i < bytes.length; i++) {
      if (decoded[i] !== bytes[i]) {
        expect.fail('byte mismatch at ' + i)
      }
    }
  })

  it('handles empty payload', () => {
    expect(base64ToBytes('').length).toBe(0)
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
  })
})

describe('PDF_MIME', () => {
  it('is the standard pdf mime', () => {
    expect(PDF_MIME).toBe('application/pdf')
  })
})
