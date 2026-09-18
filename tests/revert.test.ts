/**
 * 回滚/删除的平台分派测试。
 * 背景（2026-09-18）：deleteCreated 原先无条件先发 powershell Remove-Item，
 * macOS/Linux 上必然 spawn 失败后才回落 /bin/rm —— 每删一个文件多一次无谓
 * spawn 与失败噪声。改为按平台一次到位（纯函数 removeFileArgv 便于钉住）。
 * 作者 ddj 2026-09-18
 */
import { describe, expect, it } from 'vitest'
import { removeFileArgv } from '../src/revert.js'

describe('removeFileArgv 平台分派', () => {
  it('win32 走 PowerShell Remove-Item（含路径引号包裹）', () => {
    const argv = removeFileArgv('C:\\ws\\a.ts', 'win32')
    expect(argv[0]).toBe('powershell')
    expect(argv).toContain('-NoProfile')
    expect(argv).toContain('-NonInteractive')
    expect(argv[argv.length - 1]).toContain('Remove-Item -LiteralPath "C:\\ws\\a.ts" -Force')
  })

  it('darwin 直接用 /bin/rm（不再先试 powershell）', () => {
    const argv = removeFileArgv('/Users/u/ws/a.ts', 'darwin')
    expect(argv).toEqual(['/bin/rm', '-f', '--', '/Users/u/ws/a.ts'])
    expect(argv.join(' ')).not.toContain('powershell')
  })

  it('linux 同 darwin，且路径以 -- 隔断防以横杠开头的文件名被当选项', () => {
    expect(removeFileArgv('/home/u/-weird.ts', 'linux')).toEqual(['/bin/rm', '-f', '--', '/home/u/-weird.ts'])
  })

  it('缺省参数按当前进程平台分派', () => {
    const argv = removeFileArgv('/tmp/x')
    if (process.platform === 'win32') expect(argv[0]).toBe('powershell')
    else expect(argv[0]).toBe('/bin/rm')
  })
})
