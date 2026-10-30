/**
 * 待审台账的路径归一：面板传下来的路径可能是工作区相对写法，条目里存的是绝对路径。
 * @author ddj 2026年10月30号
 */
import { describe, expect, it } from 'vitest'
import { pendingDisplay, pendingPathKey, pendingRawId, pendingSamePath } from '../src/pendingCompat.js'
import { PENDING_PREFIX } from '../src/shared/pendingReview.js'

describe('pendingSamePath', () => {
  it('同一路径的绝对写法互判相等', () => {
    expect(pendingSamePath('D:\\Work\\demo\\src\\a.ts', 'D:\\Work\\demo\\src\\a.ts')).toBe(true)
  })

  it('分隔符与盘符大小写差异不影响判定', () => {
    // 反斜杠与正斜杠只是字形差异
    expect(pendingSamePath('D:\\Work\\demo\\src\\a.ts', 'D:/Work/demo/src/a.ts')).toBe(true)
    // 盘符路径天生大小写不敏感，与宿主平台无关（客户端 diffPathKey 同口径）
    expect(pendingSamePath('D:\\Work\\demo\\src\\a.ts', 'd:/work/demo/src/a.ts')).toBe(true)
    // POSIX 绝对路径不折叠大小写差异，跟随宿主文件系统语义
    expect(pendingSamePath('/Work/demo/a.ts', '/work/demo/a.ts')).toBe(process.platform === 'win32')
  })

  it('相对路径能匹配绝对路径的尾部', () => {
    expect(pendingSamePath('D:\\Work\\demo\\src\\a.ts', 'src/a.ts')).toBe(true)
    expect(pendingSamePath('src/a.ts', 'D:\\Work\\demo\\src\\a.ts')).toBe(true)
  })

  it('不同目录下的同名文件不算同一文件', () => {
    expect(pendingSamePath('D:\\Work\\demo\\src\\a.ts', 'D:\\Other\\demo\\src\\a.ts')).toBe(false)
  })

  it('只按整段路径比较，不做子串误判', () => {
    expect(pendingSamePath('D:\\Work\\demo\\src\\a.ts', 'a.ts')).toBe(true)
    expect(pendingSamePath('D:\\Work\\demo\\src\\a.ts', 'ta.ts')).toBe(false)
  })

  it('空路径一律不相等', () => {
    expect(pendingSamePath('', 'D:\\Work\\demo\\src\\a.ts')).toBe(false)
    expect(pendingSamePath('', '')).toBe(false)
  })

  it('比较键保留远端路径大小写', () => {
    expect(pendingPathKey('ssh://Host/Repo/a.ts')).toBe('ssh://Host/Repo/a.ts')
  })
})

describe('pendingRawId', () => {
  it('剥掉列表前缀，得到内核身份', () => {
    expect(pendingRawId(PENDING_PREFIX + 'D:\\Work\\a.ts')).toBe('D:\\Work\\a.ts')
  })

  it('已是没有前缀的原始 id 时原样返回', () => {
    expect(pendingRawId('D:\\Work\\a.ts')).toBe('D:\\Work\\a.ts')
  })
})

describe('pendingDisplay', () => {
  it('工作区内显示相对路径', () => {
    expect(pendingDisplay('D:\\Work\\demo', 'D:\\Work\\demo\\src\\a.ts')).toBe('src/a.ts')
  })

  it('工作区外保留原始路径', () => {
    expect(pendingDisplay('D:\\Work\\demo', 'C:\\Temp\\a.ts')).toBe('C:\\Temp\\a.ts')
  })

  it('前缀相同但不属于该目录时不算工作区内', () => {
    expect(pendingDisplay('D:\\Work\\demo', 'D:\\Work\\demo2\\a.ts')).toBe('D:\\Work\\demo2\\a.ts')
  })
})
