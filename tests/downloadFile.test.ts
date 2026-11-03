/**
 * client downloadFile.ts 单测（取字节链 + 批量串行 + 浏览器落盘原语）。
 * 覆盖：远程 base64 回落解码、主机错误原文透传、批量串行且单项失败不中断、
 * <a download> 触发与 objectURL 释放、文件名取路径末段。
 * shared 的二进制通道有模块态（探测一次后不再尝试），因此每题 resetModules + 动态导入。
 * 作者 ddj 2026年11月03号
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type DownloadModule = typeof import('../src/client/downloadFile.js')

let mod: DownloadModule
let fetchMock: ReturnType<typeof vi.fn>
let calls: Array<{ method: string; args: Record<string, unknown> }>
let anchor: { href: string; download: string; rel: string; click: ReturnType<typeof vi.fn> }
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

/** JSON 响应（host RPC 的普通载荷）。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 二进制通道未接线时的信封（触发回落 base64）。 */
function unwiredEnvelope(): Response {
  return jsonResponse({ ok: true, binary: { bytes: [1], mime: 'text/plain', size: 1, version: 'v1' } })
}

/** base64 成功载荷。 */
function base64Ok(content = 'aGVsbG8=', mime = 'text/plain'): Response {
  return jsonResponse({ ok: true, content, size: 5, encoding: 'base64', mime, version: 'v1' })
}

beforeEach(async () => {
  vi.resetModules()
  mod = await import('../src/client/downloadFile.js')

  calls = []
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  fetchMock.mockImplementation(async (_url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body))
    calls.push({ method: body.method, args: body.args })
    if (body.method === 'edrv.readBinary') return unwiredEnvelope()
    const path = String(body.args?.path ?? '')
    if (path.endsWith('big.bin')) return jsonResponse({ ok: false, error: '文件过大（>32MB），不支持整文件预览' })
    return base64Ok()
  })

  anchor = { href: '', download: '', rel: '', click: vi.fn() }
  createObjectURL = vi.fn(() => 'blob:test')
  revokeObjectURL = vi.fn()
  ;(URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL
  ;(URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL
  vi.stubGlobal('document', { createElement: vi.fn(() => anchor) })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (URL as unknown as Record<string, unknown>).createObjectURL
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL
})

describe('fetchDownload', () => {
  it('二进制通道不可用时回落 edrv.read base64 并解码为字节', async () => {
    const file = await mod.fetchDownload('src/a.txt', 's1')
    expect(Array.from(file.bytes)).toEqual([104, 101, 108, 108, 111])
    expect(file.mime).toBe('text/plain')
    expect(calls.map((call) => call.method)).toEqual(['edrv.readBinary', 'edrv.read'])
    expect(calls[1].args).toMatchObject({ sessionId: 's1', path: 'src/a.txt', encoding: 'base64' })
  })

  it('主机拒绝时透传错误原文（不吞成通用文案）', async () => {
    await expect(mod.fetchDownload('big.bin')).rejects.toThrow('文件过大（>32MB），不支持整文件预览')
  })
})

describe('downloadBytes', () => {
  it('触发 <a download> 并延时释放 objectURL', async () => {
    vi.useFakeTimers()
    try {
      mod.downloadBytes(new Uint8Array([1, 2, 3]), 'a.bin', 'application/octet-stream')
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(anchor.download).toBe('a.bin')
      expect(anchor.click).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).not.toHaveBeenCalled()
      vi.advanceTimersByTime(60000)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:test')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('downloadOne / downloadMany', () => {
  it('文件名取路径末段', async () => {
    const out = await mod.downloadOne('docs/说明.md')
    expect(out.path).toBe('docs/说明.md')
    expect(anchor.download).toBe('说明.md')
  })

  it('串行逐个下载：单项失败不中断，结果分列成功与失败', async () => {
    const out = await mod.downloadMany(['big.bin', 'a.txt', 'b.md'])
    expect(out.ok).toEqual(['a.txt', 'b.md'])
    expect(out.failed).toHaveLength(1)
    expect(out.failed[0]).toMatchObject({ path: 'big.bin', message: '文件过大（>32MB），不支持整文件预览' })
    expect(anchor.click).toHaveBeenCalledTimes(2)
    // 串行：3 个文件各一次 edrv.read（首次 readBinary 探测后本页不再尝试）
    expect(calls.filter((call) => call.method === 'edrv.read').map((call) => call.args.path))
      .toEqual(['big.bin', 'a.txt', 'b.md'])
  })

  it('进度回调按完成数推进', async () => {
    const seen: number[] = []
    await mod.downloadMany(['a.txt', 'b.md'], { onProgress: (done) => seen.push(done) })
    expect(seen).toEqual([1, 2])
  })
})

describe('保存位置（目录选择器）', () => {
  interface Picked {
    dirs: string[]
    files: Array<{ name: string; bytes: number[] }>
  }

  /** 造一个只记录调用的假目录句柄。 */
  function pickedDir(record: Picked) {
    const handle: Record<string, unknown> = {
      async getDirectoryHandle(name: string) {
        record.dirs.push(name)
        return handle
      },
      async getFileHandle(name: string) {
        return {
          async createWritable() {
            return {
              async write(bytes: Uint8Array) {
                record.files.push({ name, bytes: Array.from(bytes) })
              },
              async close() {},
            }
          },
        }
      },
      async queryPermission() {
        return 'granted'
      },
    }
    return handle
  }

  it('选择目录后按相对路径写盘，不再触发 <a download>', async () => {
    const record: Picked = { dirs: [], files: [] }
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => pickedDir(record)))

    const out = await mod.downloadOne('docs/a.md', { sink: { kind: 'dir', dir: pickedDir(record) as never } })
    expect(out.path).toBe('docs/a.md')
    expect(record.files.map((file) => file.name)).toEqual(['a.md'])
    expect(anchor.click).not.toHaveBeenCalled()
  })

  it('用户取消目录选择时整批中止且不发起读取', async () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }))
    const notify = vi.fn()
    await mod.downloadTarget({ path: 'a.txt', type: 'file' }, { notify } as never)

    expect(notify).toHaveBeenCalledWith('已取消下载')
    expect(calls).toHaveLength(0)
  })

  it('目录选择不可用时提示回落默认下载目录，仍完成下载', async () => {
    vi.stubGlobal('isSecureContext', false)
    const notify = vi.fn()
    await mod.downloadTarget({ path: 'a.txt', type: 'file' }, { notify } as never)

    expect(notify).toHaveBeenCalledWith('当前页面不是安全上下文（需 https 或 localhost），已保存到默认下载目录')
    expect(anchor.download).toBe('a.txt')
    expect(anchor.click).toHaveBeenCalledTimes(1)
  })

  it('选择目录后经菜单入口的单个文件走写盘路径', async () => {
    const record: Picked = { dirs: [], files: [] }
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => pickedDir(record)))
    const notify = vi.fn()
    await mod.downloadTarget({ path: 'docs/a.md', type: 'file' }, { notify } as never)

    expect(record.dirs).toEqual(['docs'])
    expect(record.files.map((file) => file.name)).toEqual(['a.md'])
    expect(notify).toHaveBeenCalledWith('已下载 1 个文件')
    expect(anchor.click).not.toHaveBeenCalled()
  })
})
