/** remote.session 文件链接路由测试（DSH 0.1.3+）：补丁拦截 / 透传回退 / 恢复。作者 ddj 2026年09月08号 */
import { describe, expect, it } from 'vitest'
import { createFileOpenerRegistry } from '../src/client/fileOpeners.js'
import { openOriginal, patchRemoteOpen, probeRemoteOpen } from '../src/client/remoteOpenRouter.js'

/** 复刻 DSH 0.1.3+ remote.session 形态：openWorkspacePath 为 getter-only accessor。 */
function makeRemoteService(originalLogs) {
  const service = {}
  Object.defineProperty(service, 'openWorkspacePath', {
    configurable: true,
    enumerable: true,
    get: () => async (request) => {
      originalLogs.push(request.path)
      return { ok: true, value: { opened: true } }
    },
  })
  return service
}

const deps = (registry, selected = 'auto') => ({
  registry,
  selected: () => selected,
  context: () => ({ sessionId: 's1', cwd: 'D:/ws' }),
})

describe('probeRemoteOpen', () => {
  it('命中 remote.session 且方法存在时返回服务实例', () => {
    const service = makeRemoteService([])
    const ctx = { get: (name) => (name === 'remote.session' ? service : undefined) }
    expect(probeRemoteOpen(ctx)).toBe(service)
  })

  it('namespace 缺失返回 undefined', () => {
    expect(probeRemoteOpen({ get: () => undefined })).toBeUndefined()
  })

  it('方法缺失返回 undefined（旧版 DSH 的 session namespace 形态不同）', () => {
    expect(probeRemoteOpen({ get: () => ({}) })).toBeUndefined()
  })

  it('get 抛错安全返回 undefined', () => {
    expect(probeRemoteOpen({ get: () => { throw new Error('old dsh') } })).toBeUndefined()
  })
})

