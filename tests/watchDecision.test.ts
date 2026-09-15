/**
 * src/client/watchDecision.ts 纯逻辑测试：外部改动同步判定表 + 基线/台账/键归一。
 * 覆盖真实场景语义：无基线首次观测、版本未变、干净缓冲版本变、脏缓冲内容相同/不同、
 * 文件被删（干净/脏两种）、Windows 反斜杠键归一、上限逐出、标记读写清除。
 * 作者 ddj 2026-09-15
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BASELINE_CAP,
  SYNC_STATE_CAP,
  baselineOf,
  clearBaseline,
  clearReadVersion,
  clearScope,
  clearSync,
  markReadVersion,
  markSync,
  readSync,
  readVersionOf,
  recordBaseline,
  syncDecision,
  syncKey,
  versionOf,
} from '../src/client/watchDecision.js'

/** 判定输入构造（缺省：有基线、版本未变、存在、干净、内容不同）。 */
function input(patch: Partial<Parameters<typeof syncDecision>[0]> = {}) {
  return { hasBaseline: true, versionChanged: false, missing: false, clean: true, contentEqual: false, ...patch }
}

describe('syncDecision', () => {
  it('无基线 → none（首次打开/后端无版本，由调用方补记基线）', () => {
    expect(syncDecision(input({ hasBaseline: false }))).toBe('none')
    expect(syncDecision(input({ hasBaseline: false, versionChanged: true }))).toBe('none')
  })

  it('版本未变 → none（含脏缓冲：没有外部改动就什么都不做）', () => {
    expect(syncDecision(input())).toBe('none')
    expect(syncDecision(input({ clean: false }))).toBe('none')
  })

  it('版本变 + 缓冲干净 → sync-silent（自动刷入，对齐 VSCode）', () => {
    expect(syncDecision(input({ versionChanged: true }))).toBe('sync-silent')
  })

  it('版本变 + 缓冲脏 + 内容与磁盘相同 → sync-silent（只补记基线，不打断编辑）', () => {
    expect(syncDecision(input({ versionChanged: true, clean: false, contentEqual: true }))).toBe('sync-silent')
  })

  it('版本变 + 缓冲脏 + 内容不同 → conflict（绝不覆盖未保存编辑）', () => {
    expect(syncDecision(input({ versionChanged: true, clean: false, contentEqual: false }))).toBe('conflict')
  })

  it('文件缺失 + 缓冲干净 → deleted；脏缓冲 → none（保留编辑，交给保存失败路径）', () => {
    expect(syncDecision(input({ missing: true }))).toBe('deleted')
    expect(syncDecision(input({ missing: true, clean: false }))).toBe('none')
  })
})

describe('versionOf', () => {
  it('取版本令牌：空串/缺失/非串 → null（后端不支持版本时不启用护栏）', () => {
    expect(versionOf({ path: 'a.ts', version: 'v1' })).toBe('v1')
    expect(versionOf({ path: 'a.ts', version: '' })).toBeNull()
    expect(versionOf({ path: 'a.ts' })).toBeNull()
    expect(versionOf(null)).toBeNull()
  })
})

