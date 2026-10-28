/**
 * host 侧会话作用域解析：优先本进程 live 会话，未命中时冷读持久化会话头取 cwd。
 * 覆盖桌面端 / Web 端两套独立宿主下的跨实例只读场景。
 * @author ddj 2026年10月28号
 */
import { describe, expect, it, vi } from 'vitest'
import { coldCwdOf, resolveScope } from '../src/registry.js'
import { resolveTargetIn } from '../src/store.js'
import { SESSION_MISSING_ERROR, SESSION_NO_WORKSPACE_ERROR } from '../src/shared/rpc.js'

/** 构造最小上下文：只提供 ctx.get 的按名返回表。 */
function makeCtx(services: Record<string, unknown> = {}): { get(name: string): unknown } {
  return { get: (name: string) => services[name] }
}

/** 构造持久化会话视图：filterSessions 命中一条远端会话记录。 */
function makeRemoteQuery(sessionId: string, cwd: string): { filterSessions: ReturnType<typeof vi.fn> } {
  return { filterSessions: vi.fn(async () => [{ header: { id: sessionId, cwd } }]) }
}

describe('resolveScope', () => {
  it('live 会话命中时返回会话与投影目录', async () => {
    const session = { id: 'local', header: { cwd: '/repo' } }
    const ctx = makeCtx({
      sessions: { get: (id: string) => (id === 'local' ? session : undefined) },
      workingDirectory: { get: () => '/repo/packages/app' },
    })
    expect(await resolveScope(ctx, 'local')).toEqual({ session, cwd: '/repo/packages/app' })
  })

  it('live 未命中时冷读持久化会话头得到 cwd，且不带会话实例', async () => {
    const ctx = makeCtx({ sessions: { get: () => undefined }, sessionQuery: makeRemoteQuery('remote-1', 'D:/remote-repo') })
    const scope = await resolveScope(ctx, 'remote-1')
    expect('err' in scope).toBe(false)
    expect(scope).toEqual({ cwd: 'D:/remote-repo' })
  })

  it('缺少 filterSessions 能力时回落到 listSessions', async () => {
    const listSessions = vi.fn(async () => [{ header: { id: 'remote-2', cwd: 'D:/listed' } }])
    const ctx = makeCtx({ sessions: { get: () => undefined }, sessionQuery: { listSessions } })
    expect(await resolveScope(ctx, 'remote-2')).toEqual({ cwd: 'D:/listed' })
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('sessionQuery 服务缺失时维持原有「会话不存在」判定', async () => {
    const ctx = makeCtx({ sessions: { get: () => undefined } })
    expect(await resolveScope(ctx, 'remote-3')).toEqual({ err: SESSION_MISSING_ERROR })
  })

  it('冷读查无此会话时维持原有「会话不存在」判定', async () => {
    const ctx = makeCtx({ sessions: { get: () => undefined }, sessionQuery: { filterSessions: async () => [] } })
    expect(await resolveScope(ctx, 'remote-4')).toEqual({ err: SESSION_MISSING_ERROR })
  })

  it('冷读抛错时不上抛，仍按「会话不存在」上报', async () => {
    const failing = { filterSessions: async () => { throw new Error('persistence offline') } }
    const ctx = makeCtx({ sessions: { get: () => undefined }, sessionQuery: failing })
    expect(await resolveScope(ctx, 'remote-5')).toEqual({ err: SESSION_MISSING_ERROR })
  })

  it('live 会话无工作区时报「会话无工作区」，不退化成冷读', async () => {
    const ctx = makeCtx({
      sessions: { get: () => ({ id: 'broken', header: {} }) },
      sessionQuery: makeRemoteQuery('broken', 'D:/should-not-be-used'),
    })
    expect(await resolveScope(ctx, 'broken')).toEqual({ err: SESSION_NO_WORKSPACE_ERROR })
  })

  it('无 sessionId 时不做冷读（冷读必须定点）', async () => {
    const query = makeRemoteQuery('remote-6', 'D:/never')
    const ctx = makeCtx({ sessions: { get: () => undefined, list: () => [] }, sessionQuery: query })
    expect(await resolveScope(ctx, undefined)).toEqual({ err: SESSION_MISSING_ERROR })
    expect(query.filterSessions).not.toHaveBeenCalled()
  })
})

describe('coldCwdOf', () => {
  it('同一会话只冷读一次（header.cwd 建会话后不可变）', async () => {
    const ctx = makeCtx({ sessionQuery: makeRemoteQuery('cache-1', 'D:/cached') })
    expect(await coldCwdOf(ctx, 'cache-1')).toBe('D:/cached')
    expect(await coldCwdOf(ctx, 'cache-1')).toBe('D:/cached')
    expect((ctx.get('sessionQuery') as { filterSessions: ReturnType<typeof vi.fn> }).filterSessions).toHaveBeenCalledTimes(1)
  })

  it('会话头缺 cwd 时返回 null', async () => {
    const ctx = makeCtx({ sessionQuery: { filterSessions: async () => [{ header: { id: 'no-cwd' } }] } })
    expect(await coldCwdOf(ctx, 'no-cwd')).toBeNull()
  })

  it('记录 id 不匹配时返回 null', async () => {
    const ctx = makeCtx({ sessionQuery: { filterSessions: async () => [{ header: { id: 'other', cwd: 'D:/other' } }] } })
    expect(await coldCwdOf(ctx, 'expected')).toBeNull()
  })
})

describe('resolveTargetIn', () => {
  it('按给定 cwd 解析相对路径，不依赖会话实例', async () => {
    const ctx = makeCtx({ fs: { resolve: async (path: string, opts: { cwd?: string }) => `${opts.cwd ?? ''}/${path}` } })
    expect(await resolveTargetIn(ctx, 'D:/remote', 'src/a.ts')).toBe('D:/remote/src/a.ts')
  })

  it('cwd 缺失时按当前目录解析（不抛错）', async () => {
    const ctx = makeCtx({ fs: { resolve: async (path: string) => path } })
    expect(await resolveTargetIn(ctx, '', 'src/a.ts')).toBe('src/a.ts')
  })

  it('冷读作用域的 cwd 可直接驱动路径解析（只读路径全链路）', async () => {
    const ctx = makeCtx({
      sessions: { get: () => undefined },
      sessionQuery: makeRemoteQuery('remote-7', 'D:/remote-repo'),
      fs: { resolve: async (path: string, opts: { cwd?: string }) => `${opts.cwd ?? ''}/${path}` },
    })
    const scope = await resolveScope(ctx, 'remote-7')
    expect('err' in scope).toBe(false)
    if ('err' in scope) return
    expect(await resolveTargetIn(ctx, scope.cwd, 'Assets/a.lua')).toBe('D:/remote-repo/Assets/a.lua')
  })
})
