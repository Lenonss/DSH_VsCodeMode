/**
 * client monaco/theme 纯函数测试（node 环境无 DOM：令牌读取与观察器的回落路径一并覆盖）。
 * 作者 ddj 2026-09-10
 */
import { describe, expect, it } from 'vitest'
import {
  EDRV_DARK,
  applyOfficial,
  observeScheme,
  officialThemeOf,
  readCssVar,
  schemeOfSnapshot,
  toMonacoColor,
  withBaseForeground,
} from '../src/client/monaco/theme.js'

describe('toMonacoColor', () => {
  it('#rgb 展开为 #rrggbb', () => {
    expect(toMonacoColor('#abc')).toBe('#aabbcc')
  })
  it('#rrggbb / #rrggbbaa 原样（大小写与空白归一）', () => {
    expect(toMonacoColor('  #1C7ED6 ')).toBe('#1c7ed6')
    expect(toMonacoColor('#1c7ed680')).toBe('#1c7ed680')
  })
  it('rgb()/rgba() 转 hex（含 alpha 通道）', () => {
    expect(toMonacoColor('rgb(28, 126, 214)')).toBe('#1c7ed6')
    expect(toMonacoColor('rgba(28, 126, 214, 0.5)')).toBe('#1c7ed680')
    expect(toMonacoColor('rgba(28,126,214,1)')).toBe('#1c7ed6')
  })
  it('hsl()/hsla() 转 hex（DSH 令牌实测写法：空格 + 斜杠 + 百分比 alpha）', () => {
    expect(toMonacoColor('hsl(0 0% 4.3% / 5%)')).toBe('#0b0b0b0d')
    expect(toMonacoColor('hsl(0 0% 4.3% / 10%)')).toBe('#0b0b0b1a')
    expect(toMonacoColor('hsl(120, 100%, 50%)')).toBe('#00ff00')
    expect(toMonacoColor('hsla(0, 100%, 50%, 0.5)')).toBe('#ff000080')
    expect(toMonacoColor('hsl(0 0% 100%)')).toBe('#ffffff')
  })
  it('带单位/缺通道的 hsl 不可识别', () => {
    expect(toMonacoColor('hsl(210deg 50% 40%)')).toBeUndefined()
    expect(toMonacoColor('hsl(210 50%)')).toBeUndefined()
  })
  it('不可识别值返回 undefined（未解析 var()/关键字/缺通道）', () => {
    expect(toMonacoColor(undefined)).toBeUndefined()
    expect(toMonacoColor('')).toBeUndefined()
    expect(toMonacoColor('var(--dsw-alias-label-primary)')).toBeUndefined()
    expect(toMonacoColor('transparent')).toBeUndefined()
    expect(toMonacoColor('rgb(1,2)')).toBeUndefined()
    expect(toMonacoColor('rgb(a, b, c)')).toBeUndefined()
  })
})

describe('schemeOfSnapshot', () => {
  it('读 active.colorScheme 与顶层 colorScheme', () => {
    expect(schemeOfSnapshot({ active: { colorScheme: 'dark' } })).toBe('dark')
    expect(schemeOfSnapshot({ colorScheme: 'light' })).toBe('light')
  })
  it('缺失/未知取值返回 undefined', () => {
    expect(schemeOfSnapshot(undefined)).toBeUndefined()
    expect(schemeOfSnapshot({})).toBeUndefined()
    expect(schemeOfSnapshot({ active: { colorScheme: 'system' } })).toBeUndefined()
  })
})

describe('officialThemeOf（无令牌环境回落现役双套）', () => {
  it('暗色：hasTokens=false 且保留现役规则与颜色', () => {
    const theme = officialThemeOf('dark')
    expect(theme.hasTokens).toBe(false)
    expect(theme.base).toBe('vs-dark')
    expect(theme.rules.length).toBeGreaterThan(10)
    expect(theme.colors['editor.background']).toBe('#1e1e1e')
  })
  it('亮色：base=vs，规则表切换为亮色分层', () => {
    const theme = officialThemeOf('light')
    expect(theme.base).toBe('vs')
    expect(theme.colors['editor.background']).toBe('#ffffff')
  })
})

describe('withBaseForeground（基础规则跟随官方前景色）', () => {
  it('token 为空串的规则换色，其余规则不动', () => {
    const rules = [{ token: '', foreground: '1e1e1e' }, { token: 'comment', foreground: '008000' }]
    const out = withBaseForeground(rules, '#0b0b0b')
    expect(out[0].foreground).toBe('0b0b0b')
    expect(out[1].foreground).toBe('008000')
    expect(rules[0].foreground).toBe('1e1e1e')
  })
  it('未解析到前景色时原样返回', () => {
    const rules = [{ token: '', foreground: '1e1e1e' }]
    expect(withBaseForeground(rules, undefined)).toBe(rules)
  })
})

describe('readCssVar / observeScheme（非浏览器环境安全降级）', () => {
  it('readCssVar 无 document 时返回 undefined 且不抛错', () => {
    expect(readCssVar('--dsw-alias-label-primary')).toBeUndefined()
  })
  it('observeScheme 返回可调用的停止函数', () => {
    const stop = observeScheme(() => {})
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })
})

describe('applyOfficial', () => {
  it('无令牌时回落现役双套（setTheme 收到 edrv-dark）', () => {
    const applied: string[] = []
    const monaco = { editor: { defineTheme: () => {}, setTheme: (id: string) => { applied.push(id) } } }
    expect(applyOfficial(monaco)).toBe(EDRV_DARK)
    expect(applied).toEqual([EDRV_DARK])
  })
  it('缺 Monaco 编辑器能力时返回现役主题名且不抛错', () => {
    expect(applyOfficial(undefined)).toBe(EDRV_DARK)
    expect(applyOfficial({})).toBe(EDRV_DARK)
  })
})
