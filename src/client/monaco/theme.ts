// @ts-nocheck
/**
 * dsh-vscode-mode client — Monaco 主题：官方令牌跟随 + 现役双套回落。
 * 优先级：官方代码/UI 令牌（--shiki-* / --dsw-alias-*，DSH 0.1.5+ 主题体系，
 * 含第三方皮肤）→ edrv-dark / edrv-light 两套内置配色（旧版 DSH 或令牌缺失）。
 * 明暗判定：body[data-ds-dark-theme]（官方）→ 根 data-theme（旧皮肤）→ prefers-color-scheme。
 * 作者 ddj 2026-08-28 / 2026-09-10
 */

export const EDRV_DARK = 'edrv-dark'
export const EDRV_LIGHT = 'edrv-light'
export const EDRV_FALLBACK = 'vs'

/** 语法分色（语义分层：关键字/字符串/数字/注释/函数/变量/类型/运算符/正则/标签/属性…）。 */
const DARK_RULES = [
  { token: '', foreground: 'd4d4d4', background: '1e1e1e' },
  { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
  { token: 'comment.doc', foreground: '7ca97c', fontStyle: 'italic' },
  { token: 'keyword', foreground: 'c586c0' },
  { token: 'keyword.control', foreground: 'c586c0' },
  { token: 'keyword.operator', foreground: 'd4d4d4' },
  { token: 'keyword.json', foreground: '9cdcfe' },
  { token: 'string', foreground: 'ce9178' },
  { token: 'string.escape', foreground: 'd7ba7d' },
  { token: 'string.key.json', foreground: '9cdcfe' },
  { token: 'string.value.json', foreground: 'ce9178' },
  { token: 'string.yaml', foreground: 'ce9178' },
  { token: 'number', foreground: 'b5cea8' },
  { token: 'number.hex', foreground: 'b5cea8' },
  { token: 'regexp', foreground: 'd16969' },
  { token: 'type', foreground: '4ec9b0' },
  { token: 'type.identifier', foreground: '4ec9b0' },
  { token: 'identifier', foreground: 'd4d4d4' },
  { token: 'variable', foreground: '9cdcfe' },
  { token: 'variable.global', foreground: 'ff6699' },
  { token: 'variable.local', foreground: '9cdcfe' },
  { token: 'variable.mutable', foreground: '9cdcfe' },
  { token: 'variable.predefined', foreground: '4fc1ff' },
  { token: 'variable.parameter', foreground: '00bfae' },
  { token: 'parameter', foreground: '00bfae' },
  { token: 'function', foreground: 'dcdcaa' },
  { token: 'method', foreground: 'dcdcaa' },
  { token: 'property', foreground: '9cdcfe' },
  { token: 'function.identifier', foreground: 'dcdcaa' },
  { token: 'member', foreground: 'dcdcaa' },
  { token: 'constant', foreground: '4fc1ff' },
  { token: 'constant.numeric', foreground: 'b5cea8' },
  { token: 'constant.language', foreground: '569cd6' },
  { token: 'tag', foreground: '569cd6' },
  { token: 'tag.xml', foreground: '569cd6' },
  { token: 'metatag', foreground: '808080' },
  { token: 'attribute.name', foreground: '9cdcfe' },
  { token: 'attribute.value', foreground: 'ce9178' },
  { token: 'delimiter', foreground: 'd4d4d4' },
  { token: 'delimiter.bracket', foreground: 'ffd700' },
  { token: 'delimiter.html', foreground: '808080' },
  { token: 'operator', foreground: 'd4d4d4' },
  { token: 'namespace', foreground: '4ec9b0' },
  { token: 'class', foreground: '4ec9b0' },
  { token: 'interface', foreground: '4ec9b0' },
  { token: 'enum', foreground: '4ec9b0' },
  { token: 'struct', foreground: '4ec9b0' },
  { token: 'annotation', foreground: 'dcdcaa' },
  { token: 'punctuation', foreground: 'd4d4d4' },
  { token: 'invalid', foreground: 'f44747' },
]

const LIGHT_RULES = [
  { token: '', foreground: '1e1e1e', background: 'ffffff' },
  { token: 'comment', foreground: '008000', fontStyle: 'italic' },
  { token: 'comment.doc', foreground: '2e7d32', fontStyle: 'italic' },
  { token: 'keyword', foreground: '0000ff' },
  { token: 'keyword.control', foreground: 'af00db' },
  { token: 'keyword.operator', foreground: '1e1e1e' },
  { token: 'keyword.json', foreground: '0451a5' },
  { token: 'string', foreground: 'a31515' },
  { token: 'string.escape', foreground: 'ee0000' },
  { token: 'string.key.json', foreground: '0451a5' },
  { token: 'string.value.json', foreground: 'a31515' },
  { token: 'string.yaml', foreground: 'a31515' },
  { token: 'number', foreground: '098658' },
  { token: 'number.hex', foreground: '098658' },
  { token: 'regexp', foreground: '811f3f' },
  { token: 'type', foreground: '267f99' },
  { token: 'type.identifier', foreground: '267f99' },
  { token: 'identifier', foreground: '1e1e1e' },
  { token: 'variable', foreground: '001080' },
  { token: 'variable.global', foreground: 'c2185b' },
  { token: 'variable.local', foreground: '001080' },
  { token: 'variable.mutable', foreground: '001080' },
  { token: 'variable.predefined', foreground: '001080' },
  { token: 'variable.parameter', foreground: '008577' },
  { token: 'parameter', foreground: '008577' },
  { token: 'function', foreground: '795e26' },
  { token: 'method', foreground: '795e26' },
  { token: 'function.identifier', foreground: '795e26' },
  { token: 'member', foreground: '795e26' },
  { token: 'property', foreground: '001080' },
  { token: 'constant', foreground: '0070c1' },
  { token: 'constant.numeric', foreground: '098658' },
  { token: 'constant.language', foreground: '0000ff' },
  { token: 'tag', foreground: '800000' },
  { token: 'tag.xml', foreground: '800000' },
  { token: 'metatag', foreground: '6b6b6b' },
  { token: 'attribute.name', foreground: 'e50000' },
  { token: 'attribute.value', foreground: '0451a5' },
  { token: 'delimiter', foreground: '1e1e1e' },
  { token: 'delimiter.bracket', foreground: 'b46400' },
  { token: 'delimiter.html', foreground: '800000' },
  { token: 'operator', foreground: '1e1e1e' },
  { token: 'namespace', foreground: '267f99' },
  { token: 'class', foreground: '267f99' },
  { token: 'interface', foreground: '267f99' },
  { token: 'enum', foreground: '267f99' },
  { token: 'struct', foreground: '267f99' },
  { token: 'annotation', foreground: '795e26' },
  { token: 'punctuation', foreground: '1e1e1e' },
  { token: 'invalid', foreground: 'cd3131' },
]

/** 编辑器 UI 配色（与语法配色同套，保证 gutter/minimap/selection 一致）。 */
const DARK_COLORS = {
  'editor.background': '#1e1e1e',
  'editor.foreground': '#d4d4d4',
  'editorLineNumber.foreground': '#6e7681',
  'editorLineNumber.activeForeground': '#c6c6c6',
  'editor.selectionBackground': '#264f78',
  'editor.inactiveSelectionBackground': '#3a3d41',
  'editor.lineHighlightBackground': '#2a2d2e',
  'editorCursor.foreground': '#aeafad',
  'editorIndentGuide.background1': '#404040',
  'editorIndentGuide.activeBackground1': '#707070',
  'editorWidget.background': '#252526',
  'editorHoverWidget.background': '#252526',
  'editorGutter.background': '#1e1e1e',
  'minimap.background': '#1e1e1e',
  'scrollbarSlider.background': '#79797966',
  'scrollbarSlider.hoverBackground': '#646464b3',
  'scrollbarSlider.activeBackground': '#bfbfbf66',
}

const LIGHT_COLORS = {
  'editor.background': '#ffffff',
  'editor.foreground': '#1e1e1e',
  'editorLineNumber.foreground': '#6c6c6c',
  'editorLineNumber.activeForeground': '#171184',
  'editor.selectionBackground': '#add6ff',
  'editor.inactiveSelectionBackground': '#e5ebf1',
  'editor.lineHighlightBackground': '#f0f0f0',
  'editorCursor.foreground': '#000000',
  'editorIndentGuide.background1': '#d3d3d3',
  'editorIndentGuide.activeBackground1': '#939393',
  'editorWidget.background': '#f3f3f3',
  'editorHoverWidget.background': '#f3f3f3',
  'editorGutter.background': '#ffffff',
  'minimap.background': '#ffffff',
  'scrollbarSlider.background': '#64646466',
  'scrollbarSlider.hoverBackground': '#646464b3',
  'scrollbarSlider.activeBackground': '#00000099',
}

/**
 * 注册 edrv 双套主题（幂等；Monaco 未加载时静默跳过）。
 * @author ddj 2026年08月28号
 * @param monaco Monaco 实例（window.monaco）
 */
export function registerThemes(monaco) {
  if (!monaco?.editor?.defineTheme) return
  try {
    monaco.editor.defineTheme(EDRV_DARK, {
      base: 'vs-dark',
      inherit: true,
      rules: DARK_RULES,
      colors: DARK_COLORS,
    })
    monaco.editor.defineTheme(EDRV_LIGHT, {
      base: 'vs',
      inherit: true,
      rules: LIGHT_RULES,
      colors: LIGHT_COLORS,
    })
  } catch (error) {
    /* 主题注册失败保留内置 vs */
  }
}

/**
 * 探测当前 DSH 明暗（官方 data-ds-dark-theme → 旧皮肤 data-theme → prefers-color-scheme → 暗）。
 * @author ddj 2026年08月28号 / 2026年09月10号
 * @returns 'dark' | 'light'
 */
export function detectColorScheme() {
  try {
    const official = document.body?.getAttribute?.('data-ds-dark-theme')
    if (official !== null && official !== undefined && official !== 'false') return 'dark'
    const attr = document.documentElement?.getAttribute?.('data-theme')
      ?? document.body?.getAttribute?.('data-theme')
    const value = String(attr ?? '').toLowerCase()
    if (value.includes('light') || value.includes('catppuccin-latte')) return 'light'
    if (value.includes('dark') || value.includes('frappe') || value.includes('macchiato') || value.includes('mocha')) return 'dark'
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    }
  } catch (error) {
    /* 探测失败回落暗色 */
  }
  return 'dark'
}

