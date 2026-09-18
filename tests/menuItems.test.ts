/**
 * client sidebar/menuItems.ts 内置菜单项测试。
 * 覆盖：默认项结构与排序、新增「添加引用到对话」的文件/文件夹分派、
 * 忙态/不可用降级、visible 守卫（空路径/无会话/动作集缺失）、
 * SVN 组显隐（managed/svnCli/tortoise × 文件/目录/根）与 P2 CLI 三项的状态矩阵。
 * 作者 ddj 2026-09-03 / 2026-09-16
 */
import { describe, expect, it, vi } from 'vitest'
import { createDefaultFileMenuItems } from '../src/client/sidebar/menuItems.js'
import type { TreeMenuItem } from '../src/client/sidebar/contextMenu.js'
import type { SidebarCtx } from '../src/client/sidebar/types.js'
import type { SvnChangeEntry, SvnStatusPayload } from '../src/shared/svn.js'

/** 按 id 索引内置菜单项。 */
const byId = (): Record<string, TreeMenuItem> =>
  Object.fromEntries(createDefaultFileMenuItems().map((item) => [item.id, item]))

/** SVN 状态构造（缺省：受管理 + CLI/Tortoise 全可用）。 */
const svnOn = (over: Partial<SvnStatusPayload> = {}): SvnStatusPayload => ({
  managed: true,
  wcRoot: '/wc',
  svnCli: true,
  tortoise: true,
  svnPath: 'svn',
  tortoiseExe: 'C:\\T\\TortoiseProc.exe',
  ...over,
})

/** 假「添加到对话」动作集：appendReference 记录调用并返回可配置结果。 */
const makeAdd = (outcome = 'ok') => ({
  appendReference: vi.fn(() => Promise.resolve(outcome)),
})

/** 构造假 ctx（缺省 sessionId=s1、带动作集与 notify spy）；传 null 表示动作集缺失。 */
const makeCtx = (add: ReturnType<typeof makeAdd> | null = makeAdd(), overrides = {}) =>
  Object.assign(
    { sessionId: 's1', addToConversation: add == null ? undefined : add, notify: vi.fn() },
    overrides,
  ) as unknown as SidebarCtx

