/**
 * 会话当前工作目录解析：跟随 DSH 0.2.1 的 workingDirectory 投影，
 * 服务缺失或抛错时回落 header.cwd。
 * @author ddj 2026年10月19号
 */
import { describe, expect, it } from 'vitest'
import { cwdOfSession } from '../src/store.js'

/** 构造最小上下文：只提供 ctx.get 的按名返回表。 */
function makeCtx(services: Record<string, unknown> = {}): { get(name: string): unknown } {
  return { get: (name: string) => services[name] }
}

const SESSION = { id: 's1', header: { cwd: '/repo' } }

describe('cwdOfSession', () => {
  it('会话内 cd 后返回投影里的当前目录', () => {
    const ctx = makeCtx({ workingDirectory: { get: () => '/repo/packages/app' } })
    expect(cwdOfSession(ctx, SESSION)).toBe('/repo/packages/app')
  })

  it('workingDirectory 服务缺失时回落 header.cwd', () => {
    expect(cwdOfSession(makeCtx(), SESSION)).toBe('/repo')
  })

  it('服务存在但 get 不是函数时回落 header.cwd', () => {
    const ctx = makeCtx({ workingDirectory: { get: 'not-a-function' } })
    expect(cwdOfSession(ctx, SESSION)).toBe('/repo')
  })

  it('投影尚未写入（null）时回落 header.cwd', () => {
    const ctx = makeCtx({ workingDirectory: { get: () => null } })
    expect(cwdOfSession(ctx, SESSION)).toBe('/repo')
  })

  it('投影返回空串时回落 header.cwd', () => {
    const ctx = makeCtx({ workingDirectory: { get: () => '' } })
    expect(cwdOfSession(ctx, SESSION)).toBe('/repo')
  })

  it('投影抛错时回落 header.cwd，不向上传播', () => {
    const ctx = makeCtx({
      workingDirectory: {
        get: () => {
          throw new Error('session disposed')
        },
      },
    })
    expect(() => cwdOfSession(ctx, SESSION)).not.toThrow()
    expect(cwdOfSession(ctx, SESSION)).toBe('/repo')
  })

  it('会话缺失时返回 null', () => {
    expect(cwdOfSession(makeCtx({ workingDirectory: { get: () => '/x' } }), undefined)).toBeNull()
  })

  it('会话无 header.cwd 且无服务时返回 null', () => {
    expect(cwdOfSession(makeCtx(), { id: 's2' })).toBeNull()
  })

  it('ctx 没有 get（极端装配）时按 header 返回，不抛错', () => {
    expect(cwdOfSession({}, SESSION)).toBe('/repo')
  })
})
