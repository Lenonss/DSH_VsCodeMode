/**
 * host reveal.ts 纯函数测试（平台 opener argv 分发 + 启动选项，不 spawn）。
 * 覆盖：win32 文件定位/目录打开、darwin open -R、linux xdg-open 文件父目录/目录自身；
 * 以及 windowsHide 回归（置 true 会让 Explorer 窗口不出现）。
 * 作者 ddj 2026-08-27 / 2026-09-20
 */
import { describe, expect, it } from 'vitest'
import { revealCommand, revealSpawnOpts } from '../src/reveal.js'

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

/**
 * 回归：opener 绝不能带 windowsHide:true。
 * DSH 的 Windows Job runner 硬编码 windowsHide:true，连 explorer.exe 的窗口一起隐藏，
 * 症状是 reveal RPC 回 ok:true 但资源管理器窗口不出现（实测 4/4 复现）。
 * 作者 ddj 2026-09-20
 */
describe('revealSpawnOpts', () => {
  it('keeps GUI windows visible (windowsHide must be false)', () => {
    const opts = revealSpawnOpts('C:\\work\\src')
    expect(opts.windowsHide).toBe(false)
    expect(opts.cwd).toBe('C:\\work\\src')
    // stdio ignore：GUI 分离进程无需回传输出，避免管道背压拖住宿主
    expect(opts.stdio).toBe('ignore')
    // detached + 调用方 unref：宿主退出不被 Explorer 拖住
    expect(opts.detached).toBe(true)
  })
})
