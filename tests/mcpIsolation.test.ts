/** 项目 MCP agent 隔离与项目选择纯函数测试。作者 ddj 2026年08月22号 */
import { describe, expect, it } from 'vitest'
import { denyTools, isProjectEntry, matchWorkspace, normalizePath } from '../src/mcpIsolation.js'
import { filterProjects } from '../src/client/ui/McpSettings.js'

describe('normalizePath', () => {
  it('统一 Windows 分隔符、盘符大小写和尾斜杠', () => {
    expect(normalizePath('D:\\Work\\Project\\')).toBe('d:/work/project')
    expect(normalizePath('d:/work/project')).toBe('d:/work/project')
  })
})

describe('matchWorkspace', () => {
  const projects = ['D:/repo', 'D:/repo/packages/app', 'C:/other']

  it('匹配 cwd 所在项目且优先最长父路径', () => {
    expect(matchWorkspace('D:/repo/packages/app/src', projects)).toBe('D:/repo/packages/app')
    expect(matchWorkspace('D:/repo/README.md', projects)).toBe('D:/repo')
  })

  it('不把相似前缀误判为项目子路径', () => {
    expect(matchWorkspace('D:/repository/file.ts', projects)).toBeUndefined()
  })

  it('无 cwd 时安全返回 undefined', () => {
    expect(matchWorkspace(undefined, projects)).toBeUndefined()
  })
})

describe('project tool isolation', () => {
  const tools = new Map([
    ['mcp__alpha__search', 'd:/alpha'],
    ['mcp__beta__search', 'd:/beta'],
    ['mcp__unknown__search', '__unknown_project__'],
  ])

  it('当前项目只允许自身项目工具', () => {
    expect(denyTools(tools, 'd:/alpha')).toEqual(['mcp__beta__search', 'mcp__unknown__search'])
  })

  it('未匹配项目时拒绝所有项目工具', () => {
    expect(denyTools(tools, undefined)).toEqual([
      'mcp__alpha__search',
      'mcp__beta__search',
      'mcp__unknown__search',
    ])
  })
})

describe('project entry compatibility', () => {
  it('识别新旧项目 entry id，不把旧格式当全局', () => {
    expect(isProjectEntry('vsm-mcp.abc123.alpha')).toBe(true)
    expect(isProjectEntry('vsm-mcp:abc123:alpha')).toBe(true)
    expect(isProjectEntry('include:mcp-codegraph')).toBe(false)
  })
})

describe('filterProjects', () => {
  const projects = [
    { title: 'Alpha App', workspacePath: 'D:/repo/alpha', servers: [] },
    { title: 'Beta Tools', workspacePath: 'D:/repo/beta', servers: [{}, {}] },
  ]

  it('按名称过滤', () => {
    expect(filterProjects(projects, 'alpha')).toHaveLength(1)
    expect(filterProjects(projects, 'ALPHA')[0].title).toBe('Alpha App')
  })

  it('按路径过滤并支持空查询', () => {
    expect(filterProjects(projects, 'repo/beta')[0].title).toBe('Beta Tools')
    expect(filterProjects(projects, '')).toEqual(projects)
  })
})
