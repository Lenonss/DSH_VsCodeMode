/**
 * 跨挂载/跨热重载待跳转交接（pendingNav）测试。
 *
 * 事故背景（第三次同款症状，2026-09-23 实测取证）：并行改码触发插件 client HMR 热重载
 * （保留 console 装配日志重复 6-7 轮为证）→ EditorView 重挂载 → 挂载级 pendingFocusRef
 * 随旧实例销毁 → 「Ctrl+点击首开只打开文件不落行，热重载平息后第二次才正常」。
 * 修复：openFileAt 同步写 window.__edrvPendingNav__ 槽，落点 effect 取 ref || 槽、
 * 成功后一并清；本文件锁定槽协议的四件事：
 *   A. put/read 往返与时间戳（且 read 不消费，新鲜槽可反复读）；
 *   B. TTL 过期即失效并清槽（防"稍后莫名跳一下"）；
 *   C. 形状守卫（垃圾数据/缺 path/非数字 at → null 且清槽）；
 *   D. 无 window 环境（node 测试/SSR）读写降级为 no-op 不抛。
 * 作者 ddj 2026年09月23号
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PENDING_NAV_KEY,
  PENDING_NAV_TTL,
  clearPendingNav,
  freshNav,
  putPendingNav,
  readPendingNav,
  sanitizeNav,
} from '../src/client/pendingNav.js'

const g = globalThis as Record<string, unknown>
const win = (): Record<string, unknown> | undefined => g.window as Record<string, unknown> | undefined
let hadWindow = false
let savedWindow: unknown

beforeEach(() => {
  hadWindow = 'window' in g
  savedWindow = g.window
  if (!hadWindow) g.window = {}
  delete win()![PENDING_NAV_KEY]
})

afterEach(() => {
  if (hadWindow) g.window = savedWindow
  else delete g.window
})

describe('sanitizeNav / freshNav：形状守卫与新鲜度（纯函数）', () => {
  it('合法入参归一化：非数字行列归 null，at 保留', () => {
    expect(sanitizeNav({ path: 'a/b.lua', line: 12, column: 'x', at: 1000 }))
      .toEqual({ path: 'a/b.lua', line: 12, column: null, endLine: null, endColumn: null, at: 1000 })
  })

  it('缺 path / 非对象 / 空 path → null', () => {
    expect(sanitizeNav(null)).toBeNull()
    expect(sanitizeNav('x')).toBeNull()
    expect(sanitizeNav({ line: 1, at: 5 })).toBeNull()
    expect(sanitizeNav({ path: '', at: 5 })).toBeNull()
  })

  it('新鲜度边界：恰在 TTL 内有效，超过即 null', () => {
    const nav = sanitizeNav({ path: 'a.lua', at: 1000 })!
    expect(freshNav(nav, 1000 + PENDING_NAV_TTL, PENDING_NAV_TTL)).not.toBeNull()
    expect(freshNav(nav, 1000 + PENDING_NAV_TTL + 1, PENDING_NAV_TTL)).toBeNull()
    expect(freshNav(null, 0, PENDING_NAV_TTL)).toBeNull()
  })
})

describe('window 槽：put / read / clear 往返', () => {
  it('put → read 往返成功并带 at 时间戳；read 不消费（可反复读）', () => {
    expect(putPendingNav({ path: 'Assets/x.lua', line: 88, column: 5 }, 1000)).toBe(true)
    const first = readPendingNav(1000 + 10)
    expect(first).toEqual({ path: 'Assets/x.lua', line: 88, column: 5, endLine: null, endColumn: null, at: 1000 })
    expect(readPendingNav(1000 + 20)).toEqual(first) // 第二次仍可读：消费点在落点成功处
  })

  it('TTL 过期 → null 且槽被清除', () => {
    putPendingNav({ path: 'a.lua', line: 3 }, 1000)
    expect(readPendingNav(1000 + PENDING_NAV_TTL + 1)).toBeNull()
    expect(win()![PENDING_NAV_KEY]).toBeUndefined()
  })

  it('非法 path 不写槽', () => {
    expect(putPendingNav({ path: '' } as never, 1000)).toBe(false)
    expect(win()![PENDING_NAV_KEY]).toBeUndefined()
  })

  it('垃圾槽数据（缺 path / at 非数字 / 裸字符串）→ null 且清槽', () => {
    for (const garbage of [{ line: 1, at: 5 }, { path: 'a.lua', at: 'nope' }, 'garbage', 42]) {
      win()![PENDING_NAV_KEY] = garbage
      expect(readPendingNav(1000)).toBeNull()
      expect(win()![PENDING_NAV_KEY]).toBeUndefined()
    }
  })

  it('clearPendingNav 幂等清槽', () => {
    putPendingNav({ path: 'a.lua', line: 1 }, 1000)
    clearPendingNav()
    expect(win()![PENDING_NAV_KEY]).toBeUndefined()
    expect(() => clearPendingNav()).not.toThrow()
    expect(readPendingNav(1000)).toBeNull()
  })

  it('无 window 环境（node/SSR）读写降级 no-op 不抛', () => {
    delete g.window
    expect(putPendingNav({ path: 'a.lua' })).toBe(false)
    expect(readPendingNav(1000)).toBeNull()
    expect(() => clearPendingNav()).not.toThrow()
  })
})
