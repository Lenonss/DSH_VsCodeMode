/**
 * 跳转目标解析与落地高亮回归测试。
 *
 * 事故回顾（用户报告）：在 ActivityTeamWorkActorComponent.lua 里 Ctrl+点击
 * `EGameHall.UserProfileMode`，只打开了 EGameHall.lua、没有定位到行，也没有任何高亮。
 *
 * 运行时证据（chrome-devtools 只读探针，v0.4.6 实测）：
 *   ① opener 派发的事件是**正确**的：{path:'EGameHall.lua', line:349, column:5}；
 *   ② 但 EditorView 的跳转 effect 门控用的是 `content === null`。跨文件切换的那一帧
 *      `content` 仍是**上一个文件**的内容（非 null），于是「已就绪」被误判：
 *        model(B) 先被填入 A 的内容(5855 字符) → reveal/setPosition(349) 生效 →
 *        B 的真实内容到达触发 setValue(16828) → Monaco 重置光标 → 停在 {1,1}，
 *        而 pendingFocus 已被消费，落点永久丢失。
 *   ③ 同文件跳转不换内容故不复现（这也解释了该 bug 看起来「时好时坏」）。
 * 修复：跳转/建 model 一律以 contentReady（contentPath === active）为门；落地后
 * 由 flashNavTarget 给目标区域挂 `.edrv-nav-target` 高亮（约 1.2s 自动清除）。
 *
 * 本文件锁定三件事：
 *   A. navTargetOf 对 opener 三种第三参形态都能解析出正确的 1-based 行/列；
 *   B. EditorView 的跳转门控必须是 contentReady（并用源码契约钉死，防退回 content === null）；
 *   C. 落地高亮装饰与样式类名存在且可用。
 *
 * 追加事故（用户报告，v0.5.3 实测复现）：「文件未打开时跳转只打开文件、不定位行，
 * 需手动再触发一次才落到目标行」。运行时证据（chrome-devtools 探针）：
 *   Monaco 未就绪时派发 {line:500} 的跳转 → 首次停在 1:1；等就绪后再派发 → 首次即 500。
 * 根因：contentReady 在**文本到达**时即为真，可能早于 Monaco 就绪；那一帧
 * editorRef.current 仍为 null → 该 effect 提前返回并保留 pendingFocus；随后 Monaco 载入、
 * ensureEditor 建好编辑器，但变化的只有 monaco，而 monaco 不在依赖数组里 → effect 不重跑，
 * pendingFocus 永久滞留。二次触发会 +1 focusRequest（是依赖）才落地。
 * 修复：跳转 effect 依赖补 monaco 与 mdPreviewing（后者是预览态重建编辑器的同类竞态）。
 * 见 navFlashRangeOf / 本文件 D 组用例。
 * 作者 ddj 2026-09-17 / 2026年09月21号
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { navTargetOf } from '../src/client/monaco/lsp/providers.js'
import { navFlashRangeOf } from '../src/client/navHighlight.js'

const ROOT = process.cwd()
const readSrc = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
/** 去掉注释后再做契约断言（注释里正当地解释了本次事故，会提到被禁写法）。 */
const stripComments = (raw: string): string => raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const EDITOR_VIEW = 'src/client/ui/EditorView.ts'
const PROVIDERS = 'src/client/monaco/lsp/providers.ts'
const CSS = 'src/client/styles/editor.css'

