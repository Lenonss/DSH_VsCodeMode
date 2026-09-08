/**
 * client/openFlow.ts 测试：路径匹配/最近会话/规则分派纯函数 + openDeepLink 编排（mock deps 全分支）。
 * 作者 ddj 2026-09-07
 */
import { describe, expect, it } from 'vitest'
import {
  containsPath,
  dirnameOf,
  matchWorkspaces,
  normPath,
  openDeepLink,
  pickRule,
  recentSession,
} from '../src/client/openFlow.js'
import type { OpenDeps, PathKind, SessionRow, WsView } from '../src/client/openFlow.js'

const WS_POP: WsView = { workspaceId: 'ws-pop', path: 'D:\\Work\\PopIsland', title: 'PopIsland', sessionIds: ['s-pop'], updatedAt: '2026-09-07T10:00:00Z' }

/** 编排测试的可观察状态 + mock deps。 */
interface MockState {
  ids: string[]
  byId: Record<string, SessionRow>
  items: WsView[]
  kinds: Record<string, PathKind>
  created: Array<{ workspaceId?: string; cwd?: string }>
  createdWs: string[]
  opened: string[]
  refs: Array<{ sessionId: string; path: string; appearance: string }>
  editors: Array<{ path: string | null; line?: number; column?: number }>
  notified: string[]
  chosenTitle: string | null
  choice: 'recent' | 'create' | null
  referenceOk: boolean
}

function makeDeps(state: MockState): OpenDeps {
  return {
    stat: async (p) => state.kinds[p] ?? 'missing',
    workspaces: () => ({ items: state.items, ready: true }),
    sessions: () => ({ ids: state.ids, byId: state.byId, ready: true }),
    createSession: async (opts) => {
      state.created.push(opts)
      return 's-new-' + state.created.length
    },
    createWorkspace: async (path) => {
      state.createdWs.push(path)
      const ws = { workspaceId: 'ws-new-' + state.createdWs.length, title: path }
      state.items.push({ ...ws, path, sessionIds: [] })
      return ws
    },
    openSession: (id) => state.opened.push(id),
    reference: async (sessionId, path, appearance) => {
      state.refs.push({ sessionId, path, appearance })
      return state.referenceOk
    },
    choose: async (title) => {
      state.chosenTitle = title
      return state.choice
    },
    openEditor: (path, line, column) => state.editors.push({ path, line, column }),
    schedule: (fn) => fn(),
    notify: (t) => state.notified.push(t),
  }
}

function baseState(): MockState {
  return {
    ids: [],
    byId: {},
    items: [{ ...WS_POP }],
    kinds: {},
    created: [],
    createdWs: [],
    opened: [],
    refs: [],
    editors: [],
    notified: [],
    chosenTitle: null,
    choice: null,
    referenceOk: true,
  }
}

describe('纯函数', () => {
  it('normPath / containsPath：分隔符归一 + 大小写不敏感 + 精确等于', () => {
    expect(normPath('D:\\Work\\PopIsland\\')).toBe('d:/work/popisland')
    expect(containsPath('D:\\Work\\PopIsland', 'd:/work/popisland/assets/scripts')).toBe(true)
    expect(containsPath('D:\\Work\\PopIsland', 'D:\\Work\\PopIsland')).toBe(true)
    expect(containsPath('D:\\Work\\PopIsland', 'D:\\Work\\PopIsland2')).toBe(false)
    expect(containsPath('D:\\Work\\PopIsland', 'D:\\Other')).toBe(false)
  })

  it('dirnameOf：剥最后一段；根回退自身', () => {
    expect(dirnameOf('D:\\Work\\PopIsland\\Assets\\Boot.lua')).toBe('D:\\Work\\PopIsland\\Assets')
    expect(dirnameOf('/home/u/proj/a.ts')).toBe('/home/u/proj')
    expect(dirnameOf('C:\\')).toBe('C:')
  })

  it('recentSession：排除子代理，updatedAt 最新优先', () => {
    const byId: Record<string, SessionRow> = {
      a: { id: 'a', updatedAt: 100 },
      b: { id: 'b', updatedAt: 300, origin: 'subagent' },
      c: { id: 'c', updatedAt: 200 },
    }
    expect(recentSession(byId, ['a', 'b', 'c'])?.id).toBe('c')
    expect(recentSession({}, [])).toBeUndefined()
  })

  it('matchWorkspaces / pickRule 分派表', () => {
    expect(matchWorkspaces([WS_POP], 'D:\\Work\\PopIsland\\Assets')).toEqual([WS_POP])
    expect(matchWorkspaces([WS_POP], 'D:\\Other')).toEqual([])
    expect(pickRule('directory', true, false)).toBe('choose')
    expect(pickRule('directory', false, true)).toBe('folderNew')
    expect(pickRule('file', false, true)).toBe('fileRecent')
    expect(pickRule('file', false, false)).toBe('bootstrap')
    expect(pickRule('missing', true, true)).toBe('abort')
  })
})

