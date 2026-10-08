import { describe, expect, it } from 'vitest'
import { configOf, parseArgs, parsePairs } from '../src/client/mcpForm.js'

describe('MCP form parsing', () => {
  it('keeps JSON string arrays lossless', () => {
    const args = ['C:\\Program Files\\agent.js', '--title=hello world', '', '  padded  ', 'a\nb', '"quote"']
    expect(parseArgs(JSON.stringify(args))).toEqual(args)
  })
  it('keeps each nonempty line as one argument, including spaces and quotes', () => {
    expect(parseArgs('C:\\Program Files\\agent.js\r\n--title=hello world\n\n"quoted text"')).toEqual(['C:\\Program Files\\agent.js', '--title=hello world', '"quoted text"'])
    expect(parseArgs('  padded  ')).toEqual(['  padded  '])
    expect(parseArgs('')).toEqual([])
  })
  it.each(['[', '[1]', '[null]', '["ok",{}]'])('rejects malformed/non-string JSON %s', (text) => {
    expect(() => parseArgs(text)).toThrow()
  })
  it('accepts header values containing equals and empty values', () => {
    expect(parsePairs('Authorization = token=a=b\nX-Empty=\n\n')).toEqual({ Authorization: 'token=a=b', 'X-Empty': '' })
  })
  it.each(['broken', '=value', '   =value', 'Token=a\nToken=b', 'Token=a\ntoken=b', 'bad key=value', 'X=a\rb'])('rejects invalid headers %s', (text) => {
    expect(() => parsePairs(text)).toThrow()
  })
  it('builds stdio config without splitting a path', () => {
    expect(configOf({ serverName: ' agent ', transport: 'stdio', command: ' node ', args: 'C:\\Program Files\\agent.js', cwd: ' C:\\Work ', url: '', headers: '' })).toEqual({ serverName: 'agent', transport: 'stdio', command: 'node', args: ['C:\\Program Files\\agent.js'], cwd: 'C:\\Work' })
  })
  it('surfaces HTTP header validation rather than silently dropping errors', () => {
    expect(() => configOf({ serverName: 'http', transport: 'streamable-http', command: '', args: '', cwd: '', url: 'https://example.test/mcp', headers: 'broken' })).toThrow()
  })
})