describe('navTargetOf：opener 第三参三形态解析', () => {
  it('形态 1 —— Monaco Range（带 getStartPosition/getEndPosition）', () => {
    const range = {
      startLineNumber: 349,
      startColumn: 5,
      endLineNumber: 351,
      endColumn: 12,
      getStartPosition: () => ({ lineNumber: 349, column: 5 }),
      getEndPosition: () => ({ lineNumber: 351, column: 12 }),
    }
    expect(navTargetOf(range)).toEqual({ line: 349, column: 5, endLine: 351, endColumn: 12 })
  })

  it('形态 2 —— 官方桥降级后的裸 { lineNumber, column }（无 getStartPosition）', () => {
    // 官方 registerEditorOpener 桥在 Range 缺 endLineNumber/endColumn 时会降级成这个形态
    expect(navTargetOf({ lineNumber: 349, column: 5 })).toEqual({ line: 349, column: 5, endLine: 349 })
  })

  it('形态 3 —— 四字段平坦对象（end 显式给出）', () => {
    expect(navTargetOf({ lineNumber: 10, column: 3, endLineNumber: 12, endColumn: 7 }))
      .toEqual({ line: 10, column: 3, endLine: 12, endColumn: 7 })
  })

  it('第三参缺失（editor.action.goToLocations 不传 options）→ 不抛错且兜底第 1 行', () => {
    // 关键：绝不能因为缺字段就抛错或产出 NaN（曾致落点退化为文件首行）
    expect(navTargetOf(undefined)).toEqual({ line: 1, column: 1, endLine: 1 })
    expect(navTargetOf(null)).toEqual({ line: 1, column: 1, endLine: 1 })
    expect(navTargetOf({})).toEqual({ line: 1, column: 1, endLine: 1 })
  })

  it('缺列/非法值各自兜底为 1，且行号不会低于 1', () => {
    expect(navTargetOf({ lineNumber: 0, column: 0 })).toEqual({ line: 1, column: 1, endLine: 1 })
    expect(navTargetOf({ lineNumber: -5 })).toEqual({ line: 1, column: 1, endLine: 1 })
  })

  it('end 早于 start 时被夹到 start（保证区间合法，反向高亮会渲染异常）', () => {
    const out = navTargetOf({ lineNumber: 20, column: 4, endLineNumber: 3, endColumn: 1 })
    expect(out.line).toBe(20)
    expect(out.endLine).toBe(20)
  })

  it('endColumn 缺失时省略该字段（交由落地端按单词/整行推定）', () => {
    expect('endColumn' in navTargetOf({ lineNumber: 7, column: 2 })).toBe(false)
  })
})

describe('EditorView：跳转门控必须用 contentReady', () => {
  const code = stripComments(readSrc(EDITOR_VIEW))

  it('跳转 effect 以 contentReady 门控（回归：曾用 content === null 误判就绪）', () => {
    // 以 effect 内唯一可执行语句为锚点（不用注释：注释已被 stripComments 去掉）
    const anchor = code.indexOf('if (!ed || !contentReady) return')
    expect(anchor, '应能定位跳转 effect 的 contentReady 门控').toBeGreaterThan(-1)
    const body = code.slice(anchor, anchor + 3000)
    // 关键回归断言：跳转 effect 里不得再用裸 content === null 作为就绪判据
    expect(body).not.toContain('content === null')
    // 且必须真的把 pendingFocus 消费在 contentReady 之后（同段落内）
    expect(body).toContain('pendingFocusRef.current')
  })

  it('model 同步 effect 同样以 contentReady 门控（否则会先塞入上一个文件的内容）', () => {
    // 锚点用可执行语句（注释会被 stripComments 去掉）
    const anchor = code.indexOf('const model = getModel(active, content)')
    expect(anchor, '应能定位 model 同步 effect').toBeGreaterThan(-1)
    const body = code.slice(Math.max(0, anchor - 400), anchor)
    expect(body).toContain('!contentReady')
    expect(body).not.toContain('content === null')
  })

  it('落地高亮：flashNavTarget 使用独立装饰 id 并在超时后清除', () => {
    expect(code).toContain('flashNavTarget')
    expect(code).toContain('edrv-nav-target')
    // 独立 ref 保存装饰 id（不得与 diff/下划线共用，否则互相清除）
    expect(code).toContain('navFlashRef')
    // 必须有自动清除路径，否则高亮会永久残留
    expect(code).toContain('NAV_FLASH_MS')
    expect(code).toMatch(/deltaDecorations\(navFlashRef\.current, \[\]\)/)
  })

  it('高亮区间经 navFlashRangeOf 推导（零宽识别与回落在纯函数里，有独立单测）', () => {
    expect(code).toContain('navFlashRangeOf(model, target)')
  })

  it('openFileAt 支持可选 endLine/endColumn 并把区间写进 pendingFocus', () => {
    const fn = code.slice(code.indexOf('const openFileAt = ('))
    expect(fn.slice(0, 900)).toContain('endLine')
    expect(fn.slice(0, 900)).toContain('endColumn')
  })

  it('卸载时清理高亮计时器与装饰 id（防泄漏）', () => {
    expect(code).toContain('clearTimeout(navFlashTimerRef.current)')
  })
})

