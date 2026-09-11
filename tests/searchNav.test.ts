/**
 * QuickOpen 候选浮窗键盘导航测试。
 *
 * 覆盖三件事：
 * ① 纯函数 stepIndex 的步进/循环/边界收敛语义（组件按键处理的唯一决策点）；
 * ② QuickOpen 源码接线契约：↑↓ 走 stepIndex、Enter 打开高亮项（回归：曾写死
 *    `pick(results[0])`，导致键盘无法选择）、输入法组词中不消费按键、高亮项滚入可视区；
 * ③ 高亮态样式契约：.edrv-search-sel 必须以 [data-edrv-view] 限定且声明在 :hover 之后
 *    （同特异性靠后胜出，否则鼠标扫过时高亮不可辨；前缀缺失即浮层样式整块失配）。
 * 组件渲染走 React DOM，本仓库 vitest 为 node 环境不挂载，故逻辑单测 + 源码静态断言。
 * 作者 ddj 2026-09-11
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stepIndex } from '../src/client/ui/searchNav.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 读取文件（相对包根）。 */
function read(rel: string): string {
  return readFileSync(ROOT + rel, 'utf8')
}

describe('stepIndex 步进语义', () => {
  it('中间位置按下/上按各移动一项', () => {
    expect(stepIndex(1, 1, 5)).toBe(2)
    expect(stepIndex(3, -1, 5)).toBe(2)
  })

  it('末位继续向下循环回首位；首位向上循环到末位', () => {
    expect(stepIndex(4, 1, 5)).toBe(0)
    expect(stepIndex(0, -1, 5)).toBe(4)
  })

  it('单项列表按下/上按都停在唯一项', () => {
    expect(stepIndex(0, 1, 1)).toBe(0)
    expect(stepIndex(0, -1, 1)).toBe(0)
  })

  it('空列表恒返回 0（不产生负下标）', () => {
    expect(stepIndex(0, 1, 0)).toBe(0)
    expect(stepIndex(3, -1, 0)).toBe(0)
    expect(stepIndex(0, 1, -2)).toBe(0)
  })

  it('当前下标越界（异步结果变短）先收敛再步进', () => {
    // 9 越界 → 收敛到末位 2；再 ↓ 循环回 0
    expect(stepIndex(9, 1, 3)).toBe(0)
    // 9 越界 → 收敛到末位 2；再 ↑ 得 1
    expect(stepIndex(9, -1, 3)).toBe(1)
    // 负下标收敛到首位 0；再 ↓ 得 1
    expect(stepIndex(-5, 1, 3)).toBe(1)
  })

  it('非有限输入不产生 NaN/越界（防御脏数据）', () => {
    expect(stepIndex(Number.NaN, 1, 3)).toBe(1)
    expect(stepIndex(1, Number.NaN, 3)).toBe(1)
    expect(stepIndex(1, Number.POSITIVE_INFINITY, 3)).toBe(1)
    expect(stepIndex(1, 0, 3)).toBe(1)
  })

  it('返回值恒在 [0, length-1] 区间内', () => {
    for (const current of [-3, 0, 2, 7]) {
      for (const delta of [-2, -1, 0, 1, 2]) {
        const index = stepIndex(current, delta, 4)
        expect(index).toBeGreaterThanOrEqual(0)
        expect(index).toBeLessThanOrEqual(3)
        expect(Number.isInteger(index)).toBe(true)
      }
    }
  })
})

describe('QuickOpen 键盘接线契约', () => {
  const source = read('src/client/ui/QuickOpen.ts')

  it('↑↓ 均接入 stepIndex 并阻止光标移动', () => {
    expect(source).toContain("from './searchNav.js'")
    expect(source).toContain('stepIndex(')
    expect(source).toContain("e.key === 'ArrowDown'")
    expect(source).toContain("e.key === 'ArrowUp'")
    expect(source).toContain('e.preventDefault()')
  })

  it('Enter 打开高亮项（回归：曾被写死为 results[0]，键盘选择无效）', () => {
    expect(source).toContain('pick(list[activeIdx])')
    expect(source).not.toContain('pick(results[0])')
  })

  it('高亮下标按候选长度收敛（异步结果变短不越界）', () => {
    expect(source).toMatch(/Math\.min\(active, list\.length - 1\)/)
  })

  it('查询变化时高亮回到第一项', () => {
    expect(source).toMatch(/setQ\(v\); setActive\(0\)/)
  })

  it('输入法组词中不消费按键（中文候选词 Enter 确认优先）', () => {
    expect(source).toContain('isComposing')
  })

  it('高亮项滚入浮窗可视区', () => {
    expect(source).toContain('scrollIntoView')
    expect(source).toContain('.edrv-search-item.edrv-search-sel')
  })

  it('候选项与浮窗带 ARIA 选中标识', () => {
    expect(source).toContain("'aria-selected': i === activeIdx")
    expect(source).toContain("'aria-activedescendant'")
    expect(source).toContain("role: 'listbox'")
  })

  it('鼠标悬停与高亮同步（点击语义不变）', () => {
    expect(source).toMatch(/onMouseEnter: \(\) => setActive\(i\)/)
    expect(source).toMatch(/onClick: \(\) => pick\(p\)/)
  })
})

describe('高亮态样式契约', () => {
  const css = read('src/client/styles/editor.css').split('\n')

  /** 某类选择器所在行号（未找到返回 -1）。 */
  function lineOf(selector: string): number {
    return css.findIndex((line) => line.includes(selector) && line.includes('{'))
  }

  it('.edrv-search-sel 规则以 [data-edrv-view] 限定（防浮层样式静默失配）', () => {
    const at = lineOf('.edrv-search-item.edrv-search-sel')
    expect(at, 'editor.css 缺少 .edrv-search-item.edrv-search-sel 规则').toBeGreaterThanOrEqual(0)
    expect(css[at].trimStart().startsWith('[data-edrv-view]')).toBe(true)
  })

  it('高亮规则声明在 :hover 之后（同特异性靠后胜出，保证选中可辨）', () => {
    const sel = lineOf('.edrv-search-item.edrv-search-sel')
    const hover = lineOf('.edrv-search-item:hover')
    expect(hover).toBeGreaterThanOrEqual(0)
    expect(sel).toBeGreaterThan(hover)
  })
})
