/** launch.json「添加配置」插入定位/文本构造纯函数测试（表驱动：多行/空数组/单行/注释/tab）。作者 ddj 2026年09月22号 */
import { describe, expect, it } from 'vitest'
import { stripJsonc } from '../src/dap/launchConfig.js'
import { buildInsertText, findArrayPos, LAUNCH_JSON_RE } from '../src/client/dap/launchInsert.js'

const BODY = '{\n  "type": "emmylua_new",\n  "request": "launch",\n  "name": "新配置",\n  "program": "${file}"\n}'

/** 把插入文本拼回原文模拟 Monaco 接受补全（word 为空 → 零宽替换；保留光标行前缀）。 */
function splice(text: string, pos: { line: number; column: number }, insertText: string): string {
  const lines = text.split('\n')
  const idx = pos.line - 1
  const prefix = lines.slice(0, idx).join('\n') + (idx > 0 ? '\n' : '')
  const line = lines[idx] ?? ''
  const before = line.slice(0, pos.column - 1)
  const after = line.slice(pos.column - 1)
  const suffix = idx + 1 < lines.length ? '\n' + lines.slice(idx + 1).join('\n') : ''
  return prefix + before + insertText + after + suffix
}

describe('findArrayPos', () => {
  it('多行数组已有元素：插入到 [ 下一行行首，取元素实测缩进，needComma=true', () => {
    const text = [
      '{',
      '  "version": "0.2.0",',
      '  "configurations": [',
      '    {',
      '      "name": "附加 Unity (xLua)",',
      '      "type": "emmylua_attach"',
      '    }',
      '  ]',
      '}',
    ].join('\n')
    const pos = findArrayPos(text)
    expect(pos).toMatchObject({ line: 4, column: 1, indent: '    ', unit: '  ', needComma: true, inline: false })
  })

  it('多行空数组：缩进回退 cfg+unit，needComma=false', () => {
    const text = ['{', '  "configurations": [', '  ]', '}'].join('\n')
    const pos = findArrayPos(text)
    expect(pos).toMatchObject({ line: 3, column: 1, indent: '    ', unit: '  ', needComma: false, inline: false })
  })

  it('单行空数组 []：光标落 [ 后，needComma=false，inline=true', () => {
    const text = ['{', '  "configurations": []', '}'].join('\n')
    const pos = findArrayPos(text)
    expect(pos).not.toBeNull()
    expect(pos!.inline).toBe(true)
    expect(pos!.line).toBe(2)
    expect(pos!.column).toBe('  "configurations": ['.length + 1)
    expect(pos!.needComma).toBe(false)
    expect(pos!.indent).toBe('    ')
    expect(pos!.cfgIndent).toBe('  ')
  })

  it('单行已有元素 [ {...} ]：needComma=true', () => {
    const text = ['{', '  "configurations": [', '  ]', '}'].join('\n')
    const inlineText = text.replace('  "configurations": [\n  ]', '  "configurations": [{ "type": "a", "name": "b" }]')
    const pos = findArrayPos(inlineText)
    expect(pos).toMatchObject({ inline: true, needComma: true, line: 2 })
  })

  it('注释：键行后的行注释不误判，缩进取真实元素行；键本身被注释时不误报', () => {
    const text = [
      '{',
      '  // "configurations": []',
      '  "configurations": [',
      '    // 首个配置的说明',
      '    {',
      '      "name": "a"',
      '    }',
      '  ]',
      '}',
    ].join('\n')
    const pos = findArrayPos(text)
    expect(pos).toMatchObject({ line: 4, column: 1, indent: '    ', needComma: true, inline: false })

    const onlyCommented = ['{', '  // "configurations": []', '  "other": 1', '}'].join('\n')
    expect(findArrayPos(onlyCommented)).toBeNull()
  })

  it('行尾注释跟在 [ 后仍是多行形态', () => {
    const text = ['{', '  "configurations": [ // 数组开始', '    { "name": "a", "type": "t" }', '  ]', '}'].join('\n')
    const pos = findArrayPos(text)
    expect(pos).toMatchObject({ line: 3, column: 1, inline: false, needComma: true })
  })

  it('tab 缩进文件：unit/indent 全 tab，body 重排为 tab', () => {
    const text = ['{', '\t"configurations": [', '\t\t{', '\t\t\t"name": "a"', '\t\t}', '\t]', '}'].join('\n')
    const pos = findArrayPos(text)
    expect(pos).toMatchObject({ indent: '\t\t', unit: '\t', needComma: true, inline: false })
    const insertText = buildInsertText(pos!, '{\n  "name": "n"\n}')
    expect(insertText).toBe('\t\t{\n\t\t\t"name": "n"\n\t\t},\n')
  })

  it('4 空格缩进文件：unit=4，body 内层按 4 空格重排', () => {
    const text = ['{', '    "configurations": [', '        {', '            "name": "a"', '        }', '    ]', '}'].join('\n')
    const pos = findArrayPos(text)
    expect(pos).toMatchObject({ indent: '        ', unit: '    ' })
    const insertText = buildInsertText(pos!, '{\n  "name": "n"\n}')
    expect(insertText).toBe('        {\n            "name": "n"\n        },\n')
  })

  it('无 configurations 键 → null；键名前缀相似不误中', () => {
    expect(findArrayPos('{"version": "0.2.0"}')).toBeNull()
    expect(findArrayPos('{"configurationsx": []}')).toBeNull()
    expect(findArrayPos('{\n  // "configurations": []\n}')).toBeNull()
  })

  it('带过滤词光标：从光标后探测结构（词不污染 needComma/缩进）', () => {
    // 模拟：单行空数组中键入过滤词 "Em"（光标在词后）
    const text = ['{', '  "configurations": [Em]', '}'].join('\n')
    const cursor = { lineNumber: 2, column: '  "configurations": [Em'.length + 1 }
    const pos = findArrayPos(text, cursor)
    expect(pos).toMatchObject({ inline: true, needComma: false })
    // 多行数组中在行首键入过滤词：缩进仍取词后的真实元素缩进
    const multi = ['{', '  "configurations": [', 'Em    {', '      "name": "a"', '    }', '  ]', '}'].join('\n')
    const pos2 = findArrayPos(multi, { lineNumber: 3, column: 3 })
    expect(pos2).toMatchObject({ needComma: true })
    expect(pos2!.indent).toBe('    ')
  })
})

