/** DSH 会话性能管理测试：路径编码 / 盘点 / 移出规划 / 移出执行 / 恢复 / patch 调优。作者 ddj 2026年09月02号 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionIdSegment, sessionWorkspaceKey, sessionsRoot } from '../src/paths.js'
import {
  markActiveSessions,
  moveOutSessions,
  planMoveOut,
  restoreSession,
  scanSessionInventory,
  sessionSizeOf,
  validDirName,
  withinDir,
} from '../src/perf.js'
import { patchHasPerfConfig, patchInsertPerfConfig, patchRemovePerfConfig } from '../src/perfPatch.js'

const HOME = join(mkdtempSync(join(tmpdir(), 'dsh-perf-')), 'home')

/** 建一个含 n 个会话（各带同尺寸日志）的工作区。 */
function makeWorkspace(wsKey: string, ids: string[], bytes: number): void {
  for (const id of ids) {
    const dir = join(HOME, 'sessions', wsKey, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'x'.repeat(bytes))
  }
}

/** 建工作区并写入会话日志。 */
function resetHome(): void {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
}

describe('会话路径编码（与 DSH 引擎 projectKey/encodeSegment 一致）', () => {
  it('cwd → 工作区目录键（黄金值）', () => {
    expect(sessionWorkspaceKey('D:\\Work\\ToolsDev\\DeepSeekHarnessPlugin\\packages\\dsh-edit-review'))
      .toBe('--D-Work-ToolsDev-DeepSeekHarnessPlugin-packages-dsh-edit-review--')
  })

  it('根盘符与分隔符折叠为单个 -', () => {
    expect(sessionWorkspaceKey('C:\\Users\\1\\repo')).toBe('--C-Users-1-repo--')
    expect(sessionWorkspaceKey('/home/user/repo')).toBe('--home-user-repo--')
  })

  it('session id 为安全字符时编码恒等', () => {
    expect(sessionIdSegment('session-cdf9d220-c8d3-440e-82bb-a14bd60d3917')).toBe('session-cdf9d220-c8d3-440e-82bb-a14bd60d3917')
    expect(sessionIdSegment('276cc928-b1e0-4c2b-ab71-b84812abf5c7')).toBe('276cc928-b1e0-4c2b-ab71-b84812abf5c7')
  })

  it('点段与非法字符转义', () => {
    expect(sessionIdSegment('.')).toBe('~002E')
    expect(sessionIdSegment('..')).toBe('~002E~002E')
    expect(sessionIdSegment('a/b')).toBe('a~002Fb')
    expect(sessionWorkspaceKey('D:\\a b')).toBe('--D-a~0020b--')
  })
})

describe('validDirName / withinDir', () => {
  it('拒绝空、点、分隔符与 Windows 非法字符', () => {
    expect(validDirName('ws')).toBe(true)
    expect(validDirName('')).toBe(false)
    expect(validDirName('.')).toBe(false)
    expect(validDirName('..')).toBe(false)
    expect(validDirName('a/b')).toBe(false)
    expect(validDirName('a:b')).toBe(false)
  })

  it('目标须落在根内', () => {
    const root = join(HOME, 'sessions')
    expect(withinDir(join(root, 'ws', 'id'), root)).toBe(true)
    expect(withinDir(root, root)).toBe(true)
    expect(withinDir(join(root, '..', 'evil'), root)).toBe(false)
  })
})

describe('scanSessionInventory / markActiveSessions', () => {
  it('按工作区聚合体积并按体积降序', async () => {
    resetHome()
    makeWorkspace('--ws-big--', ['s1', 's2'], 100)
    makeWorkspace('--ws-small--', ['s3'], 10)
    const inv = await scanSessionInventory(HOME)
    expect(inv.totals).toEqual({ workspaces: 2, sessions: 3, totalBytes: 210 })
    expect(inv.workspaces[0].workspaceKey).toBe('--ws-big--')
    expect(inv.workspaces[0].totalBytes).toBe(200)
    expect(inv.sessions[0].sessionId).toBe('s1')
  })

  it('markActiveSessions 双向匹配（原始 id 与编码段名）', () => {
    const sessions = [
      { sessionId: 'live-1', workspaceKey: 'w', bytes: 1, mtime: 0, active: false },
      { sessionId: 'gone-1', workspaceKey: 'w', bytes: 1, mtime: 0, active: false },
    ]
    markActiveSessions(sessions, ['live-1'])
    expect(sessions[0].active).toBe(true)
    expect(sessions[1].active).toBe(false)
  })
})