describe('EditorView：跳转 effect 依赖必须覆盖编辑器就绪（回归：首次跳转不定位）', () => {
  const code = stripComments(readSrc(EDITOR_VIEW))
  /** 取跳转 effect 的依赖数组（锚点 = 该 effect 的 contentReady 门控语句）。 */
  const depsOfJumpEffect = (): string => {
    const anchor = code.indexOf('if (!ed || !contentReady) return')
    expect(anchor, '应能定位跳转 effect').toBeGreaterThan(-1)
    const body = code.slice(anchor, code.indexOf('const jumpTo = (region) =>', anchor))
    const m = body.match(/\}, \[([^\]]*)\]\)/)
    expect(m, '应能定位跳转 effect 的依赖数组').not.toBeNull()
    return m![1]
  }

  it('依赖含 monaco（回归：Monaco 晚于文本就绪时 effect 必须重跑，否则 pendingFocus 滞留）', () => {
    const deps = depsOfJumpEffect()
    // 关键回归断言：缺 monaco 时，editorRef 在 contentReady 那一帧为 null，
    // 提前返回后 effect 再无重跑机会 → 首次跳转只打开文件、落到 1:1（需二次触发）
    expect(deps).toContain('monaco')
    // 也不得只靠 focusRequest 兜底（那是二次触发才生效的路径）
    expect(deps).not.toBe('active, content, contentReady, pendingRegions, focusRequest')
  })

  it('依赖含 mdPreviewing（预览态会重建编辑器实例，同类竞态）', () => {
    expect(depsOfJumpEffect()).toContain('mdPreviewing')
  })

  it('依赖仍含原有的四个触发源（未因修复漏掉已有语义）', () => {
    const deps = depsOfJumpEffect()
    for (const dep of ['active', 'content', 'contentReady', 'pendingRegions', 'focusRequest']) {
      expect(deps, dep).toContain(dep)
    }
  })

  it('pendingFocus 仍在 contentReady 之后消费（修复不得挪动就绪判据）', () => {
    const anchor = code.indexOf('if (!ed || !contentReady) return')
    const body = code.slice(anchor, code.indexOf('const jumpTo = (region) =>', anchor))
    expect(body).toContain('pendingFocusRef.current')
    expect(body).not.toContain('content === null')
  })
})

describe('providers：opener 委托与事件载荷', () => {
  const code = stripComments(readSrc(PROVIDERS))

  it('opener 经 navTargetOf 解析（不再只认 getStartPosition 单形态）', () => {
    expect(code).toContain('navTargetOf(selectionOrPosition)')
    expect(code).not.toContain('selectionOrPosition?.getStartPosition?.()')
  })

  it('openAt 把目标区间并入事件 detail（供落地高亮使用）', () => {
    const fn = code.slice(code.indexOf('function openAt'))
    expect(fn.slice(0, 400)).toContain('Object.assign({ path }, target)')
  })
})

