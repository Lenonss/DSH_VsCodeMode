/**
 * React 元素类型判定单测。
 * 重点钉住 GUI 端到端验证捕获的真实缺陷：`React.memo` 产物的 typeof 是 'object' 而非 'function'，
 * 只判 function 会让 Markdown 预览在所有新版 DSH 上永久走降级分支。
 * 作者 ddj 2026年09月18号
 */
import { describe, expect, it } from 'vitest'
import { isComponentType } from '../src/client/md/componentType.js'

/** 构造 React.memo / forwardRef 同款的「外部对象类型」替身（带 $$typeof 标记）。 */
const exotic = (tag: string) => ({ $$typeof: Symbol.for(tag), render: () => null })

describe('isComponentType', () => {
  it('函数组件/类组件为真', () => {
    expect(isComponentType(function Fn() { return null })).toBe(true)
    expect(isComponentType(() => null)).toBe(true)
    expect(isComponentType(class Cls {})).toBe(true)
  })

  it('memo/forwardRef/lazy 等外部对象类型为真（关键回归：typeof 是 object 而非 function）', () => {
    const memoLike = exotic('react.memo')
    // 先固化缺陷前提：这类值 typeof 不是 function
    expect(typeof memoLike).toBe('object')
    expect(isComponentType(memoLike)).toBe(true)
    expect(isComponentType(exotic('react.forward_ref'))).toBe(true)
    expect(isComponentType(exotic('react.lazy'))).toBe(true)
  })

  it('旧版 DSH 缺该导出（undefined）→ 假（走降级分支）', () => {
    expect(isComponentType(undefined)).toBe(false)
  })

  it('普通对象/字符串/数字/null/布尔 → 假（不得被当成组件，避免 createElement 抛错）', () => {
    expect(isComponentType({})).toBe(false)
    expect(isComponentType({ render: () => null })).toBe(false)
    expect(isComponentType('MarkdownText')).toBe(false)
    expect(isComponentType(0)).toBe(false)
    expect(isComponentType(null)).toBe(false)
    expect(isComponentType(false)).toBe(false)
  })
})
