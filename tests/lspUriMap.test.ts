/**
 * dsh-vscode-mode tests — LSP 目标 URI → 编辑器路径映射：
 *  - file:///Users/x 必须保留前导 /（原实现多吞一个 / → 跳转打开 <root>/Users/... 报"磁盘上已没有该文件"）
 *  - Windows 盘符、百分号编码、edrv:// 相对路径三种形态
 *  - toEdrvUri 工作区内走相对路径、工作区外保留绝对路径（配合 absoluteTargetOf 还原）
 * @author ddj 2026年11月15号
 */
import { describe, it, expect } from 'vitest'
import {
  pathOfModel,
  absoluteTargetOf,
  toEdrvUri,
  targetOpenPath,
  lspUriToAbs,
  targetMonoPosition,
} from '../src/client/monaco/lsp/lspClient.js'

const ROOT = '/Users/didi/pro'

describe('lspUriToAbs（URI → 可读路径）', () => {
  it('file:///Unix 绝对路径不吞前导斜杠（跳转错路径回归）', () => {
    expect(lspUriToAbs('file:///Users/didi/pro/dirpc-go/metrics/metrics.go')).toBe(
      '/Users/didi/pro/dirpc-go/metrics/metrics.go',
    )
    expect(lspUriToAbs('file:///usr/local/go/src/fmt/print.go')).toBe('/usr/local/go/src/fmt/print.go')
  })

  it('file:///D:/x 去 authority 空段、保留盘符', () => {
    expect(lspUriToAbs('file:///D:/work/main.go')).toBe('D:/work/main.go')
  })

  it('百分号编码解码（空格/中文）', () => {
    expect(lspUriToAbs('file:///tmp/a%20b/c.go')).toBe('/tmp/a b/c.go')
    expect(lspUriToAbs('file:///tmp/%E4%B8%AD%E6%96%87/c.go')).toBe('/tmp/中文/c.go')
  })

  it('edrv:// 字符串与 Monaco Uri 对象 → 工作区相对路径', () => {
    expect(lspUriToAbs('edrv:///dirpc-go/metrics/metrics.go')).toBe('dirpc-go/metrics/metrics.go')
    expect(lspUriToAbs({ scheme: 'edrv', path: '/dirpc-go/metrics/metrics.go' })).toBe(
      'dirpc-go/metrics/metrics.go',
    )
  })

  it('裸相对路径原样返回；反斜杠归一', () => {
    expect(lspUriToAbs('dirpc-go/metrics/metrics.go')).toBe('dirpc-go/metrics/metrics.go')
    expect(lspUriToAbs('dirpc-go\\metrics\\metrics.go')).toBe('dirpc-go/metrics/metrics.go')
  })

  it('空值 → 空串', () => {
    expect(lspUriToAbs('')).toBe('')
    expect(lspUriToAbs(null)).toBe('')
  })
})

describe('toEdrvUri（路径 → Monaco 模型 URI）', () => {
  it('工作区内 → edrv:///相对路径', () => {
    expect(toEdrvUri('file:///Users/didi/pro/dirpc-go/metrics/metrics.go', ROOT)).toBe(
      'edrv:///dirpc-go/metrics/metrics.go',
    )
  })

  it('工作区外 → 剥前导 / 的绝对路径（不再是 edrv:////x 非法 URI）', () => {
    expect(toEdrvUri('file:///usr/local/go/src/fmt/print.go', ROOT)).toBe(
      'edrv:///usr/local/go/src/fmt/print.go',
    )
    expect(toEdrvUri('file:///usr/local/go/src/fmt/print.go', ROOT)).not.toMatch(/^edrv:\/\/\/\//)
  })

  it('空格编码为 %20，与 EditorView 模型 URI 约定一致', () => {
    expect(toEdrvUri('file:///Users/didi/pro/a%20b/c.go', ROOT)).toBe('edrv:///a%20b/c.go')
  })

  it('已是 edrv:// 的输入原样返回', () => {
    expect(toEdrvUri('edrv:///dirpc-go/metrics/metrics.go', ROOT)).toBe(
      'edrv:///dirpc-go/metrics/metrics.go',
    )
  })

  it('round-trip：toEdrvUri → lspUriToAbs 得到可直接读取的工作区路径', () => {
    const uri = toEdrvUri('file:///Users/didi/pro/dirpc-go/metrics/metrics.go', ROOT)
    expect(lspUriToAbs(uri)).toBe('dirpc-go/metrics/metrics.go')
  })
})

describe('targetOpenPath（跳转目标 → 打开路径）', () => {
  it('优先用原始 LSP uri/root', () => {
    expect(
      targetOpenPath({ lspUri: 'file:///Users/didi/pro/a/b.go', lspRoot: ROOT }),
    ).toBe('a/b.go')
  })

  it('无 lspUri 时回落 uri/root', () => {
    expect(targetOpenPath({ uri: 'file:///Users/didi/pro/a/b.go', root: ROOT })).toBe('a/b.go')
  })

  it('工作区外目标保留绝对路径', () => {
    expect(targetOpenPath({ lspUri: 'file:///usr/local/go/src/fmt/print.go', lspRoot: ROOT })).toBe(
      '/usr/local/go/src/fmt/print.go',
    )
  })

  it('空入参不抛异常', () => {
    expect(targetOpenPath(undefined)).toBe('')
  })
})

describe('pathOfModel（模型 URI → host path）', () => {
  it('edrv 模型 → 相对路径，剥前导 / 并解码', () => {
    expect(pathOfModel({ uri: { scheme: 'edrv', path: '/dirpc-go/metrics/metrics.go' } })).toBe(
      'dirpc-go/metrics/metrics.go',
    )
    expect(pathOfModel({ uri: { scheme: 'edrv', path: '/a%20b/c.go' } })).toBe('a b/c.go')
  })

  it('非 edrv scheme / 无 uri → null', () => {
    expect(pathOfModel({ uri: { scheme: 'file', path: '/x.go' } })).toBeNull()
    expect(pathOfModel(null)).toBeNull()
    expect(pathOfModel({})).toBeNull()
  })
})

describe('absoluteTargetOf（工作区外绝对路径旁路表）', () => {
  it('未登记的 URI 返回空串', () => {
    expect(absoluteTargetOf('edrv:///not/registered.go')).toBe('')
    expect(absoluteTargetOf('')).toBe('')
    expect(absoluteTargetOf(null)).toBe('')
  })

  it('接受字符串与带 toString 的 Uri 对象', () => {
    const fake = { scheme: 'edrv', path: '/x', toString: () => 'edrv:///x' }
    expect(absoluteTargetOf(fake)).toBe('')
  })
})

describe('targetMonoPosition（0-based LSP → 1-based Monaco）', () => {
  it('优先 lspRange', () => {
    expect(
      targetMonoPosition({ lspRange: { start: { line: 273, character: 24 }, end: { line: 273, character: 35 } } }),
    ).toEqual({ line: 274, column: 25 })
  })

  it('无 lspRange 时兼容 Monaco Range', () => {
    expect(targetMonoPosition({ range: { startLineNumber: 5, startColumn: 3 } })).toEqual({
      line: 5,
      column: 3,
    })
  })

  it('缺省/越界钳到 1', () => {
    expect(targetMonoPosition({})).toEqual({ line: 1, column: 1 })
    expect(targetMonoPosition({ lspRange: { start: { line: -5, character: -1 } } })).toEqual({
      line: 1,
      column: 1,
    })
  })
})
