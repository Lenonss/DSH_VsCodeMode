/**
 * dsh-vscode-mode 共享「原生打开范围」纯函数测试：
 * 后缀解析 / 命中判定 / 默认集决策（csv/tsv 刻意不含，同 avif 例外先例）。
 * 作者 ddj 2026年09月22号
 */
import { describe, expect, it } from 'vitest'
import {
  BLIND_EXT,
  DEFAULT_NATIVE_CSV,
  DEFAULT_NATIVE_EXT,
  OFFICE_EXT,
  inNativeOpen,
  parseExtCsv,
  suffixOf,
} from '../src/shared/nativeOpen.js'

describe('suffixOf', () => {
  it('双分隔符/大小写/无后缀/隐藏文件', () => {
    expect(suffixOf('a/b/c.DOCX')).toBe('docx')
    expect(suffixOf('a\\b\\c.tar.gz')).toBe('gz')
    expect(suffixOf('README')).toBe('')
    expect(suffixOf('.gitignore')).toBe('')
    expect(suffixOf(undefined)).toBe('')
  })
})

describe('parseExtCsv', () => {
  it('逗号分隔、去空白去点小写、空段丢弃', () => {
    expect([...parseExtCsv(' doc, .XLSX ,,md')].sort()).toEqual(['doc', 'md', 'xlsx'])
  })

  it('非法输入（非字符串/空串）→ 空集合不抛错', () => {
    expect(parseExtCsv(undefined).size).toBe(0)
    expect(parseExtCsv(null).size).toBe(0)
    expect(parseExtCsv('  ').size).toBe(0)
    expect(parseExtCsv(123 as unknown).size).toBe(0)
  })
})

describe('inNativeOpen', () => {
  it('命中/未命中/无后缀', () => {
    const set = parseExtCsv('doc,md')
    expect(inNativeOpen('report.doc', set)).toBe(true)
    expect(inNativeOpen('C:\\x\\NOTES.MD', set)).toBe(true)
    expect(inNativeOpen('report.docx', set)).toBe(false)
    expect(inNativeOpen('Makefile', set)).toBe(false)
  })
})

describe('默认范围（决策固化）', () => {
  it('默认集 = 让位清单并集，且 csv/tsv 刻意不含（可编辑性优先，需显式配置才让位）', () => {
    expect(DEFAULT_NATIVE_EXT).toEqual([...OFFICE_EXT, ...BLIND_EXT])
    expect(DEFAULT_NATIVE_EXT).not.toContain('csv')
    expect(DEFAULT_NATIVE_EXT).not.toContain('tsv')
    expect(DEFAULT_NATIVE_EXT).not.toContain('avif')
    expect(DEFAULT_NATIVE_EXT).toContain('doc')
    expect(DEFAULT_NATIVE_EXT).toContain('xlsx')
    expect(DEFAULT_NATIVE_CSV).toBe(DEFAULT_NATIVE_EXT.join(','))
  })

  it('设置串往返：DEFAULT → parse 后逐项命中', () => {
    const set = parseExtCsv(DEFAULT_NATIVE_CSV)
    for (const ext of ['docx', 'zip', 'mp4', 'sqlite']) {
      expect(inNativeOpen('x.' + ext, set), ext).toBe(true)
    }
  })
})
