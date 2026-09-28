import { describe, expect, it } from 'vitest'
import { settingsDocPath } from '../src/settingsDocPath.js'

describe('settingsDocPath', () => {
  it('returns the absolute settings document path for an exact match', () => {
    expect(settingsDocPath('C:/Users/test/.dsh/cordis.patch.yml', 'C:/Users/test/.dsh/cordis.patch.yml', 'win32'))
      .toBe('C:\\Users\\test\\.dsh\\cordis.patch.yml')
  })

  it('compares paths case-insensitively on Windows', () => {
    expect(settingsDocPath('C:/Users/test/.dsh/config.yml', 'c:/users/test/.dsh/CONFIG.yml', 'win32'))
      .toBe('C:\\Users\\test\\.dsh\\config.yml')
  })

  it('resolves and compares POSIX paths case-sensitively off Windows', () => {
    expect(settingsDocPath('/home/test/.dsh/config.yml', '/home/test/.dsh/config.yml', 'linux'))
      .toBe('/home/test/.dsh/config.yml')
    expect(settingsDocPath('/home/test/.dsh/config.yml', '/home/test/.dsh/CONFIG.yml', 'linux')).toBeNull()
  })

  it('rejects any other path and an absent provider path', () => {
    expect(settingsDocPath('C:/Users/test/.dsh/config.yml', 'C:/Users/test/.dsh/other.yml', 'win32')).toBeNull()
    expect(settingsDocPath(undefined, 'C:/Users/test/.dsh/config.yml', 'win32')).toBeNull()
  })
})