/**
 * 主题名：按当前明暗返回已注册主题（未注册回落 vs）。
 * @author ddj 2026年08月28号
 * @returns 主题 id
 */
export function themeNameOf() {
  return detectColorScheme() === 'light' ? EDRV_LIGHT : EDRV_DARK
}

/**
 * 应用主题到 Monaco（全局切换；新建编辑器也用该主题）。
 * @author ddj 2026年08月28号
 * @param monaco Monaco 实例
 */
export function applyTheme(monaco) {
  if (!monaco?.editor?.setTheme) return
  try {
    monaco.editor.setTheme(themeNameOf())
  } catch (error) {
    /* setTheme 失败忽略 */
  }
}

// --region 官方主题跟随（--shiki-* / --dsw-alias-* 令牌）

/** 动态官方主题 id 前缀（每次应用带序号重建，保证 Monaco 感知重定义）。 */
const EDRV_OFFICIAL = 'edrv-official'

/** 官方代码配色令牌 → Monaco 规则 token 前缀（粗粒度；未覆盖的规则保留现役语义分层）。 */
const RULE_TOKEN_MAP = [
  ['--shiki-token-comment', ['comment']],
  ['--shiki-token-keyword', ['keyword']],
  ['--shiki-token-string', ['string']],
  ['--shiki-token-string-expression', ['string.escape']],
  ['--shiki-token-constant', ['number', 'constant']],
  ['--shiki-token-function', ['function', 'method', 'member']],
  ['--shiki-token-parameter', ['parameter', 'variable.parameter']],
  ['--shiki-token-punctuation', ['delimiter', 'operator', 'punctuation']],
  ['--shiki-token-link', ['annotation', 'metatag']],
]

