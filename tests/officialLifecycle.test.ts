import { describe, expect, it, vi } from 'vitest'
import { installCapture } from '../src/officialCapture.js'
import { repairPaths, saveSnapshot } from '../src/reviewDb.js'
import type { Ctx } from '../src/store.js'
vi.mock('../src/reviewDb.js', () => ({ saveSnapshot: vi.fn(() => true), captureState: vi.fn(), repairPaths: vi.fn(async () => {}) }))
vi.mock('../src/store.js', () => ({ loadBucket: vi.fn(async () => new Map()) }))
vi.mock('../src/log.js', () => ({ log: { warn: vi.fn() } }))

describe('official host lifecycle adapter', () => {
  it('subscribes before startup replay, excludes inherited events and drains before returning cleanup', async () => {
    const hooks = new Map<string, (...args: any[]) => any>()
    const order: string[] = []
    const session = { id: 'fork', inheritedEventCount: 1, header: { cwd: '/original' } }
    const event = { type: 'workspace/changes', seq: 1, data: { turn: 2 } }
    const query = {
      filterEvents: vi.fn(async () => []), // Official semantic projection excludes structural events.
      listEvents: vi.fn(async () => [{ seq: 0, type: 'workspace/changes' }, { seq: 1, type: 'workspace/changes' }, { seq: 2, type: 'user/message' }]),
      readEvent: vi.fn(async () => ({ target: event })),
    }
    const source = { summary: vi.fn(() => ({ turn: 2, cwd: '/after-cd', files: [], total: 0, added: 0, deleted: 0 })), diff: vi.fn() }
    const services = { sessions: { list: () => { order.push('list'); return [session] } },
      sessionQuery: query, workspaceChanges: source, fs: { resolve: vi.fn() } }
    const ctx = { on: (name: string, callback: (...args: any[]) => any) => { order.push(name); hooks.set(name, callback) },
      get: (name: keyof typeof services) => services[name] } as unknown as Ctx
    const dispose = installCapture(ctx)
    await vi.waitFor(() => expect(query.readEvent).toHaveBeenCalledTimes(1))
    await hooks.get('session/flush')!(session)
    // Completed-event replay is allowed; the durable source key is idempotent.
    hooks.get('session/event')!(session, event)
    await hooks.get('session/flush')!(session)
    expect(order.indexOf('session/event')).toBeLessThan(order.indexOf('list'))
    expect(repairPaths).toHaveBeenCalledWith('/original', expect.any(Function))
    expect(query.listEvents).toHaveBeenCalledWith('fork')
    expect(query.filterEvents).not.toHaveBeenCalled()
    expect(saveSnapshot).toHaveBeenCalledTimes(2)
    expect(saveSnapshot).toHaveBeenLastCalledWith('/after-cd', expect.objectContaining({ sessionId: 'fork', seq: 1 }))
    await dispose()
    hooks.get('session/event')!(session, { ...event, seq: 2 })
    await hooks.get('session/flush')!(session)
    expect(saveSnapshot).toHaveBeenCalledTimes(2)
  })
  it('repairs persisted paths even when cold history has no recoverable official events', async () => {
    vi.mocked(repairPaths).mockClear()
    const session = { id: 'cold', header: { cwd: '/cold' } }
    const query = { listEvents: vi.fn(async () => []), readEvent: vi.fn() }
    const source = { summary: vi.fn(() => undefined), diff: vi.fn() }
    const services = { sessions: { list: () => [session] }, sessionQuery: query, workspaceChanges: source }
    const ctx = { on: vi.fn(), get: (name: keyof typeof services) => services[name] } as unknown as Ctx
    const dispose = installCapture(ctx)
    await vi.waitFor(() => expect(query.listEvents).toHaveBeenCalledWith('cold'))
    expect(repairPaths).toHaveBeenCalledWith('/cold', expect.any(Function))
    expect(source.summary).not.toHaveBeenCalled()
    expect(query.readEvent).not.toHaveBeenCalled()
    await dispose()
  })
  it('uses backend process paths for multiple opaque targets, not object strings or opaque keys', async () => {
    vi.mocked(saveSnapshot).mockClear()
    const hooks = new Map<string, (...args: any[]) => any>()
    const paths = ['a.ts', 'b.ts']
    const session = { id: 'multi', header: { cwd: '/ws' } }
    const source = {
      summary: () => ({ turn: 9, cwd: '/ws', total: 2, added: 2, deleted: 0,
        files: paths.map((path) => ({ path, display: path, added: 1, deleted: 0 })) }),
      diff: async (_session: string, _seq: number, index: number) => ({ kind: 'binary', path: paths[index], display: paths[index] }),
    }
    const fs = { resolve: vi.fn(async (path: string) => ({ targetKey: 'opaque:' + path, displayPath: path })),
      processPath: vi.fn((target: { displayPath: string }) => '/ws/' + target.displayPath) }
    const services = { sessions: { list: () => [] }, workspaceChanges: source, fs }
    const ctx = { on: (name: string, callback: (...args: any[]) => any) => hooks.set(name, callback),
      get: (name: keyof typeof services) => services[name] } as unknown as Ctx
    const dispose = installCapture(ctx)
    hooks.get('session/event')!(session, { type: 'workspace/changes', seq: 9, data: { turn: 9 } })
    await hooks.get('session/flush')!()
    expect(saveSnapshot).toHaveBeenCalledTimes(1)
    const captured = vi.mocked(saveSnapshot).mock.calls[0][1]
    expect(captured.files.map((file) => file.identity)).toEqual(['/ws/a.ts', '/ws/b.ts'])
    expect(fs.processPath).toHaveBeenCalledTimes(2)
    await dispose()
  })
})
