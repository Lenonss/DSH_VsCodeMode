/** 官方 mcpManager 托管层：命名、需求计数、配置变更与失败隔离。@author ddj 2026年11月23号 */
import { describe, expect, it, vi } from 'vitest'
import { ManagedProject, managedName, type ManagedDef } from '../src/mcpManaged.js'
import type { ManagerEntry, ManagerPort, ManagerView } from '../src/mcpManagerBridge.js'
import type { MpcConfig } from '../src/shared/mcp.js'

/** 一个 stdio 项目定义；参数用于造配置变更。 */
function defOf(command = 'node', extra: Partial<ManagedDef> = {}): ManagedDef {
  const config: MpcConfig = { serverName: 'demo', transport: 'stdio', command, args: [], env: {}, cwd: '' }
  return { config, enabled: true, ...extra }
}

/** 记账用的 manager 端口桩：注册/注销/重启都留痕。 */
function portOf(options: { views?: ManagerView[]; failRegister?: boolean; frames?: ManagerView[][] } = {}) {
  const calls: string[] = []
  const entries: ManagerEntry[] = []
  const port: ManagerPort = {
    available: () => true,
    register: (name, entry) => {
      if (options.failRegister) throw new Error('server "' + name + '" is already configured or registered')
      calls.push('register:' + name)
      entries.push(entry)
      return () => calls.push('dispose:' + name)
    },
    list: () => options.views ?? [],
    watch: async function* () {
      for (const frame of options.frames ?? []) yield frame
    },
    restart: async (name) => { calls.push('restart:' + name) },
    probe: async () => ({}),
    authorize: async () => ({}),
    cancelAuthorize: async () => {},
    signOut: async () => {},
  }
  return { port, calls, entries }
}

/** 只实现 get 的宿主上下文桩：托管层只用到 emit 与 logger。 */
function ctxOf() {
  const warns: string[] = []
  return { ctx: { get: () => undefined, emit: vi.fn(), logger: { warn: (message: string) => warns.push(message) } }, warns }
}