/**
 * 官方 UI 令牌 → Monaco 颜色键（每键给候选令牌，按序取首个可解析值）。
 * 依据运行态实测：--dsw-alias-* 定义在 body 上；--shiki-background/-foreground 未定义，
 * 故代码面底色用 markdown-code-block 近似；selection 不覆盖（沿用现役可见选框）。
 */
const COLOR_TOKEN_MAP = [
  [['--dsw-alias-markdown-code-block', '--dsw-alias-bg-layer-2'], ['editor.background', 'editorGutter.background', 'minimap.background']],
  [['--dsw-alias-label-primary', '--shiki-foreground'], ['editor.foreground']],
  [['--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-3'], ['editorWidget.background', 'editorHoverWidget.background']],
  [['--dsw-alias-label-tertiary'], ['editorLineNumber.foreground']],
  [['--dsw-alias-label-secondary'], ['editorLineNumber.activeForeground']],
  [['--dsw-alias-interactive-bg-hover'], ['editor.lineHighlightBackground', 'editor.inactiveSelectionBackground']],
]

/** 已应用的官方主题序号（模块级计数，保证主题 id 每次唯一）。 */
let officialSeq = 0

/**
 * 读官方 CSS 变量（先 body 后文档根；未定义/空值/未解析 var() 返回 undefined）。
 * 依据运行态实测：DSH 的 --dsw-alias-* 定义在 body 上，仅 --shiki-token-* 在根。
 * @author ddj 2026年09月10号
 * @param name CSS 变量名（含 -- 前缀）
 * @returns 计算样式值，或 undefined
 */
