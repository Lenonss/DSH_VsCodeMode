/**
 * client modelCache 测试（跨挂载 model 缓存：作用域切换释放/LRU/附着保护）。
 * 作者 ddj 2026-09-09
 */
import { describe, expect, it } from 'vitest'
import { MODEL_CACHE_CAP, modelsForScope, rememberModel } from '../src/client/state/modelCache.js'

/** Monaco model 测试桩：可 dispose，可报告是否附着编辑器。 */
function fakeModel(attached = false): { disposed: boolean; isAttachedToEditor: () => boolean; dispose: () => void } {
  const stub = {
    disposed: false,
    isAttachedToEditor: () => attached,
    dispose: () => { stub.disposed = true },
  }
  return stub
}

describe('modelsForScope', () => {
  it('同作用域重复调用复用同一 Map', () => {
    const a = modelsForScope('ws:test-scope-a')
    a.set('x.ts', fakeModel())
    const b = modelsForScope('ws:test-scope-a')
    expect(b).toBe(a)
    expect(b.has('x.ts')).toBe(true)
  })

  it('切作用域释放上一作用域未附着的模型', () => {
    const prev = modelsForScope('ws:release-prev')
    const free = fakeModel(false)
    const attached = fakeModel(true)
    prev.set('free.ts', free)
    prev.set('attached.ts', attached)
    const next = modelsForScope('ws:release-next')
    expect(free.disposed).toBe(true) // 未附着 → 真正释放
    expect(attached.disposed).toBe(false) // 附着中 → 保留给编辑器自毁
    expect(prev.size).toBe(0)
    expect(next).not.toBe(prev)
    modelsForScope('ws:release-next') // 稳定当前作用域，后续用例不受影响
  })
})

describe('rememberModel', () => {
  it('刷新 LRU 序；逐出附着中的模型时移出但不 dispose', () => {
    const map = new Map<string, unknown>()
    const attached = fakeModel(true)
    rememberModel(map, 'a.ts', attached)
    for (let i = 0; i < MODEL_CACHE_CAP - 1; i++) rememberModel(map, 'f' + i + '.ts', fakeModel())
    // 容量已满：a.ts 最旧且附着中 → 被逐出但不 dispose
    rememberModel(map, 'extra.ts', fakeModel())
    expect(map.has('a.ts')).toBe(false)
    expect(attached.disposed).toBe(false)
    expect(map.size).toBe(MODEL_CACHE_CAP)
  })

  it('逐出未附着的模型时真正 dispose', () => {
    const map = new Map<string, unknown>()
    const free = fakeModel(false)
    rememberModel(map, 'free.ts', free)
    for (let i = 0; i < MODEL_CACHE_CAP; i++) rememberModel(map, 'g' + i + '.ts', fakeModel())
    expect(free.disposed).toBe(true)
    expect(map.size).toBe(MODEL_CACHE_CAP)
  })

  it('容量上限为正', () => {
    expect(MODEL_CACHE_CAP).toBeGreaterThan(0)
  })

  it('空 path/空模型忽略', () => {
    const map = new Map<string, unknown>()
    rememberModel(map, '', fakeModel())
    rememberModel(map, 'x.ts', null)
    expect(map.size).toBe(0)
  })
})