/** 等托管层的状态流跑完一轮微任务。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('managedName', () => {
  it('prefixes the workspace hash and stays inside the official name pattern', () => {
    const name = managedName('C:/w/alpha', 'demo')
    expect(name).toMatch(/^[0-9a-f]{8}-demo$/)
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })

  it('separates the same server name across workspaces and truncates long names', () => {
    expect(managedName('C:/w/alpha', 'demo')).not.toBe(managedName('C:/w/beta', 'demo'))
    const long = managedName('C:/w/alpha', 'x'.repeat(40))
    expect(long.length).toBe(32)
    expect(long).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })

  it('sanitizes characters the official name pattern rejects', () => {
    expect(managedName('C:/w/alpha', 'my server.v2')).toMatch(/^[0-9a-f]{8}-my-server-v2$/)
  })
})

describe('ManagedProject 注册生命周期', () => {
  it('registers once on the first hold and disposes after the last release', () => {
    const { ctx } = ctxOf()
    const { port, calls } = portOf()
    const managed = new ManagedProject(ctx, port)
    const name = managedName('C:/w/alpha', 'demo')

    managed.sync('C:/w/alpha', new Map([['demo', defOf()]]))
    expect(calls).toEqual([])

    const first = managed.hold('C:/w/alpha', 'demo')
    const second = managed.hold('C:/w/alpha', 'demo')
    expect(calls).toEqual(['register:' + name])

    first()
    expect(calls).toEqual(['register:' + name])
    second()
    expect(calls).toEqual(['register:' + name, 'dispose:' + name])
  })

  it('registers with on-demand tool loading and no oauth for stdio', () => {
    const { ctx } = ctxOf()
    const { port, entries } = portOf()
    const managed = new ManagedProject(ctx, port)
    managed.sync('C:/w/alpha', new Map([['demo', defOf()]]))
    managed.hold('C:/w/alpha', 'demo')

    expect(entries[0].transport).toBe('stdio')
    expect(entries[0].toolLoading).toBe('on-demand')
    expect(entries[0].oauth).toBeUndefined()
  })

  it('does nothing for a disabled or unknown definition', () => {
    const { ctx } = ctxOf()
    const { port, calls } = portOf()
    const managed = new ManagedProject(ctx, port)
    managed.sync('C:/w/alpha', new Map([['demo', defOf('node', { enabled: false })]]))
    managed.hold('C:/w/alpha', 'demo')()
    managed.hold('C:/w/alpha', 'missing')()
    expect(calls).toEqual([])
  })

  it('re-registers when the definition changes and unregisters when it is removed', () => {
    const { ctx } = ctxOf()
    const { port, calls } = portOf()
    const managed = new ManagedProject(ctx, port)
    const name = managedName('C:/w/alpha', 'demo')

    managed.sync('C:/w/alpha', new Map([['demo', defOf()]]))
    managed.hold('C:/w/alpha', 'demo')
    managed.sync('C:/w/alpha', new Map([['demo', defOf('deno')]]))
    expect(calls).toEqual(['register:' + name, 'dispose:' + name, 'register:' + name])

    managed.sync('C:/w/alpha', new Map())
    expect(calls).toEqual(['register:' + name, 'dispose:' + name, 'register:' + name, 'dispose:' + name])
  })

  it('skips a name the official settings page already owns', () => {
    const { ctx, warns } = ctxOf()
    const name = managedName('C:/w/alpha', 'demo')
    const { port, calls } = portOf({ views: [{ name, configured: true, state: 'connected' }] })
    const managed = new ManagedProject(ctx, port)

    managed.sync('C:/w/alpha', new Map([['demo', defOf()]]))
    managed.hold('C:/w/alpha', 'demo')

    expect(calls).toEqual([])
    expect(managed.stateOf('C:/w/alpha', 'demo').state).toBe('failed')
    expect(warns.some((message) => message.includes('占用'))).toBe(true)
  })

  it('turns a rejected register into a visible state instead of throwing', () => {
    const { ctx } = ctxOf()
    const { port } = portOf({ failRegister: true })
    const managed = new ManagedProject(ctx, port)
    managed.sync('C:/w/alpha', new Map([['demo', defOf()]]))

    expect(() => managed.hold('C:/w/alpha', 'demo')).not.toThrow()
    const state = managed.stateOf('C:/w/alpha', 'demo')
    expect(state.state).toBe('failed')
    expect(state.error).toContain('托管注册失败')
  })
})

describe('ManagedProject 状态与重启', () => {
  it('caches official views and exposes phase, then restarts by name', async () => {
    const { ctx } = ctxOf()
    const name = managedName('C:/w/alpha', 'demo')
    const { port, calls } = portOf({ frames: [[{ name, configured: true, state: 'connected', phase: 'authorizing' }]] })
    const managed = new ManagedProject(ctx, port)
    managed.sync('C:/w/alpha', new Map([['demo', defOf()]]))
    managed.hold('C:/w/alpha', 'demo')

    managed.start()
    await tick()
    expect(managed.stateOf('C:/w/alpha', 'demo')).toEqual({ state: 'connected', phase: 'authorizing' })

    await managed.refresh('C:/w/alpha', 'demo')
    await managed.refresh('C:/w/alpha', 'missing')
    expect(calls.filter((call) => call.startsWith('restart:'))).toEqual(['restart:' + name])
  })

  it('reports idle before the first hold and unknown while unregistered', () => {
    const { ctx } = ctxOf()
    const { port } = portOf()
    const managed = new ManagedProject(ctx, port)
    managed.sync('C:/w/alpha', new Map([['demo', defOf()]]))
    // 没注册 ≠ 禁用：面板要按「已配置、按需」显示，不能谎报禁用。
    expect(managed.stateOf('C:/w/alpha', 'demo').state).toBe('idle')
  })

  it('exposes owned names for isolation and clears them on dispose', async () => {
    const { ctx } = ctxOf()
    const { port, calls } = portOf()
    const managed = new ManagedProject(ctx, port)
    const name = managedName('C:/w/alpha', 'demo')
    managed.sync('C:/w/alpha', new Map([['demo', defOf()]]))
    managed.hold('C:/w/alpha', 'demo')

    expect(managed.ownedNames()).toEqual(new Map([[name, 'C:/w/alpha']]))
    await managed.dispose()
    expect(managed.ownedNames().size).toBe(0)
    expect(calls).toContain('dispose:' + name)
  })
})