describe('基线台账', () => {
  const scope = 'ws:A'

  beforeEach(() => clearScope(scope))

  it('记录与读取：路径键归一（反斜杠与正斜杠同一文件）', () => {
    recordBaseline(scope, 'src\\a.ts', 'v1')
    expect(baselineOf(scope, 'src/a.ts')).toBe('v1')
    expect(baselineOf(scope, 'src\\a.ts')).toBe('v1')
  })

  it('空版本不记（后端无版本令牌时不应产生假基线）', () => {
    recordBaseline(scope, 'src/a.ts', '')
    recordBaseline(scope, 'src/a.ts', null)
    expect(baselineOf(scope, 'src/a.ts')).toBeNull()
  })

  it('作用域隔离：不同 scope 互不可见，清 scope 只清自己', () => {
    recordBaseline(scope, 'src/a.ts', 'v1')
    recordBaseline('ws:B', 'src/a.ts', 'v2')
    expect(baselineOf('ws:B', 'src/a.ts')).toBe('v2')
    clearScope(scope)
    expect(baselineOf(scope, 'src/a.ts')).toBeNull()
    expect(baselineOf('ws:B', 'src/a.ts')).toBe('v2')
    clearScope('ws:B')
  })

  it('clearBaseline 只清单个路径', () => {
    recordBaseline(scope, 'src/a.ts', 'v1')
    recordBaseline(scope, 'src/b.ts', 'v1')
    clearBaseline(scope, 'src/a.ts')
    expect(baselineOf(scope, 'src/a.ts')).toBeNull()
    expect(baselineOf(scope, 'src/b.ts')).toBe('v1')
  })

  it('超上限逐出最旧（长时间运行不无界增长）', () => {
    for (let i = 0; i <= BASELINE_CAP; i += 1) recordBaseline(scope, 'src/f' + i + '.ts', 'v' + i)
    expect(baselineOf(scope, 'src/f0.ts')).toBeNull()
    expect(baselineOf(scope, 'src/f' + BASELINE_CAP + '.ts')).toBe('v' + BASELINE_CAP)
  })

  it('同步标记：写入即读回、同键覆盖、清除生效、超上限逐出', () => {
    markSync(scope, 'src/a.ts', 'conflict')
    expect(readSync(scope, 'src/a.ts')?.kind).toBe('conflict')
    markSync(scope, 'src\\a.ts', 'deleted')
    expect(readSync(scope, 'src/a.ts')?.kind).toBe('deleted')
    clearSync(scope, 'src/a.ts')
    expect(readSync(scope, 'src/a.ts')).toBeNull()
    for (let i = 0; i <= SYNC_STATE_CAP; i += 1) markSync(scope, 'src/g' + i + '.ts', 'conflict')
    expect(readSync(scope, 'src/g0.ts')).toBeNull()
    expect(readSync(scope, 'src/g' + SYNC_STATE_CAP + '.ts')?.kind).toBe('conflict')
  })
})

describe('已读版本台账（同版本不重复读盘）', () => {
  const scope = 'ws:read'

  beforeEach(() => clearScope(scope))

  it('记录后按版本命中；不同版本一律视为未读（防上一版本结果被误用）', () => {
    markReadVersion(scope, 'a.ts', 'v1', true)
    expect(readVersionOf(scope, 'a.ts', 'v1')).toEqual({ equal: true })
    expect(readVersionOf(scope, 'a.ts', 'v2')).toBeNull()
    expect(readVersionOf(scope, 'a.ts', null)).toBeNull()
    expect(readVersionOf(scope, 'b.ts', 'v1')).toBeNull()
  })

  it('记录内容不同（equal=false）的版本：命中后不读盘、按内容不同处理', () => {
    markReadVersion(scope, 'a.ts', 'v3', false)
    expect(readVersionOf(scope, 'a.ts', 'v3')).toEqual({ equal: false })
  })

  it('clearReadVersion / 空版本不记录 / 路径归一', () => {
    markReadVersion(scope, 'src\\a.ts', 'v1', false)
    expect(readVersionOf(scope, 'src/a.ts', 'v1')).toEqual({ equal: false })
    clearReadVersion(scope, 'src/a.ts')
    expect(readVersionOf(scope, 'src/a.ts', 'v1')).toBeNull()
    markReadVersion(scope, 'src/a.ts', '', true)
    expect(readVersionOf(scope, 'src/a.ts', '')).toBeNull()
  })
})

describe('syncKey', () => {
  it('作用域与路径归一后拼接（反斜杠与正斜杠同键）', () => {
    expect(syncKey('ws', 'a\\b.ts')).toBe(syncKey('ws', 'a/b.ts'))
    expect(syncKey('ws', 'a/b.ts')).not.toBe(syncKey('ws2', 'a/b.ts'))
  })
})