describe('patchRemoteOpen', () => {
  it('原始桥保留receiver并绕过路由，action/application原样透传', async () => {
    const requests: unknown[] = []
    const service = {
      /** @public @author ddj 2026年10月28号 @param request Official request. @returns Successful native handoff. */
      async openWorkspacePath(request: unknown) {
        expect(this).toBe(service)
        requests.push(request)
        return { ok: true, value: { opened: true } }
      },
    }
    const registry = createFileOpenerRegistry()
    registry.register({ id: 'trap', label: 'trap', priority: 100, open: () => { throw new Error('不得路由原生动作') } })
    const dispose = patchRemoteOpen(service, deps(registry))!
    const reveal = { path: '中文 空格.xlsx', action: 'reveal' as const }
    const application = { path: '中文 空格.xlsx', application: 'excel' }
    await service.openWorkspacePath(reveal)
    await service.openWorkspacePath(application)
    await openOriginal({ path: '中文 空格.xlsx' })
    expect(requests).toEqual([reveal, application, { path: 'D:/ws/中文 空格.xlsx' }])
    dispose()
    await expect(openOriginal({ path: 'a.xlsx' })).rejects.toThrow('官方系统打开能力不可用')
  })

  it('原件打开按所属工作区解析路径且保留官方失败原因', async () => {
    const requests: unknown[] = []
    const service = {
      /** @public @author ddj 2026年10月28号 @param request Host request. @returns Real Remote failure shape. */
      async openWorkspacePath(request: unknown) {
        requests.push(request)
        return { ok: false, error: { code: 'gateway/bad-request', message: 'Path has no verified Host path' } }
      },
    }
    const dispose = patchRemoteOpen(service, deps(createFileOpenerRegistry()))!
    try {
      await expect(openOriginal({ path: 'Assets/状态表.xlsx' }, '/project')).rejects.toThrow('gateway/bad-request: Path has no verified Host path')
      await expect(openOriginal({ path: '/absolute/状态表.xlsx', application: 'excel' }, '/project')).rejects.toThrow('Path has no verified Host path')
      expect(requests).toEqual([{ path: '/project/Assets/状态表.xlsx' }, { path: '/absolute/状态表.xlsx', application: 'excel' }])
    } finally { dispose() }
  })

  it('没有绝对工作区时拒绝把相对路径交给Host进程', async () => {
    const originalLogs = []
    const service = makeRemoteService(originalLogs)
    const dispose = patchRemoteOpen(service, { ...deps(createFileOpenerRegistry()), context: () => ({}) })!
    try {
      await expect(openOriginal({ path: 'Assets/状态表.xlsx' })).rejects.toThrow('Host 绝对路径')
      expect(originalLogs).toEqual([])
    } finally { dispose() }
  })

  it('卸载不覆盖后来安装的补丁', () => {
    const service = makeRemoteService([])
    const dispose = patchRemoteOpen(service, deps(createFileOpenerRegistry()))!
    const later = async () => ({ ok: true })
    Object.defineProperty(service, 'openWorkspacePath', { configurable: true, value: later })
    dispose()
    expect(service.openWorkspacePath).toBe(later)
  })

  it('插件打开器优先接管并返回成功结果', async () => {
    const originalLogs = []
    const service = makeRemoteService(originalLogs)
    const registry = createFileOpenerRegistry()
    const opened = []
    registry.register({ id: 'test', label: 'test', priority: 100, open: (path) => { opened.push(path) } })
    const dispose = patchRemoteOpen(service, deps(registry))
    const result = await service.openWorkspacePath({ path: 'src/a.ts' })
    expect(result).toEqual({ ok: true, value: { opened: true } })
    expect(opened).toEqual(['src/a.ts'])
    expect(originalLogs).toEqual([])
    dispose()
  })

  it('路径 "."（打开工作区文件夹）透传原实现', async () => {
    const originalLogs = []
    const service = makeRemoteService(originalLogs)
    const registry = createFileOpenerRegistry()
    const opened = []
    registry.register({ id: 'test', label: 'test', priority: 100, open: (path) => { opened.push(path) } })
    patchRemoteOpen(service, deps(registry))
    await service.openWorkspacePath({ path: '.' })
    expect(originalLogs).toEqual(['.'])
    expect(opened).toEqual([])
  })

  it('无可用打开器时透传原实现', async () => {
    const originalLogs = []
    const service = makeRemoteService(originalLogs)
    patchRemoteOpen(service, deps(createFileOpenerRegistry()))
    await service.openWorkspacePath({ path: 'src/a.ts' })
    expect(originalLogs).toEqual(['src/a.ts'])
  })

  it('打开器失败回退原实现并记录日志', async () => {
    const originalLogs = []
    const service = makeRemoteService(originalLogs)
    const registry = createFileOpenerRegistry()
    registry.register({ id: 'bad', label: 'bad', priority: 100, open: () => { throw new Error('boom') } })
    const logs = []
    patchRemoteOpen(service, { ...deps(registry), logger: (m) => logs.push(m) })
    await service.openWorkspacePath({ path: 'src/a.ts' })
    expect(originalLogs).toEqual(['src/a.ts'])
    expect(logs.some((m) => m.includes('bad'))).toBe(true)
  })

  it('selected=system 经注册表走系统打开器', async () => {
    const originalLogs = []
    const service = makeRemoteService(originalLogs)
    const registry = createFileOpenerRegistry()
    const opened = []
    registry.register({ id: 'test', label: 'test', priority: 100, open: (path) => { opened.push(path) } })
    registry.register({ id: 'system', label: '系统', priority: 0, open: (path) => { opened.push('system:' + path) } })
    patchRemoteOpen(service, deps(registry, 'system'))
    await service.openWorkspacePath({ path: 'src/a.ts' })
    expect(opened).toEqual(['system:src/a.ts'])
    expect(originalLogs).toEqual([])
  })

  it('dispose 恢复原 accessor（幂等，恢复后走原实现）', async () => {
    const originalLogs = []
    const service = makeRemoteService(originalLogs)
    const originalDescriptor = Object.getOwnPropertyDescriptor(service, 'openWorkspacePath')
    const dispose = patchRemoteOpen(service, deps(createFileOpenerRegistry()))
    dispose()
    dispose()
    expect(Object.getOwnPropertyDescriptor(service, 'openWorkspacePath').get).toBe(originalDescriptor.get)
    await service.openWorkspacePath({ path: 'b.ts' })
    expect(originalLogs).toEqual(['b.ts'])
  })
})
