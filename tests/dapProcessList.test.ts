/** 进程枚举解析与过滤测试。作者 ddj 2026年09月29号 */
import { describe, expect, it } from 'vitest'
import { filterProcesses, parseProcessListJson } from '../src/dap/processList.js'

describe('parseProcessListJson', () => {
  it('解析数组输出', () => {
    const text = JSON.stringify([
      { Id: 143460, ProcessName: 'Unity', MainWindowTitle: 'IslandSplash_BugFix2 - Login', Path: 'C:\\Unity\\Editor\\Unity.exe' },
      { Id: 99, ProcessName: 'CodeBuddy CN', MainWindowTitle: '编辑器', Path: null },
    ])
    const items = parseProcessListJson(text)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ pid: 143460, title: 'IslandSplash_BugFix2 - Login', path: 'C:\\Unity\\Editor\\Unity.exe', name: 'Unity.exe' })
    expect(items[1].name).toBe('CodeBuddy CN.exe')
    expect(items[1].path).toBe('')
  })

  it('单条对象输出同样解析', () => {
    const items = parseProcessListJson(JSON.stringify({ Id: 7, ProcessName: 'lua', MainWindowTitle: 'x', Path: 'C:\\lua.exe' }))
    expect(items).toHaveLength(1)
    expect(items[0].pid).toBe(7)
  })

  it('非法 JSON 与无效行剔除', () => {
    expect(parseProcessListJson('broken')).toEqual([])
    expect(parseProcessListJson(JSON.stringify([{ Id: -1 }, { ProcessName: 'x' }, null]))).toEqual([])
  })
})

describe('filterProcesses', () => {
  const items = [
    { pid: 1, title: 'IslandSplash_BugFix2 - Login', path: 'C:\\Unity.exe', name: 'Unity.exe' },
    { pid: 2, title: '表格管理', path: 'C:\\TableMgrFrame.exe', name: 'TableMgrFrame.exe' },
  ]

  it('按标题包含匹配', () => {
    expect(filterProcesses(items, 'IslandSplash_BugFix2').map((i) => i.pid)).toEqual([1])
  })

  it('按文件名包含匹配', () => {
    expect(filterProcesses(items, 'TableMgr').map((i) => i.pid)).toEqual([2])
  })

  it('空词全量返回', () => {
    expect(filterProcesses(items, '')).toHaveLength(2)
    expect(filterProcesses(items, undefined)).toHaveLength(2)
  })
})
