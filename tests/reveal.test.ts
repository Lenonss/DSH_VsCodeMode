/**
 * host reveal.ts 纯函数测试（平台 opener argv 分发，不 spawn）。
 * 覆盖：win32 文件定位/目录打开、darwin open -R、linux xdg-open 文件父目录/目录自身。
 * 作者 ddj 2026-08-27
 */
import { describe, expect, it } from 'vitest'
import { revealCommand } from '../src/reveal.js'

describe('revealCommand', () => {
  it('win32 文件 → explorer /select,<path>（定位选中）', () => {
    const cmd = revealCommand('C:\\work\\src\\a.ts', false, 'win32')
    expect(cmd.argv).toEqual(['explorer.exe', '/select,', 'C:\\work\\src\\a.ts'])
  })

  it('win32 目录 → explorer <path>（打开目录自身）', () => {
    const cmd = revealCommand('C:\\work\\src', true, 'win32')
    expect(cmd.argv).toEqual(['explorer.exe', 'C:\\work\\src'])
  })

  it('darwin 文件/目录 → open -R（定位选中）', () => {
    expect(revealCommand('/work/a.ts', false, 'darwin').argv).toEqual(['open', '-R', '/work/a.ts'])
    expect(revealCommand('/work/src', true, 'darwin').argv).toEqual(['open', '-R', '/work/src'])
  })

  it('linux 文件 → xdg-open 所在目录；目录 → xdg-open 自身', () => {
    const file = revealCommand('/work/src/a.ts', false, 'linux')
    expect(file.argv[0]).toBe('xdg-open')
    expect(file.argv[1]).toBe('/work/src')
    const dir = revealCommand('/work/src', true, 'linux')
    expect(dir.argv[0]).toBe('xdg-open')
    expect(dir.argv[1]).toBe('/work/src')
  })
})
