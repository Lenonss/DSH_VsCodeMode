/**
 * host mcpProject.ts 纯函数测试。
 * 覆盖：hashWorkspace / projectEntryId / serversOf / configFromDef。
 * 作者 ddj 2026年08月22号
 */
import { describe, expect, it } from 'vitest'
import { configFromDef, hashWorkspace, projectEntryId, serversOf } from '../src/mcpProject.js'

describe('hashWorkspace', () => {
  it('确定性：同路径同哈希', () => {
    const a = hashWorkspace('D:/a/b')
    const b = hashWorkspace('D:/a/b')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{10}$/)
  })

  it('不同路径不同哈希', () => {
    expect(hashWorkspace('D:/a/b')).not.toBe(hashWorkspace('D:/a/c'))
    expect(hashWorkspace('D:/x')).not.toBe(hashWorkspace('C:/x'))
  })
})

describe('projectEntryId', () => {
  it('带 vsm-mcp. 前缀 + 路径哈希 + serverName', () => {
    const id = projectEntryId('D:/proj', 'codegraph')
    expect(id).toBe('vsm-mcp.' + hashWorkspace('D:/proj') + '.codegraph')
    expect(id.startsWith('vsm-mcp.')).toBe(true)
    expect(id).not.toContain(':')
  })

  it('同路径不同 serverName 不同 id；同 serverName 不同路径不同 id', () => {
    expect(projectEntryId('D:/p', 'a')).not.toBe(projectEntryId('D:/p', 'b'))
    expect(projectEntryId('D:/p', 'a')).not.toBe(projectEntryId('D:/q', 'a'))
  })
})

describe('serversOf', () => {
  it('空/缺失 mcpServers → 空映射', () => {
    expect(serversOf({})).toEqual({})
    expect(serversOf({ mcpServers: {} })).toEqual({})
  })

  it('解析合法 stdio + http 定义', () => {
    const out = serversOf({
      mcpServers: {
        codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
        web: { url: 'http://localhost:3000/mcp', headers: { Authorization: 'x' } },
      },
    })
    expect(Object.keys(out)).toEqual(['codegraph', 'web'])
    expect(out.codegraph.command).toBe('codegraph')
    expect(out.web.url).toBe('http://localhost:3000/mcp')
  })

  it('mcpServers 非法类型抛错', () => {
    expect(() => serversOf({ mcpServers: 'nope' })).toThrow()
    expect(() => serversOf({ mcpServers: [1] })).toThrow()
  })

  it('跳过非对象 server 定义', () => {
    const out = serversOf({ mcpServers: { good: { command: 'x' }, bad: 'str', n: null, arr: [] } })
    expect(Object.keys(out)).toEqual(['good'])
  })
})

describe('configFromDef', () => {
  it('undefined → null', () => {
    expect(configFromDef(undefined, 'x')).toBeNull()
  })

  it('stdio 定义映射 command/args/cwd/env', () => {
    const cfg = configFromDef({ command: 'npx', args: ['-y', 'pkg'], cwd: '/ws', env: { TOKEN: 'abc' } }, 'srv')
    expect(cfg).toEqual({
      serverName: 'srv',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      cwd: '/ws',
      env: { TOKEN: 'abc' },
    })
  })

  it('http 定义（含 url）映射为 streamable-http', () => {
    const cfg = configFromDef({ url: 'http://h/mcp', headers: { Authorization: 't' } }, 'web')
    expect(cfg).toEqual({
      serverName: 'web',
      transport: 'streamable-http',
      url: 'http://h/mcp',
      headers: { Authorization: 't' },
    })
  })

  it('缺 url 且无 command → stdio 空 command', () => {
    const cfg = configFromDef({ args: ['a'] }, 'srv')
    expect(cfg.transport).toBe('stdio')
    expect(cfg.command).toBe('')
  })

  it('保留 toolCallTimeoutMs', () => {
    const cfg = configFromDef({ command: 'x', toolCallTimeoutMs: 30000 }, 'srv')
    expect(cfg.toolCallTimeoutMs).toBe(30000)
  })

  it('env/headers 值统一转字符串', () => {
    const cfg = configFromDef({ command: 'x', env: { N: 1, B: true } }, 'srv')
    expect(cfg.env).toEqual({ N: '1', B: 'true' })
  })
})
