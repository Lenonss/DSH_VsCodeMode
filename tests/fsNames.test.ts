/**
 * shared/fsNames.ts 文件操作名称/路径校验单测。
 * 覆盖：新建名（嵌套段/绝对路径/盘符/点段/控制字符/超长）、重命名名单段约束、
 * 路径拼接与父目录/末段推导、复制移动的「自身或子目录」护栏。
 * 作者 ddj 2026年09月22号
 */
import { describe, expect, it } from 'vitest'
import {
  NAME_MAX,
  baseNameOf,
  checkNewName,
  checkRenameName,
  isSubPath,
  joinRelPath,
  parentRelOf,
} from '../src/shared/fsNames.js'

describe('checkNewName 新建名校验（允许 a/b.c 嵌套段）', () => {
  it('单段名与嵌套名通过', () => {
    expect(checkNewName('a.ts')).toBeNull()
    expect(checkNewName('src/a.ts')).toBeNull()
    expect(checkNewName('a/b.c')).toBeNull()
    expect(checkNewName('  a.ts  ')).toBeNull()
  })

  it('空名/纯空白拒绝', () => {
    expect(checkNewName('')).toBe('名称不能为空')
    expect(checkNewName('   ')).toBe('名称不能为空')
    expect(checkNewName(null)).toBe('名称不能为空')
    expect(checkNewName(undefined)).toBe('名称不能为空')
  })

  it('绝对路径与盘符拒绝', () => {
    expect(checkNewName('/etc/passwd')).toBe('名称不能是绝对路径')
    expect(checkNewName('C:/x')).toBe('名称不能带盘符')
  })

  it('. 与 .. 路径段拒绝（目录穿越护栏）', () => {
    expect(checkNewName('..')).not.toBeNull()
    expect(checkNewName('../x')).not.toBeNull()
    expect(checkNewName('a/../b')).not.toBeNull()
    expect(checkNewName('a/./b')).not.toBeNull()
  })

  it('空路径段拒绝（a//b 不静默吞掉）', () => {
    expect(checkNewName('a//b')).toBe('名称包含空路径段')
    expect(checkNewName('a/')).toBe('名称包含空路径段')
  })

  it('反斜杠按路径分隔等价处理', () => {
    expect(checkNewName('a\\b.ts')).toBeNull()
    expect(checkNewName('a\\..\\b')).not.toBeNull()
  })

  it('控制字符与超长名称拒绝', () => {
    expect(checkNewName('a\u0000b')).not.toBeNull()
    expect(checkNewName('x'.repeat(NAME_MAX + 1))).not.toBeNull()
  })
})

describe('checkRenameName 重命名校验（仅名称段）', () => {
  it('普通名称通过；路径/点段/空名拒绝', () => {
    expect(checkRenameName('b.ts')).toBeNull()
    expect(checkRenameName('  b.ts  ')).toBeNull()
    expect(checkRenameName('a/b')).toBe('新名称不能包含路径分隔符')
    expect(checkRenameName('a\\b')).toBe('新名称不能包含路径分隔符')
    expect(checkRenameName('.')).not.toBeNull()
    expect(checkRenameName('..')).not.toBeNull()
    expect(checkRenameName('')).toBe('名称不能为空')
    expect(checkRenameName('x'.repeat(NAME_MAX + 1))).not.toBeNull()
  })
})

describe('路径推导', () => {
  it('joinRelPath：dir 为空 = 根；反斜杠归一', () => {
    expect(joinRelPath('src', 'a.ts')).toBe('src/a.ts')
    expect(joinRelPath('', 'a.ts')).toBe('a.ts')
    expect(joinRelPath('src/', 'a.ts')).toBe('src/a.ts')
    expect(joinRelPath('src', 'x\\y.ts')).toBe('src/x/y.ts')
    expect(joinRelPath('src', 'a/b.c')).toBe('src/a/b.c')
  })

  it('parentRelOf / baseNameOf：顶层条目父目录为根', () => {
    expect(parentRelOf('src/a.ts')).toBe('src')
    expect(parentRelOf('a.ts')).toBe('')
    expect(parentRelOf('a/b/c.ts')).toBe('a/b')
    expect(baseNameOf('src/a.ts')).toBe('a.ts')
    expect(baseNameOf('a.ts')).toBe('a.ts')
    expect(baseNameOf('')).toBe('')
  })
})

describe('isSubPath 自身/子目录护栏', () => {
  it('自身与其内部路径命中；兄弟/父级不命中', () => {
    expect(isSubPath('a', 'a')).toBe(true)
    expect(isSubPath('a', 'a/b')).toBe(true)
    expect(isSubPath('a', 'ab')).toBe(false)
    expect(isSubPath('a/b', 'a')).toBe(false)
    expect(isSubPath('', 'a')).toBe(false)
  })
})