export function readCssVar(name) {
  try {
    if (typeof window?.getComputedStyle !== 'function') return undefined
    const hosts = [document?.body, document?.documentElement]
    for (const host of hosts) {
      if (!host) continue
      const raw = window.getComputedStyle(host).getPropertyValue(name)
      const value = String(raw ?? '').trim()
      if (value && !value.startsWith('var(')) return value
    }
    return undefined
  } catch (error) {
    return undefined
  }
}

/**
 * 数值 → 两位十六进制（0-255 夹取）。
 * @author ddj 2026年09月10号
 * @param value 通道值
 * @returns 两位小写十六进制
 */
function hex2(value) {
  const text = Math.max(0, Math.min(255, Math.round(Number(value) || 0))).toString(16)
  return text.length === 1 ? '0' + text : text
}

/**
 * CSS 颜色归一为 Monaco 可用值（#rgb/#rrggbb/#rrggbbaa 原样，rgb()/hsl() 转 hex，其余 undefined）。
 * @author ddj 2026年09月10号
 * @param value CSS 计算样式颜色值
 * @returns Monaco 颜色字符串，或 undefined（不可识别）
 */
export function toMonacoColor(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text || text.startsWith('var(')) return undefined
  if (/^#[0-9a-f]{3}$/.test(text)) return '#' + text.slice(1).split('').map((c) => c + c).join('')
  if (/^#[0-9a-f]{6}$/.test(text) || /^#[0-9a-f]{8}$/.test(text)) return text
  return channelColor(text)
}

/**
 * rgb()/rgba()/hsl()/hsla() → Monaco 颜色（兼容逗号与空格/斜杠两种参数语法）。
 * @author ddj 2026年09月10号
 * @param text 小写颜色文本
 * @returns Monaco 颜色，或 undefined（不可识别）
 */
function channelColor(text) {
  const body = /^(?:rgba?|hsla?)\(([^)]+)\)$/.exec(text)?.[1]
  if (!body) return undefined
  const parts = body.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return undefined
  let channels
  if (text.startsWith('hsl')) {
    const h = Number(parts[0])
    const s = percentOf(parts[1])
    const l = percentOf(parts[2])
    if (![h, s, l].every(Number.isFinite)) return undefined
    channels = hslToRgb(h, s, l)
  } else {
    channels = parts.slice(0, 3).map(Number)
  }
  if (channels.some((n) => !Number.isFinite(n))) return undefined
  const alpha = parts.length > 3 ? alphaOf(parts[3]) : 1
  const tail = Number.isFinite(alpha) && alpha < 1 ? hex2(alpha * 255) : ''
  return '#' + channels.map(hex2).join('') + tail
}

