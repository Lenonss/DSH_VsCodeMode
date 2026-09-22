/**
 * 调试面板「断点项点击自动跳转」测试。
 *
 * 背景（用户报告）：侧栏调试面板的断点行只有**文件名那一个 button** 绑了跳转，
 * 点红点/目录/行号徽标/行内空白处毫无反应，必须精准点中文件名才跳。本改动把跳转面
 * 提到整行。两个必须钉死的边界：
 *   ① openFileAt 内部会 recordNav()，所以**一次点击只能调一次** —— 行级挂唯一 handler，
 *      文件名按钮不得再自带 onClick（否则双触发、导航历史重复入栈）；
 *   ② checkbox（启停）与 ×（删除）不得连带跳转，必须阻断冒泡。
 * 组件渲染走 React DOM，本仓库 vitest 为 node 环境不挂载，故采用
 * 「纯函数真断言 + 源码接线契约断言」（同 searchNav.test.ts / navTarget.test.ts 口径）。
 * 作者 ddj 2026年09月21号
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bpJumpTargetOf } from '../src/client/dap/breakpoints.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const readSrc = (rel: string): string => readFileSync(ROOT + rel, 'utf8')
/** 去注释后再做契约断言（注释里正当地解释了被禁写法，会提到 onClick/stopPropagation）。 */
const stripComments = (raw: string): string => raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const PANEL = 'src/client/sidebar/panels/DebugPanel.ts'
const CSS = 'src/client/styles/editor.css'

/**
 * 取 [start, end) 之间的源码片段（契约断言用；两端锚点缺失时返回空串）。
 * @author ddj 2026年09月21号
 */
function sliceBetween(src: string, start: string, end: string): string {
  const from = src.indexOf(start)
  if (from < 0) return ''
  const to = src.indexOf(end, from + start.length)
  return to < 0 ? '' : src.slice(from, to)
}

describe('bpJumpTargetOf：跳转目标推导与无效行守卫', () => {
  it('正常行 → 路径 + 行号 + 列 1（与搜索面板命中跳转同口径）', () => {
    expect(bpJumpTargetOf({ path: 'Assets/Scripts/Lua/A.lua', entry: { line: 199 } }))
      .toEqual({ path: 'Assets/Scripts/Lua/A.lua', line: 199, column: 1 })
  })

  it('路径空串/空白缺失 → null（不发起无效导航）', () => {
    expect(bpJumpTargetOf({ path: '', entry: { line: 3 } })).toBeNull()
    expect(bpJumpTargetOf({ path: undefined, entry: { line: 3 } })).toBeNull()
    expect(bpJumpTargetOf({ entry: { line: 3 } })).toBeNull()
  })

  it('行号非法（0 / 负数 / NaN / 非数字 / 缺失）→ null', () => {
    expect(bpJumpTargetOf({ path: 'a.lua', entry: { line: 0 } })).toBeNull()
    expect(bpJumpTargetOf({ path: 'a.lua', entry: { line: -5 } })).toBeNull()
    expect(bpJumpTargetOf({ path: 'a.lua', entry: { line: Number.NaN } })).toBeNull()
    expect(bpJumpTargetOf({ path: 'a.lua', entry: { line: Number.POSITIVE_INFINITY } })).toBeNull()
    expect(bpJumpTargetOf({ path: 'a.lua', entry: { line: '12' as unknown as number } })).toBeNull()
    expect(bpJumpTargetOf({ path: 'a.lua', entry: {} })).toBeNull()
    expect(bpJumpTargetOf({ path: 'a.lua' })).toBeNull()
  })

  it('空/损坏入参安全返回 null', () => {
    expect(bpJumpTargetOf(null)).toBeNull()
    expect(bpJumpTargetOf(undefined)).toBeNull()
    expect(bpJumpTargetOf({})).toBeNull()
  })

  it('不篡改入参对象（面板行视图跨渲染复用）', () => {
    const row = { path: 'a/b.lua', entry: { line: 7, enabled: true } }
    const snapshot = JSON.stringify(row)
    bpJumpTargetOf(row)
    expect(JSON.stringify(row)).toBe(snapshot)
  })
})

describe('DebugPanel 断点行接线（契约：整行唯一跳转入口）', () => {
  const code = stripComments(readSrc(PANEL))

  it('行容器携带 onClick 且调用 jumpBp（跳转面 = 整行）', () => {
    const row = sliceBetween(code, "className: 'edrv-dapbp'", 'edrv-dapbp-dot')
    expect(row).not.toBe('')
    expect(row).toContain('onClick: () => jumpBp(row)')
  })

  it('jumpBp 经纯函数守卫后才跳转（无效行不导航）', () => {
    expect(code).toContain('bpJumpTargetOf(row)')
    const fn = sliceBetween(code, 'const jumpBp = (row) => {', 'ctx?.openFileAt?.(')
    expect(fn).toContain('if (target)')
  })

  it('文件名按钮不再自带 onClick（防与行级 handler 双触发、双记导航历史）', () => {
    const fileBtn = sliceBetween(code, "className: 'edrv-dapbp-file'", ', base)')
    expect(fileBtn).not.toBe('')
    expect(fileBtn).not.toContain('onClick')
  })

  it('启停 checkbox 阻断冒泡（不连带跳转）', () => {
    const box = sliceBetween(code, "type: 'checkbox'", 'edrv-dapbp-dot')
    expect(box).toContain('stopPropagation')
    // 阻断不得吃掉原有启停行为
    expect(box).toContain('toggleBpEnabled(row)')
  })

  it('删除 × 阻断冒泡且仍执行删除（不连带跳转）', () => {
    const del = sliceBetween(code, "className: 'edrv-dapbp-x'", "'×'")
    expect(del).toContain('stopPropagation')
    expect(del).toContain('removeBp(row)')
  })

  it('整行点击同时驱动跳转与「跳转到」提示文案', () => {
    expect(code).toContain("title: '跳转到 ' + row.path + ':' + row.entry.line")
  })
})

describe('断点行可点击视觉契约', () => {
  const css = readSrc(CSS)

  it('.edrv-dapbp 声明 cursor: pointer（整行可点的可发现性）', () => {
    const rule = sliceBetween(css, '[data-edrv-view] .edrv-dapbp {', '}')
    expect(rule).toContain('cursor: pointer')
  })

  it('按下反馈声明在 :hover 之后且同作用域（样式不得整块失配）', () => {
    expect(css).toContain('[data-edrv-view] .edrv-dapbp:hover {')
    const hoverAt = css.indexOf('[data-edrv-view] .edrv-dapbp:hover {')
    const activeAt = css.indexOf('[data-edrv-view] .edrv-dapbp:active {')
    expect(activeAt).toBeGreaterThan(hoverAt)
  })
})