describe('createDefaultFileMenuItems', () => {
  it('内置项按 order 排序：浏览器打开 → 引用到对话 → SVN 组（树入口：CLI 四项 + 查看日志 + Tortoise 五项）', () => {
    const items = createDefaultFileMenuItems()
    expect(items.map((item) => item.id)).toEqual([
      'reveal-in-explorer',
      'add-to-conversation',
      'svn-update',
      'svn-diff-base',
      'svn-add',
      'svn-revert-cli',
      'svn-log',
      'svn-tortoise-commit',
      'svn-tortoise-log',
      'svn-tortoise-diff',
      'svn-tortoise-blame',
      'svn-tortoise-revert',
    ])
    expect(items[1]).toMatchObject({ id: 'add-to-conversation', label: '添加引用到对话', order: 1 })
  })

  it('文件目标：以 file 外观追加引用并提示「已添加文件引用」', async () => {
    const add = makeAdd('ok')
    const notify = vi.fn()
    const ctx = makeCtx(add, { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(add.appendReference).toHaveBeenCalledWith('s1', 'src/index.ts', undefined, 'file')
    expect(notify).toHaveBeenCalledWith('已添加文件引用')
  })

  it('目录目标：以 folder 外观追加引用并提示「已添加文件夹引用」', async () => {
    const add = makeAdd('ok')
    const notify = vi.fn()
    const ctx = makeCtx(add, { notify })
    byId()['add-to-conversation'].run({ path: 'src/components', type: 'directory' }, ctx)
    await Promise.resolve()
    expect(add.appendReference).toHaveBeenCalledWith('s1', 'src/components', undefined, 'folder')
    expect(notify).toHaveBeenCalledWith('已添加文件夹引用')
  })

  it('忙态：提示已降级纯文本', async () => {
    const notify = vi.fn()
    const ctx = makeCtx(makeAdd('busy'), { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(notify).toHaveBeenCalledWith('已添加文件引用（已降级纯文本）')
  })

  it('两条通道都失败：提示重试（内容未被改动）', async () => {
    const notify = vi.fn()
    const ctx = makeCtx(makeAdd('failed'), { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(notify).toHaveBeenCalledWith('添加引用失败（输入框忙或未就绪，请重试）')
  })

  it('不可用：提示无法添加到对话', async () => {
    const notify = vi.fn()
    const ctx = makeCtx(makeAdd('unavailable'), { notify })
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    await Promise.resolve()
    expect(notify).toHaveBeenCalledWith('无法添加到对话（无会话或输入框不可用）')
  })

  it('动作集缺失：notify 提示不可用且不调用 appendReference', () => {
    const ctx = makeCtx(null)
    byId()['add-to-conversation'].run({ path: 'src/index.ts', type: 'file' }, ctx)
    expect(ctx.notify).toHaveBeenCalledWith('添加到对话不可用')
  })

  it('visible 守卫：空路径/无会话/动作集缺失隐藏，正常目标显示', () => {
    const item = byId()['add-to-conversation']
    expect(item.visible({ path: '', type: 'directory' }, makeCtx())).toBe(false)
    expect(item.visible({ path: 'src', type: 'directory' }, makeCtx(null))).toBe(false)
    expect(item.visible({ path: 'src', type: 'directory' }, makeCtx(null, { sessionId: undefined }))).toBe(false)
    expect(item.visible({ path: 'src', type: 'directory' }, makeCtx())).toBe(true)
  })
})

describe('SVN 组显隐（动态能力守卫）', () => {
  const svnCtx = (over: Partial<SvnStatusPayload> = {}, base = {}): SidebarCtx =>
    makeCtx(makeAdd(), { ...base, svn: svnOn(over) })

  it('未加载/未检出/CLI 不可用时「SVN 更新」隐藏', () => {
    const item = byId()['svn-update']
    expect(item.visible({ path: 'src/a.ts', type: 'file' }, makeCtx())).toBe(false)
    expect(item.visible({ path: 'src/a.ts', type: 'file' }, svnCtx({ managed: false }))).toBe(false)
    expect(item.visible({ path: 'src/a.ts', type: 'file' }, svnCtx({ svnCli: false }))).toBe(false)
    expect(item.visible({ path: 'src/a.ts', type: 'file' }, svnCtx())).toBe(true)
  })

  it('「SVN 更新」对文件/目录/根空白区都可用', () => {
    const item = byId()['svn-update']
    expect(item.visible({ path: '', type: 'directory' }, svnCtx())).toBe(true)
    expect(item.visible({ path: 'src', type: 'directory' }, svnCtx())).toBe(true)
    expect(item.visible({ path: 'src/a.ts', type: 'file' }, svnCtx())).toBe(true)
  })

  it('Tortoise 组在 TortoiseProc 不可用时整组隐藏', () => {
    for (const id of ['svn-tortoise-commit', 'svn-tortoise-log', 'svn-tortoise-diff', 'svn-tortoise-blame', 'svn-tortoise-revert']) {
      expect(byId()[id].visible({ path: 'src/a.ts', type: 'file' }, svnCtx({ tortoise: false }))).toBe(false)
      expect(byId()[id].visible({ path: 'src/a.ts', type: 'file' }, svnCtx())).toBe(true)
    }
  })

  it('Tortoise 差异/追溯仅对文件显示；日志/还原不含根空白区', () => {
    const dir = { path: 'src', type: 'directory' } as const
    const file = { path: 'src/a.ts', type: 'file' } as const
    const root = { path: '', type: 'directory' } as const
    expect(byId()['svn-tortoise-diff'].visible(dir, svnCtx())).toBe(false)
    expect(byId()['svn-tortoise-blame'].visible(dir, svnCtx())).toBe(false)
    expect(byId()['svn-tortoise-diff'].visible(file, svnCtx())).toBe(true)
    expect(byId()['svn-tortoise-blame'].visible(file, svnCtx())).toBe(true)
    expect(byId()['svn-tortoise-log'].visible(root, svnCtx())).toBe(false)
    expect(byId()['svn-tortoise-revert'].visible(root, svnCtx())).toBe(false)
    expect(byId()['svn-tortoise-log'].visible(dir, svnCtx())).toBe(true)
    expect(byId()['svn-tortoise-revert'].visible(dir, svnCtx())).toBe(true)
  })

  it('「查看日志」：受版本控制的目标可用（文件/目录）；未纳入版本控制的文件不可用', () => {
    const log = byId()['svn-log']
    const unversioned: SvnChangeEntry = { path: 'src/new.ts', status: 'unversioned', versioned: false }
    const withEntry = (entry: SvnChangeEntry): SidebarCtx => makeCtx(makeAdd(), {
      svn: svnOn(),
      svnChanges: [entry],
      svnChangeMap: { [entry.path]: entry },
    })
    expect(log.visible({ path: 'src/a.ts', type: 'file' }, svnCtx())).toBe(true)
    expect(log.visible({ path: 'src', type: 'directory' }, svnCtx())).toBe(true)
    // 未纳入版本控制的文件没有日志
    expect(log.visible({ path: 'src/new.ts', type: 'file' }, withEntry(unversioned))).toBe(false)
  })

  it('「清理工作副本」仅出现在命令栏（不在树/页签菜单）', () => {
    const ids = createDefaultFileMenuItems().map((item) => item.id)
    expect(ids).not.toContain('svn-cleanup')
    expect(ids).toContain('svn-log')
  })

  it('Tortoise 提交对根空白区可用（等价 Commit Workspace）', () => {
    expect(byId()['svn-tortoise-commit'].visible({ path: '', type: 'directory' }, svnCtx())).toBe(true)
  })

  it('Tortoise 还原条目带 danger 标记', () => {
    expect(byId()['svn-tortoise-revert'].danger).toBe(true)
    expect(byId()['svn-tortoise-commit'].separator).toBe(true)
  })
})

describe('SVN CLI 三项（与基线比较 / 加入版本控制 / 还原）状态矩阵', () => {
  /** 构造带变更清单的 ctx（changeMap 派生自 entries）。 */
  const cliCtx = (entries: SvnChangeEntry[] = [], over: Partial<SvnStatusPayload> = {}): SidebarCtx => {
    const svn = svnOn(over)
    const svnChangeMap: Record<string, SvnChangeEntry> = {}
    for (const entry of entries) if (!(entry.path in svnChangeMap)) svnChangeMap[entry.path] = entry
    return makeCtx(makeAdd(), { svn, svnChanges: entries, svnChangeMap, openSvnDiff: vi.fn(), refreshSvnChanges: vi.fn() })
  }
  const modified: SvnChangeEntry = { path: 'src/a.ts', status: 'modified', versioned: true }
  const unversioned: SvnChangeEntry = { path: 'src/new.ts', status: 'unversioned', versioned: false }
  const conflicted: SvnChangeEntry = { path: 'src/c.ts', status: 'conflicted', versioned: true }
  const file = { path: 'src/a.ts', type: 'file' } as const
  const newFile = { path: 'src/new.ts', type: 'file' } as const
  const dir = { path: 'src', type: 'directory' } as const

  it('「与基线比较」：仅文本文件 + 受版本控制时显示（未版本控制/二进制/目录/根不显示）', () => {
    const item = byId()['svn-diff-base']
    expect(item.visible(file, cliCtx([modified]))).toBe(true)
    expect(item.visible(newFile, cliCtx([unversioned]))).toBe(false)
    expect(item.visible({ path: 'img/logo.png', type: 'file' }, cliCtx([]))).toBe(false)
    expect(item.visible(dir, cliCtx([modified]))).toBe(false)
    expect(item.visible({ path: '', type: 'directory' }, cliCtx([]))).toBe(false)
    // 未受管理时整组不显示
    expect(item.visible(file, cliCtx([modified], { managed: false }))).toBe(false)
  })

  it('「加入版本控制」：仅未纳入版本控制的目标显示', () => {
    const item = byId()['svn-add']
    expect(item.visible(newFile, cliCtx([unversioned]))).toBe(true)
    expect(item.visible(dir, cliCtx([{ path: 'src', status: 'unversioned', versioned: false }]))).toBe(true)
    expect(item.visible(file, cliCtx([modified]))).toBe(false)
    // 不在变更清单里的文件也不显示（无法确认其状态）
    expect(item.visible(file, cliCtx([]))).toBe(false)
  })

  it('「SVN 还原」：仅受版本控制且有改动的目标显示（未版本控制/干净文件不显示）', () => {
    const item = byId()['svn-revert-cli']
    expect(item.visible(file, cliCtx([modified]))).toBe(true)
    expect(item.visible({ path: 'src/c.ts', type: 'file' }, cliCtx([conflicted]))).toBe(true)
    expect(item.visible(newFile, cliCtx([unversioned]))).toBe(false)
    expect(item.visible(file, cliCtx([]))).toBe(false)
    expect(item.visible(dir, cliCtx([modified]))).toBe(false)
  })

  it('还原条目带 danger 标记（破坏性动作）', () => {
    expect(byId()['svn-revert-cli'].danger).toBe(true)
  })

  it('「与基线比较」run 走 ctx.openSvnDiff；「加入版本控制」run 调 RPC 并重查变更', async () => {
    // svnAdd 会走 client rpc（fetch 出口）：桩掉 fetch 避免真实网络请求，并让链路可确定落定
    const originalFetch = (globalThis as unknown as { fetch?: unknown }).fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ ok: true, count: 1, summary: '加入版本控制完成（1 项）', output: '' }) }))
    try {
      const openSvnDiff = vi.fn()
      const refreshSvnChanges = vi.fn()
      const ctx = Object.assign(cliCtx([unversioned]), { openSvnDiff, refreshSvnChanges })
      byId()['svn-diff-base'].run(newFile, ctx)
      expect(openSvnDiff).toHaveBeenCalledWith('src/new.ts')
      byId()['svn-add'].run(newFile, ctx)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(ctx.notify).toHaveBeenCalled()
      expect(refreshSvnChanges).toHaveBeenCalled()
    } finally {
      ;(globalThis as unknown as { fetch: unknown }).fetch = originalFetch
    }
  })

  it('「SVN 还原」run 先经 confirm 拦截：取消则不执行', () => {
    const confirm = vi.fn(() => false)
    const refreshSvnChanges = vi.fn()
    const ctx = Object.assign(cliCtx([modified]), { refreshSvnChanges, confirm })
    byId()['svn-revert-cli'].run(file, ctx)
    expect(confirm).toHaveBeenCalled()
    expect(refreshSvnChanges).not.toHaveBeenCalled()
  })
})
