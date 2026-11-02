/**
 * 加载失败诊断回归：状态探测、四类原因区分、文案不泄露 origin/查询串。
 * @author ddj 2026年11月02号
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadFailureText, monacoHint, probeStatus, statusHint } from '../src/client/loadFailure.js'

afterEach(() => vi.unstubAllGlobals())

describe('load failure diagnostics', () => {
  it('probes the real status and degrades to 0 on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    await expect(probeStatus('/remote/edrv/vendor/monaco/vs/loader.js')).resolves.toBe(403)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(probeStatus('/edrv/rpc')).resolves.toBe(0)
  })

  it('separates host fence, expired auth, missing route and network failure', () => {
    const hints = [statusHint(403), statusHint(401), statusHint(404), statusHint(0)]
    expect(new Set(hints).size).toBe(4)
    expect(hints[0]).toContain('Host')
    expect(hints[2]).toContain('不存在')
    expect(hints[3]).toContain('网络')
  })

  it('names the path and status without leaking the origin or query', () => {
    const text = loadFailureText('Monaco loader 加载失败', 'https://box.example/prefix/edrv/vendor/monaco/vs/loader.js?token=secret', 403)
    expect(text).toContain('/edrv/vendor/monaco/vs/loader.js')
    expect(text).toContain('403')
    expect(text).not.toContain('box.example')
    expect(text).not.toContain('secret')
  })

  it('turns monaco failures into distinct hints', () => {
    const hints = [monacoHint('… HTTP 403 …'), monacoHint('… HTTP 404 …'), monacoHint('请求未完成')]
    expect(new Set(hints).size).toBe(3)
    expect(hints[0]).toContain('远程访问')
    expect(hints[1]).toContain('assets/vendor/monaco')
  })
})