describe('navFlashRangeOf：高亮区间必须可见（零宽是主要陷阱）', () => {
  /**
   * 假 model：复刻 EGameHall.lua 相关行的真实内容（349 行 UserProfileMode 枚举名）。
   * 行内容：349 `    UserProfileMode =`（词起列 5、止列 20）
   */
  const LINES: Record<number, string> = {
    349: '    UserProfileMode =',
    350: '    {',
    351: '        Self = 1,',
    352: '        Other = 2,',
  }
  const model = {
    getLineCount: () => 360,
    getLineMaxColumn: (n: number) => (LINES[n] ?? '').length + 1,
    // 从真实行文本取词（与 Monaco getWordAtPosition 语义一致：无词返回 null）
    getWordAtPosition: ({ lineNumber, column }: { lineNumber: number; column: number }) => {
      const text = LINES[lineNumber]
      if (!text) return null
      const re = /[A-Za-z_][A-Za-z0-9_]*/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const start = m.index + 1
        const end = start + m[0].length
        if (column >= start && column < end) {
          return { startLineNumber: lineNumber, startColumn: start, endLineNumber: lineNumber, endColumn: end }
        }
      }
      return null
    },
  }

  it('零宽区间（Monaco collapseToStart 的常态）必须回落到单词，不得产出零宽装饰', () => {
    // 实测 opener 送来的就是 {line:349, column:5, endLine:349, endColumn:5}
    const out = navFlashRangeOf(model, { line: 349, column: 5, endLine: 349, endColumn: 5 })
    expect(out).not.toBeNull()
    expect(out!.startLineNumber).toBe(349)
    // 关键：区间必须非零宽，否则渲染不出任何可见高亮（曾经的实际故障）
    const zeroWidth = out!.startLineNumber === out!.endLineNumber && out!.startColumn === out!.endColumn
    expect(zeroWidth, '零宽区间不可见，必须回落到单词/整行').toBe(false)
    expect(out!.startColumn).toBe(5)
    expect(out!.endColumn).toBe(20)
  })

  it('endColumn 缺失（形态 2 降级）同样回落，不得产出零宽', () => {
    const out = navFlashRangeOf(model, { line: 349, column: 5, endLine: 349 })
    expect(out).not.toBeNull()
    expect(out!.endColumn).toBeGreaterThan(out!.startColumn)
  })

  it('提供真实非零宽区间时原样采用（跨行区间）', () => {
    const out = navFlashRangeOf(model, { line: 349, column: 5, endLine: 352, endColumn: 15 })
    expect(out).toEqual({ startLineNumber: 349, startColumn: 5, endLineNumber: 352, endColumn: 15 })
  })

  it('区间末端超出该行长度时夹到行尾（不产出非法列号）', () => {
    // 352 行 = '        Other = 2,'（18 字符）→ 行尾列 19
    const maxColumn = model.getLineMaxColumn(352)
    const out = navFlashRangeOf(model, { line: 349, column: 5, endLine: 352, endColumn: 9999 })
    expect(out!.endColumn).toBe(maxColumn)
  })

  it('无单词可取的符号位置回落到整行（保证一定可见）', () => {
    const out = navFlashRangeOf(model, { line: 350, column: 5, endLine: 350, endColumn: 5 })
    expect(out).toEqual({ startLineNumber: 350, startColumn: 1, endLineNumber: 350, endColumn: model.getLineMaxColumn(350) })
  })

  it('越界行号夹到文档范围（不抛错、不产出非法区间）', () => {
    const out = navFlashRangeOf(model, { line: 9999, column: 1 })
    expect(out).not.toBeNull()
    expect(out!.startLineNumber).toBe(360)
  })

  it('单词回落改用当前行补齐行号（回归：Monaco getWordAtPosition 不返回行号）', () => {
    // 实测 Monaco 只返回 { word, startColumn, endColumn }；曾因直接透传 undefined 行号
    // 产出非法装饰区间 → 装饰已挂但渲染不出任何高亮（DOM 里 .edrv-nav-target 恒为 0）。
    const wordOnlyModel = {
      getLineCount: () => 360,
      getLineMaxColumn: (n: number) => (LINES[n] ?? '').length + 1,
      getWordAtPosition: () => ({ word: 'UserProfileMode', startColumn: 5, endColumn: 20 }),
    }
    const out = navFlashRangeOf(wordOnlyModel, { line: 349, column: 5, endLine: 349, endColumn: 5 })
    expect(out).not.toBeNull()
    // 行号必须补齐为当前行，绝不允许 undefined / 非法值
    expect(out!.startLineNumber).toBe(349)
    expect(out!.endLineNumber).toBe(349)
    expect(Number.isFinite(out!.startLineNumber)).toBe(true)
    expect(Number.isFinite(out!.endLineNumber)).toBe(true)
    expect(out!.startColumn).toBe(5)
    expect(out!.endColumn).toBe(20)
  })

  it('model/target 缺失时返回 null（调用方跳过高亮）', () => {
    expect(navFlashRangeOf(null, { line: 1 })).toBeNull()
    expect(navFlashRangeOf(model, null)).toBeNull()
  })
})

