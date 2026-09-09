/**
 * client scopeStore 测试（编辑区状态作用域：路径归一化/作用域键/旧会话键迁移）。
 * 作者 ddj 2026-09-09
 */
import { describe, expect, it } from 'vitest'
import { migrateScopedKeys, normalizeWsPath, workspaceScopeOf } from '../src/client/state/scopeStore.js'

/** 内存 Storage 桩（迁移函数注入用）。 */
function memStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries))
  return {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => { map.delete(k) },
    setItem: (k, v) => { map.set(k, String(v)) },
  } as Storage
}

describe('normalizeWsPath', () => {
  it('分隔符与尾斜杠归一化（Windows 路径折叠为小写）', () => {
    expect(normalizeWsPath('D:\\Work\\x\\')).toBe('d:/work/x')
    expect(normalizeWsPath('/tmp/ws/')).toBe('/tmp/ws')
    expect(normalizeWsPath('  /a/b  ')).toBe('/a/b')
  })
  it('空值 → 空串', () => {
    expect(normalizeWsPath('')).toBe('')
    expect(normalizeWsPath(null)).toBe('')
    expect(normalizeWsPath(undefined)).toBe('')
  })
  it('Windows 盘符路径大小写不敏感（折叠），POSIX 保留大小写', () => {
    expect(normalizeWsPath('d:\\work\\X')).toBe(normalizeWsPath('D:/Work/x'))
    expect(normalizeWsPath('/Work/X')).not.toBe(normalizeWsPath('/work/x'))
  })
})

describe('workspaceScopeOf', () => {
  it('有 cwd → ws: 前缀（归一化后）', () => {
    expect(workspaceScopeOf('D:\\Work\\x\\', 's1')).toBe('ws:d:/work/x')
  })
  it('无 cwd 回退会话隔离', () => {
    expect(workspaceScopeOf(null, 's1')).toBe('sid:s1')
    expect(workspaceScopeOf(undefined, 's2')).toBe('sid:s2')
  })
  it('同工作区不同会话 → 同一作用域', () => {
    expect(workspaceScopeOf('D:\\A', 's1')).toBe(workspaceScopeOf('d:/a/', 's2'))
  })
})

describe('migrateScopedKeys', () => {
  it('旧会话键复制到作用域键', () => {
    const store = memStorage({ 'edrv.editor.v2.s1': '{"tabs":["a.ts"],"active":"a.ts"}' })
    migrateScopedKeys('ws:d:/w', 's1', store)
    expect(store.getItem('edrv.editor.v2.ws:d:/w')).toBe('{"tabs":["a.ts"],"active":"a.ts"}')
  })
  it('目标已存在跳过，不覆盖', () => {
    const store = memStorage({
      'edrv.editor.v2.s1': 'old',
      'edrv.editor.v2.ws:d:/w': 'new',
    })
    migrateScopedKeys('ws:d:/w', 's1', store)
    expect(store.getItem('edrv.editor.v2.ws:d:/w')).toBe('new')
  })
  it('无旧键不写目标', () => {
    const store = memStorage()
    migrateScopedKeys('ws:d:/w', 's1', store)
    expect(store.getItem('edrv.editor.v2.ws:d:/w')).toBeNull()
  })
  it('缺参直接返回', () => {
    const store = memStorage({ 'edrv.editor.v2.s1': 'v' })
    migrateScopedKeys('', 's1', store)
    migrateScopedKeys('ws:d:/w', undefined, store)
    expect(store.getItem('edrv.editor.v2.ws:d:/w')).toBeNull()
  })
})
