import { describe, expect, it } from 'vitest'
import { admitRoute } from '../src/httpGuard.js'
import type { Ctx } from '../src/store.js'

/** 记录写回的假响应；只实现 admitRoute 用到的三件事。 */
function fakeResponse() {
  const headers = new Map<string, string>()
  const state: { status: number; body: string } = { status: 0, body: '' }
  return {
    headers,
    state,
    set statusCode(value: number) { state.status = value },
    get statusCode(): number { return state.status },
    setHeader(name: string, value: string) { headers.set(name, value) },
    end(body?: string) { state.body = body ?? '' },
  }
}

/** 旧版宿主连接服务的替身：requestRejection 是类方法，必须带 this 才有 admit。 */
function legacyConnection(rejection?: number | Error) {
  const connection = {
    admitted: 0,
    /** @author ddj 2026年11月23号 @param request 原始请求。 @returns 拒绝状态码；undefined 放行。 @throws rejection 为 Error 时抛出。 */
    requestRejection(this: { admitted: number }, request: unknown): number | undefined {
      this.admitted += 1
      if (request === undefined) throw new Error('missing request')
      if (rejection instanceof Error) throw rejection
      return rejection
    },
  }
  return connection
}

/** 最小请求替身：admitRoute 只读 method。 */
const request = { method: 'POST' } as never

/** @author ddj 2026年11月23号 @param services 服务表。 @returns 只实现 get 的宿主上下文替身。 */
function ctxWith(services: Record<string, unknown>): Ctx {
  return { get: (name: string) => services[name] } as unknown as Ctx
}

describe('admitRoute 旧版围栏', () => {
  it('把 connection 服务实例作为接收者调用 requestRejection（v0.33.0 裸调导致 0.2.2 桌面端全量 503）', () => {
    const connection = legacyConnection(undefined)
    const res = fakeResponse()
    expect(admitRoute(ctxWith({ connection }), request, res as never, ['POST'])).toBe(true)
    expect(connection.admitted).toBe(1)
    expect(res.state.status).toBe(0)
  })

  it('围栏拒绝 403 时原样返回 403 与 JSON 体', () => {
    const res = fakeResponse()
    expect(admitRoute(ctxWith({ connection: legacyConnection(403) }), request, res as never, ['POST'])).toBe(false)
    expect(res.state.status).toBe(403)
    expect(JSON.parse(res.state.body)).toMatchObject({ ok: false })
  })

  it('围栏返回 undefined 表示放行', () => {
    const res = fakeResponse()
    expect(admitRoute(ctxWith({ connection: legacyConnection() }), request, res as never, ['POST'])).toBe(true)
    expect(res.state.status).toBe(0)
  })

  it('没有 connection 服务时交给框架路由鉴权（0.2.3+）', () => {
    const res = fakeResponse()
    expect(admitRoute(ctxWith({}), request, res as never, ['POST'])).toBe(true)
  })

  it('宿主取服务抛错时同样放行，不把服务缺失当成 503', () => {
    const ctx = { get: () => { throw new Error('service unavailable') } } as unknown as Ctx
    const res = fakeResponse()
    expect(admitRoute(ctx, request, res as never, ['POST'])).toBe(true)
  })

  it('围栏抛错时回 503，并（仅一次）把原因交给诊断回调', () => {
    const warnings: string[] = []
    const connection = legacyConnection(new Error('this.admit is not a function'))
    const res = fakeResponse()
    expect(admitRoute(ctxWith({ connection }), request, res as never, ['POST'], (text) => warnings.push(text))).toBe(false)
    expect(res.state.status).toBe(503)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('this.admit is not a function')
    admitRoute(ctxWith({ connection }), request, res as never, ['POST'], (text) => warnings.push(text))
    expect(warnings).toHaveLength(1)
  })

  it('方法不允许时回 405 并带 allow', () => {
    const res = fakeResponse()
    expect(admitRoute(ctxWith({ connection: legacyConnection() }), request, res as never, ['GET'])).toBe(false)
    expect(res.state.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
  })
})