describe('样式：.edrv-nav-target 可辨识且带官方令牌回落', () => {
  const css = readSrc(CSS)

  it('定义了 .edrv-nav-target 且有背景/可见性（不是空规则）', () => {
    const rule = css.slice(css.indexOf('.edrv-nav-target'))
    expect(rule.length).toBeGreaterThan(0)
    expect(rule.slice(0, 400)).toContain('background')
  })

  it('使用 --dsw-* 令牌并带回落值（不硬编码单一颜色，随官方主题）', () => {
    const rule = css.slice(css.indexOf('.edrv-nav-target'))
    const line = rule.slice(0, rule.indexOf('}') + 1)
    expect(line).toContain('--dsw-')
    expect(line).toMatch(/var\(--dsw-[^,]+,\s*[^)]+\)/)
  })

  it('不在插件作用域重定义官方令牌（否则永久脱离官方主题）', () => {
    // 插件作用域重新声明 --dsw-* 会让官方主题失效
    expect(css).not.toMatch(/\[data-edrv-view\][^{]*\{[^}]*--dsw-[a-z-]+\s*:/)
  })
})

describe('EditorView：pending nav 跨挂载交接 + 模型身份守卫（第三次事故）', () => {
  const code = stripComments(readSrc(EDITOR_VIEW))

  it('pendingNav 模块已接入 EditorView（import 存在）', () => {
    expect(code).toContain("from '../pendingNav.js'")
  })

  it('openFileAt 在挂载级 ref 之外同步写 window 槽（热重载交接路径）', () => {
    const fn = code.slice(code.indexOf('const openFileAt = ('))
    expect(fn.slice(0, 1600)).toContain('putPendingNav(')
  })

  it('跳转 effect 从 ref || 槽取 pending（readPendingNav 读槽）', () => {
    const anchor = code.indexOf('if (!ed || !contentReady) return')
    expect(anchor, '应能定位跳转 effect').toBeGreaterThan(-1)
    const body = code.slice(anchor, code.indexOf('const jumpTo = (region) =>', anchor))
    expect(body).toContain('const refPf = pendingFocusRef.current')
    expect(body).toContain('slotNav = refPf ? null : readPendingNav()')
  })

  it('落点前有模型身份守卫，且成功落点才清 ref 与槽（单一清除点）', () => {
    const anchor = code.indexOf('if (!ed || !contentReady) return')
    const body = code.slice(anchor, code.indexOf('const jumpTo = (region) =>', anchor))
    // 守卫必须先于 dropPending：模型不是目标文件时保留 pending 等下一次触发
    const guardAt = body.indexOf('sameFile(modelPathOf(ed), pf.path)')
    const dropAt = body.indexOf('dropPending()')
    expect(guardAt, '模型身份守卫存在').toBeGreaterThan(-1)
    expect(dropAt, '清除入口存在').toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(dropAt)
    // 单一清除点封装：清 ref 且带 line 才清槽（focusDiff region 路径不误清他人槽）
    const fn = body.slice(body.indexOf('const dropPending = () =>'), body.indexOf('const dropPending = () =>') + 220)
    expect(fn).toContain('pendingFocusRef.current = null')
    expect(fn).toContain('clearPendingNav()')
    expect(fn).toContain('pf.line != null')
  })
})
