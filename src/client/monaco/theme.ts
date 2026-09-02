// @ts-nocheck
/**
 * dsh-vscode-mode client — Monaco 语法分色主题（rich token 配色）。
 * 编辑器原先硬编码 'vs'（内置基础主题），token 分色层次少；
 * 这里定义 edrv-dark / edrv-light 两套完整 token 配色（对齐 VSCode Dark+ 语义分层），
 * 并随 DSH 明暗主题自动切换（跟随文档根 data 主题属性 / prefers-color-scheme）。
 * 作者 ddj 2026-08-28
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
 * 探测当前 DSH 明暗（文档根 data 主题属性 → prefers-color-scheme → 暗）。
 * @author ddj 2026年08月28号
 * @returns 'dark' | 'light'
 */
export function detectColorScheme() {
  try {
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