describe('openDeepLink 编排', () => {
  it('规则 1：工作区内文件夹 + 选「使用最近的工作区」→ 该工作区新建对话 + 文件夹引用 + 打开编辑页', async () => {
    const st = baseState()
    st.choice = 'recent'
    st.kinds['D:\\Work\\PopIsland\\Assets'] = 'directory'
    const deps = makeDeps(st)
    await openDeepLink({}, { paths: ['D:\\Work\\PopIsland\\Assets'] }, deps)
    expect(st.chosenTitle).toBe('PopIsland')
    expect(st.created).toEqual([{ workspaceId: 'ws-pop' }])
    expect(st.opened).toEqual(['s-new-1'])
    expect(st.refs).toEqual([{ sessionId: 's-new-1', path: 'D:\\Work\\PopIsland\\Assets', appearance: 'folder' }])
    expect(st.editors).toEqual([{ path: null }])
  })

  it('规则 1：弹窗取消 → 中止，不改任何状态', async () => {
    const st = baseState()
    st.choice = null
    st.kinds['D:\\Work\\PopIsland\\Assets'] = 'directory'
    await openDeepLink({}, { paths: ['D:\\Work\\PopIsland\\Assets'] }, makeDeps(st))
    expect(st.created).toEqual([])
    expect(st.refs).toEqual([])
    expect(st.editors).toEqual([])
  })

  it('规则 1：选「新建工作区」→ 以该文件夹注册并新建对话', async () => {
    const st = baseState()
    st.choice = 'create'
    st.kinds['D:\\Work\\PopIsland\\Assets'] = 'directory'
    await openDeepLink({}, { paths: ['D:\\Work\\PopIsland\\Assets'] }, makeDeps(st))
    expect(st.createdWs).toEqual(['D:\\Work\\PopIsland\\Assets'])
    expect(st.created).toEqual([{ workspaceId: 'ws-new-1' }])
  })

  it('规则 2：未命中工作区的文件夹 → 直接以该文件夹为根注册新工作区 + 新对话 + 引用（不弹窗）', async () => {
    const st = baseState()
    st.ids = ['s1', 's2']
    st.byId = {
      s1: { id: 's1', cwd: 'D:\\Work\\PopIsland\\IslandSplash_ZDev2', updatedAt: 100 },
      s2: { id: 's2', cwd: 'D:\\Work\\PopIsland\\IslandSplash_BugFix2', updatedAt: 500 },
    }
    // 镜像真实环境：已注册的是 ZDev2/BugFix2 项目根（PopIsland 根未注册）
    st.items = [
      { workspaceId: 'ws-z2', path: 'D:\\Work\\PopIsland\\IslandSplash_ZDev2', title: 'IslandSplash_ZDev2', sessionIds: ['s1'] },
      { workspaceId: 'ws-bf2', path: 'D:\\Work\\PopIsland\\IslandSplash_BugFix2', title: 'IslandSplash_BugFix2', sessionIds: ['s2'] },
    ]
    st.kinds['D:\\Work\\PopIsland\\IslandSplash_ZDev_Green\\Assets'] = 'directory'
    await openDeepLink({}, { paths: ['D:\\Work\\PopIsland\\IslandSplash_ZDev_Green\\Assets'] }, makeDeps(st))
    expect(st.chosenTitle).toBeNull()
    expect(st.createdWs).toEqual(['D:\\Work\\PopIsland\\IslandSplash_ZDev_Green\\Assets'])
    expect(st.created).toEqual([{ workspaceId: 'ws-new-1' }])
    expect(st.refs[0]?.appearance).toBe('folder')
    expect(st.refs[0]?.path).toBe('D:\\Work\\PopIsland\\IslandSplash_ZDev_Green\\Assets')
  })

  it('规则 2：无任何会话 → 同样以该文件夹注册新工作区', async () => {
    const st = baseState()
    st.kinds['D:\\Other\\Notes'] = 'directory'
    await openDeepLink({}, { paths: ['D:\\Other\\Notes'] }, makeDeps(st))
    expect(st.createdWs).toEqual(['D:\\Other\\Notes'])
    expect(st.refs[0]?.appearance).toBe('folder')
  })

  it('规则 3a：文件 + 已有会话 → 打开最近对话 + 编辑器展开（行列透传，不插引用）', async () => {
    const st = baseState()
    st.ids = ['s1', 's2']
    st.byId = { s1: { id: 's1', updatedAt: 100 }, s2: { id: 's2', updatedAt: 500 } }
    st.kinds['D:\\proj\\Boot.lua'] = 'file'
    await openDeepLink({}, { paths: ['D:\\proj\\Boot.lua'], line: 12, column: 3 }, makeDeps(st))
    expect(st.opened).toEqual(['s2'])
    expect(st.created).toEqual([])
    expect(st.refs).toEqual([])
    expect(st.editors).toEqual([{ path: 'D:\\proj\\Boot.lua', line: 12, column: 3 }])
  })

  it('规则 3a-亲和：文件位于已注册工作区内 → 打开该工作区最近会话（而非全局最近）', async () => {
    const st = baseState()
    st.ids = ['s-dev', 's-pop']
    st.byId = {
      's-dev': { id: 's-dev', cwd: 'D:\\Work\\ToolsDev\\x', updatedAt: 900 },
      's-pop': { id: 's-pop', cwd: 'D:\\Work\\PopIsland\\IslandSplash_BugFix2', updatedAt: 100 },
    }
    st.items = [
      { workspaceId: 'ws-dev', path: 'D:\\Work\\ToolsDev', title: 'dev', sessionIds: ['s-dev'] },
      { workspaceId: 'ws-pop', path: 'D:\\Work\\PopIsland\\IslandSplash_BugFix2', title: 'BugFix2', sessionIds: ['s-pop'] },
    ]
    st.kinds['D:\\Work\\PopIsland\\IslandSplash_BugFix2\\Foo.cs'] = 'file'
    await openDeepLink({}, { paths: ['D:\\Work\\PopIsland\\IslandSplash_BugFix2\\Foo.cs'] }, makeDeps(st))
    expect(st.opened).toEqual(['s-pop'])
    expect(st.refs).toEqual([])
    expect(st.editors).toEqual([{ path: 'D:\\Work\\PopIsland\\IslandSplash_BugFix2\\Foo.cs', line: undefined, column: undefined }])
  })

  it('规则 3a-亲和：文件所属工作区无会话 → 在该工作区新建会话 + 文件引用（其他工作区有会话也不串）', async () => {
    const st = baseState()
    st.ids = ['s-dev']
    st.byId = { 's-dev': { id: 's-dev', cwd: 'D:\\Work\\ToolsDev\\x', updatedAt: 900 } }
    st.items = [
      { workspaceId: 'ws-dev', path: 'D:\\Work\\ToolsDev', title: 'dev', sessionIds: ['s-dev'] },
      { workspaceId: 'ws-pop', path: 'D:\\Work\\PopIsland\\IslandSplash_BugFix2', title: 'BugFix2', sessionIds: [] },
    ]
    st.kinds['D:\\Work\\PopIsland\\IslandSplash_BugFix2\\Foo.cs'] = 'file'
    await openDeepLink({}, { paths: ['D:\\Work\\PopIsland\\IslandSplash_BugFix2\\Foo.cs'] }, makeDeps(st))
    expect(st.created).toEqual([{ workspaceId: 'ws-pop' }])
    expect(st.opened).toEqual(['s-new-1'])
    expect(st.refs).toEqual([{ sessionId: 's-new-1', path: 'D:\\Work\\PopIsland\\IslandSplash_BugFix2\\Foo.cs', appearance: 'file' }])
    expect(st.editors).toEqual([{ path: 'D:\\Work\\PopIsland\\IslandSplash_BugFix2\\Foo.cs', line: undefined, column: undefined }])
  })

  it('规则 3b：文件 + 无任何会话 → 父目录注册工作区 + 新对话 + 文件引用 + 编辑器打开', async () => {
    const st = baseState()
    st.kinds['D:\\proj\\Boot.lua'] = 'file'
    await openDeepLink({}, { paths: ['D:\\proj\\Boot.lua'] }, makeDeps(st))
    expect(st.createdWs).toEqual(['D:\\proj'])
    expect(st.created).toEqual([{ workspaceId: 'ws-new-1' }])
    expect(st.refs).toEqual([{ sessionId: 's-new-1', path: 'D:\\proj\\Boot.lua', appearance: 'file' }])
    expect(st.editors).toEqual([{ path: 'D:\\proj\\Boot.lua', line: undefined, column: undefined }])
  })

  it('多路径：首文件驱动规则，其余文件进编辑器、文件夹补引用', async () => {
    const st = baseState()
    st.ids = ['s1']
    st.byId = { s1: { id: 's1', updatedAt: 100 } }
    st.kinds = {
      'D:\\proj\\a.lua': 'file',
      'D:\\proj\\b.lua': 'file',
      'D:\\proj\\assets': 'directory',
    }
    await openDeepLink({}, { paths: ['D:\\proj\\a.lua', 'D:\\proj\\b.lua', 'D:\\proj\\assets'] }, makeDeps(st))
    expect(st.opened).toEqual(['s1'])
    expect(st.refs.map((r) => r.path)).toEqual(['D:\\proj\\assets'])
    expect(st.editors.map((e) => e.path)).toEqual(['D:\\proj\\a.lua', 'D:\\proj\\b.lua'])
  })

  it('路径缺失 → 通知并中止', async () => {
    const st = baseState()
    st.kinds['D:\\gone'] = 'missing'
    await openDeepLink({}, { paths: ['D:\\gone'] }, makeDeps(st))
    expect(st.notified).toHaveLength(1)
    expect(st.created).toEqual([])
  })
})