/**
 * 百分数文本 → 数值（'5%' → 5，'0.5' → 0.5）。
 * @author ddj 2026年09月10号
 * @param value 参数文本
 * @returns 数值（非数字为 NaN）
 */
function percentOf(value) {
  const text = String(value ?? '')
  return text.endsWith('%') ? Number(text.slice(0, -1)) : Number(text)
}

/**
 * alpha 参数归一（'5%' → 0.05，'0.5' → 0.5）。
 * @author ddj 2026年09月10号
 * @param value 参数文本
 * @returns 0-1 的 alpha（非数字为 NaN）
 */
function alphaOf(value) {
  const text = String(value ?? '')
  return text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text)
}

/**
 * HSL → RGB 通道（h 度、s/l 为 0-100 百分数）。
 * @author ddj 2026年09月10号
 * @param h 色相（度）
 * @param s 饱和度（0-100）
 * @param l 亮度（0-100）
 * @returns [r, g, b]（0-255）
 */
function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360
  const sat = Math.max(0, Math.min(100, s)) / 100
  const lum = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * lum - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = lum - c / 2
  const table = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]]
  return table[Math.min(5, Math.floor(hue / 60))].map((v) => (v + m) * 255)
}

/**
 * 官方令牌 → Monaco 颜色键覆盖表（候选令牌按序取首个可解析值；全缺则不写入，保持现役回落）。
 * @author ddj 2026年09月10号
 * @returns 颜色键 → 颜色值
 */
function tokenColors() {
  const out = {}
  for (const entry of COLOR_TOKEN_MAP) {
    const color = firstColor(entry[0])
    if (color === undefined) continue
    for (const key of entry[1]) out[key] = color
  }
  return out
}

/**
 * 候选令牌中首个可解析为 Monaco 颜色的值。
 * @author ddj 2026年09月10号
 * @param names CSS 变量名候选（按优先级）
 * @returns Monaco 颜色，或 undefined（全部缺失/不可解析）
 */
function firstColor(names) {
  for (const name of names) {
    const color = toMonacoColor(readCssVar(name))
    if (color !== undefined) return color
  }
  return undefined
}

/**
 * 官方令牌 → Monaco 规则前缀覆盖表（值去掉 # 前缀，Monaco rules 约定）。
 * @author ddj 2026年09月10号
 * @returns token 前缀 → 十六进制色（无 #）
 */
function tokenRules() {
  const out = {}
  for (const entry of RULE_TOKEN_MAP) {
    const color = toMonacoColor(readCssVar(entry[0]))
    if (color === undefined) continue
    for (const prefix of entry[1]) out[prefix] = color.replace('#', '')
  }
  return out
}

/**
 * 现役规则叠加令牌覆盖（前缀命中即换色，未命中保持语义分层）。
 * @author ddj 2026年09月10号
 * @param baseRules 现役规则表（edrv-dark / edrv-light）
 * @param overrides token 前缀 → 颜色
 * @returns 覆盖后的规则表（无覆盖时原样返回）
 */
function withOverrides(baseRules, overrides) {
  const prefixes = Object.keys(overrides)
  if (!prefixes.length) return baseRules
  return baseRules.map((rule) => {
    const hit = prefixes.find((p) => rule.token === p || rule.token.startsWith(p + '.'))
    return hit === undefined ? rule : Object.assign({}, rule, { foreground: overrides[hit] })
  })
}

