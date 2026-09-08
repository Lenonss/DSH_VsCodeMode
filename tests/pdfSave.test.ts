/**
 * host rpc.ts 二进制保存（edrv.saveBinary）与 edrv.read base64 mime 测试。
 * 用内存 fake fs/ctx 验证：工作区边界拒绝、超限/空内容拒绝、编码校验、
 * 成功路径 node:fs writeFile 落盘参数、成功后 pending 记录被 superseded。
 * 作者 ddj 2026-09-22
 */
import { describe, expect, it, vi } from 'vitest'
import { BINARY_READ_CAP } from '../src/store.js'
import { buildHandlers } from '../src/rpc.js'
import type { DiffRecord } from '../src/shared/types.js'

const { writeFileMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn(async (path: string, data: Uint8Array) => ({ path, data })),
}))

// 仅覆写 writeFile：rpc.ts 的二进制落盘走 node:fs，其余 node:fs/promises 导出保持原样
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: writeFileMock }
})

// invalidateIndex 会调度后台 heal 定时器；测试内隔离为 noop，避免悬挂定时器
vi.mock('../src/treeIndex.js', () => ({
  invalidateIndex: vi.fn(),
  listDirCached: vi.fn(),
}))

const CWD = '/ws'

function rec(partial: Partial<DiffRecord>): DiffRecord {
  return {
    callId: 'c1',
    toolName: 'edit',
    path: 'doc.pdf',
    before: 'old',
    create: false,
    callHunk: null,
    hunks: [{ oldText: 'a', newText: 'b' }],
    decisions: { call: 'pending', perHunk: ['pending'] },
    note: null,
    superseded: false,
    archived: false,
    batch: 1,
    at: '2026-09-22T00:00:00.000Z',
    ...partial,
  }
}

/** 内存 fake fs：stat/contains/processPath/resolve + sidecar 读写（归档收尾用）。 */
function fakeFs(opts: { contains?: boolean } = {}): any {
  const sidecars = new Map<string, string>()
  return {
    resolve: vi.fn(async (p: string, o?: { cwd?: string }) => {
      const cwd = o?.cwd ?? ''
      if (p === '.dsh-edit-review.json' || p === '.dsh-edit-review-archive.json') return (cwd ? cwd + '/' : '') + p
      if (p === '.' || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return p
      return cwd ? cwd + '/' + p : p
    }),
    stat: vi.fn(async (target: string) => {
      if (target === CWD + '/doc.pdf') return { type: 'file', size: 1234 }
      if (target === '.') return { type: 'directory', size: 0 }
      return undefined
    }),
    processPath: vi.fn((target: string) => target),
    contains: vi.fn(() => opts.contains ?? true),
    readText: vi.fn(async (target: string) => sidecars.get(target) ?? ''),
    writeText: vi.fn(async (target: string, content: string) => { sidecars.set(target, content) }),
    readBytes: vi.fn(async (target: string) => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
  }
}

function fakeCtx(fs: any): any {
  const sessions = {
    get: (id: string) => (id === 's1' ? { id: 's1', header: { cwd: CWD } } : undefined),
    list: () => [{ id: 's1', header: { cwd: CWD } }],
  }
  return { get: (name: string) => (name === 'fs' ? fs : name === 'sessions' ? sessions : undefined) }
}

function makeHandlers(fs: any, records: DiffRecord[] = []) {
  const registry = new Map<string, Map<string, DiffRecord>>([
    [CWD, new Map(records.map((r) => [r.callId, r]))],
  ])
  return { handlers: buildHandlers(fakeCtx(fs), registry), registry }
}

describe('edrv.saveBinary', () => {
  it('成功路径：解码后经 node:fs writeFile 落盘并返回 ok', async () => {
    writeFileMock.mockClear()
    const fs = fakeFs()
    const { handlers } = makeHandlers(fs)
    const res = await handlers['edrv.saveBinary']({ sessionId: 's1', path: 'doc.pdf', content: 'JVBERi0=', encoding: 'base64' })
    expect(res.ok).toBe(true)
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const call = writeFileMock.mock.calls[0]
    expect(call[0]).toBe(CWD + '/doc.pdf')
    expect(Array.from(call[1] as Uint8Array).join(',')).toBe('37,80,68,70,45')
  })

  it('工作区外目标拒绝且不写盘', async () => {
    writeFileMock.mockClear()
    const fs = fakeFs({ contains: false })
    const { handlers } = makeHandlers(fs)
    const res = await handlers['edrv.saveBinary']({ sessionId: 's1', path: 'doc.pdf', content: 'JVBERi0=', encoding: 'base64' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('不在会话工作区内')
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('解码后超上限拒绝', async () => {
    writeFileMock.mockClear()
    const fs = fakeFs()
    const { handlers } = makeHandlers(fs)
    const big = Buffer.alloc(BINARY_READ_CAP + 1).toString('base64')
    const res = await handlers['edrv.saveBinary']({ sessionId: 's1', path: 'doc.pdf', content: big, encoding: 'base64' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('过大')
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('空内容拒绝', async () => {
    writeFileMock.mockClear()
    const fs = fakeFs()
    const { handlers } = makeHandlers(fs)
    const res = await handlers['edrv.saveBinary']({ sessionId: 's1', path: 'doc.pdf', content: '', encoding: 'base64' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('为空')
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('非 base64 编码拒绝', async () => {
    const fs = fakeFs()
    const { handlers } = makeHandlers(fs)
    // @ts-expect-error 故意传非法 encoding 验证运行时校验
    const res = await handlers['edrv.saveBinary']({ sessionId: 's1', path: 'doc.pdf', content: 'JVBERi0=', encoding: 'utf8' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('base64')
  })

  it('目标不存在拒绝', async () => {
    const fs = fakeFs()
    const { handlers } = makeHandlers(fs)
    const res = await handlers['edrv.saveBinary']({ sessionId: 's1', path: 'missing.pdf', content: 'JVBERi0=', encoding: 'base64' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('文件不存在')
  })

  it('成功后该路径 pending 记录被标记 superseded 并归档', async () => {
    writeFileMock.mockClear()
    const fs = fakeFs()
    const pending = rec({ callId: 'c1', path: 'doc.pdf', superseded: false })
    const other = rec({ callId: 'c2', path: 'other.ts', superseded: false })
    const { handlers, registry } = makeHandlers(fs, [pending, other])
    const res = await handlers['edrv.saveBinary']({ sessionId: 's1', path: 'doc.pdf', content: 'JVBERi0=', encoding: 'base64' })
    expect(res.ok).toBe(true)
    const bucket = registry.get(CWD)!
    expect(bucket.get('c1')!.superseded).toBe(true)
    expect(bucket.get('c2')!.superseded).toBe(false)
  })
})

describe('edrv.read base64 mime', () => {
  it('pdf 返回 application/pdf', async () => {
    const fs = fakeFs()
    const { handlers } = makeHandlers(fs)
    const res = await handlers['edrv.read']({ sessionId: 's1', path: 'doc.pdf', encoding: 'base64' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.mime).toBe('application/pdf')
  })

  it('png 仍返回 image/png', async () => {
    const fs = fakeFs()
    fs.stat = vi.fn(async (target: string) => (target === CWD + '/logo.png' ? { type: 'file', size: 4 } : undefined))
    const { handlers } = makeHandlers(fs)
    const res = await handlers['edrv.read']({ sessionId: 's1', path: 'logo.png', encoding: 'base64' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.mime).toBe('image/png')
  })
})
