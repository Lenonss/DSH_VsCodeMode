/**
 * client 二进制预览通道（shared/rpc readBinaryPreview）单测：
 * ① octet-stream 成功：原始字节 + x-edrv-* 元数据头，不触发回退；
 * ② 各类失败（长度头不符/网络错/JSON 错误载荷）自动回退 edrv.read base64 且功能不降级；
 * ③ 「host 有 handler 但 routes 未接线（信封被 JSON 化）」只探测一次，本页不再尝试。
 * 模块态（binaryTransport）用 vi.resetModules + 动态 import 按用例重置。
 * 作者 ddj 2026-09-22
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcJsonCall } from '../src/shared/rpc.js'

type ChannelModule = typeof import('../src/shared/rpc.js')
let mod: ChannelModule

const ARGS = { sessionId: 's1', path: 'img/logo.png' }

/** 回退通道默认成功载荷（edrv.read base64，形状与 host 历史响应一致）。 */
const FALLBACK_OK = { ok: true, content: 'aGVsbG8=', size: 5, encoding: 'base64', mime: 'image/png', version: 'v1' }

let fetchMock: ReturnType<typeof vi.fn>

/** octet-stream 成功响应（带 x-edrv-* 元数据头，headers 可覆盖单项）。 */
function binRes(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'x-edrv-mime': 'image/png',
      'x-edrv-size': String(bytes.byteLength),
      'x-edrv-version': 'mtime:1',
      ...headers,
    },
  })
}

/** JSON 响应（模拟 routes 强制 JSON 的回退/错误形态）。 */
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 记录调用的回退通道 mock（readResult = 收到 edrv.read 时返回的载荷）。 */
function makeRpc(readResult: unknown = FALLBACK_OK): { fn: RpcJsonCall; calls: Array<{ method: string; args: unknown }> } {
  const calls: Array<{ method: string; args: unknown }> = []
  const fn = (async (method: string, args: unknown) => {
    calls.push({ method, args })
    return readResult
  }) as unknown as RpcJsonCall
  return { fn, calls }
}

beforeEach(async () => {
  vi.resetModules()
  mod = await import('../src/shared/rpc.js')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readBinaryPreview 成功通道', () => {
  it('octet-stream：返回原始字节与元数据头，不走回退', async () => {
    fetchMock.mockResolvedValue(binRes(new Uint8Array([1, 2, 3])))
    const rpc = makeRpc()
    const out = await mod.readBinaryPreview(rpc.fn, ARGS)
    expect(out.ok).toBe(true)
    if (out.ok && out.via === 'binary') {
      expect(Array.from(out.bytes)).toEqual([1, 2, 3])
      expect(out.mime).toBe('image/png')
      expect(out.size).toBe(3)
      expect(out.version).toBe('mtime:1')
    }
    expect(rpc.calls).toHaveLength(0)
    const body = String((fetchMock.mock.calls[0] as unknown[])[1] && (fetchMock.mock.calls[0][1] as { body?: string }).body)
    expect(body).toContain('edrv.readBinary')
  })
})

describe('readBinaryPreview 降级链', () => {
  it('长度头与字节数不符：回退 base64，且瞬时失败不关停通道', async () => {
    fetchMock.mockResolvedValue(binRes(new Uint8Array([1, 2, 3]), { 'x-edrv-size': '99' }))
    const rpc = makeRpc()
    const out = await mod.readBinaryPreview(rpc.fn, ARGS)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.via).toBe('base64')
    expect(rpc.calls[0]).toEqual({ method: 'edrv.read', args: { sessionId: 's1', path: 'img/logo.png', encoding: 'base64' } })
    // 下一次仍尝试新通道（该类失败不标记 unwired）
    fetchMock.mockClear()
    fetchMock.mockResolvedValue(binRes(new Uint8Array([7])))
    const retry = await mod.readBinaryPreview(rpc.fn, ARGS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    if (retry.ok) expect(retry.via).toBe('binary')
  })

  it('网络错误：回退 base64 并带 probed（供一次性回退日志）', async () => {
    fetchMock.mockRejectedValue(new Error('net down'))
    const rpc = makeRpc()
    const out = await mod.readBinaryPreview(rpc.fn, ARGS)
    expect(out.ok).toBe(true)
    expect((out as { probed?: boolean }).probed).toBe(true)
    expect(rpc.calls).toHaveLength(1)
  })

  it('非 200：回退 base64', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    const rpc = makeRpc()
    const out = await mod.readBinaryPreview(rpc.fn, ARGS)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.via).toBe('base64')
  })

  it('回退后 host 错误载荷透传（error + resolvedPath）', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: false, error: '文件不存在', resolvedPath: '/ws/img/logo.png' }))
    const rpc = makeRpc({ ok: false, error: '文件不存在', resolvedPath: '/ws/img/logo.png' })
    const out = await mod.readBinaryPreview(rpc.fn, ARGS)
    expect(out.ok).toBe(false)
    if (!out) return
    expect(out.error).toBe('文件不存在')
    expect(out.resolvedPath).toBe('/ws/img/logo.png')
    expect(out.probed).toBe(true)
  })
})

describe('readBinaryPreview 未接线探测（host 有 handler 但 routes 强制 JSON）', () => {
  it('识别 JSON 化信封后本页不再尝试新通道', async () => {
    const unwired = jsonRes({ ok: true, binary: { bytes: { 0: 1, 1: 2 }, mime: 'image/png', size: 2, version: '' } })
    fetchMock.mockResolvedValue(unwired)
    const rpc = makeRpc()
    const first = await mod.readBinaryPreview(rpc.fn, ARGS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.via).toBe('base64')
    expect((first as { probed?: boolean }).probed).toBe(true)
    // 第二次：直接走回退，不再发起二进制尝试（probed 属性不出现 = 未探测）
    const second = await mod.readBinaryPreview(rpc.fn, ARGS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    if (second.ok) expect(second.via).toBe('base64')
    expect((second as { probed?: boolean }).probed).toBeUndefined()
    expect(rpc.calls).toHaveLength(2)
    expect(rpc.calls.every((c) => c.method === 'edrv.read')).toBe(true)
  })

  it('JSON 错误响应（未知方法/真实错误）只回退不关停通道', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: false, error: '未知方法: edrv.readBinary' }))
    const rpc = makeRpc()
    const out = await mod.readBinaryPreview(rpc.fn, ARGS)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.via).toBe('base64')
    fetchMock.mockClear()
    fetchMock.mockResolvedValue(binRes(new Uint8Array([9])))
    const retry = await mod.readBinaryPreview(rpc.fn, ARGS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    if (retry.ok) expect(retry.via).toBe('binary')
  })
})