describe('buildInsertText', () => {
  it('多行形态：首行带缩进、尾随逗号换行；DAP 变量 ${file} 原样保留', () => {
    const text = ['{', '  "configurations": [', '    {', '      "name": "a"', '    }', '  ]', '}'].join('\n')
    const pos = findArrayPos(text)!
    const insertText = buildInsertText(pos, BODY)
    expect(insertText.startsWith('    {\n')).toBe(true)
    expect(insertText.endsWith('    },\n')).toBe(true)
    expect(insertText).toContain('"program": "${file}"')
    // 拼回原文后仍是合法 JSONC，且新配置在数组首位
    const merged = splice(text, pos, insertText)
    const parsed = JSON.parse(stripJsonc(merged)) as { configurations: { name: string }[] }
    expect(parsed.configurations).toHaveLength(2)
    expect(parsed.configurations[0].name).toBe('新配置')
    expect(parsed.configurations[1].name).toBe('a')
  })

  it('空数组：无尾逗号，拼回后仍合法且只有一个配置', () => {
    const text = ['{', '  "configurations": [', '  ]', '}'].join('\n')
    const pos = findArrayPos(text)!
    const insertText = buildInsertText(pos, '{\n  "type": "t",\n  "name": "n"\n}')
    expect(insertText.endsWith('}\n')).toBe(true)
    expect(insertText).not.toContain('},\n')
    const parsed = JSON.parse(stripJsonc(splice(text, pos, insertText))) as { configurations: unknown[] }
    expect(parsed.configurations).toHaveLength(1)
  })

  it('单行空数组：首尾自带换行并回填 cfgIndent，拼回后合法', () => {
    const text = ['{', '  "configurations": []', '}'].join('\n')
    const pos = findArrayPos(text)!
    const insertText = buildInsertText(pos, '{\n  "type": "t",\n  "name": "n"\n}')
    expect(insertText.startsWith('\n')).toBe(true)
    expect(insertText.endsWith('\n  ')).toBe(true)
    const parsed = JSON.parse(stripJsonc(splice(text, pos, insertText))) as { configurations: unknown[] }
    expect(parsed.configurations).toHaveLength(1)
  })

  it('needComma=false 时不出逗号（单行已有元素场景之外的空数组兜底）', () => {
    const pos = findArrayPos(['{', '  "configurations": [', '  ]', '}'].join('\n'))!
    expect(buildInsertText(pos, '{\n  "name": "n"\n}')).not.toContain(',\n')
    expect(buildInsertText({ ...pos, needComma: true }, '{\n  "name": "n"\n}')).toContain('},\n')
  })
})

describe('LAUNCH_JSON_RE', () => {
  it('匹配插件专属 .dsh/launch.json 结尾（相对/绝对路径同口径）', () => {
    expect(LAUNCH_JSON_RE.test('.dsh/launch.json')).toBe(true)
    expect(LAUNCH_JSON_RE.test('D:/Work/x/.dsh/launch.json')).toBe(true)
    expect(LAUNCH_JSON_RE.test('D:/Work/x/.dsh/launch.jsonc')).toBe(false)
    expect(LAUNCH_JSON_RE.test('D:/Work/x/launch.json')).toBe(false)
    expect(LAUNCH_JSON_RE.test('my.dsh/launch.json')).toBe(false)
  })

  it('真隔离：VS Code 的 .vscode/launch.json 不再命中（独立后反例）', () => {
    expect(LAUNCH_JSON_RE.test('.vscode/launch.json')).toBe(false)
    expect(LAUNCH_JSON_RE.test('D:/Work/x/.vscode/launch.json')).toBe(false)
  })
})