describe('planMoveOut', () => {
  const inv = {
    workspaces: [],
    totals: { workspaces: 1, sessions: 4, totalBytes: 0 },
    sessions: [
      { sessionId: 'a', workspaceKey: 'w', bytes: 5000, mtime: Date.now() - 40 * 24 * 3600 * 1000, active: false },
      { sessionId: 'b', workspaceKey: 'w', bytes: 300, mtime: Date.now() - 2 * 24 * 3600 * 1000, active: false },
      { sessionId: 'c', workspaceKey: 'w', bytes: 8000, mtime: Date.now(), active: true },
      { sessionId: 'd', workspaceKey: 'other', bytes: 9000, mtime: Date.now() - 60 * 24 * 3600 * 1000, active: false },
    ],
  }

  it('显式集合只选指定会话（活跃仍被排除）', () => {
    const plan = planMoveOut(inv, { sessionIds: ['a', 'c'] })
    expect(plan.items.map((i) => i.sessionId)).toEqual(['a'])
    expect(plan.reclaimedBytes).toBe(5000)
  })

  it('按体积阈值圈选非活跃会话', () => {
    const plan = planMoveOut(inv, { minBytes: 1000 })
    expect(plan.items.map((i) => i.sessionId).sort()).toEqual(['a', 'd'])
  })

  it('按天数圈选非活跃旧会话', () => {
    const plan = planMoveOut(inv, { olderThanDays: 30 })
    expect(plan.items.map((i) => i.sessionId).sort()).toEqual(['a', 'd'])
  })

  it('按工作区过滤', () => {
    const plan = planMoveOut(inv, { workspaceKey: 'w', olderThanDays: 30 })
    expect(plan.items.map((i) => i.sessionId)).toEqual(['a'])
  })

  it('无显式集合且无规则时为空（防误移）', () => {
    expect(planMoveOut(inv, {}).items).toEqual([])
  })
})

describe('moveOutSessions / restoreSession / sessionSizeOf', () => {
  it('移出到归档并统计释放字节，活跃会话拒绝', async () => {
    resetHome()
    makeWorkspace('--w--', ['s1', 's2'], 100)
    const result = await moveOutSessions(HOME, join(HOME, 'sessions-archive'), [
      { workspaceKey: '--w--', sessionId: 's1', bytes: 0 },
      { workspaceKey: '--w--', sessionId: 's2', bytes: 0 },
    ], ['s2'])
    expect(result.moved.map((i) => i.sessionId)).toEqual(['s1'])
    expect(result.failures[0]?.error).toContain('活跃会话')
    expect(result.reclaimedBytes).toBe(100)
    expect(statSync(join(HOME, 'sessions-archive', '--w--', 's1')).isDirectory()).toBe(true)
    expect(() => statSync(join(HOME, 'sessions', '--w--', 's1'))).toThrow()
  })

  it('dryRun 不搬迁但返回清单', async () => {
    resetHome()
    makeWorkspace('--w--', ['s1'], 100)
    const result = await moveOutSessions(HOME, join(HOME, 'sessions-archive'), [
      { workspaceKey: '--w--', sessionId: 's1', bytes: 0 },
    ], [], true)
    expect(result.moved).toHaveLength(1)
    expect(statSync(join(HOME, 'sessions', '--w--', 's1')).isDirectory()).toBe(true)
  })

  it('恢复：归档 → sessions，目标占用时拒绝', async () => {
    resetHome()
    makeWorkspace('--w--', ['s1'], 100)
    await moveOutSessions(HOME, join(HOME, 'sessions-archive'), [{ workspaceKey: '--w--', sessionId: 's1', bytes: 0 }], [])
    const ok = await restoreSession(HOME, join(HOME, 'sessions-archive'), '--w--', 's1')
    expect(ok.ok).toBe(true)
    expect(statSync(join(HOME, 'sessions', '--w--', 's1')).isDirectory()).toBe(true)
    const again = await restoreSession(HOME, join(HOME, 'sessions-archive'), '--w--', 's1')
    expect(again.ok).toBe(false)
  })

  it('sessionSizeOf 统计会话日志体积（缺失为 0）', async () => {
    resetHome()
    makeWorkspace(sessionWorkspaceKey('D:\\w'), ['s1'], 123)
    expect(await sessionSizeOf(HOME, 'D:\\w', 's1')).toEqual({ bytes: 123, exists: true })
    expect(await sessionSizeOf(HOME, 'D:\\w', 'missing')).toEqual({ bytes: 0, exists: false })
  })

  it('越界工作区键被拒绝', async () => {
    resetHome()
    const result = await moveOutSessions(HOME, join(HOME, 'sessions-archive'), [
      { workspaceKey: '..\\evil', sessionId: 's1', bytes: 0 },
    ], [])
    expect(result.failures[0]?.error).toContain('不合法')
    expect(sessionsRoot(HOME)).toBe(join(HOME, 'sessions'))
  })
})

describe('perfPatch 文本调优', () => {
  const SAMPLE = '# 用户层补丁\n- id: dsh-rule-engine\n  disabled: true\n'

  it('插入性能块且幂等（重复插入只有一份）', () => {
    const once = patchInsertPerfConfig(SAMPLE)
    expect(patchHasPerfConfig(once)).toBe(true)
    const twice = patchInsertPerfConfig(once)
    expect(patchHasPerfConfig(twice)).toBe(true)
    const count = twice.split('# dsh-vscode-mode perf tuning (start)').length - 1
    expect(count).toBe(1)
    expect(once).toContain('thresholdRatio: 0.6')
  })

  it('移除后恢复原文本语义（用户层补丁保留）', () => {
    const once = patchInsertPerfConfig(SAMPLE)
    const removed = patchRemovePerfConfig(once)
    expect(patchHasPerfConfig(removed)).toBe(false)
    expect(removed).toContain('- id: dsh-rule-engine')
  })

  it('无块时插入/移除原样返回', () => {
    expect(patchHasPerfConfig(SAMPLE)).toBe(false)
    expect(patchRemovePerfConfig(SAMPLE)).toBe(SAMPLE)
  })

  it('生成块以换行收尾且含起止标记', () => {
    const block = patchInsertPerfConfig('') 
    expect(block.endsWith('\n')).toBe(true)
    expect(block).toContain('# dsh-vscode-mode perf tuning (end)')
  })
})