/**
 * 基础规则（token 为空串）前景色跟随官方 editor.foreground。
 * Monaco 的 '' 规则匹配所有未被更具体规则命中的 token，不改它则内置 #1e1e1e 会盖住
 * editor.foreground 令牌色（实测 .mtk1 仍为内置值的原因）。
 * @author ddj 2026年09月10号
 * @param rules 现役规则表
 * @param color 已解析的 editor.foreground（含 #，缺省则不覆盖）
 * @returns 基础规则换色后的规则表
 */
export function withBaseForeground(rules, color) {
  if (!color) return rules
  const foreground = String(color).replace('#', '')
  return rules.map((rule) => (rule.token === '' ? Object.assign({}, rule, { foreground }) : rule))
}

/**
 * 构建跟随官方的 Monaco 主题（令牌全缺时 hasTokens=false，调用方回落现役双套）。
 * @author ddj 2026年09月10号
 * @param scheme 明暗（'light' 之外一律按暗色）
 * @returns 主题定义（base/rules/colors/hasTokens）
 */
export function officialThemeOf(scheme) {
  const dark = scheme !== 'light'
  const colors = tokenColors()
  const rules = tokenRules()
  const layered = withOverrides(dark ? DARK_RULES : LIGHT_RULES, rules)
  return {
    base: dark ? 'vs-dark' : 'vs',
    rules: withBaseForeground(layered, colors['editor.foreground']),
    colors: Object.assign({}, dark ? DARK_COLORS : LIGHT_COLORS, colors),
    hasTokens: Object.keys(colors).length > 0 || Object.keys(rules).length > 0,
  }
}

/**
 * 应用跟随官方的主题；令牌读不到或定义失败时回落现役双套。
 * @author ddj 2026年09月10号
 * @param monaco Monaco 实例
 * @returns 实际应用的 Monaco 主题 id
 */
export function applyOfficial(monaco) {
  if (!monaco?.editor?.setTheme || !monaco?.editor?.defineTheme) return themeNameOf()
  const theme = officialThemeOf(detectColorScheme())
  if (!theme.hasTokens) {
    applyTheme(monaco)
    return themeNameOf()
  }
  officialSeq += 1
  const id = EDRV_OFFICIAL + '-' + officialSeq
  try {
    monaco.editor.defineTheme(id, { base: theme.base, inherit: true, rules: theme.rules, colors: theme.colors })
    monaco.editor.setTheme(id)
    return id
  } catch (error) {
    applyTheme(monaco)
    return themeNameOf()
  }
}

/**
 * 观察官方明暗标记变化（body / 根节点的 data-ds-dark-theme 与 data-theme）。
 * @author ddj 2026年09月10号
 * @param onChange 标记变化回调
 * @returns 停止观察函数（非浏览器环境返回空函数）
 */
export function observeScheme(onChange) {
  try {
    if (typeof MutationObserver !== 'function' || !document?.body) return () => {}
    const observer = new MutationObserver(() => onChange())
    const filter = ['data-ds-dark-theme', 'data-theme']
    observer.observe(document.body, { attributes: true, attributeFilter: filter })
    if (document.documentElement) {
      observer.observe(document.documentElement, { attributes: true, attributeFilter: filter })
    }
    return () => observer.disconnect()
  } catch (error) {
    return () => {}
  }
}

/**
 * 官方主题快照 → 明暗（ThemeRuntime.getTheme() 快照；字段缺失/未知返回 undefined）。
 * @author ddj 2026年09月10号
 * @param snapshot 官方主题快照
 * @returns 'light' | 'dark' | undefined
 */
export function schemeOfSnapshot(snapshot) {
  const value = snapshot ?? {}
  const scheme = value.active?.colorScheme ?? value.colorScheme
  return scheme === 'light' || scheme === 'dark' ? scheme : undefined
}
// --endregion
