/** 宿主根作用域解析测试：新旧 cordis 的根定位、读取抛错兜底与同一性。作者 ddj 2026年11月23号 */
import { describe, expect, it } from 'vitest'
import { hostRootOf } from '../src/hostRoot.js'

const CONTEXT_ROOT = Symbol.for('cordis.root')

describe('hostRootOf', () => {
  it('新版 cordis 从 Symbol.for("cordis.root") 取根', () => {
    const root = { name: 'root' }
    const ctx = { [CONTEXT_ROOT]: root, name: 'child' }

    expect(hostRootOf(ctx)).toBe(root)
  })

  it('旧版 cordis 从普通属性 root 取根', () => {
    const root = { name: 'root' }
    const ctx = { root, name: 'child' }

    expect(hostRootOf(ctx)).toBe(root)
  })

  it('同一条根下的多个子上下文解析到同一个键', () => {
    const root = { name: 'root' }
    const first = { [CONTEXT_ROOT]: root }
    const second = { [CONTEXT_ROOT]: root, extra: true }

    expect(hostRootOf(first)).toBe(hostRootOf(second))
  })

  it('读取 root 抛错时回落且不抛错', () => {
    const ctx = {
      get name() {
        return 'child'
      },
      get root(): object {
        throw new Error('cannot get property "root" without inject')
      },
    }

    const scope = hostRootOf(ctx)
    expect(typeof scope).toBe('object')
    expect(hostRootOf(ctx)).toBe(scope)
  })

  it('两条通道都缺失时以上下文自身为键，不同上下文互不合并', () => {
    const first = { name: 'first' }
    const second = { name: 'second' }

    expect(hostRootOf(first)).toBe(first)
    expect(hostRootOf(second)).toBe(second)
    expect(hostRootOf(first)).not.toBe(hostRootOf(second))
  })

  it('上下文不可作键时退回同一进程级兜底作用域', () => {
    const scope = hostRootOf(undefined)

    expect(typeof scope).toBe('object')
    expect(hostRootOf(undefined)).toBe(scope)
    expect(hostRootOf(null)).toBe(scope)
  })

  it('符号键优先于旧属性', () => {
    const symbolRoot = { name: 'symbol-root' }
    const legacyRoot = { name: 'legacy-root' }
    const ctx = { [CONTEXT_ROOT]: symbolRoot, root: legacyRoot }

    expect(hostRootOf(ctx)).toBe(symbolRoot)
  })
})
