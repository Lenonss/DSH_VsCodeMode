/**
 * host store.ts 解析/归档纯函数测试（不触 fs，仅测解析与迁移）。
 * 覆盖：parseSidecar（v2 直通 + v1 迁移）/ parseArchive / loadBucket 归一化依赖。
 * 作者 ddj 2026-08-20
 */
import { describe, expect, it } from 'vitest'
import { parseArchive, parseSidecar } from '../src/store.js'

describe('parseSidecar', () => {
  it('v2 直通', () => {
    const data = parseSidecar(JSON.stringify({
      version: 2,
      updatedAt: '2026-08-20T00:00:00.000Z',
      workspaces: { '/ws': { at: 1, records: {} } },
    }))
    expect(data?.version).toBe(2)
    expect(data?.workspaces['/ws']).toBeDefined()
  })
  it('v1 迁移为 v2（按会话 cwd 分桶）', () => {
    const data = parseSidecar(JSON.stringify({
      version: 1,
      sessions: {
        s1: { cwd: '/a', records: { r1: { callId: 'r1', path: '/a/f.ts' } } },
        s2: { cwd: '/b', records: {} },
      },
    }))
    expect(data?.version).toBe(2)
    expect(data?.workspaces['/a'].records).toBeDefined()
    expect(data?.workspaces['/b']).toBeDefined()
    expect(data?.workspaces['/x']).toBeUndefined()
  })
  it('空/损坏 → null', () => {
    expect(parseSidecar(null)).toBeNull()
    expect(parseSidecar('not json')).toBeNull()
    expect(parseSidecar('{"version": 99}')).toBeNull()
  })
})

describe('parseArchive', () => {
  it('合法批次数组返回', () => {
    const b = parseArchive(JSON.stringify({ version: 1, batches: [{ at: 'x', cwd: '/ws', path: '/p', records: [] }] }))
    expect(b).toHaveLength(1)
    expect(b[0].cwd).toBe('/ws')
  })
  it('空/损坏 → []', () => {
    expect(parseArchive(null)).toEqual([])
    expect(parseArchive('oops')).toEqual([])
    expect(parseArchive('{"batches": "nope"}')).toEqual([])
  })
})
