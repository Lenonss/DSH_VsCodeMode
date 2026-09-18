/**
 * 诊断日志弹窗（LogDialog）纯逻辑测试：行解析（新/旧格式）、级别+关键字过滤、字节格式化。
 * 组件渲染走 React DOM，node 环境不挂载；只覆盖可离线断言的纯函数部分。
 * 作者 ddj 2026-09-17
 */
import { describe, expect, it } from 'vitest'
import { filterRows, formatBytes, parseLogLine } from '../src/client/ui/LogDialog.js'

describe('parseLogLine 行解析', () => {
  it('新格式：<ISO> [level] text → 时间/级别/文本三段', () => {
    const row = parseLogLine('2026-09-17T08:09:10.111Z [warn] 磁盘变化 x')
    expect(row.at).toBe('2026-09-17T08:09:10.111Z')
    expect(row.level).toBe('warn')
    expect(row.text).toBe('磁盘变化 x')
  })

  it('旧格式（无级别标记）：level 为空串，文本为整段剩余', () => {
    const row = parseLogLine('2026-09-17T08:09:10.111Z legacy content')
    expect(row.at).toBe('2026-09-17T08:09:10.111Z')
    expect(row.level).toBe('')
    expect(row.text).toBe('legacy content')
  })

  it('正文里的方括号不被误当级别标记（仅紧跟 ISO 时间后的一段生效）', () => {
    const row = parseLogLine('2026-09-17T08:09:10.111Z [debug] 数组 [1,2] 打印')
    expect(row.level).toBe('debug')
    expect(row.text).toBe('数组 [1,2] 打印')
  })
})

describe('filterRows 过滤', () => {
  const rows = [
    parseLogLine('2026-09-17T08:00:01.000Z [debug] render diff a'),
    parseLogLine('2026-09-17T08:00:02.000Z [error] boom'),
    parseLogLine('2026-09-17T08:00:03.000Z legacy no level'),
  ]

  it('级别档过滤：无级别旧行只在「全部」显示', () => {
    expect(filterRows(rows, 'all', '')).toHaveLength(3)
    expect(filterRows(rows, 'error', '').map((r) => r.text)).toEqual(['boom'])
    expect(filterRows(rows, 'debug', '').map((r) => r.text)).toEqual(['render diff a'])
  })

  it('关键字大小写不敏感，匹配时间或文本', () => {
    expect(filterRows(rows, 'all', 'BOOM')).toHaveLength(1)
    expect(filterRows(rows, 'all', '08:00:03')).toHaveLength(1)
    expect(filterRows(rows, 'error', 'render')).toHaveLength(0)
  })
})

describe('formatBytes 字节格式化', () => {
  it('B / KB / MB 三档（一位小数）', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
